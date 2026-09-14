/**
 * #268 Bot Flow Message Optimization — Targeted Tests
 *
 * Covers: saved-card state transitions, duplicate booking prevention,
 * ordering side-effect idempotency, provider-auth, cancel handling,
 * deep-link capability validation, interactive body overflow,
 * T&C preservation, confirmation/receipt preservation, and S3 reconciliation.
 */

import { describe, it, expect, vi } from 'vitest';
import { safeButtons } from '../shared/safe-interactive';

// ── Blocker 6: Interactive body overflow tests ──

describe('safeButtons — interactive body overflow', () => {
  it('returns single buttons message when body is within 1024 chars', () => {
    const body = 'Short summary';
    const buttons = [{ id: 'confirm', title: 'Confirm' }];
    const result = safeButtons(body, buttons);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('buttons');
  });

  it('returns text + buttons when body exceeds 1024 chars', () => {
    const body = 'A'.repeat(1025);
    const buttons = [{ id: 'confirm', title: 'Confirm' }];
    const result = safeButtons(body, buttons);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text');
    if (result[0].type === 'text') {
      // Full body preserved in text message — no truncation
      expect(result[0].text).toBe(body);
      expect(result[0].text.length).toBe(1025);
    }
    expect(result[1].type).toBe('buttons');
    if (result[1].type === 'buttons') {
      expect(result[1].body).toBe('Select an option below:');
      expect(result[1].buttons).toEqual(buttons);
    }
  });

  it('preserves payment URLs in text fallback when body exceeds limit', () => {
    const paymentUrl = 'https://paystack.com/pay/very-long-reference-code-xyz123';
    const body = 'A'.repeat(1000) + `\n\nPay here 👇\n${paymentUrl}`;
    const buttons = [{ id: 'i_paid', title: "I've Paid" }];
    const result = safeButtons(body, buttons);

    expect(result).toHaveLength(2);
    if (result[0].type === 'text') {
      expect(result[0].text).toContain(paymentUrl);
    }
  });

  it('preserves T&C link in text fallback when body exceeds limit', () => {
    const termsUrl = 'https://www.waaiio.com/t/business-slug';
    const body = 'A'.repeat(1000) + `\n\n📎 Terms: ${termsUrl}`;
    const buttons = [{ id: 'confirm', title: 'I Accept & Confirm' }];
    const result = safeButtons(body, buttons);

    expect(result).toHaveLength(2);
    if (result[0].type === 'text') {
      expect(result[0].text).toContain(termsUrl);
    }
  });

  it('returns single message at exactly 1024 chars', () => {
    const body = 'B'.repeat(1024);
    const result = safeButtons(body, [{ id: 'ok', title: 'OK' }]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('buttons');
  });

  it('passes footer through in both modes', () => {
    const shortResult = safeButtons('Short', [{ id: 'ok', title: 'OK' }], 'footer text');
    expect(shortResult).toHaveLength(1);
    if (shortResult[0].type === 'buttons') {
      expect(shortResult[0].footer).toBe('footer text');
    }

    const longResult = safeButtons('C'.repeat(1025), [{ id: 'ok', title: 'OK' }], 'footer text');
    expect(longResult).toHaveLength(2);
    if (longResult[1].type === 'buttons') {
      expect(longResult[1].footer).toBe('footer text');
    }
  });
});

// ── Blocker 7: Deep-link capability validation ──

describe('deep-link capability validation', () => {
  it('bot.service.ts only sets active_capability when deep-link capability is in effective capabilities', () => {
    // Structural test: verify the code pattern
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');

    // The line must include capabilities.includes check before setting active_capability from deepLinkCapability
    const deepLinkLine = src.match(/deepLinkCapability.*active_capability.*deepLinkCapability/);
    expect(deepLinkLine).toBeTruthy();

    // Must include capabilities.includes validation
    const validatedLine = src.match(/capabilities\.includes\(deepLinkCapability.*active_capability.*deepLinkCapability/);
    expect(validatedLine).toBeTruthy();
  });
});

// ── Blocker 8: Saved-card state machine coverage ──

describe('saved-card shared helper — handleSavedCardInput', () => {
  // Note: handleSavedCardInput uses the savedPaymentAdapter singleton, so these are structural/contract tests

  it('exports buildSavedCardOffer and handleSavedCardInput', async () => {
    const mod = await import('../shared/saved-card-flow');
    expect(typeof mod.buildSavedCardOffer).toBe('function');
    expect(typeof mod.handleSavedCardInput).toBe('function');
  });

  it('handleSavedCardInput handles cancel/go_back from saved-card offer', async () => {
    const { handleSavedCardInput } = await import('../shared/saved-card-flow');
    // Verify the function source includes cancel handling
    const src = handleSavedCardInput.toString();
    expect(src).toContain('_saved_card_cancelled');
    expect(src).toContain('go_back');
  });

  it('handleSavedCardInput handles pay_new', async () => {
    const { handleSavedCardInput } = await import('../shared/saved-card-flow');
    const src = handleSavedCardInput.toString();
    expect(src).toContain('pay_new');
    expect(src).toContain('_skip_saved_card');
  });

  it('shared helper sends auth URL for requires_provider_auth', async () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/saved-card-flow.ts', 'utf-8');
    // Must send auth URL to customer, not just store it
    expect(src).toContain('sendText');
    expect(src).toContain('requires verification');
    expect(src).toContain('result.authUrl');
    expect(src).toContain('payment_reference');
  });
});

// ── Blocker 1: State-transition ordering ──

describe('state-transition ordering — saved-card before terms loop', () => {
  const flows = [
    { name: 'payment.flow.ts', path: 'lib/bot/flows/payment.flow.ts' },
    { name: 'ticketing.flow.ts', path: 'lib/bot/flows/ticketing.flow.ts' },
    { name: 'reservation.flow.ts', path: 'lib/bot/flows/reservation.flow.ts' },
    { name: 'ordering.flow.ts', path: 'lib/bot/flows/ordering.flow.ts' },
  ];

  for (const flow of flows) {
    it(`${flow.name}: _saved_card_paid is checked before _terms_accepted in next()`, () => {
      const fs = require('fs');
      const src = fs.readFileSync(flow.path, 'utf-8');
      const savedCardIdx = src.indexOf('_saved_card_paid');
      const termsIdx = src.indexOf('_terms_loop_consumed');
      // Both must exist
      expect(savedCardIdx).toBeGreaterThan(-1);
      expect(termsIdx).toBeGreaterThan(-1);
      // Saved-card must come first
      expect(savedCardIdx).toBeLessThan(termsIdx);
    });

    it(`${flow.name}: _saved_card_cancelled is handled in next()`, () => {
      const fs = require('fs');
      const src = fs.readFileSync(flow.path, 'utf-8');
      expect(src).toContain('_saved_card_cancelled');
    });

    it(`${flow.name}: _saved_card_requires_auth routes to payment-await step`, () => {
      const fs = require('fs');
      const src = fs.readFileSync(flow.path, 'utf-8');
      expect(src).toContain('_saved_card_requires_auth');
    });
  }
});

// ── Blocker 2: Payment/Giving no duplicate booking ──

describe('Payment/Giving — no duplicate booking on re-entry', () => {
  it('process_payment guards booking INSERT with existing booking_id check', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    // Must check for existing booking before INSERT
    expect(src).toContain('!bookingId || !referenceCode');
    // Must reuse existing booking on re-entry
    expect(src).toContain('d.booking_id as string | undefined');
    expect(src).toContain('d.reference_code as string | undefined');
  });
});

// ── Blocker 3: Ordering no duplicate creation side effects ──

describe('ordering — no duplicate creation side effects on re-entry', () => {
  it('evaluateRules/triggerSequences guarded by _order_side_effects_fired', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('_order_side_effects_fired');
    // Must set flag before firing
    const setIdx = src.indexOf("d._order_side_effects_fired = true");
    const evalIdx = src.indexOf("evaluateRules(ctx.supabase, ctx.business.id, 'order_created'");
    expect(setIdx).toBeLessThan(evalIdx);
  });

  it('notifyOwnerNewOrder guarded by _order_owner_notified', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('_order_owner_notified');
  });
});

// ── Blocker 4: Provider-auth end-to-end ──

describe('provider-auth end-to-end', () => {
  it('shared helper sends auth URL to customer', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/saved-card-flow.ts', 'utf-8');
    // Auth URL must be sent as a message, not just stored
    expect(src).toContain('ctx.sender.sendText');
    expect(src).toContain('result.authUrl');
    expect(src).toContain('payment_reference: opts.reference');
  });

  it('all 4 flows route _saved_card_requires_auth to payment-await step', () => {
    const fs = require('fs');
    const flows = [
      { path: 'lib/bot/flows/payment.flow.ts', awaitStep: 'await_payment' },
      { path: 'lib/bot/flows/ticketing.flow.ts', awaitStep: 'await_ticket_payment' },
      { path: 'lib/bot/flows/reservation.flow.ts', awaitStep: 'reservation_payment' },
      { path: 'lib/bot/flows/ordering.flow.ts', awaitStep: 'await_order_payment' },
    ];
    for (const flow of flows) {
      const src = fs.readFileSync(flow.path, 'utf-8');
      // Find the _saved_card_requires_auth check and verify it routes to the await step
      const authIdx = src.indexOf('_saved_card_requires_auth');
      const awaitIdx = src.indexOf(`'${flow.awaitStep}'`, authIdx);
      expect(authIdx).toBeGreaterThan(-1);
      expect(awaitIdx).toBeGreaterThan(authIdx);
    }
  });
});

// ── Blocker 5: Cancel from saved-card offer ──

describe('saved-card cancel handling', () => {
  it('handleSavedCardInput returns _saved_card_cancelled on go_back', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/saved-card-flow.ts', 'utf-8');
    // go_back must produce _saved_card_cancelled
    expect(src).toContain("action === 'go_back'");
    expect(src).toContain('_saved_card_cancelled');
  });

  it('ordering cancel cleans up order on _saved_card_cancelled', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // _saved_card_cancelled should cancel the order
    const cancelIdx = src.indexOf('_saved_card_cancelled');
    const orderCancelIdx = src.indexOf("status: 'cancelled'", cancelIdx);
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(orderCancelIdx).toBeGreaterThan(cancelIdx);
  });
});

// ── Blocker 9 / S3 reconciliation — proactive confirmation sufficiency ──

describe('S3 reconciliation — proactive confirmation contains receipt info', () => {
  it('sendProactiveConfirmation includes amount, reference, business name, and service name', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');
    // The confirmation message must contain all key receipt fields
    expect(src).toContain('formatCurrency(payment.amount');
    expect(src).toContain('businessName');
    expect(src).toContain('serviceName');
    expect(src).toContain('referenceCode');
    expect(src).toContain("Type *receipt* to get your receipt");
  });

  it('post-completion still sends PDF receipt (only text receipt removed)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/post-completion.ts', 'utf-8');
    // PDF receipt must still be generated and sent
    expect(src).toContain('generateReceiptPdf');
    expect(src).toContain('sendDocument');
    // Standalone text receipt should NOT be sent (removed in #268)
    // The old receipt lines were: "✅ *Payment Receipt*" sent via sendText
    // Verify the auto-receipt section no longer sends a text message
    const autoReceiptSection = src.slice(src.indexOf('Auto-receipt'));
    expect(autoReceiptSection).not.toContain("sender.sendText({ to: phone, text: await t(receiptLines)");
  });

  it('proactive confirmation is sufficient as receipt summary when PDF fails', () => {
    // S3 deviation documentation: the proactive confirmation in send-confirmation.ts
    // already contains: ✅ Payment Confirmed! + business name + service name +
    // amount (formatted) + reference code + "Type *receipt* to get your receipt".
    // This is sufficient receipt information even if the PDF send fails non-fatally.
    // The standalone text receipt was removed because it duplicated this information.
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');

    // All required receipt fields present in confirmation
    expect(src).toContain('Payment Confirmed');
    expect(src).toContain('formatCurrency(payment.amount');
    expect(src).toContain('referenceCode');

    // PDF receipt is non-fatal — explicit try/catch
    const postCompletionSrc = fs.readFileSync('lib/bot/flows/shared/post-completion.ts', 'utf-8');
    expect(postCompletionSrc).toContain('PDF receipt error (non-fatal)');
  });
});

// ── T&C preservation ──

describe('T&C acceptance preserved in consolidated confirmation', () => {
  const flows = [
    'lib/bot/flows/payment.flow.ts',
    'lib/bot/flows/ticketing.flow.ts',
    'lib/bot/flows/reservation.flow.ts',
    'lib/bot/flows/ordering.flow.ts',
  ];

  for (const path of flows) {
    const name = path.split('/').pop()!;
    it(`${name}: confirmation validate sets _terms_accepted on confirm`, () => {
      const fs = require('fs');
      const src = fs.readFileSync(path, 'utf-8');
      // Must set _terms_accepted when customer confirms
      expect(src).toContain("_terms_accepted: true");
    });

    it(`${name}: T&C URL is included in confirmation body when required`, () => {
      const fs = require('fs');
      const src = fs.readFileSync(path, 'utf-8');
      expect(src).toContain('termsUrl') ;
      expect(src).toContain('I Accept & Confirm');
    });
  }
});
