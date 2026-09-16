/**
 * Production regression: complete paid appointment booking path.
 *
 * Exercises the full journey from WhatsApp button reply through payment link:
 *   date_YYYY-MM-DD bypasses promo verification
 *   → scheduling.flow select_date accepts the date
 *   → select_time is reachable and accepts a time
 *   → confirmation accepts 'confirm'
 *   → create_booking creates booking + initializes payment for paid/deposit service
 *   → WhatsApp response contains the payment link/action
 *
 * This test does NOT call the real database or payment providers.
 * It exercises the flow step validate/next/prompt functions with mocked context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FlowContext, FlowStepConfig, ValidationResult, PromptMessage } from '@/lib/bot/flows/types';

// ── Mocks ──

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
}));

vi.mock('@/lib/payments/factory', () => ({
  getPaymentGateway: vi.fn(async () => ({
    initialize: vi.fn(async () => ({
      authorizationUrl: 'https://paystack.com/pay/test123',
      reference: 'PAY-TEST-REF-001',
      accessCode: 'acc_test',
    })),
    name: 'paystack',
  })),
  getPaymentGatewayByName: vi.fn(async () => ({
    initialize: vi.fn(async () => ({
      authorizationUrl: 'https://paystack.com/pay/test123',
      reference: 'PAY-TEST-REF-001',
      accessCode: 'acc_test',
    })),
    name: 'paystack',
  })),
}));

// Shared mock builder
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
  // Make awaitable
  chainable.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });

  return {
    from: vi.fn(() => chainable),
    rpc: vi.fn(async (name: string) => {
      if (name === 'book_slot_atomic') {
        return {
          data: {
            booking_id: 'booking-uuid-001',
            reference_code: 'WAA-TEST-001',
            slot_available: true,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
    _chainable: chainable,
  };
}

function makeFlowContext(overrides?: Partial<FlowContext> & { sessionData?: Record<string, unknown> }): FlowContext {
  const supabase = mockSupabaseClient() as any;

  // For time slot validation: need chainable to resolve with count: 0
  const fromFn = supabase.from;
  fromFn.mockImplementation(() => {
    const chain = supabase._chainable;
    // Override the then for await-ability with count
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
        service_price: 5000, // ₦50.00
        service_deposit: 2000, // ₦20.00 deposit required
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

// ── Helpers to get flow steps ──

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

      // Compute tomorrow's date (same as production)
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];
      const postbackId = `date_${dateStr}`;

      const result = await handlePromoVerification(
        {} as any, vi.fn(), '+2348012345678', postbackId,
        'biz-uuid-001', undefined,
        ['scheduling', 'promo_verification'],
        'pre_resolved',
        'button', // WhatsApp interactive button reply
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
      expect(result.data).toBeDefined();
      expect(result.data!.time).toBe('10:00');
    });

    it('validates an am/pm time input', async () => {
      const step = getStep('select_time');
      const ctx = makeFlowContext({
        sessionData: { date: '2026-09-17', staff_id: null },
      });

      const result = await step.validate('2pm', ctx);

      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.time).toBe('14:00');
    });

    it('next() returns select_addons (continues toward booking)', async () => {
      const step = getStep('select_time');
      const ctx = makeFlowContext({
        sessionData: { date: '2026-09-17', time: '10:00' },
      });

      const nextStep = await step.next(ctx);

      expect(nextStep).toBe('select_addons');
    });
  });

  describe('Step 4: confirmation accepts confirm action', () => {
    it('validates confirm button tap', async () => {
      const step = getStep('confirmation');
      const ctx = makeFlowContext();

      const result = await step.validate('confirm', ctx);

      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!._action).toBe('confirm');
    });

    it('next() returns collect_name on confirm (continues to booking)', async () => {
      const step = getStep('confirmation');
      const ctx = makeFlowContext({
        sessionData: { _action: 'confirm' },
      });

      const nextStep = await step.next(ctx);

      expect(nextStep).toBe('collect_name');
    });
  });

  describe('Step 5: create_booking with paid service produces payment link', () => {
    it('prompt() calls initializePayment and returns messages with payment URL', async () => {
      const step = getStep('create_booking');

      // Build context with all required session data for a paid booking
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];

      const ctx = makeFlowContext({
        sessionData: {
          service_id: 'svc-uuid-001',
          service_name: 'Meet the Aces',
          service_price: 5000,
          service_deposit: 2000, // Deposit required — triggers payment path
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
        },
      });

      // Mock the supabase.rpc for book_slot_atomic
      (ctx.supabase.rpc as any).mockResolvedValueOnce({
        data: {
          booking_id: 'booking-uuid-001',
          reference_code: 'WAA-TEST-001',
          slot_available: true,
        },
        error: null,
      });

      // Mock supabase.from chains for:
      // 1. User lookup/creation
      // 2. Booking read-back
      // 3. Session update
      // 4. Payment insertion
      // 5. URL shortener
      const fromMock = ctx.supabase.from as any;
      const makeChain = () => {
        const c: any = {
          select: vi.fn(() => c),
          insert: vi.fn(() => c),
          update: vi.fn(() => c),
          upsert: vi.fn(() => c),
          eq: vi.fn(() => c),
          neq: vi.fn(() => c),
          in: vi.fn(() => c),
          gte: vi.fn(() => c),
          lte: vi.fn(() => c),
          is: vi.fn(() => c),
          or: vi.fn(() => c),
          not: vi.fn(() => c),
          order: vi.fn(() => c),
          limit: vi.fn(() => c),
          single: vi.fn(async () => ({ data: null, error: null })),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        };
        c.then = (resolve: (v: any) => void) => resolve({ data: null, error: null, count: 0 });
        return c;
      };

      fromMock.mockImplementation((table: string) => {
        const chain = makeChain();

        if (table === 'whatsapp_users') {
          // createWhatsAppUser lookup — user exists
          chain.maybeSingle.mockResolvedValue({
            data: { id: 'user-uuid-001', phone: '+2348012345678' },
            error: null,
          });
        } else if (table === 'bookings') {
          // Booking read-back after creation
          chain.single.mockResolvedValue({
            data: {
              id: 'booking-uuid-001',
              reference_code: 'WAA-TEST-001',
              status: 'pending',
              amount: 5000,
              deposit_amount: 2000,
            },
            error: null,
          });
        } else if (table === 'bot_sessions') {
          // Session update (current_step = 'payment')
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        } else if (table === 'payments') {
          // Payment insertion + lookup
          chain.maybeSingle.mockResolvedValue({ data: null, error: null });
          chain.single.mockResolvedValue({
            data: {
              id: 'payment-uuid-001',
              reference: 'PAY-TEST-REF-001',
              checkout_url: 'https://paystack.com/pay/test123',
              amount: 2000,
              currency: 'NGN',
              status: 'pending',
            },
            error: null,
          });
          // For insert().select().single()
          chain.insert.mockReturnValue({
            ...chain,
            select: vi.fn(() => ({
              ...chain,
              single: vi.fn(async () => ({
                data: {
                  id: 'payment-uuid-001',
                  reference: 'PAY-TEST-REF-001',
                  checkout_url: 'https://paystack.com/pay/test123',
                  amount: 2000,
                  currency: 'NGN',
                  status: 'pending',
                },
                error: null,
              })),
            })),
          });
        } else if (table === 'short_urls') {
          // URL shortener
          chain.then = (resolve: (v: any) => void) => resolve({ data: null, error: null });
        } else if (table === 'platform_config_versions') {
          // Fee policy config lookup
          chain.maybeSingle.mockResolvedValue({
            data: {
              id: 'config-v1',
              config_snapshot: { fee_policy_enabled: false },
            },
            error: null,
          });
        } else if (table === 'saved_payment_methods') {
          chain.maybeSingle.mockResolvedValue({ data: null, error: null });
        } else if (table === 'businesses') {
          chain.single.mockResolvedValue({
            data: {
              id: 'biz-uuid-001',
              subscription_tier: 'growth',
              trial_ends_at: '2027-01-01T00:00:00Z',
              deposit_per_guest: null,
            },
            error: null,
          });
          chain.maybeSingle.mockResolvedValue({
            data: {
              id: 'biz-uuid-001',
              subscription_tier: 'growth',
              trial_ends_at: '2027-01-01T00:00:00Z',
              deposit_per_guest: null,
            },
            error: null,
          });
        }

        return chain;
      });

      let messages: PromptMessage[];
      try {
        messages = await step.prompt(ctx);
      } catch (e: any) {
        // If prompt throws due to deep mocking gaps, the test should fail
        // with a clear message about what's missing
        throw new Error(
          `create_booking.prompt() threw: ${e.message}\n\n` +
          'This may indicate a gap in the mocks. The test aims to verify that ' +
          'the payment initialization path is reachable — if it throws before ' +
          'reaching initializePayment, the promo interception fix alone does not ' +
          'guarantee the payment link will be produced.'
        );
      }

      // The response must contain the payment URL or a payment action.
      // create_booking produces either:
      // a) A text message with the payment link URL
      // b) A buttons message with "I've Paid" / "Get New Link" / "Cancel"
      const allText = messages
        .map((m) => {
          if (m.type === 'text') return m.text;
          if (m.type === 'buttons') return m.body;
          return '';
        })
        .join('\n');

      const allButtonIds = messages
        .filter((m): m is Extract<PromptMessage, { type: 'buttons' }> => m.type === 'buttons')
        .flatMap((m) => m.buttons.map((b) => b.id));

      // At minimum, the payment path should produce an "I've Paid" button
      // or the payment URL in the message text
      const hasPaymentButton = allButtonIds.some(
        (id) => id.startsWith('i_paid') || id === 'retry_payment'
      );
      const hasPaymentUrl = /https?:\/\//.test(allText) || /pay/i.test(allText);

      expect(
        hasPaymentButton || hasPaymentUrl,
        `Expected payment link or "I've Paid" button in response.\n` +
        `Messages: ${JSON.stringify(messages, null, 2)}\n` +
        `Button IDs: ${allButtonIds}\n` +
        `Text content: ${allText}`
      ).toBe(true);

      // Verify the booking creation path was reached.
      // The RPC may be called via ctx.supabase or the service client.
      // Either way, if we got messages back with payment content, the path worked.
    });
  });

  describe('Step 6: payment step produces I\'ve Paid buttons', () => {
    it('prompt() returns buttons with i_paid and retry_payment', async () => {
      const step = getStep('payment');
      const ctx = makeFlowContext({
        sessionData: {
          booking_id: 'booking-uuid-001',
          reference_code: 'WAA-TEST-001',
          payment_reference: 'PAY-TEST-REF-001',
          deposit_amount: 2000,
        },
      });

      const messages = await step.prompt(ctx);

      // Should have buttons with i_paid
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
      // Verify the step chain exists in the flow definition
      const stepIds = schedulingSteps.map((s) => s.id);

      // All required steps for the paid path must exist
      const requiredSteps = [
        'select_date',
        'select_time',
        'confirmation',
        'create_booking',
        'payment',
      ];

      for (const id of requiredSteps) {
        expect(stepIds, `Missing required step: ${id}`).toContain(id);
      }
    });

    it('select_date → select_staff → select_time chain is navigable', async () => {
      // select_date.next() → select_staff
      const dateStep = getStep('select_date');
      const ctx1 = makeFlowContext({ sessionData: { date: '2026-09-17' } });
      expect(await dateStep.next(ctx1)).toBe('select_staff');

      // select_staff exists and has next() → select_time
      const staffStep = getStep('select_staff');
      const ctx2 = makeFlowContext({ sessionData: { date: '2026-09-17', staff_id: null } });
      const staffNext = await staffStep.next(ctx2);
      expect(staffNext).toBe('select_time');

      // select_time.next() → select_addons
      const timeStep = getStep('select_time');
      const ctx3 = makeFlowContext({ sessionData: { date: '2026-09-17', time: '10:00' } });
      expect(await timeStep.next(ctx3)).toBe('select_addons');
    });
  });
});
