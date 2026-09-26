/**
 * #379 executable adapter regressions.
 *
 * These tests exercise the Stripe saved-payment adapter through its public
 * provider-neutral interface. They prove state transitions and side effects;
 * they do not inspect source text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockChargeStripeSavedCard = vi.fn();
const mockBuildSavedCardPIParams = vi.fn(() => ({
  customer: 'cus_test',
  payment_method: 'pm_test',
  amount: '12000',
  currency: 'usd',
  confirm: 'true',
  'payment_method_types[0]': 'card',
}));
const mockCreateAuthAttempt = vi.fn();
const mockReconcilePayment = vi.fn();
const mockRecoverDispatchedSavedCardPayment = vi.fn();

vi.mock('../payments/charge-saved', () => ({
  getSavedPaymentMethod: vi.fn().mockResolvedValue(null),
  chargeSavedCard: vi.fn(),
}));

vi.mock('../payments/saved-card-compat', () => ({
  canonicalSavedCardPhone: vi.fn((phone: string) => phone.startsWith('+') ? phone : `+${phone}`),
  isCompatibleForSavedCard: vi.fn().mockResolvedValue({ compatible: true }),
  isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: true }),
}));

vi.mock('../payments/resolve-stripe-routing', () => ({
  resolvePaymentRoutingAuthority: vi.fn().mockResolvedValue({
    classification: 'platform',
    compatible: true,
    paymentOrigin: 'platform',
    stripeAccountId: null,
    platformFeeAmount: 0,
  }),
  isStripeCompatibleForSavedCard: vi.fn().mockReturnValue(true),
}));

vi.mock('../payments/stripe-saved-card', () => ({
  buildSavedCardPIParams: (...args: unknown[]) => mockBuildSavedCardPIParams(...args),
  chargeStripeSavedCard: (...args: unknown[]) => mockChargeStripeSavedCard(...args),
  createAuthAttempt: (...args: unknown[]) => mockCreateAuthAttempt(...args),
}));

vi.mock('../payments/reconcile', () => ({
  reconcilePayment: (...args: unknown[]) => mockReconcilePayment(...args),
}));

vi.mock('../payments/saved-card-recovery', () => ({
  recoverDispatchedSavedCardPayment: (...args: unknown[]) => mockRecoverDispatchedSavedCardPayment(...args),
}));

import { savedPaymentAdapter } from '../payments/saved-payment-adapter';

const METHOD = {
  id: 'spm-stripe-1',
  gateway: 'stripe',
  authorization_code: null,
  customer_code: null,
  authorization_email: null,
  stripe_payment_method_id: 'pm_test',
  stripe_customer_id: 'cus_test',
  card_last4: '4242',
  card_brand: 'visa',
  pin_hash: null,
  pin_attempts: 0,
  pin_locked_until: null,
};

interface MockState {
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  updateFilters: Array<Array<[string, unknown]>>;
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
  events: string[];
}

function makeSupabase(opts: {
  existingPayment?: Record<string, unknown> | null;
  paymentId?: string;
  donationIntentResult?: { data?: unknown; error?: unknown };
} = {}) {
  const state: MockState = { inserts: [], updates: [], updateFilters: [], rpcCalls: [], events: [] };
  const paymentId = opts.paymentId || 'pay-new-1';

  const supabase = {
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      state.rpcCalls.push({ name, params });
      state.events.push(`rpc:${name}`);
      return opts.donationIntentResult || { data: { created: true, already_existed: false }, error: null };
    }),
    from: vi.fn((table: string) => {
      let operation: 'read' | 'insert' | 'update' = 'read';
      let filters: Array<[string, unknown]> = [];

      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        }),
        in: vi.fn((col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        }),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        insert: vi.fn((payload: Record<string, unknown>) => {
          operation = 'insert';
          state.inserts.push(payload);
          if (table === 'payments') state.events.push('payment_insert');
          return chain;
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          operation = 'update';
          state.updates.push(payload);
          state.updateFilters.push(filters);
          filters = [];
          return chain;
        }),
        maybeSingle: vi.fn(async () => {
          if (table === 'saved_payment_methods') {
            return { data: METHOD, error: null };
          }
          if (table === 'payments' && operation === 'read') {
            return { data: opts.existingPayment ?? null, error: null };
          }
          return { data: null, error: null };
        }),
        single: vi.fn(async () => {
          if (table === 'payments' && operation === 'insert') {
            return { data: { id: paymentId }, error: null };
          }
          return { data: null, error: null };
        }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const result = table === 'payments' && operation === 'update'
            ? { data: [{ id: paymentId }], error: null }
            : { data: null, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };

      return chain;
    }),
  };

  return { supabase: supabase as any, state };
}

const CHARGE_OPTS = {
  methodId: 'spm-stripe-1',
  customerPhone: '+15712746425',
  amount: 120,
  currency: 'USD',
  email: 'customer@example.com',
  reference: 'WA-BK-TEST-saved',
  businessId: 'biz-jshop',
  bookingId: 'booking-1',
  transactionCategory: 'scheduling',
  inboundChannelId: 'channel-jshop-1',
  confirmationOrigin: 'whatsapp' as const,
};

describe('#379 Stripe saved-payment adapter behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecoverDispatchedSavedCardPayment.mockResolvedValue({
      outcome: 'indeterminate',
      message: 'provider_dispatch_ambiguous',
    });
    mockBuildSavedCardPIParams.mockReturnValue({
      customer: 'cus_test',
      payment_method: 'pm_test',
      amount: '12000',
      currency: 'usd',
      confirm: 'true',
      'payment_method_types[0]': 'card',
    });
    mockReconcilePayment.mockResolvedValue({ lifecycle: { status: 'completed' } });
  });

  it('persists http status + type + code + classification on the same dispatched payment without marking it failed', async () => {
    mockChargeStripeSavedCard.mockResolvedValue({
      status: 'indeterminate',
      errorMessage: 'stripe_config_400:parameter_missing',
      errorEvidence: {
        httpStatus: 400,
        type: 'invalid_request_error',
        code: 'parameter_missing',
        classification: 'config_error',
      },
    });

    const { supabase, state } = makeSupabase({ paymentId: 'pay-evidence' });
    const result = await savedPaymentAdapter.chargeSavedMethod(supabase, CHARGE_OPTS);

    expect(result).toEqual({
      status: 'indeterminate',
      paymentId: 'pay-evidence',
      message: 'stripe_config_400:parameter_missing',
    });
    expect(state.inserts).toHaveLength(1);

    const evidenceUpdate = state.updates.find(u =>
      typeof u.gateway_status === 'string' && u.gateway_status.startsWith('dispatched_error;'),
    );
    expect(evidenceUpdate).toBeDefined();
    expect(evidenceUpdate!.gateway_status).toContain('http=400');
    expect(evidenceUpdate!.gateway_status).toContain('class=config_error');
    expect(evidenceUpdate!.gateway_status).toContain('type=invalid_request_error');
    expect(evidenceUpdate!.gateway_status).toContain('code=parameter_missing');
    expect(evidenceUpdate).not.toHaveProperty('status');
    expect(String(evidenceUpdate!.gateway_status)).not.toContain('Missing required parameter');

    // Canonical row was fenced before provider dispatch and remains the same row.
    expect(state.updates[0]).toEqual({ provider_init_state: 'dispatched' });
  });

  it('persists exact WhatsApp channel provenance on the canonical saved-card payment', async () => {
    mockChargeStripeSavedCard.mockResolvedValue({
      status: 'indeterminate',
      errorMessage: 'stripe_retryable_429:rate_limit',
      errorEvidence: {
        httpStatus: 429,
        type: 'rate_limit_error',
        code: 'rate_limit',
        classification: 'retryable',
      },
    });

    const { supabase, state } = makeSupabase({ paymentId: 'pay-channel' });
    await savedPaymentAdapter.chargeSavedMethod(supabase, CHARGE_OPTS);

    expect(state.inserts).toHaveLength(1);
    const metadata = state.inserts[0].metadata as Record<string, unknown>;
    expect(metadata._inbound_channel_id).toBe('channel-jshop-1');
    expect(metadata._confirmation_origin).toBe('whatsapp');
  });

  it('a second interaction with an existing dispatched payment does not insert or dispatch a second charge', async () => {
    const existing = {
      id: 'pay-existing',
      status: 'pending',
      gateway_reference: 'sc_pending_123',
      provider_init_state: 'dispatched',
    };
    const { supabase, state } = makeSupabase({ existingPayment: existing });

    const result = await savedPaymentAdapter.chargeSavedMethod(supabase, CHARGE_OPTS);

    expect(result).toEqual({
      status: 'indeterminate',
      paymentId: 'pay-existing',
      message: 'provider_dispatch_ambiguous',
    });
    expect(state.inserts).toHaveLength(0);
    expect(mockChargeStripeSavedCard).not.toHaveBeenCalled();
    expect(mockRecoverDispatchedSavedCardPayment).toHaveBeenCalledWith(supabase, 'pay-existing');
  });

  it('creates and verifies a campaign donation intent before Stripe dispatch', async () => {
    const { supabase, state } = makeSupabase({
      paymentId: 'pay-giving-new',
      donationIntentResult: { data: { created: false, reason: 'amount_mismatch' }, error: null },
    });

    const result = await savedPaymentAdapter.chargeSavedMethod(supabase, {
      ...CHARGE_OPTS,
      campaignId: 'campaign-1',
      customerPhone: '+15712746425',
      donorName: 'Ada Donor',
    });

    expect(result).toEqual({
      status: 'indeterminate',
      paymentId: 'pay-giving-new',
      message: 'Donation intent creation failed',
    });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ campaign_id: 'campaign-1', gateway: 'stripe' });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      name: 'ensure_campaign_donation_intent_for_payment',
      params: {
        p_payment_id: 'pay-giving-new',
        p_donor_phone: '+15712746425',
        p_donor_name: 'Ada Donor',
      },
    });
    expect(state.events).toEqual([
      'payment_insert',
      'rpc:ensure_campaign_donation_intent_for_payment',
    ]);
    expect(mockChargeStripeSavedCard).not.toHaveBeenCalled();
  });

  it('blocks existing campaign recovery before reconciliation when intent verification fails', async () => {
    const { supabase, state } = makeSupabase({
      existingPayment: {
        id: 'pay-giving-existing', status: 'pending', gateway_reference: 'pi_existing',
        provider_init_state: 'provider_confirmed',
      },
      donationIntentResult: { data: { created: false, reason: 'donor_identity_mismatch' }, error: null },
    });

    const result = await savedPaymentAdapter.chargeSavedMethod(supabase, {
      ...CHARGE_OPTS,
      campaignId: 'campaign-1',
      customerPhone: '+15712746425',
      donorName: 'Ada Donor',
    });

    expect(result).toEqual({
      status: 'indeterminate',
      paymentId: 'pay-giving-existing',
      message: 'Donation intent unavailable',
    });
    expect(state.rpcCalls).toHaveLength(1);
    expect(mockReconcilePayment).not.toHaveBeenCalled();
    expect(mockRecoverDispatchedSavedCardPayment).not.toHaveBeenCalled();
    expect(mockChargeStripeSavedCard).not.toHaveBeenCalled();
  });

  it('requires_action binds the PI to the canonical row before creating a durable Waaiio auth attempt', async () => {
    mockChargeStripeSavedCard.mockResolvedValue({
      status: 'requires_action',
      paymentIntentId: 'pi_requires_action',
      clientSecret: 'pi_secret_not_exposed',
    });
    mockCreateAuthAttempt.mockResolvedValue({
      authUrl: 'https://www.waaiio.com/payment-auth?t=signed',
      attemptId: 'attempt-1',
    });

    const { supabase, state } = makeSupabase({ paymentId: 'pay-3ds' });
    const result = await savedPaymentAdapter.chargeSavedMethod(supabase, CHARGE_OPTS);

    expect(result).toEqual({
      status: 'requires_provider_auth',
      authUrl: 'https://www.waaiio.com/payment-auth?t=signed',
      paymentId: 'pay-3ds',
    });

    const bindIndex = state.updates.findIndex(u =>
      u.gateway_reference === 'pi_requires_action' && u.provider_init_state === 'provider_confirmed',
    );
    expect(bindIndex).toBeGreaterThanOrEqual(0);
    expect(mockCreateAuthAttempt).toHaveBeenCalledWith(supabase, 'pay-3ds', '+15712746425');
  });

  it('provider success binds the PI and converges through canonical Payment Authority', async () => {
    mockChargeStripeSavedCard.mockResolvedValue({
      status: 'succeeded',
      paymentIntentId: 'pi_success',
    });

    const { supabase, state } = makeSupabase({ paymentId: 'pay-success' });
    const result = await savedPaymentAdapter.chargeSavedMethod(supabase, CHARGE_OPTS);

    expect(result).toEqual({ status: 'charged', paymentId: 'pay-success' });
    expect(state.updates).toContainEqual({
      gateway_reference: 'pi_success',
      provider_init_state: 'provider_confirmed',
    });
    expect(mockReconcilePayment).toHaveBeenCalledTimes(1);
    expect(mockReconcilePayment).toHaveBeenCalledWith(supabase, 'pay-success', 'saved_card');
  });

  it('uses the canonical payment row ID to derive the Stripe idempotency key', async () => {
    mockChargeStripeSavedCard.mockResolvedValue({
      status: 'indeterminate',
      errorMessage: 'stripe_retryable_429:rate_limit',
      errorEvidence: {
        httpStatus: 429,
        type: 'rate_limit_error',
        code: 'rate_limit',
        classification: 'retryable',
      },
    });

    const { supabase } = makeSupabase({ paymentId: 'pay-idem-42' });
    await savedPaymentAdapter.chargeSavedMethod(supabase, CHARGE_OPTS);

    expect(mockChargeStripeSavedCard).toHaveBeenCalledTimes(1);
    expect(mockChargeStripeSavedCard.mock.calls[0][0].idempotencyKey).toBe('sc_charge_pay-idem-42');
  });
});
