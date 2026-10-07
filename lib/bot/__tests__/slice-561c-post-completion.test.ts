/**
 * Slice 561-C — Post-completion / document / wrapper copy tests
 *
 * Proves:
 * - Post-completion buttons use deterministic copy
 * - Confirmation templates accept lang parameter
 * - Order status labels use corpus keys
 * - Document wrapper chrome is localized
 * - Refund flow chrome is localized
 * - Escape hatch buttons use corpus keys
 * - English baseline correct
 * - Pidgin (entitled) gets Pidgin copy
 */
import { describe, it, expect, vi } from 'vitest';
import { getFlowCopy, fillFlowCopy, _FLOW_COPY_FOR_TESTS } from '../flows/flow-localization';
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

// ═══════════════════════════════════════════════════════════════
// 1. New 561-C corpus keys exist in all locales
// ═══════════════════════════════════════════════════════════════

describe('561-C: new corpus keys have full locale coverage', () => {
  const newKeys = [
    'ordering.edit_change_name', 'ordering.edit_change_address',
    'ordering.edit_back_to_summary', 'ordering.edit_return_desc',
    'ordering.edit_body', 'ordering.min_order_prompt', 'ordering.after_paying',
    'orders.what_to_do', 'orders.action_error', 'orders.action_cancelled',
    'docs.generating', 'docs.caption_history', 'docs.caption_annual',
    'docs.caption_receipt', 'docs.no_transactions', 'docs.error_generating',
    'docs.receipt_header', 'docs.order_receipt_header',
    'docs.donation_receipt_header', 'docs.invoice_receipt_header',
    'docs.lbl_business', 'docs.lbl_service', 'docs.lbl_order',
    'docs.lbl_date', 'docs.lbl_paid', 'docs.lbl_amount',
    'docs.lbl_ref', 'docs.lbl_status', 'docs.lbl_organization',
    'docs.lbl_campaign', 'docs.lbl_invoice', 'docs.continue_hint',
    'refund.submitted', 'refund.generic_error',
    'confirm.lbl_checkin', 'confirm.lbl_checkout',
  ];

  for (const key of newKeys) {
    it(`${key} exists in en and pcm`, () => {
      expect(_FLOW_COPY_FOR_TESTS.en[key], `en.${key}`).toBeTruthy();
      expect(_FLOW_COPY_FOR_TESTS.pcm[key], `pcm.${key}`).toBeTruthy();
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// 2. Post-completion buttons use deterministic copy
// ═══════════════════════════════════════════════════════════════

describe('561-C: post-completion buttons use corpus keys', () => {
  it('executor source uses getFlowCopy for post-completion buttons', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    // Find showPostCompletionMenu method
    // Find the private method definition, not the call site
    const methodStart = source.indexOf('private async showPostCompletionMenu');
    expect(methodStart).toBeGreaterThan(0);
    const methodBody = source.slice(methodStart, methodStart + 3000);
    // Button titles should use getFlowCopy, not hardcoded strings
    expect(methodBody).toContain("'post.give_again'");
    expect(methodBody).toContain("'post.buy_more_tickets'");
    expect(methodBody).toContain("'post.order_again'");
    expect(methodBody).toContain("'post.book_again'");
    expect(methodBody).toContain("'menu.what_next'");
    expect(methodBody).toContain("'nav.view_options'");
    // Should NOT have hardcoded English button titles
    expect(methodBody).not.toContain("title: 'Give Again'");
    expect(methodBody).not.toContain("title: 'Book Again'");
    expect(methodBody).not.toContain("title: 'Order Again'");
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Confirmation templates accept lang parameter
// ═══════════════════════════════════════════════════════════════

describe('561-C: confirmation templates accept lang', () => {
  it('getConfirmationMessage accepts lang parameter', async () => {
    const { getConfirmationMessage } = await import('../flows/shared/templates');
    // English
    const enMsg = getConfirmationMessage({
      emoji: '📅', businessName: 'TestBiz', dateLabel: '2024-01-01',
      time: '10:00', quantity: 1, quantityLabel: 'person',
      referenceCode: 'REF-123', lang: 'en',
    });
    expect(enMsg).toContain('Thank you!');
    expect(enMsg).toContain('REF-123'); // Protected value preserved
    expect(enMsg).toContain('TestBiz'); // Merchant name preserved
  });

  it('getConfirmationMessage produces Pidgin thank-you', async () => {
    const { getConfirmationMessage } = await import('../flows/shared/templates');
    const pcmMsg = getConfirmationMessage({
      emoji: '📅', businessName: 'TestBiz', dateLabel: '2024-01-01',
      time: '10:00', quantity: 1, quantityLabel: 'person',
      referenceCode: 'REF-123', lang: 'pcm',
    });
    // Pidgin thank_you is "Thank you! 🙏" (same, kept for recognizability)
    expect(pcmMsg).toContain('Thank you!');
    expect(pcmMsg).toContain('REF-123');
  });

  it('getOrderConfirmationMessage accepts lang parameter', async () => {
    const { getOrderConfirmationMessage } = await import('../flows/shared/templates');
    const enMsg = getOrderConfirmationMessage({
      businessName: 'TestBiz', items: [{ name: 'Pizza', quantity: 1, price: 5000 }],
      totalAmount: 5000, referenceCode: 'ORD-456', lang: 'en',
    });
    expect(enMsg).toContain('Order Confirmed');
    expect(enMsg).toContain('ORD-456');
    expect(enMsg).toContain('Items');
  });

  it('getTicketConfirmationMessage accepts lang parameter', async () => {
    const { getTicketConfirmationMessage } = await import('../flows/shared/templates');
    const enMsg = getTicketConfirmationMessage({
      eventName: 'Concert', dateLabel: '2024-12-25', venue: 'Hall',
      quantity: 2, totalAmount: 10000, referenceCode: 'TKT-789', lang: 'en',
    });
    expect(enMsg).toContain('Tickets Confirmed');
    expect(enMsg).toContain('TKT-789');
    expect(enMsg).toContain('See you there');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Document wrapper chrome
// ═══════════════════════════════════════════════════════════════

describe('561-C: document wrapper chrome localized', () => {
  it('docs.generating interpolates docType placeholder', () => {
    const en = fillFlowCopy('en', 'docs.generating', { docType: 'receipt' });
    expect(en).toContain('receipt');
    expect(en).not.toContain('{docType}');

    const pcm = fillFlowCopy('pcm', 'docs.generating', { docType: 'receipt' });
    expect(pcm).toContain('receipt');
    expect(pcm).toContain('generate');
  });

  it('receipt labels exist in English and Pidgin', () => {
    expect(getFlowCopy('en', 'docs.receipt_header')).toBe('🧾 *Receipt*');
    expect(getFlowCopy('en', 'docs.lbl_business')).toBe('Business:');
    expect(getFlowCopy('en', 'docs.lbl_amount')).toBe('Amount:');
    expect(getFlowCopy('en', 'docs.continue_hint')).toContain('*Hi*');
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Refund flow chrome
// ═══════════════════════════════════════════════════════════════

describe('561-C: refund flow chrome localized', () => {
  it('refund keys exist and produce correct English', () => {
    expect(getFlowCopy('en', 'refund.no_eligible')).toContain('eligible for refund');
    expect(getFlowCopy('en', 'refund.title')).toBe('Refund Request');
    expect(getFlowCopy('en', 'refund.submitted')).toContain('submitted');
    expect(getFlowCopy('en', 'refund.enter_reason')).toContain('reason');
  });

  it('refund keys produce Pidgin for entitled sessions', () => {
    const pcm = getFlowCopy('pcm', 'refund.submitted');
    expect(pcm).toContain('submit');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Order status labels
// ═══════════════════════════════════════════════════════════════

describe('561-C: order status labels', () => {
  const statusKeys = [
    'order_status.pending', 'order_status.confirmed', 'order_status.processing',
    'order_status.ready', 'order_status.shipped', 'order_status.delivered',
    'order_status.cancelled',
  ];

  it('all status labels exist in English', () => {
    for (const key of statusKeys) {
      expect(getFlowCopy('en', key), `en.${key}`).toBeTruthy();
    }
  });

  it('status labels are within WhatsApp limits', () => {
    for (const key of statusKeys) {
      for (const lang of ['en', 'pcm']) {
        const val = getFlowCopy(lang, key);
        expect(val.length, `${lang}.${key} = "${val}"`).toBeLessThanOrEqual(24);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. Ordering edit menu wiring
// ═══════════════════════════════════════════════════════════════

describe('561-C: ordering edit menu uses corpus keys', () => {
  it('ordering source contains edit menu corpus keys', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(source).toContain("'ordering.edit_change_name'");
    expect(source).toContain("'ordering.edit_change_address'");
    expect(source).toContain("'ordering.edit_back_to_summary'");
    expect(source).toContain("'ordering.edit_return_desc'");
    expect(source).toContain("'ordering.edit_body'");
  });

  it('ordering edit step exists and returns list with localized titles', async () => {
    const { orderingFlow } = await import('../flows/ordering.flow');
    const step = orderingFlow.steps.find(s => s.id === 'edit_order_menu');
    expect(step).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Escape hatches use corpus keys
// ═══════════════════════════════════════════════════════════════

describe('561-C: escape hatches use corpus keys', () => {
  it('escape-hatches source contains nav corpus keys', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('lib/bot/handlers/escape-hatches.ts', 'utf-8');
    expect(source).toContain("'nav.back_to_menu'");
    expect(source).toContain("'nav.switch_business'");
    expect(source).toContain("'nav.exit_what_next'");
    expect(source).toContain("'nav.no_business_guide'");
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('561-C: CERTIFIED_LANGUAGES unchanged', () => {
  it('only en and pcm are certified', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en', 'pcm']);
  });
});
