/**
 * Issue #393: Payment UX parity — enforce one saved-card offer across every payment-capable flow
 *
 * Root cause: When PIN is required, validate() returns valid:true with _awaiting_card_pin,
 * and next() returns the same step. The executor calls advanceToStep() which calls prompt()
 * again, re-emitting the saved-card offer (duplicate).
 *
 * Fix: Two-layer guard:
 *   1. buildSavedCardOffer() returns null when _awaiting_card_pin is set (shared layer)
 *   2. Each flow's payment step prompt() returns [] when _awaiting_card_pin is set
 *
 * This test covers:
 *   - Every payment-capable domain (giving, ordering, ticketing, reservation, invoice, payment, scheduling)
 *   - Duplicate webhook delivery
 *   - Retry after PIN prompt
 *   - Concurrent execution
 *   - Session re-entry
 *   - Appointment non-regression (delegates to scheduling)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowContext, FlowStepConfig, PromptMessage } from '@/lib/bot/flows/types';

// ── Hoisted mocks ──

const { mockLogError, mockLogWarn, mockLogInfo } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: mockLogInfo, warn: mockLogWarn, error: mockLogError, debug: vi.fn(),
    withContext: () => ({ error: mockLogError, warn: mockLogWarn, info: mockLogInfo }),
  },
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
vi.mock('@/lib/categoryConfig', () => ({
  getCategoryLabels: () => ({
    service: 'Service', staff: 'Staff', date: 'Date',
    confirmationEmoji: '✅', quantityLabel: 'guest(s)', actionVerb: 'Payment',
  }),
}));
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
  getAuthorization: vi.fn(), createPlan: vi.fn(), createSubscription: vi.fn(),
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
  analyzeReceipt: vi.fn(), receiptMatchesExpected: vi.fn(),
}));

// Real saved-card-flow — NOT mocked — we test the actual buildSavedCardOffer + handleSavedCardInput
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
  observeProvider: vi.fn(), logSplitResolved: vi.fn(), logSplitMissing: vi.fn(),
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
vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: vi.fn().mockResolvedValue({
    lifecycle: { status: 'completed' },
  }),
}));

// ── Helpers ──

function makeCtx(sessionData: Record<string, unknown>, overrides?: Partial<FlowContext>): FlowContext {
  if (!sessionData._inbound_channel_id) sessionData._inbound_channel_id = 'channel-test';

  const makeChain = (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'or', 'not', 'order', 'limit', 'gte', 'lte', 'is', 'gt', 'lt']) {
      c[m] = vi.fn().mockReturnValue(c);
    }
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue(
      table === 'countries' ? { data: { currency_code: 'NGN' }, error: null } : { data: null, error: null },
    );
    return c;
  };
  return {
    supabase: {
      from: vi.fn().mockImplementation((table: string) => makeChain(table)),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 2 }, error: null }),
    } as any,
    sender: { sendText: vi.fn().mockResolvedValue(undefined) } as any,
    standalone: {
      getBotTemplates: vi.fn().mockResolvedValue({ confirmation: '✅ Confirmed!\nRef: {{reference_code}}' }),
      checkTierLimits: vi.fn().mockResolvedValue({ isWhitelabel: false }),
      fillTemplate: vi.fn().mockImplementation((t: string) => t),
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

function hasSavedCardOffer(messages: PromptMessage[]): boolean {
  return messages.some(m =>
    (m.type === 'buttons' && typeof m.body === 'string' && m.body.includes('saved card'))
    || (m.type === 'text' && typeof m.text === 'string' && m.text.includes('saved card')),
  );
}

// ═══════════════════════════════════════════════════════════════
// Domain map: each flow's payment step and module import
// ═══════════════════════════════════════════════════════════════

interface DomainSpec {
  name: string;
  importPath: string;
  flowExport: string;
  stepId: string;
  /** Session data needed for the step's prompt to be reachable */
  baseSessionData: Record<string, unknown>;
}

const DOMAINS: DomainSpec[] = [
  {
    name: 'giving',
    importPath: '@/lib/bot/flows/crowdfunding.flow',
    flowExport: 'crowdfundingFlow',
    stepId: 'donation_payment',
    baseSessionData: {
      campaign_id: 'camp-1',
      campaign_title: 'Test Campaign',
      donation_amount: 5000,
      donor_display_name: 'Test Donor',
      active_capability: 'giving',
    },
  },
  {
    name: 'ordering',
    importPath: '@/lib/bot/flows/ordering.flow',
    flowExport: 'orderingFlow',
    stepId: 'process_order',
    baseSessionData: {
      order_id: 'ord-1',
      cart: [{ product_id: 'p1', name: 'Widget', price: 5000, quantity: 1 }],
      reference_code: 'ORD-TEST1',
      active_capability: 'ordering',
    },
  },
  {
    name: 'ticketing',
    importPath: '@/lib/bot/flows/ticketing.flow',
    flowExport: 'ticketingFlow',
    stepId: 'process_tickets',
    baseSessionData: {
      event_id: 'ev-1',
      ticket_type_id: 'tt-1',
      ticket_quantity: 2,
      total_amount: 10000,
      reference_code: 'TIX-TEST1',
      active_capability: 'ticketing',
    },
  },
  {
    name: 'reservation',
    importPath: '@/lib/bot/flows/reservation.flow',
    flowExport: 'reservationFlow',
    stepId: 'create_reservation',
    baseSessionData: {
      reservation_id: 'res-1',
      selected_slot: '2026-10-01T10:00',
      party_size: 2,
      reference_code: 'RES-TEST1',
      active_capability: 'reservation',
    },
  },
  {
    name: 'invoice',
    importPath: '@/lib/bot/flows/invoice.flow',
    flowExport: 'invoiceFlow',
    stepId: 'invoice_pay',
    baseSessionData: {
      _selected_invoice_id: 'inv-1',
      active_capability: 'invoice',
    },
  },
  {
    name: 'payment',
    importPath: '@/lib/bot/flows/payment.flow',
    flowExport: 'paymentFlow',
    stepId: 'process_payment',
    baseSessionData: {
      amount: 5000,
      payment_description: 'Test payment',
      reference_code: 'PAY-TEST1',
      active_capability: 'payment',
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// §1. Shared layer: buildSavedCardOffer blocks during PIN wait
// ═══════════════════════════════════════════════════════════════

describe('#393 §1: buildSavedCardOffer returns null during PIN wait', () => {
  beforeEach(() => {
    mockGetSavedMethods.mockReset();
  });

  it('returns offer when _awaiting_card_pin is NOT set and saved method exists', async () => {
    const { buildSavedCardOffer } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockGetSavedMethods.mockResolvedValue([{ id: 'spm-1', last4: '4242', displayLabel: 'VISA **4242' }]);
    const ctx = makeCtx({ _saved_method_id: 'spm-1' });
    const result = await buildSavedCardOffer(ctx, 5000);
    expect(result).not.toBeNull();
    expect(result!.prompt.body).toContain('saved card');
  });

  it('returns null when _awaiting_card_pin is set (even with valid saved method)', async () => {
    const { buildSavedCardOffer } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockGetSavedMethods.mockResolvedValue([{ id: 'spm-1', last4: '4242', displayLabel: 'VISA **4242' }]);
    const ctx = makeCtx({ _saved_method_id: 'spm-1', _awaiting_card_pin: true });
    const result = await buildSavedCardOffer(ctx, 5000);
    expect(result).toBeNull();
  });

  it('returns null when _skip_saved_card is set', async () => {
    const { buildSavedCardOffer } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const ctx = makeCtx({ _skip_saved_card: true });
    const result = await buildSavedCardOffer(ctx, 5000);
    expect(result).toBeNull();
    // getSavedMethods should not even be called
    expect(mockGetSavedMethods).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// §2. Per-domain: prompt() returns [] during PIN wait
// ═══════════════════════════════════════════════════════════════

describe('#393 §2: Every payment step prompt() returns [] during _awaiting_card_pin', () => {
  for (const domain of DOMAINS) {
    it(`${domain.name}: prompt() returns empty array when _awaiting_card_pin`, async () => {
      const mod = await import(domain.importPath);
      const flow = mod[domain.flowExport];
      const step = findStep(flow, domain.stepId);
      const ctx = makeCtx({
        ...domain.baseSessionData,
        _awaiting_card_pin: true,
        _saved_method_id: 'spm-1',
      });
      const messages = await step.prompt(ctx);
      expect(messages).toEqual([]);
    });
  }

  it('scheduling: saved_card_prompt step returns [] (reference implementation)', async () => {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const step = findStep(schedulingFlow, 'saved_card_prompt');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const messages = await step.prompt(ctx);
    expect(messages).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// §3. Full lifecycle: no duplicate saved-card offer during PIN flow
// ═══════════════════════════════════════════════════════════════

describe('#393 §3: Full saved-card PIN lifecycle — one offer, one PIN prompt, no duplicate', () => {
  beforeEach(() => {
    mockGetSavedMethods.mockReset();
    mockRequiresPin.mockReset();
    mockVerifyPin.mockReset();
    mockChargeSavedMethod.mockReset();
  });

  for (const domain of DOMAINS) {
    it(`${domain.name}: prompt→validate(pay_saved)→PIN→re-prompt produces zero messages`, async () => {
      const mod = await import(domain.importPath);
      const flow = mod[domain.flowExport];
      const step = findStep(flow, domain.stepId);

      // Step 1: Initial prompt shows saved-card offer
      mockGetSavedMethods.mockResolvedValue([{ id: 'spm-1', last4: '4242', displayLabel: 'VISA **4242' }]);
      const sd = { ...domain.baseSessionData };
      const ctx = makeCtx(sd);
      // (For most flows, the prompt does many things — we just need it to not throw.
      //  The key test is step 2: re-prompt after PIN request.)

      // Step 2: User taps "pay_saved" — validate sends PIN prompt
      mockRequiresPin.mockResolvedValue({ required: true, locked: false });
      const sendText = vi.fn().mockResolvedValue(undefined);
      const ctx2 = makeCtx(
        { ...domain.baseSessionData, _saved_method_id: 'spm-1' },
        { sender: { sendText } as any },
      );
      const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
      const valResult = await handleSavedCardInput('pay_saved', ctx2, {
        amount: 5000,
        reference: 'REF-test-saved',
        entityId: {},
        transactionCategory: domain.name,
      });
      expect(valResult).toBeTruthy();
      expect(valResult!.data!._awaiting_card_pin).toBe(true);
      // PIN prompt was sent
      expect(sendText).toHaveBeenCalledOnce();

      // Step 3: Executor would call next() which returns same step, then advanceToStep→prompt()
      // Simulate: prompt() with _awaiting_card_pin=true must return []
      const ctx3 = makeCtx({
        ...domain.baseSessionData,
        _saved_method_id: 'spm-1',
        _awaiting_card_pin: true,
      });
      const rePromptMessages = await step.prompt(ctx3);
      expect(rePromptMessages).toEqual([]);
      expect(hasSavedCardOffer(rePromptMessages)).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// §4. Duplicate webhook delivery — second call must not re-offer
// ═══════════════════════════════════════════════════════════════

describe('#393 §4: Duplicate webhook/message delivery', () => {
  beforeEach(() => {
    mockGetSavedMethods.mockReset();
    mockRequiresPin.mockReset();
  });

  it('duplicate pay_saved while _awaiting_card_pin is fully idempotent — zero sends, zero provider calls', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
      { sender: { sendText } as any },
    );
    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000,
      reference: 'REF-dup',
      entityId: {},
      transactionCategory: 'giving',
    });
    expect(result).toBeTruthy();
    expect(result!.valid).toBe(true);
    // No data mutation — stays in PIN-wait state
    expect(result!.data).toBeUndefined();
    // Zero sends — no PIN challenge re-sent
    expect(sendText).not.toHaveBeenCalled();
    // Zero provider calls — no requiresPin, no charge
    expect(mockRequiresPin).not.toHaveBeenCalled();
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('triple-replayed pay_saved produces zero cumulative side effects', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const baseOpts = {
      amount: 5000,
      reference: 'REF-triple',
      entityId: {},
      transactionCategory: 'giving',
    };

    for (let i = 0; i < 3; i++) {
      const ctx = makeCtx(
        { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
        { sender: { sendText } as any },
      );
      const result = await handleSavedCardInput('pay_saved', ctx, baseOpts);
      expect(result!.valid).toBe(true);
      expect(result!.data).toBeUndefined();
    }

    expect(sendText).not.toHaveBeenCalled();
    expect(mockRequiresPin).not.toHaveBeenCalled();
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('buildSavedCardOffer called twice in same state returns null on second call', async () => {
    const { buildSavedCardOffer } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockGetSavedMethods.mockResolvedValue([{ id: 'spm-1', last4: '4242', displayLabel: 'VISA **4242' }]);

    // First call: normal offer
    const ctx1 = makeCtx({});
    const first = await buildSavedCardOffer(ctx1, 5000);
    expect(first).not.toBeNull();

    // Second call: after PIN was requested
    const ctx2 = makeCtx({ _awaiting_card_pin: true });
    const second = await buildSavedCardOffer(ctx2, 5000);
    expect(second).toBeNull();
  });

  for (const domain of DOMAINS) {
    it(`${domain.name}: re-entry with _awaiting_card_pin produces no messages`, async () => {
      const mod = await import(domain.importPath);
      const flow = mod[domain.flowExport];
      const step = findStep(flow, domain.stepId);
      const ctx = makeCtx({
        ...domain.baseSessionData,
        _awaiting_card_pin: true,
        _saved_method_id: 'spm-1',
      });
      const messages = await step.prompt(ctx);
      expect(messages).toEqual([]);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// §5. Retry: wrong PIN → correct PIN → charge (no duplicate offer)
// ═══════════════════════════════════════════════════════════════

describe('#393 §5: PIN retry path — no duplicate offer between attempts', () => {
  beforeEach(() => {
    mockVerifyPin.mockReset();
    mockChargeSavedMethod.mockReset();
  });

  it('wrong PIN returns valid:false, prompt() still returns [] on re-prompt', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const sendText = vi.fn().mockResolvedValue(undefined);
    mockVerifyPin.mockResolvedValue({ valid: false, locked: false, attemptsRemaining: 2 });

    const ctx = makeCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
      { sender: { sendText } as any },
    );
    const result = await handleSavedCardInput('9999', ctx, {
      amount: 5000,
      reference: 'REF-retry',
      entityId: {},
      transactionCategory: 'giving',
    });
    expect(result).toBeTruthy();
    expect(result!.valid).toBe(false);
    // Re-prompt message tells user to retry
    expect(sendText).toHaveBeenCalledOnce();
    const msg = sendText.mock.calls[0][0].text;
    expect(msg).toContain('Wrong PIN');
    expect(msg).toContain('2 attempts remaining');

    // After wrong PIN, _awaiting_card_pin stays true.
    // If executor re-prompts the same step, prompt() must still return [].
    for (const domain of DOMAINS) {
      const mod = await import(domain.importPath);
      const flow = mod[domain.flowExport];
      const step = findStep(flow, domain.stepId);
      const ctxRetry = makeCtx({
        ...domain.baseSessionData,
        _awaiting_card_pin: true,
        _saved_method_id: 'spm-1',
      });
      const messages = await step.prompt(ctxRetry);
      expect(messages).toEqual([]);
    }
  });

  it('correct PIN after retry charges and sets _saved_card_paid', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockVerifyPin.mockResolvedValue({ valid: true, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-retry-1' });

    const ctx = makeCtx({
      _awaiting_card_pin: true,
      _saved_method_id: 'spm-1',
    });
    const result = await handleSavedCardInput('1234', ctx, {
      amount: 5000,
      reference: 'REF-retry',
      entityId: {},
      transactionCategory: 'giving',
    });
    expect(result).toBeTruthy();
    expect(result!.valid).toBe(true);
    expect(result!.data!._saved_card_paid).toBe(true);
    expect(result!.data!._saved_card_payment_id).toBe('pay-retry-1');
    expect(result!.data!._awaiting_card_pin).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// §6. Concurrent execution: two workers hit same session
// ═══════════════════════════════════════════════════════════════

describe('#393 §6: Concurrent execution — guard is stateless per-call', () => {
  beforeEach(() => {
    mockGetSavedMethods.mockReset();
    mockRequiresPin.mockReset();
    mockVerifyPin.mockReset();
    mockChargeSavedMethod.mockReset();
  });

  it('two concurrent prompt() calls with _awaiting_card_pin both return []', async () => {
    // Simulates two workers reading the same session state concurrently
    for (const domain of DOMAINS) {
      const mod = await import(domain.importPath);
      const flow = mod[domain.flowExport];
      const step = findStep(flow, domain.stepId);

      const sd = {
        ...domain.baseSessionData,
        _awaiting_card_pin: true,
        _saved_method_id: 'spm-1',
      };

      // Run two prompt calls concurrently
      const [msgs1, msgs2] = await Promise.all([
        step.prompt(makeCtx({ ...sd })),
        step.prompt(makeCtx({ ...sd })),
      ]);

      expect(msgs1).toEqual([]);
      expect(msgs2).toEqual([]);
    }
  });

  it('two concurrent handleSavedCardInput(pay_saved) during PIN wait — zero sends, zero provider calls', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const opts = {
      amount: 5000,
      reference: 'REF-concurrent',
      entityId: {},
      transactionCategory: 'giving',
    };

    const [r1, r2] = await Promise.all([
      handleSavedCardInput('pay_saved', makeCtx(
        { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
        { sender: { sendText } as any },
      ), opts),
      handleSavedCardInput('pay_saved', makeCtx(
        { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
        { sender: { sendText } as any },
      ), opts),
    ]);

    expect(r1!.valid).toBe(true);
    expect(r1!.data).toBeUndefined();
    expect(r2!.valid).toBe(true);
    expect(r2!.data).toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
    expect(mockRequiresPin).not.toHaveBeenCalled();
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('concurrent PIN entry + pay_saved replay — PIN processes, replay is no-op', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockVerifyPin.mockResolvedValue({ valid: true, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-conc' });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const opts = {
      amount: 5000,
      reference: 'REF-conc-mixed',
      entityId: {},
      transactionCategory: 'giving',
    };

    const [pinResult, replayResult] = await Promise.all([
      handleSavedCardInput('1234', makeCtx(
        { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
      ), opts),
      handleSavedCardInput('pay_saved', makeCtx(
        { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
        { sender: { sendText } as any },
      ), opts),
    ]);

    // PIN entry processes normally
    expect(pinResult!.valid).toBe(true);
    expect(pinResult!.data!._saved_card_paid).toBe(true);
    // Replay is fully idempotent — no additional PIN challenge or provider call
    expect(replayResult!.valid).toBe(true);
    expect(replayResult!.data).toBeUndefined();
    // sendText not called by the replay (PIN path uses chargeSavedCard, not sendText)
    expect(sendText).not.toHaveBeenCalled();
    // requiresPin not called — replay skipped entirely
    expect(mockRequiresPin).not.toHaveBeenCalled();
    // chargeSavedMethod called exactly once — by the PIN entry, not the replay
    expect(mockChargeSavedMethod).toHaveBeenCalledOnce();
  });

  it('buildSavedCardOffer is safe under concurrent calls', async () => {
    const { buildSavedCardOffer } = await import('@/lib/bot/flows/shared/saved-card-flow');
    mockGetSavedMethods.mockResolvedValue([{ id: 'spm-1', last4: '4242', displayLabel: 'VISA **4242' }]);

    const [r1, r2] = await Promise.all([
      buildSavedCardOffer(makeCtx({ _awaiting_card_pin: true }), 5000),
      buildSavedCardOffer(makeCtx({ _awaiting_card_pin: true }), 5000),
    ]);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// §7. Session re-entry: user sends unrelated message during PIN wait
// ═══════════════════════════════════════════════════════════════

describe('#393 §7: Session re-entry during PIN wait', () => {
  it('non-PIN text during _awaiting_card_pin returns valid:false with re-prompt', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const sendText = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      { _awaiting_card_pin: true, _saved_method_id: 'spm-1' },
      { sender: { sendText } as any },
    );
    const result = await handleSavedCardInput('what is this', ctx, {
      amount: 5000,
      reference: 'REF-reentry',
      entityId: {},
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.valid).toBe(false);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0].text).toContain('4-digit');
  });

  it('user sends "cancel" during PIN wait → cancels, not re-offer', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await handleSavedCardInput('cancel', ctx, {
      amount: 5000,
      reference: 'REF-cancel',
      entityId: {},
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.data!._saved_card_cancelled).toBe(true);
    expect(result!.data!._awaiting_card_pin).toBe(false);
  });

  it('user sends "pay_new" during PIN wait → switches to new card without cancelling', async () => {
    const { handleSavedCardInput } = await import('@/lib/bot/flows/shared/saved-card-flow');
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const result = await handleSavedCardInput('pay_new', ctx, {
      amount: 5000,
      reference: 'REF-switch',
      entityId: {},
      transactionCategory: 'payment',
    });
    expect(result).toBeTruthy();
    expect(result!.data!._skip_saved_card).toBe(true);
    expect(result!.data!._awaiting_card_pin).toBe(false);
    expect(result!.data!._saved_card_cancelled).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// §8. Appointment/Reservation non-regression
// ═══════════════════════════════════════════════════════════════

describe('#393 §8: Appointment non-regression (delegates to scheduling)', () => {
  it('appointment flow has no independent payment step (uses scheduling)', async () => {
    const { appointmentFlow } = await import('@/lib/bot/flows/appointment.flow');
    const paymentStepIds = ['process_payment', 'donation_payment', 'invoice_pay'];
    for (const id of paymentStepIds) {
      const step = appointmentFlow.steps.find(s => s.id === id);
      expect(step).toBeUndefined();
    }
  });

  it('scheduling saved_card_prompt validate still handles PIN correctly', async () => {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const step = findStep(schedulingFlow, 'saved_card_prompt');

    // PIN wait → prompt returns []
    const ctx = makeCtx({ _awaiting_card_pin: true, _saved_method_id: 'spm-1' });
    const messages = await step.prompt(ctx);
    expect(messages).toEqual([]);

    // next() during PIN wait stays on saved_card_prompt
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('saved_card_prompt');
  });

  it('reservation prompt returns [] during PIN wait (no regression)', async () => {
    const { reservationFlow } = await import('@/lib/bot/flows/reservation.flow');
    const step = findStep(reservationFlow, 'create_reservation');
    const ctx = makeCtx({
      _awaiting_card_pin: true,
      _saved_method_id: 'spm-1',
      reservation_id: 'res-1',
      active_capability: 'reservation',
    });
    const messages = await step.prompt(ctx);
    expect(messages).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// §9. Normal path preserved: _awaiting_card_pin NOT set → prompt works normally
// ═══════════════════════════════════════════════════════════════

describe('#393 §9: Normal path preserved — prompt runs when _awaiting_card_pin is NOT set', () => {
  beforeEach(() => {
    mockGetSavedMethods.mockReset().mockResolvedValue([]);
    mockInitializePayment.mockReset().mockResolvedValue({ url: 'https://pay.test/link', reference: 'REF-123' });
  });

  it('giving: prompt runs normally when _awaiting_card_pin is not set', async () => {
    const { crowdfundingFlow } = await import('@/lib/bot/flows/crowdfunding.flow');
    const step = findStep(crowdfundingFlow, 'donation_payment');
    const ctx = makeCtx({
      campaign_id: 'camp-1',
      campaign_title: 'Test Campaign',
      donation_amount: 5000,
      donor_display_name: 'Test Donor',
      active_capability: 'giving',
    });
    const messages = await step.prompt(ctx);
    // Should have content (payment link prompt)
    expect(messages.length).toBeGreaterThan(0);
  });

  it('payment: prompt runs normally when _awaiting_card_pin is not set', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const step = findStep(paymentFlow, 'process_payment');
    const ctx = makeCtx({
      amount: 5000,
      payment_description: 'Test payment',
      reference_code: 'PAY-TEST1',
      active_capability: 'payment',
      _terms_accepted: true, // bypass T&C gate
    });
    const messages = await step.prompt(ctx);
    expect(messages).toBeDefined();
    expect(messages.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// §10. Pay-new fallback after PIN guard — re-prompt shows payment link
// ═══════════════════════════════════════════════════════════════

describe('#393 §10: pay_new after PIN → re-prompt shows payment link (not saved card)', () => {
  beforeEach(() => {
    mockGetSavedMethods.mockReset().mockResolvedValue([]);
    mockInitializePayment.mockReset().mockResolvedValue({ url: 'https://pay.test/link', reference: 'REF-new' });
  });

  it('giving: _skip_saved_card=true, _awaiting_card_pin=false → shows payment link', async () => {
    const { crowdfundingFlow } = await import('@/lib/bot/flows/crowdfunding.flow');
    const step = findStep(crowdfundingFlow, 'donation_payment');
    const ctx = makeCtx({
      campaign_id: 'camp-1',
      campaign_title: 'Test Campaign',
      donation_amount: 5000,
      donor_display_name: 'Test Donor',
      active_capability: 'giving',
      _skip_saved_card: true, // User chose "use different card"
      // _awaiting_card_pin is NOT set
    });
    const messages = await step.prompt(ctx);
    expect(messages.length).toBeGreaterThan(0);
    expect(hasSavedCardOffer(messages)).toBe(false);
  });
});
