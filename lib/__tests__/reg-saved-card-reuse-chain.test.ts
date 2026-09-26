/**
 * REG-SC-001: Saved-card second-payment reuse chain
 *
 * Proves the REAL caller handoff: invoice flow prompt() stores _saved_method_id
 * from buildSavedCardOffer, then validate('pay_saved') reaches handleSavedCardInput
 * which charges the exact offered method. No manual _saved_method_id assignment.
 *
 * @see #406 B3a — gap #8
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowContext, FlowStepConfig } from '@/lib/bot/flows/types';

// ── Hoisted mocks ──
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
const mockGetSavedMethods = vi.fn();
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
  const invoiceData = {
    id: 'inv-reuse-1',
    reference_code: 'INV-REUSE',
    total_amount: 5000,
    amount_paid: 0,
    status: 'sent',
    business_id: 'biz-1',
    businesses: { name: 'Test Biz', country_code: 'NG', payment_gateway: null, subscription_tier: 'growth' },
  };
  const makeChain = (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'or', 'not', 'order', 'limit']) c[m] = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue(
      table === 'invoices' ? { data: invoiceData, error: null } : { data: null, error: null },
    );
    c.maybeSingle = vi.fn().mockResolvedValue(
      table === 'countries' ? { data: { currency_code: 'NGN' }, error: null } : { data: null, error: null },
    );
    return c;
  };
  return {
    supabase: { from: vi.fn().mockImplementation((table: string) => makeChain(table)), rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 2 }, error: null }) } as any,
    sender: { sendText: vi.fn().mockResolvedValue(undefined) } as any,
    standalone: { getBotTemplates: vi.fn().mockResolvedValue({ confirmation: '✅ Confirmed!\nRef: {{reference_code}}' }), checkTierLimits: vi.fn().mockResolvedValue({ isWhitelabel: false }), fillTemplate: vi.fn().mockImplementation((t: string) => t) } as any,
    intelligence: {} as any,
    from: '+2348012345678',
    session: { id: 'sess-1', user_id: 'user-1', business_id: 'biz-1', current_step: 'invoice_pay', session_data: sessionData, version: 1 },
    business: { id: 'biz-1', name: 'Test Biz', slug: 'test-biz', category: 'general' as any, flow_type: 'scheduling' as any, subscription_tier: 'growth', trial_ends_at: '', metadata: {}, country_code: 'NG' as any },
    t: async (text: string) => text,
    ...overrides,
  };
}

function findStep(flow: { steps: FlowStepConfig[] }, stepId: string): FlowStepConfig {
  const step = flow.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found`);
  return step;
}

describe('REG-SC-001: Saved-card second-payment reuse chain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invoice prompt() stores offered method ID → validate(pay_saved) charges that exact method', async () => {
    const { invoiceFlow } = await import('@/lib/bot/flows/invoice.flow');
    const step = findStep(invoiceFlow, 'invoice_pay');

    // Adapter returns a previously saved card
    mockGetSavedMethods.mockResolvedValue([
      { id: 'spm-reuse-42', last4: '4242', brand: 'visa', provider: 'stripe' },
    ]);

    // Session starts clean — NO _saved_method_id pre-seeded
    const sessionData: Record<string, unknown> = { _invoice_id: 'inv-reuse-1' };
    const ctx = makeCtx(sessionData);

    // ── Phase 1: Real flow prompt() sets _saved_method_id ──
    await step.prompt!(ctx);

    // Prove the PRODUCTION caller stored the offered method ID — not the test
    expect(sessionData._saved_method_id).toBe('spm-reuse-42');

    // ── Phase 2: Customer selects pay_saved, no PIN required ──
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({
      status: 'charged',
      paymentId: 'pay-reuse-1',
      reference: 'INV-REUSE-saved-test',
    });

    const result = await step.validate!('pay_saved', ctx);

    // Prove the charge used the exact method ID stored by prompt(), not a hardcoded value
    expect(mockChargeSavedMethod).toHaveBeenCalledOnce();
    const chargeOpts = mockChargeSavedMethod.mock.calls[0][1];
    expect(chargeOpts.methodId).toBe('spm-reuse-42');

    // Prove saved-card payment completed
    expect(result).toBeTruthy();
    expect(result.data?._saved_card_paid).toBe(true);
  });
});
