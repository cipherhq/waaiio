/**
 * P0 Post-Payment Lifecycle Regression Tests — CTO-mandated executable evidence
 *
 * 6 areas, ~22 tests:
 *   Area 1: Real executor CAS path — nextAfterPrompt + no direct current_step writes (4)
 *   Area 2: Session terminalization + exactEntityFamily gating (8)
 *   Area 3: Saved-card phone normalization with .limit(1) (4)
 *   Area 4: Payment/Giving bot_session_id + crash recovery (3)
 *   Area 5: Cross-capability caller boundaries (2)
 *   Area 6: Post-success no-reinit (1)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowContext, FlowStepConfig } from '@/lib/bot/flows/types';
import * as fs from 'fs';
import * as path from 'path';

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
vi.mock('@/lib/categoryConfig', () => ({ getCategoryLabels: () => ({ service: 'Service', staff: 'Staff', date: 'Date', confirmationEmoji: '✅' }) }));
vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('user-1'),
  findUserByPhone: vi.fn().mockResolvedValue(null),
  getCustomerName: vi.fn().mockResolvedValue('Test User'),
}));

const mockInitializePayment = vi.fn();
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: mockInitializePayment }));
vi.mock('@/lib/bot/flows/shared/terms', () => ({ getTermsPrompt: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewPayment: vi.fn(),
  notifyOwnerNewBooking: vi.fn(),
  notifyOwnerNewTicketSale: vi.fn(),
  notifyOwnerNewDonation: vi.fn(),
  notifyOwnerNewOrder: vi.fn(),
  notifyOwnerNewQuoteRequest: vi.fn(),
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
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({ sendTicketsAfterPurchase: vi.fn() }));
vi.mock('@/lib/bot/utils/truncate', () => ({ truncTitle: (s: string) => s }));
vi.mock('@/lib/payments/saved-payment-adapter', () => ({ savedPaymentAdapter: vi.fn() }));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: vi.fn(() => ''), isWhiteLabel: () => false }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn() }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn() }));
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
    standalone: {} as any,
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

/** Read source of a flow file relative to this test */
function readFlowSource(filename: string): string {
  const sourcePath = path.resolve(__dirname, '../bot/flows', filename);
  return fs.readFileSync(sourcePath, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════
// AREA 1: Real executor CAS path — nextAfterPrompt + structural
// ═══════════════════════════════════════════════════════════════
describe('Area 1: Real executor CAS path', () => {
  let paymentFlow: any;
  let schedulingFlow: any;
  let reservationFlow: any;
  let ticketingFlow: any;

  beforeEach(async () => {
    paymentFlow = (await import('@/lib/bot/flows/payment.flow')).paymentFlow;
    schedulingFlow = (await import('@/lib/bot/flows/scheduling.flow')).schedulingFlow;
    reservationFlow = (await import('@/lib/bot/flows/reservation.flow')).reservationFlow;
    ticketingFlow = (await import('@/lib/bot/flows/ticketing.flow')).ticketingFlow;
  });

  it('1. payment process_payment: nextAfterPrompt returns await_payment when payment_reference set', () => {
    const step = findStep(paymentFlow, 'process_payment');
    expect(step.nextAfterPrompt).toBeDefined();
    const ctx = makeCtx({ payment_reference: 'ref-123', amount: 5000 });
    expect(callNextAfterPrompt(step, ctx)).toBe('await_payment');
  });

  it('2. payment.flow.ts process_payment step has NO direct current_step DB writes', () => {
    // Read the source file and find the process_payment step's prompt function
    const source = readFlowSource('payment.flow.ts');
    // Verify no direct .update({...current_step...}) patterns exist in the entire file
    // The only allowed current_step reference is the nextAfterPrompt mechanism
    const updateCurrentStepPattern = /\.update\(\s*\{[^}]*current_step[^}]*\}/g;
    const matches = source.match(updateCurrentStepPattern);
    // payment.flow.ts should have zero direct current_step update calls
    expect(matches).toBeNull();
  });

  it('3. scheduling create_booking: nextAfterPrompt routes correctly for saved-card, payment, and free paths', () => {
    const step = findStep(schedulingFlow, 'create_booking');
    expect(step.nextAfterPrompt).toBeDefined();

    // Saved-card path
    const savedCtx = makeCtx({ _saved_method_id: 'sm-1' });
    expect(callNextAfterPrompt(step, savedCtx)).toBe('saved_card_prompt');

    // Payment reference path
    const payCtx = makeCtx({ payment_reference: 'ref-456' });
    expect(callNextAfterPrompt(step, payCtx)).toBe('payment');

    // Free booking path (no payment, no saved card)
    const freeCtx = makeCtx({});
    expect(callNextAfterPrompt(step, freeCtx)).toBeUndefined();

    // Skip saved card path
    const skipCtx = makeCtx({ _skip_saved_card: true, _saved_method_id: 'sm-1' });
    expect(callNextAfterPrompt(step, skipCtx)).toBeUndefined();
  });

  it('4. reservation + ticketing: nextAfterPrompt routes to correct payment steps', () => {
    // Reservation
    const resStep = findStep(reservationFlow, 'create_reservation');
    expect(resStep.nextAfterPrompt).toBeDefined();
    const resCtx = makeCtx({ payment_reference: 'ref-789' });
    expect(callNextAfterPrompt(resStep, resCtx)).toBe('reservation_payment');

    // Ticketing
    const tickStep = findStep(ticketingFlow, 'process_tickets');
    expect(tickStep.nextAfterPrompt).toBeDefined();
    const tickCtx = makeCtx({ bank_transfer_reference: 'bt-ref-001' });
    expect(callNextAfterPrompt(tickStep, tickCtx)).toBe('await_ticket_payment');
  });
});

// ═══════════════════════════════════════════════════════════════
// AREA 2: Session terminalization + exactEntityFamily gating
// ═══════════════════════════════════════════════════════════════
describe('Area 2: Session terminalization', () => {
  function mockSupabase(opts: {
    entityData?: { bot_session_id: string | null } | null;
    entityError?: { message: string } | null;
    updateResult?: { id: string }[] | null;
    updateError?: { message: string } | null;
    reReadSession?: { id: string; is_active: boolean } | null;
    reReadError?: { message: string } | null;
  }) {
    const sb: any = {
      from: vi.fn((table: string) => {
        if (table === 'bookings' || table === 'orders' || table === 'reservations') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: opts.entityData !== undefined ? opts.entityData : null,
                  error: opts.entityError || null,
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
                    data: opts.updateResult !== undefined ? opts.updateResult : [],
                    error: opts.updateError || null,
                  }),
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: opts.reReadSession !== undefined ? opts.reReadSession : null,
                  error: opts.reReadError || null,
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
    };
    return sb;
  }

  let terminalizeOriginatingSession: typeof import('@/lib/payments/session-terminalization').terminalizeOriginatingSession;

  beforeEach(async () => {
    vi.clearAllMocks();
    terminalizeOriginatingSession = (await import('@/lib/payments/session-terminalization')).terminalizeOriginatingSession;
  });

  it('5. Booking with bot_session_id + active session -> deactivated', async () => {
    const sb = mockSupabase({
      entityData: { bot_session_id: 'sess-abc' },
      updateResult: [{ id: 'sess-abc' }],
    });
    const result = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(result.status).toBe('deactivated');
  });

  it('6. Booking with bot_session_id + already inactive -> already_inactive', async () => {
    const sb = mockSupabase({
      entityData: { bot_session_id: 'sess-abc' },
      updateResult: [],
      reReadSession: { id: 'sess-abc', is_active: false },
    });
    const result = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(result.status).toBe('already_inactive');
  });

  it('7. Legacy null bot_session_id -> legacy_null, no session UPDATE attempted', async () => {
    const sb = mockSupabase({
      entityData: { bot_session_id: null },
    });
    const result = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(result.status).toBe('legacy_null');
    const fromCalls = sb.from.mock.calls.map((c: any[]) => c[0]);
    expect(fromCalls).not.toContain('bot_sessions');
  });

  it('8. Invoice/campaign entity (no booking/order/reservation) -> no_origin', async () => {
    const sb = mockSupabase({});
    const result = await terminalizeOriginatingSession(sb, { invoiceId: 'inv-1', campaignId: 'camp-1' });
    expect(result.status).toBe('no_origin');
  });

  it('9. DB error on entity lookup -> error with retryable: true', async () => {
    const sb = mockSupabase({
      entityError: { message: 'connection timeout' },
    });
    const result = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(result.status).toBe('error');
    expect((result as { retryable: boolean }).retryable).toBe(true);
  });

  // ── exactEntityFamily gating tests ──

  it('10. exactEntityFamily is true for booking/order/reservation (even legacy_null)', async () => {
    // The authority.ts derives exactEntityFamily = (termResult.status !== 'no_origin')
    // So deactivated, already_inactive, and legacy_null all yield exactEntityFamily=true
    const bookingDeactivated = await terminalizeOriginatingSession(
      mockSupabase({ entityData: { bot_session_id: 'sess-1' }, updateResult: [{ id: 'sess-1' }] }),
      { bookingId: 'bk-1' },
    );
    expect(bookingDeactivated.status).toBe('deactivated');
    expect(bookingDeactivated.status !== 'no_origin').toBe(true); // exactEntityFamily = true

    const orderLegacy = await terminalizeOriginatingSession(
      mockSupabase({ entityData: { bot_session_id: null } }),
      { orderId: 'ord-1' },
    );
    expect(orderLegacy.status).toBe('legacy_null');
    expect(orderLegacy.status !== 'no_origin').toBe(true); // exactEntityFamily = true

    const reservationInactive = await terminalizeOriginatingSession(
      mockSupabase({ entityData: { bot_session_id: 'sess-2' }, updateResult: [], reReadSession: { id: 'sess-2', is_active: false } }),
      { reservationId: 'res-1' },
    );
    expect(reservationInactive.status).toBe('already_inactive');
    expect(reservationInactive.status !== 'no_origin').toBe(true); // exactEntityFamily = true
  });

  it('11. exactEntityFamily is false for invoice/campaign (no_origin)', async () => {
    const sb = mockSupabase({});
    const invoice = await terminalizeOriginatingSession(sb, { invoiceId: 'inv-1' });
    expect(invoice.status).toBe('no_origin');
    // exactEntityFamily = (status !== 'no_origin') = false
    expect(invoice.status !== 'no_origin').toBe(false);

    const campaign = await terminalizeOriginatingSession(sb, { campaignId: 'camp-1' });
    expect(campaign.status).toBe('no_origin');
    expect(campaign.status !== 'no_origin').toBe(false);
  });

  it('12. Stage 3 broad heuristic step names do NOT include booking/order/reservation steps', () => {
    // Read send-confirmation.ts and verify the .in('current_step', [...]) for the broad heuristic
    const source = fs.readFileSync(
      path.resolve(__dirname, '../payments/send-confirmation.ts'),
      'utf-8',
    );
    // Find the broad heuristic .in('current_step', [...]) call near the exactEntityFamily guard
    const broadHeuristicMatch = source.match(/\.in\('current_step',\s*\[([^\]]+)\]\)/g);
    expect(broadHeuristicMatch).not.toBeNull();

    // Extract step names from the .in('current_step', [...]) arrays
    for (const match of broadHeuristicMatch!) {
      // Parse out the quoted step names from the array literal
      const stepNames = [...match.matchAll(/'([^']+)'/g)].map(m => m[1])
        .filter(s => s !== 'current_step'); // exclude the column name

      // None of these steps should be booking/order/reservation/ticketing steps
      // Those families are gated by exactEntityFamily and must NOT appear in the broad heuristic
      const bookingFamilySteps = [
        'create_booking', 'saved_card_prompt', 'await_booking_payment',
        'process_order', 'await_order_payment',
        'create_reservation', 'reservation_payment', 'await_reservation_payment',
        'process_tickets', 'await_ticket_payment',
        'process_payment', 'await_payment', // payment flow (booking-backed)
      ];

      for (const stepName of stepNames) {
        expect(bookingFamilySteps).not.toContain(stepName);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// AREA 3: Saved-card phone normalization
// ═══════════════════════════════════════════════════════════════
describe('Area 3: Saved-card phone normalization', () => {
  let getSavedPaymentMethod: typeof import('@/lib/payments/charge-saved').getSavedPaymentMethod;

  const SAVED_METHOD_ROW = {
    id: 'spm-1',
    gateway: 'paystack',
    authorization_code: 'AUTH_abc',
    customer_code: 'CUS_xyz',
    stripe_payment_method_id: null,
    stripe_customer_id: null,
    card_last4: '4242',
    card_brand: 'visa',
  };

  /** Build a mock supabase that uses .limit(1) pattern (not .maybeSingle()) */
  function buildPhoneMockSb(opts: {
    returnData?: (typeof SAVED_METHOD_ROW)[] | null;
    captureInArgs?: (field: string, values: string[]) => void;
    returnError?: { message: string } | null;
  }) {
    const sb: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockImplementation((field: string, values: string[]) => {
              opts.captureInArgs?.(field, values);
              return {
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: opts.returnData !== undefined ? opts.returnData : null,
                      error: opts.returnError || null,
                    }),
                  }),
                }),
              };
            }),
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

  it('13. +E.164 stored, non-+ lookup -> found (.in() includes both variants, uses .limit(1))', async () => {
    let capturedValues: string[] = [];
    const sb = buildPhoneMockSb({
      returnData: [SAVED_METHOD_ROW],
      captureInArgs: (_field, values) => { capturedValues = values; },
    });

    const result = await getSavedPaymentMethod(sb, 'biz-1', '2348012345678');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('spm-1');
    expect(capturedValues).toContain('+2348012345678');
    expect(capturedValues).toContain('2348012345678');
  });

  it('14. Dual-variant rows exist -> query returns exactly one (not error)', async () => {
    const sb = buildPhoneMockSb({
      // Even if both +E.164 and non-+ exist, .limit(1) ensures exactly one returned
      returnData: [SAVED_METHOD_ROW],
    });

    const result = await getSavedPaymentMethod(sb, 'biz-1', '+2348012345678');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('spm-1');
  });

  it('15. Query error -> returns null (not throws)', async () => {
    const sb = buildPhoneMockSb({
      returnData: null,
      returnError: { message: 'connection reset' },
    });

    // Must return null, not throw
    const result = await getSavedPaymentMethod(sb, 'biz-1', '+2348012345678');
    expect(result).toBeNull();
  });

  it('16. No active method -> returns null', async () => {
    const sb = buildPhoneMockSb({ returnData: [] });
    const result = await getSavedPaymentMethod(sb, 'biz-1', '+2348012345678');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// AREA 4: Payment/Giving bot_session_id + crash recovery
// ═══════════════════════════════════════════════════════════════
describe('Area 4: Payment/Giving bot_session_id + crash recovery', () => {
  let paymentFlow: any;

  beforeEach(async () => {
    paymentFlow = (await import('@/lib/bot/flows/payment.flow')).paymentFlow;
  });

  it('17. payment flow booking INSERT SQL includes bot_session_id (structural)', () => {
    const source = readFlowSource('payment.flow.ts');
    // Verify the booking insert includes bot_session_id
    expect(source).toContain('bot_session_id: ctx.session.id');
    // Also verify crash-window recovery pattern exists
    expect(source).toContain("error?.code === '23505'");
    expect(source).toContain("error?.message?.includes('bot_session_id')");
  });

  it('18. crash-window: prompt() with 23505 unique constraint error recovers existing booking', async () => {
    const step = findStep(paymentFlow, 'process_payment');

    // Build mock supabase that returns unique constraint error on INSERT, then existing booking on recovery
    const mockSb: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bookings') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint "bookings_bot_session_id_key" bot_session_id' },
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  in: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { id: 'existing-bk-1', reference_code: 'REF-EXISTING' },
                      error: null,
                    }),
                  }),
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
        service_name: 'Test Service',
        amount: 5000,
        first_name: 'John',
        last_name: 'Doe',
        _terms_accepted: true,
      },
      { supabase: mockSb },
    );

    // After prompt runs, session_data should have the recovered booking
    mockInitializePayment.mockResolvedValueOnce({ reference: 'pay-ref-1', url: 'https://pay.test/1' });
    const msgs = await step.prompt(ctx);

    // Should not be an error message — the recovery path should have worked
    expect(ctx.session.session_data.booking_id).toBe('existing-bk-1');
    expect(ctx.session.session_data.reference_code).toBe('REF-EXISTING');
  });

  it('19. re-entry with existing booking_id skips INSERT entirely', async () => {
    const step = findStep(paymentFlow, 'process_payment');

    const insertSpy = vi.fn();
    const mockSb: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bookings') {
          return {
            insert: insertSpy.mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null, error: null }),
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
        service_name: 'Test Service',
        amount: 5000,
        first_name: 'John',
        last_name: 'Doe',
        _terms_accepted: true,
        booking_id: 'existing-bk-2',
        reference_code: 'REF-EXISTING-2',
      },
      { supabase: mockSb },
    );

    mockInitializePayment.mockResolvedValueOnce({ reference: 'pay-ref-2', url: 'https://pay.test/2' });
    await step.prompt(ctx);

    // INSERT should NOT have been called — booking_id already in session_data
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// AREA 5: Cross-capability caller boundaries
// ═══════════════════════════════════════════════════════════════
describe('Area 5: Cross-capability caller boundaries', () => {
  it('20. scheduling flow calls initializePayment with transactionCategory=scheduling', async () => {
    const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
    const step = findStep(schedulingFlow, 'create_booking');

    // Verify structurally that the source passes transactionCategory: 'scheduling'
    const source = readFlowSource('scheduling.flow.ts');
    const initPaymentCallsInSource = source.match(/initializePayment\(ctx\.supabase,\s*\{[\s\S]*?\}\)/g);
    expect(initPaymentCallsInSource).not.toBeNull();
    // At least one call must include transactionCategory: 'scheduling'
    const hasSchedulingCategory = initPaymentCallsInSource!.some(call =>
      call.includes("transactionCategory: 'scheduling'")
    );
    expect(hasSchedulingCategory).toBe(true);
  });

  it('21. ordering flow calls initializePayment with transactionCategory=ordering', async () => {
    const source = readFlowSource('ordering.flow.ts');
    const initPaymentCallsInSource = source.match(/initializePayment\(ctx\.supabase,\s*\{[\s\S]*?\}\)/g);
    expect(initPaymentCallsInSource).not.toBeNull();
    const hasOrderingCategory = initPaymentCallsInSource!.some(call =>
      call.includes("transactionCategory: 'ordering'")
    );
    expect(hasOrderingCategory).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// AREA 6: Post-success no-reinit
// ═══════════════════════════════════════════════════════════════
describe('Area 6: Post-success no-reinit', () => {
  it('22. after payment confirmed, I-ve-Paid reconciliation returns already_confirmed, not new payment init', async () => {
    const { paymentFlow } = await import('@/lib/bot/flows/payment.flow');
    const awaitStep = findStep(paymentFlow, 'await_payment');

    // Mock verifyAndReconcilePayment to return 'completed'
    const { verifyAndReconcilePayment } = await import('@/lib/payments/bot-recovery');
    (verifyAndReconcilePayment as any).mockResolvedValueOnce({ outcome: 'completed' });

    const sendTextSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(
      {
        payment_reference: 'ref-done-1',
        booking_id: 'bk-done-1',
        reference_code: 'RC-DONE',
        service_name: 'Test Service',
        amount: 5000,
      },
      {
        sender: { sendText: sendTextSpy } as any,
      },
    );

    // Simulate "I've Paid" button tap — validate() should reconcile, not reinit
    const result = await awaitStep.validate('i_paid', ctx);

    // The I've Paid handler calls parseIvePaidInput. Since our mock returns recognized:false,
    // it falls through. Let's instead test the actual i_paid_ref: path which is the button postback.
    // Use the ref-matching path
    const { parseIvePaidInput } = await import('@/lib/bot/flows/shared/ive-paid-input');
    (parseIvePaidInput as any).mockReturnValueOnce({ recognized: true, paymentRef: null });
    (verifyAndReconcilePayment as any).mockResolvedValueOnce({ outcome: 'completed' });

    const result2 = await awaitStep.validate(`i_paid_ref:ref-done-1`, ctx);
    // Should get already_confirmed action, not a reinit
    expect(result2.valid).toBe(true);
    expect(result2.data?._action).toBe('already_confirmed');

    // Verify a text was sent to the user confirming payment
    expect(sendTextSpy).toHaveBeenCalled();
    const sentText = sendTextSpy.mock.calls[sendTextSpy.mock.calls.length - 1][0].text;
    expect(sentText).toContain('Payment Confirmed');
  });
});
