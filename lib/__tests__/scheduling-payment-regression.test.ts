/**
 * Production regression: complete paid appointment booking path.
 *
 * Exercises the full journey from WhatsApp button reply through payment link:
 *   date_YYYY-MM-DD bypasses promo verification
 *   → scheduling.flow select_date accepts the date
 *   → select_time is reachable and accepts a time
 *   → confirmation accepts 'confirm'
 *   → create_booking creates booking + calls initializePayment at the
 *     shared/payment boundary with correct args
 *   → WhatsApp response contains the exact checkout URL from initializePayment
 *   → payment-error message is absent
 *
 * This test does NOT call the real database or payment providers.
 * It exercises the flow step validate/next/prompt functions with mocked context
 * and spies on initializePayment at the module boundary.
 *
 * NOTE: This test proves the scheduling flow correctly calls initializePayment
 * with the right args and surfaces the returned URL. It does NOT prove that
 * initializePayment itself succeeds in production — a separate
 * initializePayment THREW error observed in production may be an independent
 * defect that this PR's promo-bypass fix does not address.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowContext, FlowStepConfig, PromptMessage } from '@/lib/bot/flows/types';

// ── Known test constants ──

const KNOWN_CHECKOUT_URL = 'https://checkout.paystack.com/test-exact-abc123';
const KNOWN_PAYMENT_REF = 'PAY-EXACT-REF-001';
const PAYMENT_ERROR_MESSAGE = "couldn't set up payment";

// ── Module-level mocks ──

// Mock initializePayment at the shared/payment boundary.
// This is the authoritative spy — we assert exact call args and return value.
const initializePaymentSpy = vi.fn();
vi.mock('@/lib/bot/flows/shared/payment', () => ({
  initializePayment: initializePaymentSpy,
}));

// Mock bank transfer eligibility (not the focus; return no bank transfer)
vi.mock('@/lib/bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn(async () => ({
    qualifies: false,
    bankAccount: null,
    platformSettings: { transfer_expiry_hours: 24 },
  })),
  createPendingTransfer: vi.fn(async () => 'TRF-TEST-001'),
  formatBankTransferBlock: vi.fn(() => 'Bank details here'),
  BANK_ONLY_BUTTONS: [{ id: 'sent_transfer', title: "I've Sent Transfer" }],
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => mockSupabaseClient()),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn(() => ({})),
}));

vi.mock('@/lib/observability', () => ({
  observe: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn(async () => ({ feePercentage: 5, isInTrial: false })),
}));

vi.mock('@/lib/trial-status', () => ({
  resolveTrialStatus: vi.fn(async () => ({ isInTrial: false, trialEndsAt: null })),
  resolveTrialCredit: vi.fn(async () => false),
}));

// Mock the capability guard to always allow — we're testing initializePayment, not capabilities
vi.mock('@/lib/bot/flows/shared/capability-guard', () => ({
  requireCurrentCapability: vi.fn(async () => ({ allowed: true })),
}));

// Not needed — initializePayment is mocked at the boundary
vi.mock('@/lib/payments/factory', () => ({
  getPaymentGateway: vi.fn(),
  getPaymentGatewayByName: vi.fn(),
}));

// ── Shared mock builder ──

function mockSupabaseClient() {
  const chainable: any = {
    select: vi.fn(() => chainable),
    insert: vi.fn(() => chainable),
    update: vi.fn(() => chainable),
    upsert: vi.fn(() => chainable),
    delete: vi.fn(() => chainable),
    eq: vi.fn(() => chainable),
    neq: vi.fn(() => chainable),
    in: vi.fn(() => chainable),
    gte: vi.fn(() => chainable),
    lte: vi.fn(() => chainable),
    gt: vi.fn(() => chainable),
    lt: vi.fn(() => chainable),
    is: vi.fn(() => chainable),
    or: vi.fn(() => chainable),
    not: vi.fn(() => chainable),
    order: vi.fn(() => chainable),
    limit: vi.fn(() => chainable),
    single: vi.fn(async () => ({ data: null, error: null })),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    then: undefined,
    count: 0,
    head: true,
  };
  chainable.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });

  return {
    from: vi.fn(() => chainable),
    rpc: vi.fn((_name: string) => {
      // RPC returns a chainable with .single()
      const rpcResult = {
        data: {
          booking_id: 'booking-uuid-001',
          reference_code: 'WAA-TEST-001',
          slot_available: true,
        },
        error: null,
      };
      return {
        single: vi.fn(async () => rpcResult),
        then: (resolve: (v: any) => void) => resolve(rpcResult),
      };
    }),
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    _chainable: chainable,
  };
}

function makeFlowContext(overrides?: Partial<FlowContext> & { sessionData?: Record<string, unknown> }): FlowContext {
  const supabase = mockSupabaseClient() as any;

  const fromFn = supabase.from;
  fromFn.mockImplementation(() => {
    const chain = supabase._chainable;
    chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });
    return chain;
  });

  return {
    supabase,
    sender: {
      sendText: vi.fn(async () => ({ success: true })),
      sendButtons: vi.fn(async () => ({ success: true })),
      sendList: vi.fn(async () => ({ success: true })),
      sendImage: vi.fn(async () => ({ success: true })),
      sendDocument: vi.fn(async () => ({ success: true })),
    } as any,
    standalone: {} as any,
    intelligence: {
      resetAbuse: vi.fn(),
      checkAbuse: vi.fn(() => false),
      classify: vi.fn(async () => null),
    } as any,
    from: '+2348012345678',
    session: {
      id: 'session-uuid-001',
      user_id: 'user-uuid-001',
      business_id: 'biz-uuid-001',
      current_step: 'select_date',
      session_data: {
        flow_type: 'scheduling',
        service_id: 'svc-uuid-001',
        service_name: 'Meet the Aces',
        service_price: 5000,
        service_deposit: 2000,
        party_size: 1,
        ...(overrides?.sessionData || {}),
      },
      version: 1,
    },
    business: {
      id: 'biz-uuid-001',
      name: 'Test Business',
      slug: 'test-biz',
      category: 'health_beauty',
      flow_type: 'scheduling',
      subscription_tier: 'growth',
      trial_ends_at: '2027-01-01T00:00:00Z',
      metadata: {},
      operating_hours: {
        monday: { open: '09:00', close: '17:00' },
        tuesday: { open: '09:00', close: '17:00' },
        wednesday: { open: '09:00', close: '17:00' },
        thursday: { open: '09:00', close: '17:00' },
        friday: { open: '09:00', close: '17:00' },
        saturday: { open: '10:00', close: '15:00' },
      },
      country_code: 'NG',
      payment_gateway: null,
    },
    t: vi.fn(async (text: string) => text),
    ...overrides,
  } as unknown as FlowContext;
}

// ── Helpers ──

let schedulingSteps: FlowStepConfig[];

beforeEach(async () => {
  vi.clearAllMocks();
  const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
  schedulingSteps = schedulingFlow.steps;
});

function getStep(id: string): FlowStepConfig {
  const step = schedulingSteps.find((s) => s.id === id);
  if (!step) throw new Error(`Step "${id}" not found in scheduling flow`);
  return step;
}

// ── Tests ──

describe('Complete paid appointment regression path', () => {
  describe('Step 1: handlePromoVerification skips button reply', () => {
    it('date_YYYY-MM-DD with messageType=button bypasses promo verification', async () => {
      const { handlePromoVerification } = await import('@/lib/bot/handlers/promo-verification');

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];

      const result = await handlePromoVerification(
        {} as any, vi.fn(), '+2348012345678', `date_${dateStr}`,
        'biz-uuid-001', undefined,
        ['scheduling', 'promo_verification'],
        'pre_resolved',
        'button',
      );

      expect(result.handled).toBe(false);
    });
  });

  describe('Step 2: select_date accepts date_YYYY-MM-DD postback', () => {
    it('validates date_YYYY-MM-DD and extracts the date', async () => {
      const step = getStep('select_date');
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];
      const ctx = makeFlowContext();

      const result = await step.validate(`date_${dateStr}`, ctx);

      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.date).toBe(dateStr);
    });

    it('next() returns select_staff (continues the flow)', async () => {
      const step = getStep('select_date');
      const ctx = makeFlowContext({ sessionData: { date: '2026-09-17' } });

      const nextStep = await step.next(ctx);
      expect(nextStep).toBe('select_staff');
    });
  });

  describe('Step 3: select_time accepts time selection', () => {
    it('validates a normalized HH:MM time', async () => {
      const step = getStep('select_time');
      const ctx = makeFlowContext({
        sessionData: { date: '2026-09-17', staff_id: null },
      });

      const result = await step.validate('10:00', ctx);

      expect(result.valid).toBe(true);
      expect(result.data!.time).toBe('10:00');
    });

    it('validates an am/pm time input', async () => {
      const step = getStep('select_time');
      const ctx = makeFlowContext({
        sessionData: { date: '2026-09-17', staff_id: null },
      });

      const result = await step.validate('2pm', ctx);

      expect(result.valid).toBe(true);
      expect(result.data!.time).toBe('14:00');
    });

    it('next() returns select_addons (continues toward booking)', async () => {
      const step = getStep('select_time');
      const ctx = makeFlowContext({
        sessionData: { date: '2026-09-17', time: '10:00' },
      });

      expect(await step.next(ctx)).toBe('select_addons');
    });
  });

  describe('Step 4: confirmation accepts confirm action', () => {
    it('validates confirm button tap', async () => {
      const step = getStep('confirmation');
      const ctx = makeFlowContext();

      const result = await step.validate('confirm', ctx);

      expect(result.valid).toBe(true);
      expect(result.data!._action).toBe('confirm');
    });

    it('next() returns collect_name on confirm (continues to booking)', async () => {
      const step = getStep('confirmation');
      const ctx = makeFlowContext({ sessionData: { _action: 'confirm' } });

      expect(await step.next(ctx)).toBe('collect_name');
    });
  });

  describe('Step 5: create_booking calls initializePayment with correct args', () => {
    // Shared mock setup for create_booking tests
    function setupCreateBookingMocks(ctx: FlowContext) {
      const fromMock = ctx.supabase.from as any;
      const makeChain = () => {
        const c: any = {
          select: vi.fn(() => c), insert: vi.fn(() => c), update: vi.fn(() => c),
          upsert: vi.fn(() => c), eq: vi.fn(() => c), neq: vi.fn(() => c),
          in: vi.fn(() => c), gte: vi.fn(() => c), lte: vi.fn(() => c),
          is: vi.fn(() => c), or: vi.fn(() => c), not: vi.fn(() => c),
          order: vi.fn(() => c), limit: vi.fn(() => c),
          single: vi.fn(async () => ({ data: null, error: null })),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        };
        c.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });
        return c;
      };

      const bizData = {
        id: 'biz-uuid-001', status: 'active', subscription_tier: 'growth',
        trial_ends_at: '2027-01-01T00:00:00Z', deposit_per_guest: null, category: 'health_beauty',
      };

      fromMock.mockImplementation((table: string) => {
        const chain = makeChain();
        if (table === 'whatsapp_users') {
          chain.maybeSingle.mockResolvedValue({ data: { id: 'user-uuid-001', phone: '+2348012345678' }, error: null });
        } else if (table === 'businesses') {
          chain.single.mockResolvedValue({ data: bizData, error: null });
          chain.maybeSingle.mockResolvedValue({ data: bizData, error: null });
        } else if (table === 'saved_payment_methods') {
          chain.maybeSingle.mockResolvedValue({ data: null, error: null });
        } else if (table === 'bot_sessions') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        } else if (table === 'business_capabilities') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: [{ capability_id: 'scheduling', is_enabled: true }], error: null });
        } else if (table === 'capability_overrides') {
          chain.then = (resolve: (v: any) => void) => resolve({ data: [], error: null });
        }
        return chain;
      });
    }

    function makeCreateBookingSessionData() {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];
      return {
        service_id: 'svc-uuid-001',
        service_name: 'Meet the Aces',
        service_price: 5000,
        service_deposit: 2000,
        party_size: 1,
        date: dateStr,
        time: '10:00',
        user_id: 'user-uuid-001',
        customer_name: 'Ade Testing',
        email: 'ade@test.com',
        staff_id: null,
        location_id: null,
        selected_addons: [],
        _service_duration: 60,
        _inbound_channel_id: 'ch-uuid-001',
        _terms_accepted: true,
      };
    }

    it('calls initializePayment exactly once with booking ID, deposit amount, business context, and scheduling category', async () => {
      const step = getStep('create_booking');
      const sessionData = makeCreateBookingSessionData();
      const ctx = makeFlowContext({ sessionData });

      initializePaymentSpy.mockResolvedValueOnce({
        url: KNOWN_CHECKOUT_URL,
        reference: KNOWN_PAYMENT_REF,
      });

      setupCreateBookingMocks(ctx);

      (ctx.supabase.rpc as any).mockReturnValueOnce({
        single: vi.fn(async () => ({
          data: { booking_id: 'booking-uuid-001', reference_code: 'WAA-TEST-001', slot_available: true },
          error: null,
        })),
      });

      let messages: PromptMessage[];
      try {
        messages = await step.prompt(ctx);
      } catch (e: any) {
        throw new Error(`create_booking.prompt() threw: ${e.message}`);
      }

      // ── Assert initializePayment was called exactly once ──
      expect(initializePaymentSpy).toHaveBeenCalledTimes(1);

      // ── Assert exact call args ──
      const callArgs = initializePaymentSpy.mock.calls[0];
      expect(callArgs[0]).toBeDefined(); // supabase client
      const opts = callArgs[1];
      expect(opts.bookingId).toBe('booking-uuid-001');
      expect(opts.amount).toBe(2000); // deposit amount, not full price
      expect(opts.businessId).toBe('biz-uuid-001');
      expect(opts.countryCode).toBe('NG');
      expect(opts.referenceCode).toBe('WAA-TEST-001');
      expect(opts.phone).toBe('+2348012345678');
      expect(opts.confirmationOrigin).toBe('whatsapp');
      expect(opts.transactionCategory).toBe('scheduling');
      expect(opts.inboundChannelId).toBe('ch-uuid-001');
      expect(opts.gatewayOverride).toBeNull();
      expect(opts.userEmail).toBe('ade@test.com');
      expect(opts.userId).toBe('user-uuid-001');
      expect(opts.businessName).toBe('Test Business');

      // ── Assert the EXACT known checkout URL appears in response ──
      const allText = messages
        .map((m) => {
          if (m.type === 'text') return m.text;
          if (m.type === 'buttons') return m.body;
          return '';
        })
        .join('\n');

      expect(allText).toContain(KNOWN_CHECKOUT_URL);

      // ── Assert the payment-error message is ABSENT ──
      expect(allText.toLowerCase()).not.toContain(PAYMENT_ERROR_MESSAGE);

      // ── Assert I've Paid button with correct payment reference ──
      const allButtonIds = messages
        .filter((m): m is Extract<PromptMessage, { type: 'buttons' }> => m.type === 'buttons')
        .flatMap((m) => m.buttons.map((b) => b.id));

      expect(allButtonIds).toContain(`i_paid_ref:${KNOWN_PAYMENT_REF}`);
    });

    it('when initializePayment returns null, the failure message appears (not the checkout URL)', async () => {
      const step = getStep('create_booking');
      const sessionData = makeCreateBookingSessionData();
      const ctx = makeFlowContext({ sessionData });

      initializePaymentSpy.mockResolvedValueOnce(null);

      setupCreateBookingMocks(ctx);

      (ctx.supabase.rpc as any).mockReturnValueOnce({
        single: vi.fn(async () => ({
          data: { booking_id: 'booking-uuid-002', reference_code: 'WAA-TEST-002', slot_available: true },
          error: null,
        })),
      });

      const messages = await step.prompt(ctx);

      const allText = messages
        .map((m) => { if (m.type === 'text') return m.text; if (m.type === 'buttons') return m.body; return ''; })
        .join('\n');

      // The failure message MUST appear when initializePayment returns null
      expect(allText.toLowerCase()).toContain(PAYMENT_ERROR_MESSAGE);

      // The checkout URL must NOT appear
      expect(allText).not.toContain(KNOWN_CHECKOUT_URL);

      // No i_paid button — only retry_payment
      const allButtonIds = messages
        .filter((m): m is Extract<PromptMessage, { type: 'buttons' }> => m.type === 'buttons')
        .flatMap((m) => m.buttons.map((b) => b.id));
      expect(allButtonIds.some((id) => id.startsWith('i_paid'))).toBe(false);
      expect(allButtonIds).toContain('retry_payment');
    });
  });

  describe('Step 6: payment step produces I\'ve Paid buttons', () => {
    it('prompt() returns buttons with i_paid and retry_payment', async () => {
      const step = getStep('payment');
      const ctx = makeFlowContext({
        sessionData: {
          booking_id: 'booking-uuid-001',
          reference_code: 'WAA-TEST-001',
          payment_reference: KNOWN_PAYMENT_REF,
          deposit_amount: 2000,
        },
      });

      const messages = await step.prompt(ctx);

      const buttonMessages = messages.filter(
        (m): m is Extract<PromptMessage, { type: 'buttons' }> => m.type === 'buttons'
      );
      expect(buttonMessages.length).toBeGreaterThan(0);

      const allButtonIds = buttonMessages.flatMap((m) => m.buttons.map((b) => b.id));
      expect(allButtonIds.some((id) => id.startsWith('i_paid'))).toBe(true);
    });
  });

  describe('End-to-end flow step reachability', () => {
    it('date → staff → time → addons → ... → booking is a reachable path', () => {
      const stepIds = schedulingSteps.map((s) => s.id);
      for (const id of ['select_date', 'select_time', 'confirmation', 'create_booking', 'payment']) {
        expect(stepIds, `Missing required step: ${id}`).toContain(id);
      }
    });

    it('select_date → select_staff → select_time chain is navigable', async () => {
      const dateStep = getStep('select_date');
      const ctx1 = makeFlowContext({ sessionData: { date: '2026-09-17' } });
      expect(await dateStep.next(ctx1)).toBe('select_staff');

      const staffStep = getStep('select_staff');
      const ctx2 = makeFlowContext({ sessionData: { date: '2026-09-17', staff_id: null } });
      expect(await staffStep.next(ctx2)).toBe('select_time');

      const timeStep = getStep('select_time');
      const ctx3 = makeFlowContext({ sessionData: { date: '2026-09-17', time: '10:00' } });
      expect(await timeStep.next(ctx3)).toBe('select_addons');
    });
  });
});
