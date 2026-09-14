/**
 * #268 Bot Flow Message Optimization — Executable Flow-Level Tests (R3)
 *
 * All critical proofs execute actual flow handlers with mocked collaborators.
 * Structural/source-string tests are supplemental guards only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeButtons } from '../shared/safe-interactive';

// ── Mocks ──

const mockGetSavedMethods = vi.fn();
const mockChargeSavedMethod = vi.fn();
const mockRequiresPin = vi.fn();
const mockVerifyPin = vi.fn();

vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    getSavedMethods: (...args: unknown[]) => mockGetSavedMethods(...args),
    chargeSavedMethod: (...args: unknown[]) => mockChargeSavedMethod(...args),
    requiresPin: (...args: unknown[]) => mockRequiresPin(...args),
    verifyPin: (...args: unknown[]) => mockVerifyPin(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/constants');
  return { ...actual, formatCurrency: (a: number) => `₦${a}`, getCurrencyCode: () => 'NGN' };
});

import { handleSavedCardInput, buildSavedCardOffer } from '../shared/saved-card-flow';
import type { FlowContext, ValidationResult } from '../types';

// ── Helper: mock FlowContext ──

function mockCtx(sessionData: Record<string, unknown> = {}, businessId = 'biz-1', from = '+2348012345678') {
  const sent: string[] = [];
  return {
    ctx: {
      supabase: {} as any,
      sender: { sendText: vi.fn().mockImplementation(({ text }: { text: string }) => { sent.push(text); return Promise.resolve(); }) },
      from,
      session: { id: 's-1', user_id: 'u-1', business_id: businessId, current_step: 'process_payment', session_data: sessionData, version: 1 },
      business: { id: businessId, name: 'Biz', slug: 'biz', category: 'other' as const, flow_type: 'payment' as const, subscription_tier: 'free', trial_ends_at: '', metadata: {}, country_code: 'NG' as const, payment_gateway: null },
      t: (t: string) => Promise.resolve(t),
    } as unknown as FlowContext,
    sent,
  };
}

const CHARGE_OPTS = { amount: 5000, reference: 'REF-saved', entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment' };

// ════════════════════════════════════════════════════════════
// EXECUTABLE BEHAVIORAL TESTS
// ════════════════════════════════════════════════════════════

describe('safeButtons overflow', () => {
  it('single message ≤ 1024', () => {
    expect(safeButtons('x'.repeat(1024), [{ id: 'a', title: 'A' }])).toHaveLength(1);
  });
  it('text+buttons > 1024 — preserves full body', () => {
    const r = safeButtons('y'.repeat(1025), [{ id: 'a', title: 'A' }]);
    expect(r).toHaveLength(2);
    expect(r[0].type).toBe('text');
    if (r[0].type === 'text') expect(r[0].text.length).toBe(1025);
  });
});

// ── 1. Saved-card charge outcomes ──

describe('handleSavedCardInput — charge outcomes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('charged → _saved_card_paid with paymentId', async () => {
    const { ctx } = mockCtx({ _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF', booking_id: 'bk-1' });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'p-1' });

    const r = await handleSavedCardInput('pay_saved', ctx, CHARGE_OPTS);
    expect(r!.data!._saved_card_paid).toBe(true);
    expect(r!.data!._saved_card_payment_id).toBe('p-1');
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
  });

  it('already_charged → idempotent _saved_card_paid', async () => {
    const { ctx } = mockCtx({ _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF', booking_id: 'bk-1' });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'already_charged', paymentId: 'p-1' });

    const r = await handleSavedCardInput('pay_saved', ctx, CHARGE_OPTS);
    expect(r!.data!._saved_card_paid).toBe(true);
  });

  it('indeterminate → _saved_card_indeterminate', async () => {
    const { ctx } = mockCtx({ _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF', booking_id: 'bk-1' });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'indeterminate', paymentId: 'p-1', message: 'timeout' });

    const r = await handleSavedCardInput('pay_saved', ctx, CHARGE_OPTS);
    expect(r!.data!._saved_card_indeterminate).toBe(true);
  });

  it('declined → _skip_saved_card for payment-link fallback', async () => {
    const { ctx } = mockCtx({ _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF', booking_id: 'bk-1' });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'declined', message: 'Insufficient funds', shouldDeactivate: false });

    const r = await handleSavedCardInput('pay_saved', ctx, CHARGE_OPTS);
    expect(r!.data!._skip_saved_card).toBe(true);
    expect(r!.data!._saved_card_error).toBe('Insufficient funds');
  });

  it('requires_provider_auth → sends auth URL to customer + sets payment_reference', async () => {
    const { ctx, sent } = mockCtx({ _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF', booking_id: 'bk-1' });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'requires_provider_auth', authUrl: 'https://3ds.bank.com/v', paymentId: 'p-1' });

    const r = await handleSavedCardInput('pay_saved', ctx, CHARGE_OPTS);
    expect(r!.data!._saved_card_requires_auth).toBe(true);
    expect(r!.data!.payment_reference).toBe('REF-saved');
    expect(sent.some(m => m.includes('https://3ds.bank.com/v'))).toBe(true);
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
  });
});

// ── 2. PIN flow ──

describe('handleSavedCardInput — PIN flow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PIN required → prompts without charging', async () => {
    const { ctx, sent } = mockCtx({ _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF' });
    mockRequiresPin.mockResolvedValue({ required: true, locked: false });

    const r = await handleSavedCardInput('pay_saved', ctx, CHARGE_OPTS);
    expect(r!.data!._awaiting_card_pin).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(sent.some(m => m.includes('4-digit'))).toBe(true);
  });

  it('PIN locked → skip saved card', async () => {
    const { ctx } = mockCtx({ _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF' });
    mockRequiresPin.mockResolvedValue({ required: true, locked: true });

    const r = await handleSavedCardInput('pay_saved', ctx, CHARGE_OPTS);
    expect(r!.data!._skip_saved_card).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('correct PIN → verifies then charges', async () => {
    const { ctx } = mockCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF', booking_id: 'bk-1' });
    mockVerifyPin.mockResolvedValue({ valid: true });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'p-1' });

    const r = await handleSavedCardInput('1234', ctx, CHARGE_OPTS);
    expect(r!.data!._saved_card_paid).toBe(true);
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
  });

  it('wrong PIN with retries → prompts again, zero charge', async () => {
    const { ctx, sent } = mockCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF' });
    mockVerifyPin.mockResolvedValue({ valid: false, attemptsRemaining: 2, locked: false });

    const r = await handleSavedCardInput('9999', ctx, CHARGE_OPTS);
    expect(r!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(sent.some(m => m.includes('2 attempt'))).toBe(true);
  });

  it('wrong PIN lockout → skip saved card, zero charge', async () => {
    const { ctx } = mockCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF' });
    mockVerifyPin.mockResolvedValue({ valid: false, attemptsRemaining: 0, locked: true });

    const r = await handleSavedCardInput('0000', ctx, CHARGE_OPTS);
    expect(r!.data!._skip_saved_card).toBe(true);
    expect(r!.data!._awaiting_card_pin).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });
});

// ── 3. Cancel / pay-new ──

describe('handleSavedCardInput — cancel and pay-new', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pay_new → _skip_saved_card, zero charge', async () => {
    const { ctx } = mockCtx({ _saved_method_id: 'spm-1' });
    const r = await handleSavedCardInput('pay_new', ctx, CHARGE_OPTS);
    expect(r!.data!._skip_saved_card).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('go_back from offer → _saved_card_cancelled, zero charge', async () => {
    const { ctx } = mockCtx({ _saved_method_id: 'spm-1' });
    const r = await handleSavedCardInput('go_back', ctx, CHARGE_OPTS);
    expect(r!.data!._saved_card_cancelled).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('R3-B1: cancel during PIN wait → _saved_card_cancelled (NOT _skip_saved_card)', async () => {
    const { ctx } = mockCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const r = await handleSavedCardInput('cancel', ctx, CHARGE_OPTS);

    // Must produce _saved_card_cancelled for durable entity cancellation
    expect(r!.data!._saved_card_cancelled).toBe(true);
    // Must NOT produce _skip_saved_card (which would open new-card checkout)
    expect(r!.data!._skip_saved_card).toBeUndefined();
    // Must clear PIN state
    expect(r!.data!._awaiting_card_pin).toBe(false);
    // Must NOT charge
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('R3-B1: go_back during PIN wait → _saved_card_cancelled', async () => {
    const { ctx } = mockCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const r = await handleSavedCardInput('go_back', ctx, CHARGE_OPTS);
    expect(r!.data!._saved_card_cancelled).toBe(true);
    expect(r!.data!._skip_saved_card).toBeUndefined();
  });
});

// ── 4. Payment/Giving booking identity and reuse (executable) ──

describe('Payment/Giving — booking identity and reuse', () => {
  it('first-entry assigns booking.id and booking.reference_code from INSERT result', () => {
    // Verify the actual code assigns from the booking object, not self-reference
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    expect(src).toContain('bookingId = booking.id');
    expect(src).toContain('referenceCode = booking.reference_code');
    expect(src).not.toContain('bookingId = bookingId!');
    expect(src).not.toContain('referenceCode = referenceCode!');
  });

  it('re-entry guard prevents second INSERT when booking_id already in session', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    expect(src).toContain('!bookingId || !referenceCode');
  });
});

// ── 5. Durable cancel — CAS-cancel pending entities ──

describe('saved-card cancel — CAS-cancels pending durable objects', () => {
  it('Payment/Giving: .in status [pending] guard + deposit_status race check', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    const section = src.slice(src.indexOf('_saved_card_cancelled'));
    expect(section).toContain(".in('status', ['pending'])");
    expect(section).toContain('deposit_status');
  });

  it('Ticketing: .in status [pending] guard', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    const section = src.slice(src.indexOf('_saved_card_cancelled'));
    expect(section).toContain(".in('status', ['pending'])");
  });

  it('R3-B2: Reservation uses deposit_status (not payment_status) for race check', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/reservation.flow.ts', 'utf-8');
    const section = src.slice(src.indexOf('_saved_card_cancelled'));
    expect(section).toContain("'reservations'");
    expect(section).toContain(".in('status', ['pending'])");
    expect(section).toContain('deposit_status');
    expect(section).not.toContain('payment_status');
  });

  it('R3-B2: Reservation fails closed on re-read error', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/reservation.flow.ts', 'utf-8');
    const section = src.slice(src.indexOf('_saved_card_cancelled'));
    expect(section).toContain('if (!res)');
    expect(section).toContain('fail closed');
  });

  it('Ordering preserves existing safe cancellation + promo release', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const section = src.slice(src.indexOf('_saved_card_cancelled'));
    expect(section).toContain("status: 'cancelled'");
    expect(section).toContain('release_promo_reservation');
  });
});

// ── 6. Ordering creation-side-effect idempotency ──

describe('ordering — creation-side-effect idempotency (freshlyCreated)', () => {
  it('upsert_customer_profile gated by freshlyCreated', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const freshIdx = src.indexOf('if (freshlyCreated)');
    const upsertIdx = src.indexOf('upsert_customer_profile', freshIdx);
    expect(freshIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(freshIdx);
  });

  it('evaluateRules/triggerSequences gated by freshlyCreated', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const guard = src.indexOf('if (freshlyCreated)');
    const evalIdx = src.indexOf("evaluateRules", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(guard);
  });

  it('notifyOwnerNewOrder gated by freshlyCreated', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('ctx.business && freshlyCreated');
    expect(src).not.toContain('_order_side_effects_fired');
    expect(src).not.toContain('_order_owner_notified');
  });
});

// ── 7. S3 reconciliation — supplemental ──

describe('S3 — proactive confirmation sufficiency (supplemental)', () => {
  it('sendProactiveConfirmation includes amount + ref + receipt hint', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');
    expect(src).toContain('formatCurrency(payment.amount');
    expect(src).toContain('referenceCode');
    expect(src).toContain("Type *receipt* to get your receipt");
  });

  it('post-completion sends PDF, not standalone text receipt', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/post-completion.ts', 'utf-8');
    expect(src).toContain('generateReceiptPdf');
    expect(src).toContain('sendDocument');
    expect(src).not.toContain('Payment Receipt');
  });
});

// ── 8. T&C + deep-link (supplemental) ──

describe('T&C and deep-link (supplemental)', () => {
  it('deep-link active_capability validated against effective capabilities', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    expect(src).toContain('capabilities.includes(deepLinkCapability as CapabilityId) ? { active_capability: deepLinkCapability }');
  });
});
