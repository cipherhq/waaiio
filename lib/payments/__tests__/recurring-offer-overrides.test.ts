/**
 * recurring-offer capability_overrides fix tests.
 *
 * Validates:
 * - Override query via service client (not business column)
 * - Cross-business rejection (Safeguard B)
 * - Override query failure → silent return (Safeguard A)
 * - Payment finalization preserved when recurring offer fails
 * - Eligibility with overrides present
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BIZ_ID = 'test-biz-recurring';
const PAYMENT_ID = 'test-pay-recurring';
const BOOKING_ID = 'test-booking-recurring';
const SERVICE_ID = 'test-svc-recurring';
const PROFILE_ID = 'test-profile-recurring';

// Standard test data
const successPayment = {
  id: PAYMENT_ID,
  status: 'success',
  gateway: 'paystack',
  metadata: { _card_authorization: { reusable: true } },
  finalization_completed_at: '2026-01-01',
  confirmation_sent_at: '2026-01-01',
  business_id: BIZ_ID,
};

const paymentBooking = {
  flow_type: 'payment',
  service_id: SERVICE_ID,
  business_id: BIZ_ID,
};

const recurringService = {
  billing_type: 'recurring',
  recurring_interval: 'monthly',
  service_type: 'giving',
  is_active: true,
  business_id: BIZ_ID,
};

const eligibleBusiness = {
  id: BIZ_ID,
  name: 'Test Church',
  recurring_enabled: true,
  country_code: 'NG',
  subscription_tier: 'growth',
  trial_ends_at: null,
  category: 'church',
};

interface MockOpts {
  payment?: Record<string, unknown> | null;
  booking?: Record<string, unknown> | null;
  service?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  overrides?: string[];
  overrideError?: { message: string } | null;
  configOk?: boolean;
  capabilities?: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
  profile?: Record<string, unknown> | null;
  existingSub?: Record<string, unknown> | null;
  offerResult?: Record<string, unknown> | null;
  offerError?: { message: string } | null;
}

function createMockSupabase(opts: MockOpts) {
  const tableData: Record<string, unknown> = {
    payments: opts.payment ?? successPayment,
    bookings: opts.booking ?? paymentBooking,
    services: opts.service ?? recurringService,
    businesses: opts.business ?? eligibleBusiness,
    profiles: opts.profile ?? { id: PROFILE_ID },
    customer_subscriptions: opts.existingSub ?? null,
  };

  return {
    from: (table: string) => ({
      select: () => {
        const chain: Record<string, (...args: unknown[]) => unknown> = {};
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.or = () => chain;
        chain.limit = () => chain;
        chain.order = () => chain;
        chain.single = () => Promise.resolve({ data: tableData[table] ?? null, error: null });
        chain.maybeSingle = () => Promise.resolve({ data: tableData[table] ?? null, error: null });
        return chain;
      },
    }),
    rpc: vi.fn().mockResolvedValue({
      data: opts.offerResult ?? { created: true, intent_id: 'intent-1' },
      error: opts.offerError ?? null,
    }),
  };
}

function createMockServiceClient(opts: MockOpts) {
  const overrideRows = (opts.overrides || []).map(c => ({ capability: c }));
  // Supabase builders are thenables — .eq() returns an object with .then()
  function makeThenable(data: unknown, error: unknown) {
    const obj: Record<string, unknown> = {
      eq: () => obj,
      single: () => Promise.resolve({ data, error }),
      maybeSingle: () => Promise.resolve({ data, error }),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve({ data, error }).then(resolve, reject),
    };
    return obj;
  }
  return {
    from: (table: string) => ({
      select: () => {
        if (table === 'capability_overrides') {
          return makeThenable(overrideRows, opts.overrideError ?? null);
        }
        return makeThenable(null, null);
      },
    }),
  };
}

describe('recurring-offer capability_overrides fix', () => {
  let checkAndOfferRecurring: typeof import('@/lib/payments/recurring-offer').checkAndOfferRecurring;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup(opts: MockOpts = {}) {
    const mockServiceClient = createMockServiceClient(opts);

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue(mockServiceClient),
    }));

    vi.doMock('@/lib/capabilities/service', () => ({
      getConfiguredCapabilities: vi.fn().mockResolvedValue({
        ok: opts.configOk !== false,
        rows: opts.capabilities || [{ capability: 'recurring', is_enabled: true, sort_order: 0 }],
      }),
    }));

    vi.doMock('@/lib/capabilities/legacy-defaults', () => ({
      getLegacyDefaultCapabilities: vi.fn().mockReturnValue(['scheduling']),
    }));

    vi.doMock('@/lib/trial-status', () => ({
      resolveTrialCredit: vi.fn().mockResolvedValue(false),
    }));

    vi.doMock('@/lib/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
      },
    }));

    const mod = await import('@/lib/payments/recurring-offer');
    checkAndOfferRecurring = mod.checkAndOfferRecurring;

    return { supabase: createMockSupabase(opts) };
  }

  it('cross-business payment mismatch returns silently (Safeguard B)', async () => {
    const { supabase } = await setup({
      payment: { ...successPayment, business_id: 'other-biz' },
    });

    // Should not throw — function NEVER affects payment finalization
    await checkAndOfferRecurring(
      supabase as any,
      { id: PAYMENT_ID, amount: 5000, booking_id: BOOKING_ID },
      BIZ_ID, null, '+2341234567890', '[test]',
    );

    // RPC should NOT have been called
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('cross-business booking mismatch returns silently (Safeguard B)', async () => {
    const { supabase } = await setup({
      booking: { ...paymentBooking, business_id: 'other-biz' },
    });

    await checkAndOfferRecurring(
      supabase as any,
      { id: PAYMENT_ID, amount: 5000, booking_id: BOOKING_ID },
      BIZ_ID, null, '+2341234567890', '[test]',
    );

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('override query failure returns silently (Safeguard A)', async () => {
    const { supabase } = await setup({
      overrideError: { message: 'permission denied for table capability_overrides' },
    });

    // Should not throw
    await checkAndOfferRecurring(
      supabase as any,
      { id: PAYMENT_ID, amount: 5000, booking_id: BOOKING_ID },
      BIZ_ID, null, '+2341234567890', '[test]',
    );

    // RPC should NOT have been called (failed before eligibility resolved)
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('payment finalization preserved when recurring offer throws', async () => {
    const { supabase } = await setup({
      offerError: { message: 'RPC timeout' },
    });

    // Must not throw even when RPC errors
    await expect(
      checkAndOfferRecurring(
        supabase as any,
        { id: PAYMENT_ID, amount: 5000, booking_id: BOOKING_ID },
        BIZ_ID, null, '+2341234567890', '[test]',
      ),
    ).resolves.toBeUndefined();
  });

  it('eligible path with overrides reaches RPC', async () => {
    const { supabase } = await setup({
      overrides: ['recurring'],
    });

    await checkAndOfferRecurring(
      supabase as any,
      { id: PAYMENT_ID, amount: 5000, booking_id: BOOKING_ID },
      BIZ_ID, null, '+2341234567890', '[test]',
    );

    expect(supabase.rpc).toHaveBeenCalledWith('create_recurring_offer', {
      p_source_payment_id: PAYMENT_ID,
      p_business_id: BIZ_ID,
      p_provider: 'paystack',
    });
  });
});
