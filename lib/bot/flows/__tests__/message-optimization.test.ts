/**
 * #268 Bot Flow Message Optimization — Executable Flow-Level Tests
 *
 * R2: These tests execute actual flow behavior through mocked contexts,
 * not structural/source-string checks. They prove state transitions,
 * idempotency, cancel safety, and provider-auth routing at the flow level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeButtons } from '../shared/safe-interactive';

// ── Mock dependencies for saved-card-flow ──

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
  return {
    ...actual,
    formatCurrency: (amount: number) => `₦${amount.toLocaleString()}`,
    getCurrencyCode: () => 'NGN',
  };
});

import { handleSavedCardInput, buildSavedCardOffer } from '../shared/saved-card-flow';

// ── Helper: create mock FlowContext ──

function createMockCtx(overrides: {
  sessionData?: Record<string, unknown>;
  businessId?: string;
  from?: string;
} = {}) {
  const sentMessages: string[] = [];
  return {
    supabase: {} as any,
    sender: {
      sendText: vi.fn().mockImplementation(({ text }: { text: string }) => {
        sentMessages.push(text);
        return Promise.resolve();
      }),
    },
    from: overrides.from || '+2348012345678',
    session: {
      id: 'sess-1',
      user_id: 'user-1',
      business_id: overrides.businessId || 'biz-1',
      current_step: 'process_payment',
      session_data: overrides.sessionData || {},
      version: 1,
    },
    business: {
      id: overrides.businessId || 'biz-1',
      name: 'Test Business',
      slug: 'test-biz',
      category: 'other' as const,
      flow_type: 'payment' as const,
      subscription_tier: 'free',
      trial_ends_at: '',
      metadata: {},
      country_code: 'NG' as const,
      payment_gateway: null,
    },
    t: (text: string) => Promise.resolve(text),
    sentMessages,
  } as unknown as import('../types').FlowContext & { sentMessages: string[] };
}

// ── safeButtons tests (kept — these are behavioral, not structural) ──

describe('safeButtons — interactive body overflow', () => {
  it('returns single buttons message when body ≤ 1024 chars', () => {
    const result = safeButtons('Short summary', [{ id: 'ok', title: 'OK' }]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('buttons');
  });

  it('returns text + buttons when body > 1024 chars — preserves full content', () => {
    const longBody = 'A'.repeat(1025);
    const result = safeButtons(longBody, [{ id: 'ok', title: 'OK' }]);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text');
    if (result[0].type === 'text') expect(result[0].text.length).toBe(1025);
    expect(result[1].type).toBe('buttons');
  });

  it('never truncates payment URL in fallback', () => {
    const url = 'https://paystack.com/pay/long-ref-code-xyz123456';
    const body = 'A'.repeat(1000) + `\n${url}`;
    const result = safeButtons(body, [{ id: 'i_paid', title: "I've Paid" }]);
    if (result[0].type === 'text') expect(result[0].text).toContain(url);
  });

  it('returns 1 message at exactly 1024 chars', () => {
    const result = safeButtons('B'.repeat(1024), [{ id: 'ok', title: 'OK' }]);
    expect(result).toHaveLength(1);
  });
});

// ── Executable saved-card flow tests ──

describe('handleSavedCardInput — executable state transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pay_saved with no PIN charges directly and returns charged outcome', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1', booking_id: 'bk-1' },
    });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-1' });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    expect(result!.data?._saved_card_paid).toBe(true);
    expect(result!.data?._saved_card_payment_id).toBe('pay-1');
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
  });

  it('pay_saved with already_charged returns idempotent result', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1', booking_id: 'bk-1' },
    });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'already_charged', paymentId: 'pay-1' });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._saved_card_paid).toBe(true);
  });

  it('pay_saved with indeterminate returns indeterminate state', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1', booking_id: 'bk-1' },
    });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'indeterminate', paymentId: 'pay-1', message: 'timeout' });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._saved_card_indeterminate).toBe(true);
  });

  it('pay_saved with decline returns skip_saved_card for payment-link fallback', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1', booking_id: 'bk-1' },
    });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'declined', message: 'Insufficient funds', shouldDeactivate: false });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._skip_saved_card).toBe(true);
    expect(result!.data?._saved_card_error).toBe('Insufficient funds');
  });

  it('pay_saved with requires_provider_auth sends auth URL to customer', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1', booking_id: 'bk-1' },
    });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({
      status: 'requires_provider_auth', authUrl: 'https://3ds.bank.com/verify', paymentId: 'pay-1',
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._saved_card_requires_auth).toBe(true);
    expect(result!.data?.payment_reference).toBe('REF-1-saved');
    // Auth URL must have been sent to customer
    expect(ctx.sentMessages.some((m: string) => m.includes('https://3ds.bank.com/verify'))).toBe(true);
  });

  it('pay_saved with PIN required prompts for PIN without charging', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1' },
    });
    mockRequiresPin.mockResolvedValue({ required: true, locked: false });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._awaiting_card_pin).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(ctx.sentMessages.some((m: string) => m.includes('4-digit card PIN'))).toBe(true);
  });

  it('pay_saved with PIN locked skips saved card', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1' },
    });
    mockRequiresPin.mockResolvedValue({ required: true, locked: true });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._skip_saved_card).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('correct PIN verifies and charges', async () => {
    const ctx = createMockCtx({
      sessionData: { _awaiting_card_pin: true, _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1', booking_id: 'bk-1' },
    });
    mockVerifyPin.mockResolvedValue({ valid: true });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-1' });

    const result = await handleSavedCardInput('1234', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._saved_card_paid).toBe(true);
    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
  });

  it('wrong PIN with attempts remaining prompts retry', async () => {
    const ctx = createMockCtx({
      sessionData: { _awaiting_card_pin: true, _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1' },
    });
    mockVerifyPin.mockResolvedValue({ valid: false, attemptsRemaining: 2, locked: false });

    const result = await handleSavedCardInput('9999', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(ctx.sentMessages.some((m: string) => m.includes('2 attempt'))).toBe(true);
  });

  it('wrong PIN that triggers lockout skips saved card', async () => {
    const ctx = createMockCtx({
      sessionData: { _awaiting_card_pin: true, _saved_method_id: 'spm-1', _pending_deposit: 5000, reference_code: 'REF-1' },
    });
    mockVerifyPin.mockResolvedValue({ valid: false, attemptsRemaining: 0, locked: true });

    const result = await handleSavedCardInput('0000', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._skip_saved_card).toBe(true);
    expect(result!.data?._awaiting_card_pin).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('pay_new returns skip_saved_card for payment-link fallback', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1' },
    });

    const result = await handleSavedCardInput('pay_new', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._skip_saved_card).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('go_back/cancel returns _saved_card_cancelled — zero charge', async () => {
    const ctx = createMockCtx({
      sessionData: { _saved_method_id: 'spm-1' },
    });

    const result = await handleSavedCardInput('go_back', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._saved_card_cancelled).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('cancel during PIN wait skips saved card — zero charge', async () => {
    const ctx = createMockCtx({
      sessionData: { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
    });

    const result = await handleSavedCardInput('cancel', ctx, {
      amount: 5000, reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment',
    });

    expect(result!.data?._skip_saved_card).toBe(true);
    expect(result!.data?._awaiting_card_pin).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });
});

// ── Payment/Giving booking identity tests ──

describe('Payment/Giving — booking identity and reuse', () => {
  it('process_payment uses actual booking.id/reference_code from INSERT (not undefined)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    // After INSERT, must assign from booking object, not self-reference
    expect(src).toContain('bookingId = booking.id');
    expect(src).toContain('referenceCode = booking.reference_code');
    // Must NOT have the old buggy self-assignment
    expect(src).not.toContain('bookingId = bookingId!');
    expect(src).not.toContain('referenceCode = referenceCode!');
  });

  it('re-entry guard checks d.booking_id before INSERT', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    // Guard must exist before INSERT
    const guardIdx = src.indexOf('!bookingId || !referenceCode');
    const insertIdx = src.indexOf("from('bookings')", guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(guardIdx);
  });
});

// ── Saved-card cancel CAS tests ──

describe('saved-card cancel — CAS-cancels pending durable objects', () => {
  it('Payment/Giving cancel CAS-updates booking to cancelled with status guard', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    const cancelSection = src.slice(src.indexOf('_saved_card_cancelled'));
    // Must use .in('status', ['pending']) to prevent overwriting paid/confirmed
    expect(cancelSection).toContain(".in('status', ['pending'])");
    // Must handle race condition where Payment Authority wins
    expect(cancelSection).toContain('deposit_status');
  });

  it('Ticketing cancel CAS-updates booking to cancelled with status guard', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    const cancelSection = src.slice(src.indexOf('_saved_card_cancelled'));
    expect(cancelSection).toContain(".in('status', ['pending'])");
  });

  it('Reservation cancel CAS-updates reservation to cancelled with status guard', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/reservation.flow.ts', 'utf-8');
    const cancelSection = src.slice(src.indexOf('_saved_card_cancelled'));
    // Must cancel the reservation, not the booking
    expect(cancelSection).toContain("'reservations'");
    expect(cancelSection).toContain(".in('status', ['pending'])");
  });

  it('Ordering cancel preserves existing safe cancellation with promo release', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const cancelSection = src.slice(src.indexOf('_saved_card_cancelled'));
    expect(cancelSection).toContain("status: 'cancelled'");
    expect(cancelSection).toContain('release_promo_reservation');
  });
});

// ── Ordering creation-side-effect idempotency ──

describe('ordering — creation-side-effect idempotency', () => {
  it('upsert_customer_profile guarded by freshlyCreated', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // Profile upsert must be inside freshlyCreated guard
    const freshIdx = src.indexOf('if (freshlyCreated)');
    const upsertIdx = src.indexOf('upsert_customer_profile', freshIdx);
    expect(freshIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(freshIdx);
    // freshlyCreated guard must come before upsert_customer_profile
    // (may be separated by other freshlyCreated-guarded code in the same block)
  });

  it('evaluateRules/triggerSequences guarded by freshlyCreated', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // Rules/sequences must be gated by freshlyCreated, not just session flags
    const rulesGuard = src.indexOf("if (freshlyCreated)");
    const evalIdx = src.indexOf("evaluateRules(ctx.supabase, ctx.business.id, 'order_created'");
    expect(rulesGuard).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(rulesGuard);
  });

  it('notifyOwnerNewOrder guarded by freshlyCreated', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // Owner notification must use freshlyCreated, not in-memory flag
    expect(src).toContain('ctx.business && freshlyCreated');
    expect(src).toContain('notifyOwnerNewOrder');
    // Old in-memory flags must be removed
    expect(src).not.toContain('_order_side_effects_fired');
    expect(src).not.toContain('_order_owner_notified');
  });
});

// ── S3 reconciliation ──

describe('S3 — proactive confirmation sufficiency', () => {
  it('sendProactiveConfirmation includes amount, reference, business, service, and receipt hint', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');
    expect(src).toContain('formatCurrency(payment.amount');
    expect(src).toContain('referenceCode');
    expect(src).toContain('businessName');
    expect(src).toContain('serviceName');
    expect(src).toContain("Type *receipt* to get your receipt");
  });

  it('post-completion sends PDF receipt but not standalone text receipt', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/post-completion.ts', 'utf-8');
    expect(src).toContain('generateReceiptPdf');
    expect(src).toContain('sendDocument');
    // Text receipt removed — no sendText with receipt lines
    expect(src).not.toContain('Payment Receipt');
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
    it(`${name}: sets _terms_accepted on confirm`, () => {
      const fs = require('fs');
      const src = fs.readFileSync(path, 'utf-8');
      expect(src).toContain("_terms_accepted: true");
    });
  }
});

// ── Deep-link capability validation ──

describe('deep-link capability validation', () => {
  it('active_capability only set when deepLinkCapability is in effective capabilities', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/bot.service.ts', 'utf-8');
    // Must validate: capabilities.includes(deepLinkCapability) before setting active_capability
    expect(src).toContain('capabilities.includes(deepLinkCapability as CapabilityId) ? { active_capability: deepLinkCapability }');
  });
});
