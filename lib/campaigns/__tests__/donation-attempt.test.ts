import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mock = vi.hoisted(() => ({ dispatch: vi.fn(), routing: vi.fn(), gateway: 'stripe' }));
vi.mock('@/lib/payments/factory', () => ({ getPaymentGatewayByName: () => ({ name: mock.gateway, initializePayment: mock.dispatch }), getPaymentGateway: vi.fn() }));
vi.mock('@/lib/payments/gateway-resolver', () => ({ resolveCountryGateway: vi.fn(), resolveBusinessGateway: async () => ({ gateway: mock.gateway, currency: 'USD' }) }));
vi.mock('@/lib/payments/resolve-stripe-routing', () => ({ resolvePaymentRoutingAuthority: mock.routing }));
vi.mock('@/lib/observability', () => ({ observe: (_name: unknown, _attrs: unknown, run: () => unknown) => run() }));
vi.mock('@/lib/trial-status', () => ({ resolveTrialStatus: async () => false }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
import { initializePayment } from '@/lib/bot/flows/shared/payment';

type Row = Record<string, any>;
function database(v1 = false) {
  const payments: Row[] = [];
  const donations: Row[] = [];
  let rejectIntent = false;
  const db = {
    from(table: string) {
      let mode = 'read'; let payload: Row = {}; const filters: Array<(row: Row) => boolean> = [];
      const query: any = {
        select: () => query, order: () => query, limit: () => query, lte: () => query,
        like: (key: string, value: string) => { filters.push(row => typeof row[key] === 'string' && row[key].startsWith(value.replace('%', ''))); return query; },
        is: (key: string, value: unknown) => { filters.push(row => (key === 'metadata->>campaign_web_attempt' ? row.metadata?.campaign_web_attempt ?? null : row[key]) === value); return query; },
        eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
        insert: (row: Row) => { mode = 'insert'; payload = row; return query; },
        update: (row: Row) => { mode = 'update'; payload = row; return query; },
        single: () => execute(true), maybeSingle: () => execute(true),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(execute(false)).then(resolve),
      };
      function execute(single: boolean) {
        if (table === 'platform_config_versions') return { data: { id: 'config', config_snapshot: {
          fee_policy_enabled: v1, pricing_tiers: { free: { feePercentage: 5, feeFlat: 0 } }, category_fee_rates: { giving: { feePercentage: 2 } },
        } }, error: null };
        if (table === 'businesses') return { data: { subscription_tier: 'free', payment_channels: null }, error: null };
        if (table !== 'payments') throw new Error(`Unexpected table ${table}`);
        if (mode === 'insert') {
          if (payments.some(row => row.id === payload.id || row.gateway_reference === payload.gateway_reference)) return { data: null, error: { code: '23505' } };
          payments.push(structuredClone(payload));
          return { data: single ? payload : [payload], error: null };
        }
        const selected = payments.filter(row => filters.every(filter => filter(row)));
        if (mode === 'update') selected.forEach(row => Object.assign(row, structuredClone(payload)));
        return { data: single ? selected[0] || null : selected, error: null };
      }
      return query;
    },
    async rpc(name: string, input: Row) {
      expect(name).toBe('ensure_campaign_donation_intent_for_payment');
      if (rejectIntent) return { data: null, error: { message: 'failed' } };
      const old = donations.find(row => row.payment_id === input.p_payment_id);
      if (old && (old.phone !== input.p_donor_phone || old.name !== input.p_donor_name)) return { data: { reason: 'donor_identity_mismatch' }, error: null };
      if (!old) donations.push({ payment_id: input.p_payment_id, phone: input.p_donor_phone, name: input.p_donor_name });
      return { data: { donation_id: 'donation', created: !old, already_existed: !!old }, error: null };
    },
  };
  return { db: db as unknown as SupabaseClient, payments, donations, reject: () => { rejectIntent = true; } };
}
const options = {
  businessId: 'business', campaignId: 'campaign', campaignAttemptKey: 'attempt-a', userId: null,
  phone: '+12025550123', donorName: 'Donor', amount: 25, referenceCode: 'DON-attempt-a',
  businessName: 'Business', confirmationOrigin: 'web' as const, transactionCategory: 'giving',
};
beforeEach(() => {
  vi.clearAllMocks(); mock.gateway = 'stripe'; mock.routing.mockResolvedValue({});
  mock.dispatch.mockImplementation(async (input: Row) => ({ url: `https://checkout.test/${input.existingPaymentId}`, reference: `provider-${input.referenceCode}` }));
});

describe.each([false, true])('campaign attempt, fee policy %s', v1 => {
  it.each([
    ['stripe', {}], ['stripe', { stripeAccountId: 'acct_merchant', providerConnectionId: 'connection' }],
    ['paystack', {}], ['paystack', { isByo: true, byoSecretKey: 'test-merchant', byoPlatformSubaccount: 'split', byoBusinessId: 'business', providerConnectionId: 'connection' }],
  ])('preserves %s custody routing %j', async (gateway, routing) => {
    mock.gateway = gateway as string; mock.routing.mockResolvedValue(routing);
    const state = database(v1);
    expect(await initializePayment(state.db, options)).not.toBeNull();
    const { providerConnectionId, ...providerRouting } = routing as Record<string, unknown>;
    expect(mock.dispatch).toHaveBeenCalledWith(expect.objectContaining(providerRouting));
    if (providerConnectionId) expect(state.payments[0].metadata.provider_connection_id).toBe(providerConnectionId);
    expect(state.payments[0].business_id).toBe('business');
    expect(state.payments[0].metadata.campaign_web_attempt).toBe(true);
    expect(state.payments[0].metadata._confirmation_origin).toBe('web');
  });

  it('legacy campaign lookup does not reuse a public-web donor checkout', async () => {
    const state = database(v1);
    await initializePayment(state.db, options);
    const legacy = await initializePayment(state.db, { ...options, campaignAttemptKey: undefined, referenceCode: 'DON-legacy' });
    expect(legacy?.url).not.toBe(`https://checkout.test/${state.payments[0].id}`);
    expect(mock.dispatch).toHaveBeenCalledTimes(2);
  });

  it('reuses one donor attempt and links intent before provider dispatch', async () => {
    const state = database(v1);
    mock.dispatch.mockImplementation(async (input: Row) => {
      expect(state.donations.find(row => row.payment_id === input.existingPaymentId)).toBeTruthy();
      expect(state.payments[0].metadata._confirmation_origin).toBe('web');
      return { url: 'https://checkout.test/one', reference: 'provider-one' };
    });
    const first = await initializePayment(state.db, options);
    expect(first?.url).toBe('https://checkout.test/one');
    expect(await initializePayment(state.db, options)).toEqual(first);
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
    expect(state.payments).toHaveLength(1);
  });
  it('separates two donors and a second donation from the same donor', async () => {
    const state = database(v1);
    await initializePayment(state.db, options);
    await initializePayment(state.db, { ...options, phone: '+12025550124', campaignAttemptKey: 'attempt-b', referenceCode: 'DON-b' });
    await initializePayment(state.db, { ...options, campaignAttemptKey: 'attempt-c', referenceCode: 'DON-c' });
    expect(mock.dispatch).toHaveBeenCalledTimes(3);
    expect(new Set(state.payments.map(row => row.id)).size).toBe(3);
  });
  it('allows only one concurrent dispatch for an attempt', async () => {
    const state = database(v1);
    await Promise.all([initializePayment(state.db, options), initializePayment(state.db, options)]);
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
  });
  it('never redispatches an ambiguous provider response', async () => {
    const state = database(v1); mock.dispatch.mockResolvedValue(null);
    expect(await initializePayment(state.db, options)).toBeNull();
    expect(await initializePayment(state.db, options)).toBeNull();
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
    expect(state.payments[0].provider_init_state).toBe('dispatched');
  });
  it('blocks changed amount, donor identity, and quarantine on reuse', async () => {
    const state = database(v1); await initializePayment(state.db, options);
    expect(await initializePayment(state.db, { ...options, amount: 26 })).toBeNull();
    expect(await initializePayment(state.db, { ...options, donorName: 'Other' })).toBeNull();
    state.payments[0].gateway_status = 'review_required:amount';
    expect(await initializePayment(state.db, options)).toBeNull();
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
  });
  it('blocks provider dispatch when donation intent cannot be verified', async () => {
    const state = database(v1); state.reject();
    expect(await initializePayment(state.db, options)).toBeNull();
    expect(mock.dispatch).not.toHaveBeenCalled();
  });
  it('keeps terminal callback state when it arrives before initialization returns', async () => {
    const state = database(v1);
    mock.dispatch.mockImplementation(async () => {
      expect(state.donations).toHaveLength(1);
      // Existing Stripe webhook resolves the pre-provider reference and repairs it before finalizing.
      const row = state.payments.find(row => row.gateway_reference === options.referenceCode)!;
      Object.assign(row, { gateway_reference: 'provider-fast', provider_init_state: 'provider_confirmed', status: 'success' });
      return { url: 'https://checkout.test/paid', reference: 'provider-fast' };
    });
    expect(await initializePayment(state.db, options)).toBeNull();
    expect(state.payments[0].status).toBe('success');
    expect(await initializePayment(state.db, options)).toBeNull();
    expect(mock.dispatch).toHaveBeenCalledTimes(1);
  });
});
