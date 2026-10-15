/**
 * REG-SC-002: PIN lockout regression coverage
 *
 * Proves:
 * 1. requiresPin → { required: true, locked: true } → lockout message, no charge, _skip_saved_card
 * 2. verifyPin → { valid: false, locked: true } → lockout message, no charge, _skip_saved_card + _awaiting_card_pin cleared
 *
 * @see #406 B3a — gap #7
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowContext } from '@/lib/bot/flows/types';

// ── Hoisted mocks (same pattern as saved-card-pin-ux-regression.test.ts) ──
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: (e: unknown) => ({ err: String(e) }),
  normalizeError: (e: unknown) => e instanceof Error ? e : new Error(String(e)),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({})) }));
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
vi.mock('@/lib/bot/flows/shared/user', () => ({ createWhatsAppUser: vi.fn().mockResolvedValue('user-1'), findUserByPhone: vi.fn().mockResolvedValue(null), getCustomerName: vi.fn().mockResolvedValue('Test User') }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/terms', () => ({ getTermsPrompt: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({ notifyOwnerNewPayment: vi.fn().mockResolvedValue(undefined), notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined), notifyOwnerNewTicketSale: vi.fn().mockResolvedValue(undefined), notifyOwnerNewDonation: vi.fn().mockResolvedValue(undefined), notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined), notifyOwnerNewQuoteRequest: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn() }));
vi.mock('@/lib/payments/paystack-recurring', () => ({ getAuthorization: vi.fn(), createPlan: vi.fn(), createSubscription: vi.fn() }));
vi.mock('@/lib/payments/stripe-recurring', () => ({ createRecurringCheckout: vi.fn() }));
vi.mock('@/lib/payments/flutterwave-recurring', () => ({ getCardToken: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/bank-transfer', () => ({ checkBankTransferEligibility: vi.fn().mockResolvedValue({ eligible: false, qualifies: false }), createPendingTransfer: vi.fn(), formatBankTransferBlock: vi.fn(), BANK_ONLY_BUTTONS: [] }));
vi.mock('@/lib/bot/flows/shared/ive-paid-input', () => ({ parseIvePaidInput: vi.fn().mockReturnValue({ recognized: false }), isIvePaidInput: vi.fn(() => false) }));
vi.mock('@/lib/bot/receipt-ocr', () => ({ analyzeReceipt: vi.fn(), receiptMatchesExpected: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/safe-interactive', () => ({ safeButtons: vi.fn((body: string, buttons: unknown[]) => [{ type: 'buttons', body, buttons }]) }));
vi.mock('@/lib/bot/flows/shared/templates', () => ({ getConfirmationMessage: vi.fn(() => 'Confirmed'), getReservationConfirmationMessage: vi.fn(() => 'Reserved'), getTicketConfirmationMessage: vi.fn(() => 'Ticketed'), getOrderConfirmationMessage: vi.fn(() => 'Ordered') }));
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
vi.mock('@/lib/observability', () => ({ observeProvider: vi.fn(), logSplitResolved: vi.fn(), logSplitMissing: vi.fn() }));
vi.mock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn().mockResolvedValue({ feeTotal: 0 }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/capability-guard', () => ({ requireCurrentCapability: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/payments/bot-recovery', () => ({ verifyAndReconcilePayment: vi.fn() }));

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

function makeCtx(sessionData: Record<string, unknown>, overrides?: Partial<FlowContext>): FlowContext {
  if (!sessionData._inbound_channel_id) sessionData._inbound_channel_id = 'channel-test';
  const makeChain = (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'or', 'not', 'order', 'limit']) c[m] = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue(table === 'countries' ? { data: { currency_code: 'NGN' }, error: null } : { data: null, error: null });
    return c;
  };
  return {
    supabase: { from: vi.fn().mockImplementation((table: string) => makeChain(table)), rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 2 }, error: null }) } as any,
    sender: { sendText: vi.fn().mockResolvedValue(undefined) } as any,
    standalone: { getBotTemplates: vi.fn().mockResolvedValue({ confirmation: '✅ Confirmed!\nRef: {{reference_code}}' }), checkTierLimits: vi.fn().mockResolvedValue({ isWhitelabel: false }), fillTemplate: vi.fn().mockImplementation((t: string) => t) } as any,
    intelligence: {} as any,
    from: '+2348012345678',
    session: { id: 'sess-1', user_id: 'user-1', business_id: 'biz-1', current_step: 'test', session_data: sessionData, version: 1 },
    business: { id: 'biz-1', name: 'Test Biz', slug: 'test-biz', category: 'general' as any, flow_type: 'scheduling' as any, subscription_tier: 'growth', trial_ends_at: '', metadata: {}, country_code: 'NG' as any },
    t: async (text: string) => text,
    ...overrides,
  };
}

describe('REG-SC-002: PIN lockout regression', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requiresPin locked=true → lockout message, no charge, _skip_saved_card set', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');

    mockRequiresPin.mockResolvedValue({ required: true, locked: true });

    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _saved_method_id: 'spm-locked-1' },
      { sender: { sendText } as any },
    );

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000,
      reference: 'REF-LOCK-1',
      entityId: { bookingId: 'bk-1' },
      transactionCategory: 'appointment',
    });

    // No charge should occur
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    // Lockout message sent
    expect(sendText).toHaveBeenCalled();
    const msg = sendText.mock.calls[0][0].text;
    expect(msg).toContain('locked');
    expect(msg).toContain('remove card');
    // Session state: skip saved card
    expect(result).toBeTruthy();
    expect(result!.data?._skip_saved_card).toBe(true);
  });

  it('verifyPin locked=true after wrong PIN → lockout message, no charge, PIN wait cleared', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');

    mockVerifyPin.mockResolvedValue({ valid: false, locked: true, attemptsRemaining: 0 });

    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _saved_method_id: 'spm-locked-2', _awaiting_card_pin: true },
      { sender: { sendText } as any },
    );

    const result = await handleSavedCardInput('1234', ctx, {
      amount: 5000,
      reference: 'REF-LOCK-2',
      entityId: { bookingId: 'bk-2' },
      transactionCategory: 'appointment',
    });

    // No charge should occur
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    // Lockout message sent
    expect(sendText).toHaveBeenCalled();
    const msg = sendText.mock.calls[0][0].text;
    expect(msg).toContain('Too many wrong attempts');
    expect(msg).toContain('locked');
    // Session state: skip saved card, PIN wait cleared
    expect(result).toBeTruthy();
    expect(result!.data?._skip_saved_card).toBe(true);
    expect(result!.data?._awaiting_card_pin).toBe(false);
  });
});
