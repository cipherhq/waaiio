/**
 * Saved-card PIN UX regression tests
 *
 * Proves:
 * 1. _awaiting_card_pin prevents premature flow completion (all 5 affected flows)
 * 2. pay_new during PIN wait escapes to standard payment without cancelling
 * 3. Invalid input during PIN wait re-prompts, does not complete flow
 * 4. Cancel during PIN wait cancels the transaction
 * 5. Successful saved-card payment routes correctly
 * 6. PIN copy includes "Waaiio PIN" disambiguation and privacy notice
 * 7. PR #327 CAS/session-terminalization non-regression
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowContext, FlowStepConfig } from '@/lib/bot/flows/types';

// ── Hoisted mocks ──

const { mockLogError, mockLogWarn, mockLogInfo } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: vi.fn(),
    withContext: () => ({ error: mockLogError, warn: mockLogWarn, info: mockLogInfo }),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: (e: unknown) => ({ err: String(e) }),
  normalizeError: (e: unknown) => e instanceof Error ? e : new Error(String(e)),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({})),
}));
vi.mock('@/lib/constants', () => ({
  formatCurrency: (a: number) => `$${a}`,
  getCurrencyCode: () => 'NGN',
  getLocale: () => 'en-NG',
  getMaxQuantity: () => 10,
  BOOKING_DEFAULTS: { maxDaysAhead: 90, minAdvanceHours: 1, slotDuration: 30 },
  generateTimeSlots: vi.fn(() => []),
  getStaffDaySchedule: vi.fn(),
  isStaffAvailable: vi.fn(() => true),
}));
vi.mock('@/lib/categoryConfig', () => ({ getCategoryLabels: () => ({ service: 'Service', staff: 'Staff', date: 'Date', confirmationEmoji: '✅', quantityLabel: 'guest(s)', actionVerb: 'Payment' }) }));
vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('user-1'),
  findUserByPhone: vi.fn().mockResolvedValue(null),
  getCustomerName: vi.fn().mockResolvedValue('Test User'),
}));

const mockInitializePayment = vi.fn();
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: mockInitializePayment }));
vi.mock('@/lib/bot/flows/shared/terms', () => ({ getTermsPrompt: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewPayment: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewTicketSale: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewDonation: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewQuoteRequest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn() }));
vi.mock('@/lib/payments/paystack-recurring', () => ({
  getAuthorization: vi.fn(),
  createPlan: vi.fn(),
  createSubscription: vi.fn(),
}));
vi.mock('@/lib/payments/stripe-recurring', () => ({ createRecurringCheckout: vi.fn() }));
vi.mock('@/lib/payments/flutterwave-recurring', () => ({ getCardToken: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn().mockResolvedValue({ eligible: false, qualifies: false }),
  createPendingTransfer: vi.fn(),
  formatBankTransferBlock: vi.fn(),
  BANK_ONLY_BUTTONS: [],
}));
vi.mock('@/lib/bot/flows/shared/ive-paid-input', () => ({
  parseIvePaidInput: vi.fn().mockReturnValue({ recognized: false }),
  isIvePaidInput: vi.fn(() => false),
}));
vi.mock('@/lib/bot/receipt-ocr', () => ({
  analyzeReceipt: vi.fn(),
  receiptMatchesExpected: vi.fn(),
}));

// Real saved-card-flow — NOT mocked — we test the actual handleSavedCardInput
const mockRequiresPin = vi.fn();
const mockVerifyPin = vi.fn();
const mockGetSavedMethods = vi.fn().mockResolvedValue([]);
const mockChargeSavedMethod = vi.fn();
vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    getSavedMethods: (...args: unknown[]) => mockGetSavedMethods(...args),
    requiresPin: (...args: unknown[]) => mockRequiresPin(...args),
    verifyPin: (...args: unknown[]) => mockVerifyPin(...args),
    chargeSavedMethod: (...args: unknown[]) => mockChargeSavedMethod(...args),
  },
}));

vi.mock('@/lib/bot/flows/shared/safe-interactive', () => ({
  safeButtons: vi.fn((body: string, buttons: unknown[]) => [{ type: 'buttons', body, buttons }]),
}));
vi.mock('@/lib/bot/flows/shared/templates', () => ({
  getConfirmationMessage: vi.fn(() => 'Confirmed'),
  getReservationConfirmationMessage: vi.fn(() => 'Reserved'),
  getTicketConfirmationMessage: vi.fn(() => 'Ticketed'),
  getOrderConfirmationMessage: vi.fn(() => 'Ordered'),
}));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({ sendTicketsAfterPurchase: vi.fn() }));
vi.mock('@/lib/bot/utils/truncate', () => ({ truncTitle: (s: string) => s }));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: vi.fn(() => ''), isWhiteLabel: () => false }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn(() => '') }));
vi.mock('@/lib/observability', () => ({
  observeProvider: vi.fn(),
  logSplitResolved: vi.fn(),
  logSplitMissing: vi.fn(),
}));
vi.mock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn().mockResolvedValue({ feeTotal: 0 }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/capability-guard', () => ({
  requireCurrentCapability: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/payments/bot-recovery', () => ({
  verifyAndReconcilePayment: vi.fn(),
}));

// ── Helpers ──

function makeCtx(sessionData: Record<string, unknown>, overrides?: Partial<FlowContext>): FlowContext {
  return {
    supabase: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 2 }, error: null }),
    } as any,
    sender: { sendText: vi.fn().mockResolvedValue(undefined) } as any,
    standalone: {
      getBotTemplates: vi.fn().mockResolvedValue({ confirmation: '✅ Confirmed!\nRef: {{reference_code}}' }),
      checkTierLimits: vi.fn().mockResolvedValue({ isWhitelabel: false }),
      fillTemplate: vi.fn().mockImplementation((template: string) => template),
    } as any,
    intelligence: {} as any,
    from: '+2348012345678',
    session: {
      id: 'sess-1',
      user_id: 'user-1',
      business_id: 'biz-1',
      current_step: 'test',
      session_data: sessionData,
      version: 1,
    },
    business: {
      id: 'biz-1',
      name: 'Test Biz',
      slug: 'test-biz',
      category: 'general' as any,
      flow_type: 'scheduling' as any,
      subscription_tier: 'growth',
      trial_ends_at: '',
      metadata: {},
      country_code: 'NG' as any,
    },
    t: async (text: string) => text,
    ...overrides,
  };
}

function findStep(flow: { steps: FlowStepConfig[] }, stepId: string): FlowStepConfig {
  const step = flow.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in flow`);
  return step;
}

// ═══════════════════════════════════════════════════════════════
// 1. _awaiting_card_pin prevents premature flow completion
// ═══════════════════════════════════════════════════════════════
describe('Bug 1: _awaiting_card_pin prevents premature flow completion', () => {
  it('payment flow: next() returns process_payment when _awaiting_card_pin', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const step = findStep(paymentFlow, 'process_payment');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await step.next!(ctx);
    expect(result).toBe('process_payment');
  });

  it('ordering flow: next() returns process_order when _awaiting_card_pin', async () => {
    const { orderingFlow } = await import('@/lib/bot/flows/ordering.flow');
    const step = findStep(orderingFlow, 'process_order');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await step.next!(ctx);
    expect(result).toBe('process_order');
  });

  it('reservation flow: next() returns create_reservation when _awaiting_card_pin', async () => {
    const { reservationFlow } = await import('@/lib/bot/flows/reservation.flow');
    const step = findStep(reservationFlow, 'create_reservation');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await step.next!(ctx);
    expect(result).toBe('create_reservation');
  });

  it('ticketing flow: next() returns process_tickets when _awaiting_card_pin', async () => {
    const { ticketingFlow } = await import('@/lib/bot/flows/ticketing.flow');
    const step = findStep(ticketingFlow, 'process_tickets');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await step.next!(ctx);
    expect(result).toBe('process_tickets');
  });

  it('scheduling flow: next() returns saved_card_prompt when _awaiting_card_pin', async () => {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const step = findStep(schedulingFlow, 'saved_card_prompt');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await step.next!(ctx);
    expect(result).toBe('saved_card_prompt');
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. pay_new during PIN wait escapes without cancelling
// ═══════════════════════════════════════════════════════════════
describe('Bug 2: pay_new escape during PIN wait', () => {
  it('shared handleSavedCardInput: pay_new during _awaiting_card_pin sets _skip_saved_card, clears PIN state', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await handleSavedCardInput('pay_new', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.data!._skip_saved_card).toBe(true);
    expect(result!.data!._awaiting_card_pin).toBe(false);
    // Must NOT set _saved_card_cancelled (no transaction cancellation)
    expect(result!.data!._saved_card_cancelled).toBeUndefined();
  });

  it('scheduling flow inline: pay_new during _awaiting_card_pin sets _skip_saved_card', async () => {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const step = findStep(schedulingFlow, 'saved_card_prompt');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await step.validate!('pay_new', ctx);
    expect(result.valid).toBe(true);
    expect(result.data!._skip_saved_card).toBe(true);
    expect(result.data!._awaiting_card_pin).toBe(false);
  });

  it('pay_new during PIN wait does NOT consume a PIN attempt', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    await handleSavedCardInput('pay_new', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(mockVerifyPin).not.toHaveBeenCalled();
    expect(mockRequiresPin).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Invalid input during PIN wait re-prompts
// ═══════════════════════════════════════════════════════════════
describe('Invalid input during PIN wait', () => {
  it('non-numeric text re-prompts with Waaiio PIN copy', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
      { sender: { sendText } as any },
    );
    const result = await handleSavedCardInput('hello', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.valid).toBe(false);
    // Verify the re-prompt uses "Waaiio PIN" copy
    expect(sendText).toHaveBeenCalledOnce();
    const msg = sendText.mock.calls[0][0].text;
    expect(msg).toContain('Waaiio PIN');
    expect(msg).not.toContain('card PIN');
  });

  it('5-digit number is not treated as PIN', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
      { sender: { sendText } as any },
    );
    const result = await handleSavedCardInput('12345', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.valid).toBe(false);
    expect(mockVerifyPin).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Cancel during PIN wait cancels the transaction
// ═══════════════════════════════════════════════════════════════
describe('Cancel during PIN wait', () => {
  it('cancel during _awaiting_card_pin sets _saved_card_cancelled', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await handleSavedCardInput('cancel', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.data!._saved_card_cancelled).toBe(true);
    expect(result!.data!._awaiting_card_pin).toBe(false);
  });

  it('go_back during _awaiting_card_pin also cancels', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await handleSavedCardInput('go_back', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.data!._saved_card_cancelled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Successful saved-card payment routes correctly
// ═══════════════════════════════════════════════════════════════
describe('Successful saved-card payment', () => {
  beforeEach(() => {
    mockRequiresPin.mockReset();
    mockVerifyPin.mockReset();
    mockChargeSavedMethod.mockReset();
  });

  it('pay_saved with no PIN required → charges and sets _saved_card_paid', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-1' });
    const ctx = makeCtx({
      _saved_method_id: 'spm-1',
      amount: 5000,
    });
    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.data!._saved_card_paid).toBe(true);
    expect(result!.data!._saved_card_payment_id).toBe('pay-1');
  });

  it('pay_saved with PIN → prompts PIN with Waaiio copy + privacy notice', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockRequiresPin.mockResolvedValue({ required: true, locked: false });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _saved_method_id: 'spm-1', amount: 5000 },
      { sender: { sendText } as any },
    );
    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.data!._awaiting_card_pin).toBe(true);
    const msg = sendText.mock.calls[0][0].text;
    expect(msg).toContain('Waaiio PIN');
    expect(msg).toContain('not your bank/ATM PIN');
    expect(msg).toContain('delete your PIN message');
  });

  it('correct PIN → charges and sets _saved_card_paid', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockVerifyPin.mockResolvedValue({ valid: true });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-2' });
    const ctx = makeCtx({
      _awaiting_card_pin: true,
      _saved_method_id: 'spm-1',
      amount: 5000,
    });
    const result = await handleSavedCardInput('1234', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.data!._saved_card_paid).toBe(true);
    expect(result!.data!._awaiting_card_pin).toBe(false);
  });

  it('wrong PIN → re-prompts with remaining attempts', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockVerifyPin.mockResolvedValue({ valid: false, attemptsRemaining: 2, locked: false });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1', amount: 5000 },
      { sender: { sendText } as any },
    );
    const result = await handleSavedCardInput('9999', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.valid).toBe(false);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0].text).toContain('2 attempts remaining');
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. PIN creation copy includes Waaiio disambiguation
// ═══════════════════════════════════════════════════════════════
describe('PIN creation copy', () => {
  let savedCardsSource: string;
  beforeEach(async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    savedCardsSource = readFileSync(resolve(__dirname, '../bot/handlers/saved-cards.ts'), 'utf8');
  });

  it('handleSaveCard creation prompt says "Waaiio PIN" and "not your bank/ATM PIN"', () => {
    expect(savedCardsSource).toContain('Waaiio PIN');
    expect(savedCardsSource).toContain('not your bank/ATM PIN');
  });

  it('PIN success confirmation says "Waaiio PIN" and privacy notice', () => {
    expect(savedCardsSource).toContain('Waaiio PIN set successfully');
    expect(savedCardsSource).toContain('delete your PIN message');
  });

  it('PIN validation error says "Waaiio PIN" without example PIN', () => {
    expect(savedCardsSource).toContain('Waaiio PIN:');
    expect(savedCardsSource).not.toContain('e.g. 1234');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. PR #327 CAS / session-terminalization non-regression
// ═══════════════════════════════════════════════════════════════
describe('PR #327 non-regression: nextAfterPrompt CAS still works', () => {
  it('payment flow process_payment: nextAfterPrompt returns await_payment when payment_reference set', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const step = findStep(paymentFlow, 'process_payment');
    expect(step.nextAfterPrompt).toBeDefined();
    const ctx = makeCtx({ payment_reference: 'ref-1' });
    const nap = typeof step.nextAfterPrompt === 'function'
      ? step.nextAfterPrompt(ctx) : step.nextAfterPrompt;
    expect(nap).toBe('await_payment');
  });

  it('payment flow process_payment: nextAfterPrompt returns undefined when no payment_reference (saved-card path)', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const step = findStep(paymentFlow, 'process_payment');
    const ctx = makeCtx({ _saved_method_id: 'spm-1' });
    const nap = typeof step.nextAfterPrompt === 'function'
      ? step.nextAfterPrompt(ctx) : step.nextAfterPrompt;
    expect(nap).toBeUndefined();
  });

  it('session-terminalization module still exports terminalizeOriginatingSession', async () => {
    const mod = await import('@/lib/payments/session-terminalization');
    expect(mod.terminalizeOriginatingSession).toBeTypeOf('function');
  });

  it('scheduling flow create_booking: nextAfterPrompt returns payment when payment_reference set', async () => {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const step = findStep(schedulingFlow, 'create_booking');
    expect(step.nextAfterPrompt).toBeDefined();
    const ctx = makeCtx({ payment_reference: 'ref-1' });
    const nap = typeof step.nextAfterPrompt === 'function'
      ? step.nextAfterPrompt(ctx) : step.nextAfterPrompt;
    expect(nap).toBe('payment');
  });

  it('reservation flow create_reservation: nextAfterPrompt returns reservation_payment when payment_reference set', async () => {
    const { reservationFlow } = await import('@/lib/bot/flows/reservation.flow');
    const step = findStep(reservationFlow, 'create_reservation');
    expect(step.nextAfterPrompt).toBeDefined();
    const ctx = makeCtx({ payment_reference: 'ref-1' });
    const nap = typeof step.nextAfterPrompt === 'function'
      ? step.nextAfterPrompt(ctx) : step.nextAfterPrompt;
    expect(nap).toBe('reservation_payment');
  });

  it('ticketing flow process_tickets: nextAfterPrompt returns await_ticket_payment when payment_reference set', async () => {
    const { ticketingFlow } = await import('@/lib/bot/flows/ticketing.flow');
    const step = findStep(ticketingFlow, 'process_tickets');
    expect(step.nextAfterPrompt).toBeDefined();
    const ctx = makeCtx({ payment_reference: 'ref-1' });
    const nap = typeof step.nextAfterPrompt === 'function'
      ? step.nextAfterPrompt(ctx) : step.nextAfterPrompt;
    expect(nap).toBe('await_ticket_payment');
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. Message-count neutrality: no new standalone messages
// ═══════════════════════════════════════════════════════════════
describe('Message-count neutrality', () => {
  it('PIN prompt is exactly one sendText call (no additional message)', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockRequiresPin.mockResolvedValue({ required: true, locked: false });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _saved_method_id: 'spm-1' },
      { sender: { sendText } as any },
    );
    await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    // Exactly 1 outbound message (the PIN prompt itself)
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('pay_new escape during PIN wait sends zero messages', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
      { sender: { sendText } as any },
    );
    await handleSavedCardInput('pay_new', ctx, {
      amount: 5000,
      reference: 'REF-1-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(sendText).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. Round-trip: validate(pay_new) → merge → next() → prompt()
//    proves saved-card offer is bypassed and normal payment reached
// ═══════════════════════════════════════════════════════════════
describe('Round-trip: pay_new escape reaches normal payment path', () => {
  beforeEach(() => {
    mockGetSavedMethods.mockReset().mockResolvedValue([{ id: 'spm-1', displayLabel: 'VISA ****4242', brandHint: 'visa', last4: '4242', supportsDirectCharge: true }]);
    mockInitializePayment.mockReset().mockResolvedValue({ url: 'https://pay.test/link', reference: 'ref-123' });
  });

  it('payment flow: validate(pay_new) → next() → prompt() calls initializePayment, not buildSavedCardOffer', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const step = findStep(paymentFlow, 'process_payment');

    // Step 1: validate('pay_new') during PIN wait
    const sessionData: Record<string, unknown> = {
      _awaiting_card_pin: true,
      _saved_method_id: 'spm-1',
      amount: 5000,
      service_name: 'Test Service',
      _terms_accepted: true,
      booking_id: 'bk-1',
      reference_code: 'REF-001',
      first_name: 'Test',
    };
    const ctx = makeCtx(sessionData);
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const valResult = await handleSavedCardInput('pay_new', ctx, {
      amount: 5000,
      reference: 'REF-001-saved',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'payment',
    });
    expect(valResult).toBeTruthy();
    expect(valResult!.data!._skip_saved_card).toBe(true);
    expect(valResult!.data!._awaiting_card_pin).toBe(false);

    // Step 2: Executor merges validate data into session_data
    Object.assign(sessionData, valResult!.data);
    expect(sessionData._skip_saved_card).toBe(true);

    // Step 3: next() routes back to process_payment
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('process_payment');

    // Step 4: After next(), _saved_method_id should be deleted but _skip_saved_card retained
    expect(sessionData._saved_method_id).toBeUndefined();
    expect(sessionData._skip_saved_card).toBe(true);

    // Step 5: prompt() — buildSavedCardOffer checks _skip_saved_card and returns null
    const msgs = await step.prompt(ctx);
    // Should NOT have re-offered the saved card — should reach initializePayment
    expect(mockInitializePayment).toHaveBeenCalled();
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('ordering flow: validate(pay_new) → next() retains _skip_saved_card → buildSavedCardOffer returns null', async () => {
    const { orderingFlow } = await import('@/lib/bot/flows/ordering.flow');
    const step = findStep(orderingFlow, 'process_order');

    const sessionData: Record<string, unknown> = {
      _awaiting_card_pin: true,
      _saved_method_id: 'spm-1',
      _terms_accepted: true,
      order_id: 'ord-1',
      reference_code: 'ORD-001',
      order_total: 3000,
      first_name: 'Test',
      items: [],
    };
    const ctx = makeCtx(sessionData);
    const { handleSavedCardInput, buildSavedCardOffer } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const valResult = await handleSavedCardInput('pay_new', ctx, {
      amount: 3000,
      reference: 'ORD-001-saved',
      entityId: { orderId: 'ord-1' },
      transactionCategory: 'ordering',
    });

    Object.assign(sessionData, valResult!.data);
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('process_order');
    expect(sessionData._saved_method_id).toBeUndefined();
    expect(sessionData._skip_saved_card).toBe(true);

    // Prove buildSavedCardOffer is bypassed with _skip_saved_card retained
    const offer = await buildSavedCardOffer(ctx, 3000);
    expect(offer).toBeNull();
  });

  it('reservation flow: validate(pay_new) → next() retains _skip_saved_card → buildSavedCardOffer returns null', async () => {
    const { reservationFlow } = await import('@/lib/bot/flows/reservation.flow');
    const step = findStep(reservationFlow, 'create_reservation');

    const sessionData: Record<string, unknown> = {
      _awaiting_card_pin: true,
      _saved_method_id: 'spm-1',
      _terms_accepted: true,
      reservation_id: 'res-1',
      reference_code: 'RES-001',
      deposit_amount: 2000,
      first_name: 'Test',
    };
    const ctx = makeCtx(sessionData);
    const { handleSavedCardInput, buildSavedCardOffer } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const valResult = await handleSavedCardInput('pay_new', ctx, {
      amount: 2000,
      reference: 'RES-001-saved',
      entityId: { reservationId: 'res-1' },
      transactionCategory: 'reservation',
    });

    Object.assign(sessionData, valResult!.data);
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('create_reservation');
    expect(sessionData._saved_method_id).toBeUndefined();
    expect(sessionData._skip_saved_card).toBe(true);

    const offer = await buildSavedCardOffer(ctx, 2000);
    expect(offer).toBeNull();
  });

  it('ticketing flow: validate(pay_new) → next() retains _skip_saved_card → buildSavedCardOffer returns null', async () => {
    const { ticketingFlow } = await import('@/lib/bot/flows/ticketing.flow');
    const step = findStep(ticketingFlow, 'process_tickets');

    const sessionData: Record<string, unknown> = {
      _awaiting_card_pin: true,
      _saved_method_id: 'spm-1',
      _terms_accepted: true,
      booking_id: 'bk-2',
      reference_code: 'TK-001',
      ticket_total: 1500,
      first_name: 'Test',
    };
    const ctx = makeCtx(sessionData);
    const { handleSavedCardInput, buildSavedCardOffer } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const valResult = await handleSavedCardInput('pay_new', ctx, {
      amount: 1500,
      reference: 'TK-001-saved',
      entityId: { bookingId: 'bk-2' },
      transactionCategory: 'ticketing',
    });

    Object.assign(sessionData, valResult!.data);
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('process_tickets');
    expect(sessionData._saved_method_id).toBeUndefined();
    expect(sessionData._skip_saved_card).toBe(true);

    const offer = await buildSavedCardOffer(ctx, 1500);
    expect(offer).toBeNull();
  });
});
