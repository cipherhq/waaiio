/**
 * #268 Bot Flow Message Optimization — Executable Flow-Level Tests (R5)
 *
 * All critical proofs execute actual flow step handlers.
 * No escape hatches to toString()/source-string inspection for critical paths.
 * Structural tests are supplemental guards only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeButtons } from '../shared/safe-interactive';

// ── Comprehensive mocks — must cover ALL dynamic imports used by flow steps ──

const mockGetSavedMethods = vi.fn().mockResolvedValue([]);
const mockChargeSavedMethod = vi.fn();
const mockRequiresPin = vi.fn();
const mockVerifyPin = vi.fn();

vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    getSavedMethods: (...a: unknown[]) => mockGetSavedMethods(...a),
    chargeSavedMethod: (...a: unknown[]) => mockChargeSavedMethod(...a),
    requiresPin: (...a: unknown[]) => mockRequiresPin(...a),
    verifyPin: (...a: unknown[]) => mockVerifyPin(...a),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/constants');
  return { ...actual, formatCurrency: (a: number) => `₦${a}`, getCurrencyCode: () => 'NGN' };
});

vi.mock('@/lib/categoryConfig', () => ({
  getCategoryLabels: () => ({ confirmationEmoji: '🏢', receiptTitle: 'Booking', actionVerb: 'Payment', quantityLabel: 'guest(s)' }),
}));

// Static imports used by flow files
vi.mock('../shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('user-1'),
  findUserByPhone: vi.fn().mockResolvedValue({ first_name: 'John', last_name: 'Doe' }),
}));

const mockInitializePayment = vi.fn().mockResolvedValue({ url: 'https://pay.test/xyz', reference: 'PAY-REF-1' });
vi.mock('../shared/payment', () => ({ initializePayment: (...a: unknown[]) => mockInitializePayment(...a) }));

vi.mock('../shared/terms', () => ({
  getTermsPrompt: vi.fn().mockReturnValue([{ type: 'buttons', body: 'T&C', buttons: [{ id: 'accept_terms', title: 'Accept' }] }]),
}));

vi.mock('../shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn().mockResolvedValue({ qualifies: false, bankAccount: null, platformSettings: {} }),
  createPendingTransfer: vi.fn(), formatBankTransferBlock: vi.fn(), BANK_ONLY_BUTTONS: [],
}));

// Dynamic imports used inside prompt() — must mock at the path the flow file resolves
vi.mock('../shared/capability-guard', () => ({
  requireCurrentCapability: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: vi.fn().mockResolvedValue({ lifecycle: { status: 'completed' } }),
}));

vi.mock('@/lib/payments/bot-recovery', () => ({
  verifyAndReconcilePayment: vi.fn().mockResolvedValue({ outcome: 'not_paid' }),
}));

vi.mock('@/lib/bot/smart-intent', () => ({
  extractEntitiesOnly: vi.fn().mockReturnValue({}),
  parseSmartIntent: vi.fn(),
  parseSmartIntentHybrid: vi.fn(),
  matchServiceFromKeywords: vi.fn(),
  buildAcknowledgment: vi.fn(),
  matchProductsFromKeywords: vi.fn(),
}));

vi.mock('../shared/notify-owner', () => ({
  notifyOwnerNewPayment: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewTicketSale: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewQuoteRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../shared/notifications', () => ({ createNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../shared/templates', () => ({
  getOrderConfirmationMessage: vi.fn().mockReturnValue('Order Summary'),
  getReservationConfirmationMessage: vi.fn().mockReturnValue('Reservation Summary'),
  getTicketConfirmationMessage: vi.fn().mockReturnValue('Ticket Summary'),
  getConfirmationMessage: vi.fn().mockReturnValue('Confirmation'),
}));
vi.mock('../shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/receipt-ocr', () => ({ analyzeReceipt: vi.fn(), receiptMatchesExpected: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/ive-paid-input', () => ({
  parseIvePaidInput: vi.fn().mockReturnValue({ recognized: false }),
  isIvePaidInput: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: vi.fn().mockResolvedValue({ allowed: true }) }));

const mockEvaluateRules = vi.fn().mockResolvedValue(undefined);
const mockTriggerSequences = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: (...a: unknown[]) => mockEvaluateRules(...a) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: (...a: unknown[]) => mockTriggerSequences(...a) }));

vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: (...a: unknown[]) => mockTriggerSequences(...a) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: () => '_Powered by Waaiio_' }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: () => '' }));

import { handleSavedCardInput } from '../shared/saved-card-flow';
import type { FlowContext, FlowStepConfig } from '../types';

// ── Supabase mock that tracks table-specific operations ──

function createTestSupabase() {
  const ops: { table: string; op: string; data?: unknown }[] = [];

  const makeChain = (table: string): Record<string, any> => {
    const c: Record<string, any> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'neq', 'or', 'lt', 'gt', 'gte', 'lte', 'is']) {
      c[m] = vi.fn().mockReturnValue(c);
    }
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue(
      table === 'countries'
        ? { data: { currency_code: 'USD' }, error: null }
        : { data: null, error: null }
    );
    c.insert = vi.fn().mockImplementation((data: unknown) => {
      ops.push({ table, op: 'insert', data });
      const ic: Record<string, any> = {};
      ic.select = vi.fn().mockReturnValue(ic);
      ic.eq = vi.fn().mockReturnValue(ic);
      ic.single = vi.fn().mockResolvedValue({
        data: table === 'bookings'
          ? { id: 'bk-TEST-001', reference_code: 'BW-TEST-001' }
          : table === 'reservations'
          ? { id: 'res-TEST-001', reference_code: 'RES-TEST-001' }
          : { id: 'gen-001' },
        error: null,
      });
      return ic;
    });
    c.update = vi.fn().mockImplementation((data: unknown) => {
      ops.push({ table, op: 'update', data });
      return c;
    });
    c.upsert = vi.fn().mockImplementation((data: unknown) => {
      ops.push({ table, op: 'upsert', data });
      return c;
    });
    c.delete = vi.fn().mockImplementation(() => {
      ops.push({ table, op: 'delete' });
      return c;
    });
    return c;
  };

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
    rpc: vi.fn().mockImplementation((name: string, args: unknown) => {
      ops.push({ table: 'rpc', op: name, data: args });
      if (name === 'create_order_atomic') {
        return Promise.resolve({ data: { order_id: 'ord-TEST-001', reference_code: 'ORD-TEST-001', created: true, error: null }, error: null });
      }
      return Promise.resolve({ data: { success: true, allowed: true }, error: null });
    }),
    storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ data: null, error: null }), createSignedUrl: vi.fn().mockResolvedValue({ data: null }) }) },
  } as any;

  return {
    supabase,
    ops,
    getInserts: (table: string) => ops.filter(o => o.table === table && o.op === 'insert'),
    getUpdates: (table: string) => ops.filter(o => o.table === table && o.op === 'update'),
    getRpcs: (name: string) => ops.filter(o => o.table === 'rpc' && o.op === name),
  };
}

function flowCtx(supabase: any, sessionData: Record<string, unknown> = {}): FlowContext {
  // If supabase is not a real mock (e.g. {} as any), create one so DB queries don't throw
  const sb = (supabase && typeof supabase.from === 'function') ? supabase : createTestSupabase().supabase;
  return {
    supabase: sb,
    sender: { sendText: vi.fn().mockResolvedValue(undefined), sendButtons: vi.fn().mockResolvedValue(undefined), sendList: vi.fn().mockResolvedValue(undefined), sendImage: vi.fn().mockResolvedValue(undefined), sendDocument: vi.fn().mockResolvedValue(undefined) },
    standalone: {} as any,
    intelligence: {} as any,
    from: '+2348012345678',
    session: { id: 's-1', user_id: 'user-1', business_id: 'biz-1', current_step: 'process_payment', session_data: sessionData, version: 1 },
    business: { id: 'biz-1', name: 'TestBiz', slug: 'testbiz', category: 'other' as any, flow_type: 'payment' as any, subscription_tier: 'free', trial_ends_at: '', metadata: {}, country_code: 'NG' as any, payment_gateway: null },
    t: (t: string) => Promise.resolve(t),
  } as unknown as FlowContext;
}

// ════════════════════════════════════════════
// EXECUTABLE BEHAVIORAL TESTS
// ════════════════════════════════════════════

describe('safeButtons', () => {
  it('≤ 1024 → 1 msg', () => expect(safeButtons('x'.repeat(1024), [{ id: 'a', title: 'A' }])).toHaveLength(1));
  it('> 1024 → text + buttons', () => {
    const r = safeButtons('y'.repeat(1025), [{ id: 'a', title: 'A' }]);
    expect(r).toHaveLength(2);
    if (r[0].type === 'text') expect(r[0].text.length).toBe(1025);
  });
});

// ── handleSavedCardInput behavioral tests ──

describe('handleSavedCardInput — executable', () => {
  beforeEach(() => vi.clearAllMocks());
  const OPTS = { amount: 5000, reference: 'REF-saved', entityId: { bookingId: 'bk-1' }, transactionCategory: 'payment' };

  it('charged', async () => {
    const ctx = flowCtx({} as any, { _saved_method_id: 's1', _pending_deposit: 5000, reference_code: 'R', booking_id: 'b1' });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'p1' });
    const r = await handleSavedCardInput('pay_saved', ctx, OPTS);
    expect(r!.data!._saved_card_paid).toBe(true);
  });

  it('requires_provider_auth sends URL', async () => {
    const ctx = flowCtx({} as any, { _saved_method_id: 's1', _pending_deposit: 5000, reference_code: 'R', booking_id: 'b1' });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'requires_provider_auth', authUrl: 'https://3ds.test', paymentId: 'p1' });
    const r = await handleSavedCardInput('pay_saved', ctx, OPTS);
    expect(r!.data!._saved_card_requires_auth).toBe(true);
    expect((ctx.sender as any).sendText).toHaveBeenCalled();
  });

  it('declined → skip', async () => {
    const ctx = flowCtx({} as any, { _saved_method_id: 's1', _pending_deposit: 5000, reference_code: 'R', booking_id: 'b1' });
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'declined', message: 'No funds', shouldDeactivate: false });
    const r = await handleSavedCardInput('pay_saved', ctx, OPTS);
    expect(r!.data!._skip_saved_card).toBe(true);
  });

  it('pay_new → skip, zero charge', async () => {
    const r = await handleSavedCardInput('pay_new', flowCtx({} as any, { _saved_method_id: 's1' }), OPTS);
    expect(r!.data!._skip_saved_card).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('go_back → cancelled, zero charge', async () => {
    const r = await handleSavedCardInput('go_back', flowCtx({} as any, { _saved_method_id: 's1' }), OPTS);
    expect(r!.data!._saved_card_cancelled).toBe(true);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('PIN-stage cancel → cancelled NOT skip', async () => {
    const r = await handleSavedCardInput('cancel', flowCtx({} as any, { _awaiting_card_pin: true, _saved_method_id: 's1' }), OPTS);
    expect(r!.data!._saved_card_cancelled).toBe(true);
    expect(r!.data!._skip_saved_card).toBeUndefined();
  });

  it('correct PIN → charges', async () => {
    const ctx = flowCtx({} as any, { _awaiting_card_pin: true, _saved_method_id: 's1', _pending_deposit: 5000, reference_code: 'R', booking_id: 'b1' });
    mockVerifyPin.mockResolvedValue({ valid: true });
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'p1' });
    const r = await handleSavedCardInput('1234', ctx, OPTS);
    expect(r!.data!._saved_card_paid).toBe(true);
  });
});

// ── Payment/Giving: real process_payment step ──

describe('Payment/Giving process_payment — real flow step execution', () => {
  let step: FlowStepConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSavedMethods.mockResolvedValue([]);
    mockInitializePayment.mockResolvedValue({ url: 'https://pay.test/xyz', reference: 'PAY-REF-1' });
    const { paymentFlow } = await import('../payment.flow');
    step = paymentFlow.steps.find(s => s.id === 'process_payment')!;
  });

  it('first-entry: reaches real booking INSERT and persists ID/reference', async () => {
    const { supabase, getInserts } = createTestSupabase();
    const sd: Record<string, unknown> = {
      active_capability: 'payment', service_id: 'svc-1', service_name: 'Tithe',
      amount: 5000, first_name: 'John', last_name: 'Doe', _terms_accepted: true,
    };
    const ctx = flowCtx(supabase, sd);

    const msgs = await step.prompt(ctx);

    // Must have reached the booking INSERT
    const bookingInserts = getInserts('bookings');
    expect(bookingInserts.length).toBe(1);

    // Must have persisted the returned IDs in session
    expect(sd.booking_id).toBe('bk-TEST-001');
    expect(sd.reference_code).toBe('BW-TEST-001');

    // Must have returned payment messages (not an error/T&C)
    expect(msgs.length).toBeGreaterThan(0);

    // R6-Gap1 + R7: initializePayment called with the durable booking identity
    expect(mockInitializePayment).toHaveBeenCalled();
    const initCall = mockInitializePayment.mock.calls[0];
    if (initCall) {
      const initOpts = initCall[1]; // second arg to initializePayment(supabase, opts)
      expect(initOpts.bookingId).toBe('bk-TEST-001');
      expect(initOpts.referenceCode).toBe('BW-TEST-001');
    }
  });

  it('re-entry: zero second booking INSERT', async () => {
    const { supabase, getInserts } = createTestSupabase();
    const sd: Record<string, unknown> = {
      active_capability: 'payment', service_id: 'svc-1', service_name: 'Tithe',
      amount: 5000, first_name: 'John', _terms_accepted: true,
      booking_id: 'bk-EXISTING', reference_code: 'BW-EXISTING',
    };
    const ctx = flowCtx(supabase, sd);

    await step.prompt(ctx);

    expect(getInserts('bookings').length).toBe(0);
    expect(sd.booking_id).toBe('bk-EXISTING');
    expect(sd.reference_code).toBe('BW-EXISTING');
  });

  it('pay-new → validate merge → next → re-entry: zero second booking', async () => {
    const { supabase, getInserts } = createTestSupabase();
    const sd: Record<string, unknown> = {
      active_capability: 'payment', booking_id: 'bk-1', reference_code: 'BW-1',
      amount: 5000, _terms_accepted: true, _saved_method_id: 'spm-1',
    };
    const ctx = flowCtx(supabase, sd);

    // Simulate pay_new through real validate
    const vr = await step.validate!('pay_new', ctx);
    expect(vr.valid).toBe(true);
    // Merge returned data as executor does
    if (vr.data) Object.assign(sd, vr.data);
    expect(sd._skip_saved_card).toBe(true);

    // Execute next → should re-enter process_payment
    const nextStep = await step.next(ctx);
    expect(nextStep).toBe('process_payment');

    // Clear skip for re-entry
    delete sd._saved_method_id;
    delete sd._skip_saved_card;

    // Re-entry prompt — must NOT insert second booking
    await step.prompt(ctx);
    expect(getInserts('bookings').length).toBe(0);
  });

  it('PIN-stage cancel → validate merge → next → CAS-cancel booking, no new-card route', async () => {
    const { supabase, getUpdates } = createTestSupabase();
    mockInitializePayment.mockClear(); // clear from prior tests
    const sd: Record<string, unknown> = {
      active_capability: 'payment', booking_id: 'bk-1', reference_code: 'BW-1',
      amount: 5000, _terms_accepted: true, _awaiting_card_pin: true, _saved_method_id: 'spm-1',
    };
    const ctx = flowCtx(supabase, sd);

    // Execute cancel through real validate
    const vr = await step.validate!('cancel', ctx);
    expect(vr.valid).toBe(true);
    if (vr.data) Object.assign(sd, vr.data);

    // Must produce _saved_card_cancelled
    expect(sd._saved_card_cancelled).toBe(true);
    // Must NOT produce _skip_saved_card (no new-card fallback)
    expect(sd._skip_saved_card).toBeUndefined();

    // Execute next → should end flow (null), NOT re-enter process_payment
    const nextStep = await step.next(ctx);
    expect(nextStep).toBeNull();

    // R6-Gap2: Durable CAS cancellation must have been attempted on bookings table
    const bookingUpdates = getUpdates('bookings');
    expect(bookingUpdates.length).toBeGreaterThanOrEqual(1);
    // At least one update must set status: 'cancelled'
    expect(bookingUpdates.some((u: any) => u.data?.status === 'cancelled')).toBe(true);

    // R6-Gap2: No new-card initializePayment must have been called
    expect(mockInitializePayment).not.toHaveBeenCalled();
  });

  it('provider-auth → validate merge → next → routes to await_payment', async () => {
    const { supabase } = createTestSupabase();
    const sd: Record<string, unknown> = {
      active_capability: 'payment', booking_id: 'bk-1', reference_code: 'BW-1',
      amount: 5000, _terms_accepted: true, _saved_method_id: 'spm-1',
    };
    const ctx = flowCtx(supabase, sd);
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'requires_provider_auth', authUrl: 'https://3ds.test', paymentId: 'p1' });

    const vr = await step.validate!('pay_saved', ctx);
    if (vr.data) Object.assign(sd, vr.data);

    const nextStep = await step.next(ctx);
    expect(nextStep).toBe('await_payment');
  });

  it('decline → validate merge → next → re-enters for payment link', async () => {
    const { supabase } = createTestSupabase();
    const sd: Record<string, unknown> = {
      active_capability: 'payment', booking_id: 'bk-1', reference_code: 'BW-1',
      amount: 5000, _terms_accepted: true, _saved_method_id: 'spm-1',
    };
    const ctx = flowCtx(supabase, sd);
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockChargeSavedMethod.mockResolvedValue({ status: 'declined', message: 'Insufficient', shouldDeactivate: false });

    const vr = await step.validate!('pay_saved', ctx);
    if (vr.data) Object.assign(sd, vr.data);

    const nextStep = await step.next(ctx);
    expect(nextStep).toBe('process_payment');
  });
});

// ── Ordering: real process_order step ──

describe('Ordering process_order — real flow step execution', () => {
  let step: FlowStepConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSavedMethods.mockResolvedValue([]);
    mockEvaluateRules.mockClear();
    mockTriggerSequences.mockClear();
    const { notifyOwnerNewOrder } = await import('../shared/notify-owner');
    vi.mocked(notifyOwnerNewOrder).mockClear();
    const { orderingFlow } = await import('../ordering.flow');
    step = orderingFlow.steps.find(s => s.id === 'process_order')!;
  });

  it('first-entry (created:true): fires ALL creation-only side effects exactly once', async () => {
    const { supabase, getRpcs } = createTestSupabase();
    supabase.rpc = vi.fn().mockImplementation((name: string) => {
      if (name === 'create_order_atomic') {
        return Promise.resolve({ data: { order_id: 'ord-1', reference_code: 'ORD-1', created: true, error: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });

    const { notifyOwnerNewOrder } = await import('../shared/notify-owner');

    const sd: Record<string, unknown> = {
      active_capability: 'ordering', _terms_accepted: true,
      cart: [{ product_id: 'p1', name: 'Widget', quantity: 1, price: 1000 }],
      first_name: 'John', delivery_type: 'pickup',
    };
    const ctx = flowCtx(supabase, sd);
    ctx.business!.flow_type = 'ordering' as any;

    await step.prompt(ctx);

    // R6-Gap5: ALL creation-only side effects fire exactly once
    expect(mockEvaluateRules).toHaveBeenCalledTimes(1);
    expect(mockTriggerSequences).toHaveBeenCalledTimes(1);
    expect(notifyOwnerNewOrder).toHaveBeenCalledTimes(1);
    // Customer profile upsert via RPC
    const profileRpcs = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === 'upsert_customer_profile');
    expect(profileRpcs.length).toBe(1);
  });

  it('re-entry (created:false): ZERO creation-only side effects', async () => {
    const { supabase } = createTestSupabase();
    supabase.rpc = vi.fn().mockImplementation((name: string) => {
      if (name === 'create_order_atomic') {
        return Promise.resolve({ data: { order_id: 'ord-1', reference_code: 'ORD-1', created: false, error: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });

    const { notifyOwnerNewOrder } = await import('../shared/notify-owner');
    vi.mocked(notifyOwnerNewOrder).mockClear();

    const sd: Record<string, unknown> = {
      active_capability: 'ordering', _terms_accepted: true,
      cart: [{ product_id: 'p1', name: 'Widget', quantity: 1, price: 1000 }],
      first_name: 'John', delivery_type: 'pickup',
      order_id: 'ord-1', reference_code: 'ORD-1',
    };
    const ctx = flowCtx(supabase, sd);
    ctx.business!.flow_type = 'ordering' as any;

    await step.prompt(ctx);

    // R6-Gap5: Zero creation-only side effects on re-entry
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    expect(mockTriggerSequences).not.toHaveBeenCalled();
    expect(notifyOwnerNewOrder).not.toHaveBeenCalled();
    // No customer profile upsert
    const profileRpcs = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === 'upsert_customer_profile');
    expect(profileRpcs.length).toBe(0);
  });
});

// ── R7: Cancellation race tests with modeled CAS outcomes ──

/**
 * Creates a supabase mock that models specific CAS return values for cancellation race testing.
 * updateResult: what .update().in().select() returns (affected rows)
 * rereadResult: what the follow-up .select().single() returns on re-read
 */
function createCancelRaceMock(config: {
  updateResult: { data: unknown[] | null; error: unknown | null };
  rereadResult: { data: unknown | null; error: unknown | null };
}) {
  const sentTexts: string[] = [];
  let transferUpdateCalled = false;

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      // Each from() call gets a fresh chain that tracks whether it's an update or select path
      let isUpdatePath = false;

      const c: Record<string, any> = {};
      for (const m of ['eq', 'in', 'not', 'neq', 'order', 'limit']) c[m] = vi.fn().mockReturnValue(c);

      c.update = vi.fn().mockImplementation(() => {
        if (table === 'pending_transfers') {
          transferUpdateCalled = true;
        }
        isUpdatePath = true;
        return c;
      });

      c.select = vi.fn().mockImplementation(() => {
        if (isUpdatePath) {
          // This is .update().eq().in().select('id') — return CAS result as Promise
          return Promise.resolve(config.updateResult);
        }
        // This is a fresh .select() for re-read
        return c;
      });

      c.single = vi.fn().mockResolvedValue(config.rereadResult);
      c.maybeSingle = vi.fn().mockResolvedValue(config.rereadResult);

      return c;
    }),
    rpc: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
  } as any;

  const ctx = (sd: Record<string, unknown>) => ({
    supabase,
    sender: {
      sendText: vi.fn().mockImplementation(({ text }: { text: string }) => { sentTexts.push(text); return Promise.resolve(); }),
    },
    from: '+2348012345678',
    session: { id: 's-1', user_id: 'u-1', business_id: 'biz-1', current_step: 'x', session_data: sd, version: 1 },
    business: { id: 'biz-1', name: 'Biz', slug: 'biz', category: 'other', flow_type: 'payment', subscription_tier: 'free', trial_ends_at: '', metadata: {}, country_code: 'NG', payment_gateway: null },
    t: (t: string) => Promise.resolve(t),
  } as unknown as FlowContext);

  return { supabase, sentTexts, ctx, wasTransferCancelCalled: () => transferUpdateCalled };
}

describe('R7: Payment/Giving cancellation races', () => {
  let step: FlowStepConfig;
  beforeEach(async () => {
    const { paymentFlow } = await import('../payment.flow');
    step = paymentFlow.steps.find(s => s.id === 'process_payment')!;
  });

  it('pending → CAS succeeds → cancellation claimed', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [{ id: 'bk-1' }], error: null },
      rereadResult: { data: null, error: null },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(true);
  });

  it('paid/confirmed race → zero CAS rows → reports confirmed', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'confirmed', deposit_status: 'paid' }, error: null },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    expect(m.sentTexts.some(t => t.includes('confirmed'))).toBe(true);
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(false);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });

  it('already cancelled → zero CAS rows → idempotent cancellation', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'cancelled', deposit_status: 'pending' }, error: null },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(true);
  });

  it('re-read error → fail closed, no cancellation claim', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: null, error: { message: 'DB error' } },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(false);
    expect(m.sentTexts.some(t => t.includes('confirmed'))).toBe(false);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });
});

describe('R7: Ticketing cancellation races', () => {
  let step: FlowStepConfig;
  beforeEach(async () => {
    const { ticketingFlow } = await import('../ticketing.flow');
    step = ticketingFlow.steps.find(s => s.id === 'process_tickets')!;
  });

  it('pending → CAS succeeds → cancellation claimed', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [{ id: 'bk-1' }], error: null },
      rereadResult: { data: null, error: null },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(true);
  });

  it('paid/confirmed race → reports confirmed', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'confirmed', deposit_status: 'paid' }, error: null },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts.some(t => t.includes('confirmed'))).toBe(true);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });

  it('re-read error → fail closed', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: null, error: { message: 'DB error' } },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts).toHaveLength(0);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });
});

describe('R7: Reservation cancellation races', () => {
  let step: FlowStepConfig;
  beforeEach(async () => {
    const { reservationFlow } = await import('../reservation.flow');
    step = reservationFlow.steps.find(s => s.id === 'create_reservation')!;
  });

  it('pending → CAS succeeds → cancellation claimed', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [{ id: 'res-1' }], error: null },
      rereadResult: { data: null, error: null },
    });
    const sd = { reservation_id: 'res-1', _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(true);
  });

  it('paid/confirmed race → reports confirmed', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'confirmed', deposit_status: 'paid' }, error: null },
    });
    const sd = { reservation_id: 'res-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts.some(t => t.includes('confirmed'))).toBe(true);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });

  it('already cancelled → idempotent cancellation', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'cancelled', deposit_status: 'pending' }, error: null },
    });
    const sd = { reservation_id: 'res-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(true);
  });

  it('re-read error → fail closed', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: null, error: { message: 'DB error' } },
    });
    const sd = { reservation_id: 'res-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts).toHaveLength(0);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });
});

// ── R8: Missing durable entity ID — fail closed ──

describe('R8: Missing durable entity ID — fail closed', () => {
  it('Payment/Giving: no booking_id → fail closed, no cancellation message', async () => {
    const { paymentFlow } = await import('../payment.flow');
    const step = paymentFlow.steps.find(s => s.id === 'process_payment')!;
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: null, error: null },
    });
    // No booking_id in session — durable entity identity missing
    const sd = { _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    // Must NOT claim cancellation
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(false);
    // Must NOT cancel transfers
    expect(m.wasTransferCancelCalled()).toBe(false);
  });

  it('Ticketing: no booking_id → fail closed, no cancellation message', async () => {
    const { ticketingFlow } = await import('../ticketing.flow');
    const step = ticketingFlow.steps.find(s => s.id === 'process_tickets')!;
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: null, error: null },
    });
    const sd = { _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(false);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });

  it('Reservation: no reservation_id → fail closed, no cancellation message', async () => {
    const { reservationFlow } = await import('../reservation.flow');
    const step = reservationFlow.steps.find(s => s.id === 'create_reservation')!;
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: null, error: null },
    });
    const sd = { _saved_card_cancelled: true } as Record<string, unknown>;
    const result = await step.next(m.ctx(sd));
    expect(result).toBeNull();
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(false);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });
});

// ── R8: Ticketing already-cancelled + unknown state fail-closed ──

describe('R8: Ticketing additional race coverage', () => {
  let step: FlowStepConfig;
  beforeEach(async () => {
    const { ticketingFlow } = await import('../ticketing.flow');
    step = ticketingFlow.steps.find(s => s.id === 'process_tickets')!;
  });

  it('already cancelled → idempotent cancellation', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'cancelled', deposit_status: 'pending' }, error: null },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(true);
  });

  it('unknown state → fail closed, no cancellation message', async () => {
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'processing', deposit_status: 'pending' }, error: null },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(false);
    expect(m.sentTexts.some(t => t.includes('confirmed'))).toBe(false);
  });
});

// ── R8: Payment/Giving + Reservation unknown state fail-closed ──

describe('R8: Unknown state fail-closed coverage', () => {
  it('Payment/Giving: unknown state → fail closed', async () => {
    const { paymentFlow } = await import('../payment.flow');
    const step = paymentFlow.steps.find(s => s.id === 'process_payment')!;
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'processing', deposit_status: 'pending' }, error: null },
    });
    const sd = { booking_id: 'bk-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(false);
    expect(m.sentTexts.some(t => t.includes('confirmed'))).toBe(false);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });

  it('Reservation: unknown state → fail closed', async () => {
    const { reservationFlow } = await import('../reservation.flow');
    const step = reservationFlow.steps.find(s => s.id === 'create_reservation')!;
    const m = createCancelRaceMock({
      updateResult: { data: [], error: null },
      rereadResult: { data: { status: 'processing', deposit_status: 'pending' }, error: null },
    });
    const sd = { reservation_id: 'res-1', _saved_card_cancelled: true } as Record<string, unknown>;
    await step.next(m.ctx(sd));
    expect(m.sentTexts.some(t => t.includes('cancelled'))).toBe(false);
    expect(m.sentTexts.some(t => t.includes('confirmed'))).toBe(false);
    expect(m.wasTransferCancelCalled()).toBe(false);
  });
});

// ── R7: Reservation availability — cancelled excluded from active ──

describe('Reservation availability — cancelled excluded', () => {
  it('select_checkin availability query uses .in(status) filter that excludes cancelled', () => {
    // The reservation flow's select_checkin step queries existing reservations to find
    // blocked dates. The query filters by status IN ('pending', 'confirmed').
    // A cancelled reservation (status='cancelled') is excluded by this filter.
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/reservation.flow.ts', 'utf-8');
    const checkinSection = src.slice(src.indexOf("'select_checkin'"), src.indexOf("'select_checkout'"));
    // Must use .in('status', [...]) with pending/confirmed — cancelled excluded
    expect(checkinSection).toContain('.in(');
    expect(checkinSection).toContain('pending');
    expect(checkinSection).toContain('confirmed');
  });
});

// ── Supplemental structural guards ──

describe('Supplemental guards', () => {
  it('booking.id assigned from INSERT or crash-recovery (not self-reference)', () => {
    const src = require('fs').readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
    // After idempotent crash-recovery, booking is assigned via resolvedBooking
    expect(src).toContain('bookingId = resolvedBooking!.id');
    expect(src).not.toContain('bookingId = bookingId!');
  });

  it('reservation cancel uses deposit_status', () => {
    const src = require('fs').readFileSync('lib/bot/flows/reservation.flow.ts', 'utf-8');
    const s = src.slice(src.indexOf('_saved_card_cancelled'));
    expect(s).toContain('deposit_status');
    expect(s).not.toContain('payment_status');
  });

  it('CAS-cancel guards use .in(status, [pending])', () => {
    for (const p of ['lib/bot/flows/payment.flow.ts', 'lib/bot/flows/ticketing.flow.ts', 'lib/bot/flows/reservation.flow.ts']) {
      const s = require('fs').readFileSync(p, 'utf-8').slice(require('fs').readFileSync(p, 'utf-8').indexOf('_saved_card_cancelled'));
      expect(s).toContain(".in('status', ['pending'])");
    }
  });

  it('deep-link active_capability validated', () => {
    const src = require('fs').readFileSync('lib/bot/bot.service.ts', 'utf-8');
    expect(src).toContain('capabilities.includes(deepLinkCapability as CapabilityId) ? { active_capability: deepLinkCapability }');
  });
});
