/**
 * P0 Post-Payment Lifecycle Regression Tests
 *
 * Covers 4 areas of the P0 fix on branch fix/p0-post-payment-lifecycle:
 *   1. nextAfterPrompt transitions (tests 1-6)
 *   2. Session terminalization (tests 7-12)
 *   3. Saved-card phone normalization (tests 13-16)
 *   4. Payment/Giving bot_session_id structural (tests 17-18)
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
vi.mock('@/lib/categoryConfig', () => ({ getCategoryLabels: () => ({ service: 'Service', staff: 'Staff', date: 'Date' }) }));
vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('user-1'),
  findUserByPhone: vi.fn().mockResolvedValue(null),
  getCustomerName: vi.fn().mockResolvedValue('Test User'),
}));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/terms', () => ({ getTermsPrompt: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewPayment: vi.fn(),
  notifyOwnerNewBooking: vi.fn(),
  notifyOwnerNewTicketSale: vi.fn(),
  notifyOwnerNewDonation: vi.fn(),
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
  checkBankTransferEligibility: vi.fn().mockResolvedValue({ eligible: false }),
  createPendingTransfer: vi.fn(),
  formatBankTransferBlock: vi.fn(),
  BANK_ONLY_BUTTONS: [],
}));
vi.mock('@/lib/bot/flows/shared/ive-paid-input', () => ({
  parseIvePaidInput: vi.fn(),
  isIvePaidInput: vi.fn(() => false),
}));
vi.mock('@/lib/bot/receipt-ocr', () => ({
  analyzeReceipt: vi.fn(),
  receiptMatchesExpected: vi.fn(),
}));
vi.mock('@/lib/bot/flows/shared/saved-card-flow', () => ({
  buildSavedCardOffer: vi.fn(),
  handleSavedCardInput: vi.fn(),
}));
vi.mock('@/lib/bot/flows/shared/safe-interactive', () => ({
  safeButtons: vi.fn((body: string, buttons: unknown[]) => ({ type: 'buttons', body, buttons })),
}));
vi.mock('@/lib/bot/flows/shared/templates', () => ({
  getConfirmationMessage: vi.fn(() => 'Confirmed'),
  getReservationConfirmationMessage: vi.fn(() => 'Reserved'),
  getTicketConfirmationMessage: vi.fn(() => 'Ticketed'),
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

// ── Helpers ──

/** Build a minimal FlowContext with only session_data populated */
function makeCtx(sessionData: Record<string, unknown>): FlowContext {
  return {
    supabase: {} as any,
    sender: {} as any,
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
// AREA 1: nextAfterPrompt transitions
// ═══════════════════════════════════════════════════════════════
describe('Area 1: nextAfterPrompt transitions', () => {
  let paymentFlow: any;
  let schedulingFlow: any;
  let reservationFlow: any;
  let ticketingFlow: any;

  beforeEach(async () => {
    // Import actual flow definitions (mocks above prevent side effects)
    paymentFlow = (await import('@/lib/bot/flows/payment.flow')).paymentFlow;
    schedulingFlow = (await import('@/lib/bot/flows/scheduling.flow')).schedulingFlow;
    reservationFlow = (await import('@/lib/bot/flows/reservation.flow')).reservationFlow;
    ticketingFlow = (await import('@/lib/bot/flows/ticketing.flow')).ticketingFlow;
  });

  it('1. payment process_payment + payment_reference → await_payment', () => {
    const step = findStep(paymentFlow, 'process_payment');
    const ctx = makeCtx({ payment_reference: 'ref-123', amount: 5000 });
    expect(callNextAfterPrompt(step, ctx)).toBe('await_payment');
  });

  it('2. scheduling create_booking + _saved_method_id (no skip/refs) → saved_card_prompt', () => {
    const step = findStep(schedulingFlow, 'create_booking');
    const ctx = makeCtx({ _saved_method_id: 'sm-1' });
    expect(callNextAfterPrompt(step, ctx)).toBe('saved_card_prompt');
  });

  it('3. scheduling create_booking + payment_reference → payment', () => {
    const step = findStep(schedulingFlow, 'create_booking');
    const ctx = makeCtx({ payment_reference: 'ref-456' });
    expect(callNextAfterPrompt(step, ctx)).toBe('payment');
  });

  it('4. scheduling create_booking + _skip_saved_card → undefined (free/retry path)', () => {
    const step = findStep(schedulingFlow, 'create_booking');
    const ctx = makeCtx({ _skip_saved_card: true });
    expect(callNextAfterPrompt(step, ctx)).toBeUndefined();
  });

  it('5. reservation create_reservation + payment_reference → reservation_payment', () => {
    const step = findStep(reservationFlow, 'create_reservation');
    const ctx = makeCtx({ payment_reference: 'ref-789' });
    expect(callNextAfterPrompt(step, ctx)).toBe('reservation_payment');
  });

  it('6. ticketing process_tickets + bank_transfer_reference → await_ticket_payment', () => {
    const step = findStep(ticketingFlow, 'process_tickets');
    const ctx = makeCtx({ bank_transfer_reference: 'bt-ref-001' });
    expect(callNextAfterPrompt(step, ctx)).toBe('await_ticket_payment');
  });
});

// ═══════════════════════════════════════════════════════════════
// AREA 2: Session terminalization
// ═══════════════════════════════════════════════════════════════
describe('Area 2: Session terminalization', () => {
  /** Create a mock supabase client with configurable entity lookup and session update results */
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

  it('7. Booking with bot_session_id + active session → deactivated', async () => {
    const sb = mockSupabase({
      entityData: { bot_session_id: 'sess-abc' },
      updateResult: [{ id: 'sess-abc' }],
    });
    const result = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(result.status).toBe('deactivated');
  });

  it('8. Booking with bot_session_id + already inactive session → already_inactive', async () => {
    const sb = mockSupabase({
      entityData: { bot_session_id: 'sess-abc' },
      updateResult: [],  // zero-row UPDATE
      reReadSession: { id: 'sess-abc', is_active: false },
    });
    const result = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(result.status).toBe('already_inactive');
  });

  it('9. Duplicate terminalization → same already_inactive', async () => {
    const sb = mockSupabase({
      entityData: { bot_session_id: 'sess-abc' },
      updateResult: [],
      reReadSession: { id: 'sess-abc', is_active: false },
    });
    const r1 = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    const r2 = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(r1.status).toBe('already_inactive');
    expect(r2.status).toBe('already_inactive');
  });

  it('10. Legacy null bot_session_id → legacy_null, no session UPDATE attempted', async () => {
    const sb = mockSupabase({
      entityData: { bot_session_id: null },
    });
    const result = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(result.status).toBe('legacy_null');
    // Verify no bot_sessions table was touched — from() was only called for bookings
    const fromCalls = sb.from.mock.calls.map((c: any[]) => c[0]);
    expect(fromCalls).not.toContain('bot_sessions');
  });

  it('11. Invoice/campaign entity (no booking/order/reservation) → no_origin', async () => {
    const sb = mockSupabase({});
    const result = await terminalizeOriginatingSession(sb, { invoiceId: 'inv-1', campaignId: 'camp-1' });
    expect(result.status).toBe('no_origin');
  });

  it('12. DB error on entity lookup → error with retryable: true', async () => {
    const sb = mockSupabase({
      entityError: { message: 'connection timeout' },
    });
    const result = await terminalizeOriginatingSession(sb, { bookingId: 'bk-1' });
    expect(result.status).toBe('error');
    expect((result as { retryable: boolean }).retryable).toBe(true);
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

  /** Build a mock supabase that captures the .in() call args and returns configurable data */
  function buildPhoneMockSb(opts: {
    returnData?: typeof SAVED_METHOD_ROW | null;
    captureInArgs?: (field: string, values: string[]) => void;
  }) {
    const sb: any = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            in: vi.fn().mockImplementation((field: string, values: string[]) => {
              opts.captureInArgs?.(field, values);
              return {
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: opts.returnData !== undefined ? opts.returnData : null,
                    error: null,
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

  it('13. +E.164 stored, non-+ lookup → found (.in() includes both variants)', async () => {
    let capturedValues: string[] = [];
    const sb = buildPhoneMockSb({
      returnData: SAVED_METHOD_ROW,
      captureInArgs: (_field, values) => { capturedValues = values; },
    });

    const result = await getSavedPaymentMethod(sb, 'biz-1', '2348012345678');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('spm-1');
    // Both +E.164 and non-+ variants should be in the query
    expect(capturedValues).toContain('+2348012345678');
    expect(capturedValues).toContain('2348012345678');
  });

  it('14. Non-+ stored, + lookup → found', async () => {
    let capturedValues: string[] = [];
    const sb = buildPhoneMockSb({
      returnData: SAVED_METHOD_ROW,
      captureInArgs: (_field, values) => { capturedValues = values; },
    });

    const result = await getSavedPaymentMethod(sb, 'biz-1', '+2348012345678');
    expect(result).not.toBeNull();
    // Both variants included
    expect(capturedValues).toContain('+2348012345678');
    expect(capturedValues).toContain('2348012345678');
  });

  it('15. Cross-tenant → not found (different business_id)', async () => {
    // The .eq('business_id', ...) filters out cross-tenant — our mock returns null
    const sb = buildPhoneMockSb({ returnData: null });
    const result = await getSavedPaymentMethod(sb, 'biz-other', '+2348012345678');
    expect(result).toBeNull();
  });

  it('16. No active method → returns null', async () => {
    const sb = buildPhoneMockSb({ returnData: null });
    const result = await getSavedPaymentMethod(sb, 'biz-1', '+2348012345678');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// AREA 4: Payment/Giving bot_session_id
// ═══════════════════════════════════════════════════════════════
describe('Area 4: Payment/Giving bot_session_id', () => {
  let paymentFlow: any;

  beforeEach(async () => {
    paymentFlow = (await import('@/lib/bot/flows/payment.flow')).paymentFlow;
  });

  it('17. paymentFlow process_payment step exists and has nextAfterPrompt', () => {
    const step = findStep(paymentFlow, 'process_payment');
    expect(step).toBeDefined();
    expect(step.nextAfterPrompt).toBeDefined();
    expect(typeof step.nextAfterPrompt).toBe('function');
  });

  it('18. payment.flow.ts booking INSERT includes bot_session_id (structural)', () => {
    // Read the actual source file and verify the booking insert includes bot_session_id
    const sourcePath = path.resolve(__dirname, '../bot/flows/payment.flow.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Verify the booking INSERT block contains bot_session_id
    // The pattern is: .insert({...bot_session_id: ctx.session.id...})
    expect(source).toContain('bot_session_id: ctx.session.id');

    // Also verify crash-window recovery pattern exists
    expect(source).toContain("error?.code === '23505'");
    expect(source).toContain("error?.message?.includes('bot_session_id')");
  });
});
