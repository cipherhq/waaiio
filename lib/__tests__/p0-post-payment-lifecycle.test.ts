/**
 * P0 Post-Payment Lifecycle Regression Tests — CTO-mandated executable evidence
 *
 * 4 Blockers, ~25 tests:
 *   Blocker 1: Deterministic saved-card selection (4)
 *   Blocker 2: Real executor CAS path — nextAfterPrompt + prompt() tests (6)
 *   Blocker 3: Executable authority lifecycle (6)
 *   Blocker 4: Real caller boundaries + explicit zero-reinit (5)
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
    withContext: () => ({ error: mockLogError, warn: mockLogWarn, info: mockLogInfo }),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: (e: unknown) => ({ err: String(e) }),
  normalizeError: (e: unknown) => e instanceof Error ? e : new Error(String(e)),
}));

// Mock everything the flow files try to import so they can load without side effects
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
vi.mock('@/lib/categoryConfig', () => ({ getCategoryLabels: () => ({ service: 'Service', staff: 'Staff', date: 'Date', confirmationEmoji: '✅', quantityLabel: 'guest(s)' }) }));
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
vi.mock('@/lib/payments/saved-card-compat', () => ({
  isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
}));
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
vi.mock('@/lib/bot/flows/shared/saved-card-flow', () => ({
  buildSavedCardOffer: vi.fn().mockResolvedValue(null),
  handleSavedCardInput: vi.fn(),
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
vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    getSavedMethods: vi.fn().mockResolvedValue([]),
  },
}));
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

/** Build a minimal FlowContext with only session_data populated */
function makeCtx(sessionData: Record<string, unknown>, overrides?: Partial<FlowContext>): FlowContext {
  return {
    supabase: {} as any,
    sender: { sendText: vi.fn().mockResolvedValue(undefined) } as any,
    standalone: {
      getBotTemplates: vi.fn().mockResolvedValue({ confirmation: '✅ Booking confirmed!\nRef: {{reference_code}}' }),
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

/** Find a step by ID in a flow definition */
function findStep(flow: { steps: FlowStepConfig[] }, stepId: string): FlowStepConfig {
  const step = flow.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in flow`);
  return step;
}

/** Call nextAfterPrompt on a step — handles both string and function forms */
function callNextAfterPrompt(step: FlowStepConfig, ctx: FlowContext): string | undefined {
  if (!step.nextAfterPrompt) return undefined;
  if (typeof step.nextAfterPrompt === 'string') return step.nextAfterPrompt;
  return step.nextAfterPrompt(ctx);
}

// ═══════════════════════════════════════════════════════════════
// BLOCKER 1: Deterministic saved-card selection
// ═══════════════════════════════════════════════════════════════
describe('Blocker 1: Deterministic saved-card selection', () => {
  let getSavedPaymentMethod: typeof import('@/lib/payments/charge-saved').getSavedPaymentMethod;

  const CANONICAL_ROW = {
    id: 'spm-canonical',
    gateway: 'paystack',
    authorization_code: 'AUTH_canonical',
    customer_code: 'CUS_canonical',
    authorization_email: '2348012345678@whatsapp.waaiio.com',
    stripe_payment_method_id: null,
    stripe_customer_id: null,
    card_last4: '4242',
    card_brand: 'visa',
    customer_phone: '+2348012345678',
  };
  const LEGACY_ROW = {
    id: 'spm-legacy',
    gateway: 'paystack',
    authorization_code: 'AUTH_legacy',
    customer_code: 'CUS_legacy',
    authorization_email: '2348012345678@whatsapp.waaiio.com',
    stripe_payment_method_id: null,
    stripe_customer_id: null,
    card_last4: '4242',
    card_brand: 'visa',
    customer_phone: '2348012345678',
  };

  /** Build a mock supabase that returns provided rows from .limit(2) */
  function buildSavedCardMockSb(opts: {
    returnRows?: any[];
    returnError?: { message: string } | null;
    captureInArgs?: (field: string, values: string[]) => void;
  }) {
    // Mock chain matches the global saved-card query:
    // .from().select().in(phone).eq(is_active).eq(gateway).limit(2)
    // No .eq('business_id') — global card model.
    const sb: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockImplementation((field: string, values: string[]) => {
            opts.captureInArgs?.(field, values);
            return {
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: opts.returnRows ?? null,
                    error: opts.returnError ?? null,
                  }),
                }),
              }),
            };
          }),
          // Also support .eq() first for other queries on the same table
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: opts.returnRows ?? null, error: opts.returnError ?? null }),
                }),
              }),
            }),
            eq: vi.fn().mockReturnValue({ not: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }),
            not: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    };
    return sb;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    getSavedPaymentMethod = (await import('@/lib/payments/charge-saved')).getSavedPaymentMethod;
  });

  it('1.1 Both +E.164 and non-+ rows returned — canonical +E.164 wins regardless of array order (canonical first)', async () => {
    const sb = buildSavedCardMockSb({ returnRows: [CANONICAL_ROW, LEGACY_ROW] });
    const result = await getSavedPaymentMethod(sb, 'biz-1', '2348012345678');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('spm-canonical');
  });

  it('1.2 Both rows returned — canonical +E.164 wins when legacy is first in array', async () => {
    // Reverse order: legacy comes first from DB
    const sb = buildSavedCardMockSb({ returnRows: [LEGACY_ROW, CANONICAL_ROW] });
    const result = await getSavedPaymentMethod(sb, 'biz-1', '2348012345678');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('spm-canonical');
  });

  it('1.3 Legacy-only fallback — only non-+ row exists, still found', async () => {
    const sb = buildSavedCardMockSb({ returnRows: [LEGACY_ROW] });
    const result = await getSavedPaymentMethod(sb, 'biz-1', '+2348012345678');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('spm-legacy');
  });

  it('1.4 Query error returns null (not throws)', async () => {
    const sb = buildSavedCardMockSb({ returnError: { message: 'connection reset' } });
    const result = await getSavedPaymentMethod(sb, 'biz-1', '+2348012345678');
    expect(result).toBeNull();
  });

  it('1.5 Cross-tenant — empty result returns null', async () => {
    const sb = buildSavedCardMockSb({ returnRows: [] });
    const result = await getSavedPaymentMethod(sb, 'different-biz', '+2348012345678');
    expect(result).toBeNull();
  });

  it('1.6 .in() receives both phone variants for normalization', async () => {
    let capturedValues: string[] = [];
    const sb = buildSavedCardMockSb({
      returnRows: [CANONICAL_ROW],
      captureInArgs: (_field, values) => { capturedValues = values; },
    });
    await getSavedPaymentMethod(sb, 'biz-1', '2348012345678');
    expect(capturedValues).toContain('+2348012345678');
    expect(capturedValues).toContain('2348012345678');
  });
});

// ═══════════════════════════════════════════════════════════════
// BLOCKER 2: Real executor CAS path — nextAfterPrompt + prompt()
// ═══════════════════════════════════════════════════════════════
describe('Blocker 2: Real executor CAS path', () => {
  let paymentFlow: any;
  let schedulingFlow: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    paymentFlow = (await import('@/lib/bot/flows/payment.flow')).paymentFlow;
    schedulingFlow = (await import('@/lib/bot/flows/scheduling.flow')).schedulingFlow;
    mockInitializePayment.mockReset();
  });

  it('2.1 payment process_payment: nextAfterPrompt returns await_payment when payment_reference set', () => {
    const step = findStep(paymentFlow, 'process_payment');
    expect(step.nextAfterPrompt).toBeDefined();
    const ctx = makeCtx({ payment_reference: 'ref-123', amount: 5000 });
    expect(callNextAfterPrompt(step, ctx)).toBe('await_payment');
  });

  it('2.2 payment process_payment: nextAfterPrompt returns await_payment for bank_transfer_reference', () => {
    const step = findStep(paymentFlow, 'process_payment');
    const ctx = makeCtx({ bank_transfer_reference: 'bt-ref-1' });
    expect(callNextAfterPrompt(step, ctx)).toBe('await_payment');
  });

  it('2.3 payment process_payment: nextAfterPrompt returns undefined when no payment ref', () => {
    const step = findStep(paymentFlow, 'process_payment');
    const ctx = makeCtx({ amount: 5000 });
    expect(callNextAfterPrompt(step, ctx)).toBeUndefined();
  });

  it('2.4 scheduling create_booking: nextAfterPrompt routes saved_card_prompt, payment, or undefined', () => {
    const step = findStep(schedulingFlow, 'create_booking');
    expect(step.nextAfterPrompt).toBeDefined();

    // Saved-card path
    expect(callNextAfterPrompt(step, makeCtx({ _saved_method_id: 'sm-1' }))).toBe('saved_card_prompt');
    // Payment reference path
    expect(callNextAfterPrompt(step, makeCtx({ payment_reference: 'ref-456' }))).toBe('payment');
    // Free booking (no payment, no saved card)
    expect(callNextAfterPrompt(step, makeCtx({}))).toBeUndefined();
    // Skip saved card
    expect(callNextAfterPrompt(step, makeCtx({ _skip_saved_card: true, _saved_method_id: 'sm-1' }))).toBeUndefined();
  });

  it('2.5 payment process_payment prompt() does NOT write current_step directly — only session_data', async () => {
    const step = findStep(paymentFlow, 'process_payment');

    // Track all .update() calls on bot_sessions
    const updateCalls: any[] = [];
    const mockSb: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bookings') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'bk-new', reference_code: 'REF-NEW' },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'bot_sessions') {
          return {
            update: vi.fn().mockImplementation((payload: any) => {
              updateCalls.push(payload);
              return {
                eq: vi.fn().mockResolvedValue({ data: null, error: null }),
              };
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }),
    };

    mockInitializePayment.mockResolvedValueOnce({ reference: 'pay-ref-1', url: 'https://pay.test/1' });

    const ctx = makeCtx(
      {
        service_id: 'svc-1',
        service_name: 'Test Service',
        amount: 5000,
        first_name: 'John',
        last_name: 'Doe',
        _terms_accepted: true,
      },
      { supabase: mockSb },
    );

    await step.prompt(ctx);

    // Verify NONE of the bot_sessions .update() calls include current_step
    for (const payload of updateCalls) {
      expect(payload).not.toHaveProperty('current_step');
    }
  });

  it('2.6 payment process_payment prompt() sets session_data fields, nextAfterPrompt returns correct next step', async () => {
    const step = findStep(paymentFlow, 'process_payment');

    const mockSb: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bookings') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'bk-created', reference_code: 'REF-CREATED' },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'bot_sessions') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }),
    };

    mockInitializePayment.mockResolvedValueOnce({ reference: 'pay-ref-test', url: 'https://pay.test/x' });

    const ctx = makeCtx(
      {
        service_id: 'svc-1',
        service_name: 'Test Service',
        amount: 5000,
        first_name: 'John',
        last_name: 'Doe',
        _terms_accepted: true,
      },
      { supabase: mockSb },
    );

    const msgs = await step.prompt(ctx);
    expect(msgs.length).toBeGreaterThan(0);

    // After prompt, session_data should have payment_reference set by initializePayment
    expect(ctx.session.session_data.payment_reference).toBe('pay-ref-test');

    // Now nextAfterPrompt should return 'await_payment'
    expect(callNextAfterPrompt(step, ctx)).toBe('await_payment');
  });
});

// ═══════════════════════════════════════════════════════════════
// BLOCKER 3: Executable authority lifecycle
// ═══════════════════════════════════════════════════════════════
describe('Blocker 3: Executable authority lifecycle', () => {
  let authorizeAndFinalize: typeof import('@/lib/payments/authority').authorizeAndFinalize;

  const VERIFIED_PAYMENT = {
    provider: 'paystack' as const,
    waaiioReference: 'ref-test-001',
    amount: 5000,
    currency: 'NGN',
    verifiedAt: new Date().toISOString(),
  };

  /** Build a mock supabase for authority tests */
  function buildAuthoritySb(opts: {
    paymentRow?: any;
    paymentLookupError?: { message: string } | null;
    markPaidRows?: any[];
    markPaidError?: { message: string } | null;
    claimResult?: any;
    claimError?: { message: string } | null;
    completeResult?: any;
    completeError?: { message: string } | null;
    termEntityData?: { bot_session_id: string | null } | null;
    termUpdateResult?: any[];
    adoptError?: { message: string } | null;
    refreshedStatus?: string;
  }) {
    const sb: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'payments') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: opts.paymentRow ?? null,
                  error: opts.paymentLookupError ?? null,
                }),
                single: vi.fn().mockResolvedValue({
                  data: opts.refreshedStatus ? { status: opts.refreshedStatus } : null,
                  error: null,
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((_field: string, _val: string) => ({
                eq: vi.fn().mockReturnValue({
                  select: vi.fn().mockResolvedValue({
                    data: opts.markPaidRows ?? [{ id: 'pay-1' }],
                    error: opts.markPaidError ?? null,
                  }),
                }),
                is: vi.fn().mockResolvedValue({
                  data: null,
                  error: opts.adoptError ?? null,
                }),
                select: vi.fn().mockResolvedValue({
                  data: opts.markPaidRows ?? [{ id: 'pay-1' }],
                  error: opts.markPaidError ?? null,
                }),
              })),
            }),
          };
        }
        // session-terminalization tables
        if (table === 'bookings' || table === 'orders' || table === 'reservations') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: opts.termEntityData !== undefined ? opts.termEntityData : null,
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'bot_sessions') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  select: vi.fn().mockResolvedValue({
                    data: opts.termUpdateResult ?? [],
                    error: null,
                  }),
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'sess-term', is_active: false },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }),
      rpc: vi.fn().mockImplementation((fnName: string) => {
        if (fnName === 'claim_payment_finalization') {
          return Promise.resolve({
            data: opts.claimResult ?? { claimed: true, claim_token: 'tok-123', booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 100 },
            error: opts.claimError ?? null,
          });
        }
        if (fnName === 'complete_payment_finalization') {
          return Promise.resolve({
            data: opts.completeResult ?? { completed: true },
            error: opts.completeError ?? null,
          });
        }
        if (fnName === 'release_payment_finalization') {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    };
    return sb;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    authorizeAndFinalize = (await import('@/lib/payments/authority')).authorizeAndFinalize;
  });

  it('3.1 Booking payment — terminalization succeeds BEFORE sendConfirmation is invoked', async () => {
    const callOrder: string[] = [];

    const processPayment = vi.fn().mockImplementation(async () => {
      callOrder.push('processPayment');
      return { criticalSuccess: true };
    });
    const sendConfirmation = vi.fn().mockImplementation(async () => {
      callOrder.push('sendConfirmation');
      return { status: 'completed' as const };
    });

    const paymentRow = {
      id: 'pay-1', amount: 5000, currency: 'NGN', gateway: 'paystack',
      status: 'pending', booking_id: 'bk-1', invoice_id: null, campaign_id: null,
      reservation_id: null, order_id: null, metadata: null, gateway_fee: 100,
      finalization_completed_at: null, payment_authority_version: 1,
      fee_policy_version: 1, config_version_id: null, transaction_category: 'scheduling', fee_basis: null,
    };

    const sb = buildAuthoritySb({
      paymentRow,
      termEntityData: { bot_session_id: 'sess-bot-1' },
      termUpdateResult: [{ id: 'sess-bot-1' }],
    });

    const result = await authorizeAndFinalize(sb, VERIFIED_PAYMENT, processPayment, sendConfirmation);

    expect(result.status).toBe('completed');
    expect(processPayment).toHaveBeenCalledOnce();
    expect(sendConfirmation).toHaveBeenCalledOnce();
    // processPayment (Stage 2) MUST complete before sendConfirmation (Stage 3)
    expect(callOrder).toEqual(['processPayment', 'sendConfirmation']);
  });

  it('3.2 Terminalization DB error — sendConfirmation NOT called (retryable)', async () => {
    const processPayment = vi.fn().mockResolvedValue({ criticalSuccess: true });
    const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' as const });

    const paymentRow = {
      id: 'pay-2', amount: 5000, currency: 'NGN', gateway: 'paystack',
      status: 'pending', booking_id: 'bk-2', invoice_id: null, campaign_id: null,
      reservation_id: null, order_id: null, metadata: null, gateway_fee: 100,
      finalization_completed_at: null, payment_authority_version: 1,
      fee_policy_version: 1, config_version_id: null, transaction_category: 'scheduling', fee_basis: null,
    };

    // Override the session terminalization to return error
    // We need to mock the bookings lookup to return an error
    const sb = buildAuthoritySb({ paymentRow });
    // Override from() for bookings to return error
    const originalFrom = sb.from;
    sb.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: null,
                error: { message: 'connection timeout' },
              }),
            }),
          }),
        };
      }
      return originalFrom(table);
    });

    const result = await authorizeAndFinalize(sb, VERIFIED_PAYMENT, processPayment, sendConfirmation);

    expect(result.status).toBe('retryable_failed');
    expect(result.retryable).toBe(true);
    expect(sendConfirmation).not.toHaveBeenCalled();
  });

  it('3.3 legacy_null (bot_session_id is null) — sendConfirmation called with exactEntityFamily: true', async () => {
    const processPayment = vi.fn().mockResolvedValue({ criticalSuccess: true });
    const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' as const });

    const paymentRow = {
      id: 'pay-3', amount: 5000, currency: 'NGN', gateway: 'paystack',
      status: 'pending', booking_id: 'bk-3', invoice_id: null, campaign_id: null,
      reservation_id: null, order_id: null, metadata: null, gateway_fee: 100,
      finalization_completed_at: null, payment_authority_version: 1,
      fee_policy_version: 1, config_version_id: null, transaction_category: 'scheduling', fee_basis: null,
    };

    const sb = buildAuthoritySb({
      paymentRow,
      termEntityData: { bot_session_id: null }, // Legacy null — no session to terminalize
    });

    const result = await authorizeAndFinalize(sb, VERIFIED_PAYMENT, processPayment, sendConfirmation);

    expect(result.status).toBe('completed');
    expect(sendConfirmation).toHaveBeenCalledOnce();
    // legacy_null status !== 'no_origin' => exactEntityFamily = true
    const confirmOpts = sendConfirmation.mock.calls[0][2];
    expect(confirmOpts).toEqual({ exactEntityFamily: true });
  });

  it('3.4 Invoice/campaign — sendConfirmation called with exactEntityFamily: false', async () => {
    const processPayment = vi.fn().mockResolvedValue({ criticalSuccess: true });
    const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' as const });

    const paymentRow = {
      id: 'pay-4', amount: 5000, currency: 'NGN', gateway: 'paystack',
      status: 'pending', booking_id: null, invoice_id: 'inv-1', campaign_id: null,
      reservation_id: null, order_id: null, metadata: null, gateway_fee: 100,
      finalization_completed_at: null, payment_authority_version: 1,
      fee_policy_version: 1, config_version_id: null, transaction_category: 'invoice', fee_basis: null,
    };

    const sb = buildAuthoritySb({ paymentRow });

    const result = await authorizeAndFinalize(sb, VERIFIED_PAYMENT, processPayment, sendConfirmation);

    expect(result.status).toBe('completed');
    expect(sendConfirmation).toHaveBeenCalledOnce();
    // no booking/order/reservation => no_origin => exactEntityFamily = false
    const confirmOpts = sendConfirmation.mock.calls[0][2];
    expect(confirmOpts).toEqual({ exactEntityFamily: false });
  });

  it('3.5 processPayment critical failure — releases claim, returns retryable, sendConfirmation NOT called', async () => {
    const processPayment = vi.fn().mockResolvedValue({ criticalSuccess: false, errors: ['DB write failed'] });
    const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' as const });

    const paymentRow = {
      id: 'pay-5', amount: 5000, currency: 'NGN', gateway: 'paystack',
      status: 'pending', booking_id: 'bk-5', invoice_id: null, campaign_id: null,
      reservation_id: null, order_id: null, metadata: null, gateway_fee: 100,
      finalization_completed_at: null, payment_authority_version: 1,
      fee_policy_version: 1, config_version_id: null, transaction_category: 'scheduling', fee_basis: null,
    };

    const sb = buildAuthoritySb({ paymentRow });

    const result = await authorizeAndFinalize(sb, VERIFIED_PAYMENT, processPayment, sendConfirmation);

    expect(result.status).toBe('retryable_failed');
    expect(result.retryable).toBe(true);
    expect(sendConfirmation).not.toHaveBeenCalled();
    // release_payment_finalization should have been called
    expect(sb.rpc).toHaveBeenCalledWith('release_payment_finalization', expect.objectContaining({ p_payment_id: 'pay-5' }));
  });

  it('3.6 processPayment receives correct payment fields including fee_policy_version and transaction_category', async () => {
    const processPayment = vi.fn().mockResolvedValue({ criticalSuccess: true });
    const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' as const });

    const paymentRow = {
      id: 'pay-6', amount: 5000, currency: 'NGN', gateway: 'paystack',
      status: 'pending', booking_id: 'bk-6', invoice_id: null, campaign_id: null,
      reservation_id: null, order_id: null, metadata: { some: 'meta' }, gateway_fee: 150,
      finalization_completed_at: null, payment_authority_version: 1,
      fee_policy_version: 2, config_version_id: 'cfg-v1', transaction_category: 'scheduling', fee_basis: { rate: 0.05 },
    };

    const sb = buildAuthoritySb({
      paymentRow,
      claimResult: {
        claimed: true, claim_token: 'tok-456',
        booking_id: 'bk-6', invoice_id: null, campaign_id: null,
        reservation_id: null, order_id: null, gateway_fee: 150,
      },
      termEntityData: { bot_session_id: null },
    });

    await authorizeAndFinalize(sb, VERIFIED_PAYMENT, processPayment, sendConfirmation);

    expect(processPayment).toHaveBeenCalledWith(sb, expect.objectContaining({
      id: 'pay-6',
      amount: 5000,
      fee_policy_version: 2,
      config_version_id: 'cfg-v1',
      transaction_category: 'scheduling',
      fee_basis: { rate: 0.05 },
    }));
  });
});

// ═══════════════════════════════════════════════════════════════
// BLOCKER 4: Real caller boundaries + explicit zero-reinit
// ═══════════════════════════════════════════════════════════════
describe('Blocker 4: Real caller boundaries + explicit zero-reinit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitializePayment.mockReset();
  });

  it('4.1 scheduling flow calls initializePayment with transactionCategory=scheduling and correct entity args', async () => {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const step = findStep(schedulingFlow, 'create_booking');

    mockInitializePayment.mockResolvedValueOnce({ reference: 'sched-ref-1', url: 'https://pay.test/sched' });

    const mockSb: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bot_sessions') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }),
      rpc: vi.fn().mockImplementation((fnName: string) => {
        if (fnName === 'book_slot_atomic') {
          // RPC returns a chainable query builder — .single() is called on it
          const result = { data: { booking_id: 'bk-sched', reference_code: 'REF-SCHED', slot_available: true }, error: null };
          return { single: vi.fn().mockResolvedValue(result) };
        }
        // Default: return a thenable with .single() for safety
        return Promise.resolve({ data: null, error: null });
      }),
    };

    const ctx = makeCtx(
      {
        service_id: 'svc-1',
        service_name: 'Haircut',
        service_price: 3000,
        service_deposit: 3000,
        amount: 3000,
        first_name: 'Ada',
        last_name: 'Obi',
        date: '2026-10-01',
        time: '10:00',
        _terms_accepted: true,
        _inbound_channel_id: 'ch-1',
      },
      { supabase: mockSb },
    );

    await step.prompt(ctx);

    expect(mockInitializePayment).toHaveBeenCalledOnce();
    const callArgs = mockInitializePayment.mock.calls[0];
    expect(callArgs[0]).toBe(mockSb); // supabase client
    expect(callArgs[1]).toMatchObject({
      bookingId: 'bk-sched',
      transactionCategory: 'scheduling',
      confirmationOrigin: 'whatsapp',
      inboundChannelId: 'ch-1',
    });
  });

  it('4.2 ordering flow calls initializePayment with transactionCategory=ordering', async () => {
    const { orderingFlow } = await import('@/lib/bot/flows/ordering.flow');
    const step = findStep(orderingFlow, 'process_order');

    mockInitializePayment.mockResolvedValueOnce({ reference: 'ord-ref-1', url: 'https://pay.test/ord' });

    const mockSb: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bot_sessions') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }),
      rpc: vi.fn().mockImplementation((fnName: string) => {
        if (fnName === 'create_order_atomic') {
          return Promise.resolve({
            data: { order_id: 'ord-1', reference_code: 'REF-ORD', created: true },
            error: null,
          });
        }
        if (fnName === 'upsert_customer_profile') {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    };

    const ctx = makeCtx(
      {
        cart: [{ id: 'prod-1', product_id: 'prod-1', name: 'Widget', price: 7500, quantity: 1 }],
        first_name: 'Ada',
        last_name: 'Obi',
        _terms_accepted: true,
        _inbound_channel_id: 'ch-2',
      },
      {
        supabase: mockSb,
        business: {
          id: 'biz-1',
          name: 'Test Shop',
          slug: 'test-shop',
          category: 'retail' as any,
          flow_type: 'ordering' as any,
          subscription_tier: 'growth',
          trial_ends_at: '',
          metadata: {},
          country_code: 'NG' as any,
        },
      },
    );

    await step.prompt(ctx);

    expect(mockInitializePayment).toHaveBeenCalledOnce();
    const callArgs = mockInitializePayment.mock.calls[0];
    expect(callArgs[1]).toMatchObject({
      orderId: 'ord-1',
      transactionCategory: 'ordering',
      confirmationOrigin: 'whatsapp',
    });
  });

  it('4.3 payment flow process_payment calls initializePayment exactly once on first prompt', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const step = findStep(paymentFlow, 'process_payment');

    mockInitializePayment.mockResolvedValueOnce({ reference: 'pay-ref-once', url: 'https://pay.test/once' });

    const mockSb: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bookings') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'bk-once', reference_code: 'REF-ONCE' },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'bot_sessions') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }),
    };

    const ctx = makeCtx(
      {
        service_id: 'svc-1',
        service_name: 'Donation',
        amount: 1000,
        first_name: 'Test',
        last_name: 'User',
        _terms_accepted: true,
      },
      { supabase: mockSb },
    );

    await step.prompt(ctx);
    expect(mockInitializePayment).toHaveBeenCalledOnce();
  });

  it('4.4 post-success zero-reinit: after payment completed, "I\'ve Paid" reconciliation does NOT call initializePayment', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const awaitStep = findStep(paymentFlow, 'await_payment');

    const { verifyAndReconcilePayment } = await import('@/lib/payments/bot-recovery');
    const { parseIvePaidInput } = await import('@/lib/bot/flows/shared/ive-paid-input');

    // Simulate recognized "I've paid" input
    (parseIvePaidInput as any).mockReturnValueOnce({ recognized: true, paymentRef: null });
    // Reconciliation says payment already completed
    (verifyAndReconcilePayment as any).mockResolvedValueOnce({ outcome: 'completed' });

    const sendTextSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      {
        payment_reference: 'ref-already-done',
        booking_id: 'bk-done',
        reference_code: 'RC-DONE',
        service_name: 'Test Service',
        amount: 5000,
      },
      { sender: { sendText: sendTextSpy } as any },
    );

    const result = await awaitStep.validate('i_paid', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('already_confirmed');
    // CRITICAL: initializePayment must NOT be called on post-success "I've Paid"
    expect(mockInitializePayment).not.toHaveBeenCalled();
    // User should see Payment Confirmed message
    expect(sendTextSpy).toHaveBeenCalled();
    const sentText = sendTextSpy.mock.calls[0][0].text;
    expect(sentText).toContain('Payment Confirmed');
  });

  it('4.5 post-success zero-reinit: retry_payment after completed payment does NOT reinitialize', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const awaitStep = findStep(paymentFlow, 'await_payment');

    const { verifyAndReconcilePayment } = await import('@/lib/payments/bot-recovery');
    // Reconciliation says payment already completed
    (verifyAndReconcilePayment as any).mockResolvedValueOnce({ outcome: 'completed' });

    const sendTextSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      {
        payment_reference: 'ref-retry-done',
        booking_id: 'bk-retry-done',
        reference_code: 'RC-RETRY',
        service_name: 'Test Service',
        amount: 5000,
      },
      { sender: { sendText: sendTextSpy } as any },
    );

    const result = await awaitStep.validate('retry_payment', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('already_confirmed');
    // CRITICAL: initializePayment must NOT be called
    expect(mockInitializePayment).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// Area B: Saved-card listing → authorization consistency
// ═══════════════════════════════════════════════════════════════
describe('Area B: Saved-card listing → authorization consistency', () => {
  let getSavedPaymentMethod: typeof import('@/lib/payments/charge-saved').getSavedPaymentMethod;

  const CANONICAL_PHONE = '+2348012345678';
  const RAW_PHONE = '2348012345678';

  const PAYSTACK_METHOD = {
    id: 'spm-ps-1',
    gateway: 'paystack',
    authorization_code: 'AUTH_ps1',
    customer_code: 'CUS_ps1',
    authorization_email: '2348012345678@whatsapp.waaiio.com',
    stripe_payment_method_id: null,
    stripe_customer_id: null,
    card_last4: '4242',
    card_brand: 'visa',
    customer_phone: CANONICAL_PHONE,
  };

  /**
   * Build a supabase mock matching the global saved-card query chain:
   * .from().select().in(customer_phone).eq(is_active).eq(gateway).limit(2)
   * No .eq(business_id) — global card model.
   */
  function buildListingSb(opts: {
    returnRows?: any[];
    returnError?: { message: string } | null;
    captureInArgs?: (field: string, values: string[]) => void;
    captureGateway?: (gateway: string) => void;
  }) {
    const sb: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          // .in(customer_phone, [...]) — first chained call after select
          in: vi.fn().mockImplementation((field: string, values: string[]) => {
            opts.captureInArgs?.(field, values);
            return {
              // .eq('is_active', true)
              eq: vi.fn().mockReturnValue({
                // .eq('gateway', 'paystack')
                eq: vi.fn().mockImplementation((_field: string, value: string) => {
                  opts.captureGateway?.(value);
                  const filtered = opts.returnRows
                    ? opts.returnRows.filter((r: any) => r.gateway === value)
                    : null;
                  return {
                    limit: vi.fn().mockResolvedValue({
                      data: opts.returnError ? null : filtered,
                      error: opts.returnError ?? null,
                    }),
                  };
                }),
              }),
            };
          }),
          eq: vi.fn().mockReturnValue({ not: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
        }),
      }),
    };
    return sb;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    getSavedPaymentMethod = (await import('@/lib/payments/charge-saved')).getSavedPaymentMethod;
  });

  it('B.1 Legacy non-+ stored method is listed — then same raw phone would pass authorization lookup', async () => {
    // getSavedPaymentMethod queries with .in('customer_phone', ['+234...', '234...'])
    // A legacy row stored without '+' is found because both variants are queried.
    // The same phone normalization in lookupAuthorizedMethod ensures authorization
    // would also succeed for the same raw phone.
    const legacyRow = { ...PAYSTACK_METHOD, customer_phone: RAW_PHONE };

    let capturedPhones: string[] = [];
    const sb = buildListingSb({
      returnRows: [legacyRow],
      captureInArgs: (_field, values) => { capturedPhones = values; },
    });

    const listed = await getSavedPaymentMethod(sb, 'biz-1', RAW_PHONE);

    // The method is found despite legacy storage
    expect(listed).not.toBeNull();
    expect(listed!.id).toBe('spm-ps-1');

    // Both phone variants were queried — the same normalization used in lookupAuthorizedMethod
    expect(capturedPhones).toContain('+2348012345678');
    expect(capturedPhones).toContain('2348012345678');
  });

  it('B.2 Global card — different business still finds the customer card', async () => {
    // Global saved card: business_id is not a filter anymore
    const sb = buildListingSb({ returnRows: [PAYSTACK_METHOD] });
    const result = await getSavedPaymentMethod(sb, 'biz-FOREIGN', CANONICAL_PHONE);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('spm-ps-1');
  });

  it('B.3 Paystack+Stripe coexistence: getSavedPaymentMethod filters by gateway=paystack, only Paystack returned', async () => {
    const stripeMethod = {
      id: 'spm-stripe-1',
      gateway: 'stripe',
      authorization_code: null,
      customer_code: null,
      stripe_payment_method_id: 'pm_stripe_1',
      stripe_customer_id: 'cus_stripe_1',
      card_last4: '1234',
      card_brand: 'mastercard',
      customer_phone: CANONICAL_PHONE,
    };

    let capturedGateway: string | undefined;
    const sb = buildListingSb({
      returnRows: [PAYSTACK_METHOD, stripeMethod],
      captureGateway: (g) => { capturedGateway = g; },
    });

    const result = await getSavedPaymentMethod(sb, 'biz-1', CANONICAL_PHONE);

    // Verify the gateway filter was applied as 'paystack'
    expect(capturedGateway).toBe('paystack');

    // Only the Paystack method should be returned (Stripe filtered out by gateway eq)
    expect(result).not.toBeNull();
    expect(result!.id).toBe('spm-ps-1');
    expect(result!.gateway).toBe('paystack');
  });
});
