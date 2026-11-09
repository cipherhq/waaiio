/**
 * Owner pricing decision 2026-11-08 (lane C): the merchant pays every
 * payment-gateway fee, and Waaiio's fee is the same on every route,
 * including bring-your-own (BYO) gateways.
 *
 * Behavioral tests: real Paystack initializer, real saved-card charge,
 * real recurring charge_authorization, real bot checkout initializer and
 * real fee calculator / fee ledger writer. Only provider HTTP (fetch) and
 * the Supabase client are mocked. The request body sent to Paystack is
 * asserted field by field.
 *
 * Paystack docs (Split Payments → "Bearer of transaction fee"): by default
 * Paystack charges are borne by the main account; `bearer: "subaccount"`
 * moves them to the subaccount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Responder = (table: string, op: 'select' | 'insert' | 'update', terminal: 'single' | 'maybeSingle' | 'list', payload: unknown) => { data: unknown; error: unknown };

/** Chainable Supabase mock: every builder method returns the chain; the terminal resolves via `respond`. */
function makeSupabase(respond: Responder) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const from = vi.fn((table: string) => {
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: unknown;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'not', 'in', 'is', 'like', 'order', 'limit', 'lte', 'gte', 'lt', 'gt']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.insert = vi.fn((p: unknown) => { op = 'insert'; payload = p; writes.push({ table, op, payload: p }); return chain; });
    chain.update = vi.fn((p: unknown) => { op = 'update'; payload = p; writes.push({ table, op, payload: p }); return chain; });
    chain.single = vi.fn(async () => respond(table, op, 'single', payload));
    chain.maybeSingle = vi.fn(async () => respond(table, op, 'maybeSingle', payload));
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(respond(table, op, 'list', payload)).then(res, rej);
    return chain;
  });
  return { client: { from, rpc: vi.fn(async () => ({ data: null, error: null })) }, writes };
}

function quietLogger() {
  vi.doMock('@/lib/logger', () => {
    const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
    l.withContext = () => l;
    return { logger: l };
  });
}

/** Captures every fetch call and returns a Paystack-shaped success. */
function stubPaystackFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Row }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers || {}) as Record<string, string>, body: JSON.parse(String(init?.body || '{}')) });
    const payload = url.includes('charge_authorization')
      ? { status: true, data: { status: 'success', reference: 'ref-x', id: 77 } }
      : { status: true, data: { authorization_url: 'https://checkout.paystack.test/x', reference: 'ref-x', access_code: 'ac' } };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const PLATFORM_KEY = 'sk_test_platform_unit';
const BYO_KEY = 'sk_test_merchant_unit';

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  process.env.PAYSTACK_SECRET_KEY = PLATFORM_KEY;
  quietLogger();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PAYSTACK_SECRET_KEY;
});

// ─────────────────────────────────────────────────────────────
// Split-parameter helpers
// ─────────────────────────────────────────────────────────────
describe('paystack-split helpers', () => {
  it('merchant split on Waaiio account: Waaiio keeps exactly its fee, merchant subaccount bears Paystack fee', async () => {
    const { paystackMerchantSplit } = await import('@/lib/payments/paystack-split');
    expect(paystackMerchantSplit('ACCT_merchant', 30000)).toEqual({
      subaccount: 'ACCT_merchant', transaction_charge: 30000, bearer: 'subaccount',
    });
  });

  it('merchant split with a 0 Waaiio fee sends transaction_charge 0 (never omitted) and names the merchant as bearer', async () => {
    const { paystackMerchantSplit } = await import('@/lib/payments/paystack-split');
    expect(paystackMerchantSplit('ACCT_merchant', 0)).toEqual({ subaccount: 'ACCT_merchant', transaction_charge: 0, bearer: 'subaccount' });
  });

  it('BYO reversed split: merchant (main account) keeps the rest and bears Paystack fee', async () => {
    const { paystackByoSplit } = await import('@/lib/payments/paystack-split');
    expect(paystackByoSplit('ACCT_waaiio', 970000)).toEqual({
      subaccount: 'ACCT_waaiio', transaction_charge: 970000, bearer: 'account',
    });
  });
});

// ─────────────────────────────────────────────────────────────
// One-off checkout — PaystackGateway.initializePayment
// ─────────────────────────────────────────────────────────────
describe('Paystack one-off checkout (real PaystackGateway)', () => {
  const base = {
    userId: 'u1', amount: 10000, currency: 'NGN', referenceCode: 'REF-1',
    businessName: 'Biz', phone: '+2348012345678', businessId: 'biz-1',
    existingPaymentId: 'pay-pre-1',
  };

  async function init(extra: Row) {
    const calls = stubPaystackFetch();
    const { client } = makeSupabase(() => ({ data: null, error: null }));
    const { PaystackGateway } = await import('@/lib/payments/paystack');
    const result = await new PaystackGateway().initializePayment({ supabase: client as never, ...base, ...extra });
    return { result, calls };
  }

  it('merchant split (direct_split): bearer=subaccount, transaction_charge = Waaiio fee only, Waaiio key', async () => {
    const { result, calls } = await init({ subaccountCode: 'ACCT_merchant', platformFeeAmount: 300 });
    expect(result?.url).toBe('https://checkout.paystack.test/x');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.paystack.co/transaction/initialize');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(calls[0].body.amount).toBe(1000000);
    expect(calls[0].body.subaccount).toBe('ACCT_merchant');
    expect(calls[0].body.transaction_charge).toBe(30000);
    expect(calls[0].body.bearer).toBe('subaccount');
  });

  it.each([
    ['fee 0', 0], ['fee not passed (bot checkout maps 0 to undefined)', undefined],
  ])('merchant split with %s: sends transaction_charge 0 so Paystack does not apply the subaccount default percentage', async (_label, fee) => {
    const { calls } = await init({ subaccountCode: 'ACCT_merchant', platformFeeAmount: fee });
    expect(calls[0].body.subaccount).toBe('ACCT_merchant');
    expect(calls[0].body.transaction_charge).toBe(0);
    expect(calls[0].body.bearer).toBe('subaccount');
  });

  it('BYO reversed split: merchant key, Waaiio subaccount gets the fee, merchant (main account) bears Paystack fee', async () => {
    const { calls } = await init({
      isByo: true, byoSecretKey: BYO_KEY, byoPlatformSubaccount: 'ACCT_waaiio',
      byoBusinessId: 'biz-1', platformFeeAmount: 300,
    });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${BYO_KEY}`);
    expect(calls[0].body.subaccount).toBe('ACCT_waaiio');
    expect(calls[0].body.transaction_charge).toBe(970000); // 10000 - 300 = 9700 NGN kept by merchant
    expect(calls[0].body.bearer).toBe('account');
  });

  it('Waaiio-collected (no split): no split params and no bearer — gateway fee is deducted from the merchant payout instead', async () => {
    const { calls } = await init({});
    expect(calls[0].headers.Authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect('subaccount' in calls[0].body).toBe(false);
    expect('transaction_charge' in calls[0].body).toBe(false);
    expect('bearer' in calls[0].body).toBe(false);
  });

  it('Paystack Connect: account-level split unchanged — no split params, no bearer', async () => {
    const { calls } = await init({ connectAccountId: 'CONNECT_1', platformFeeAmount: 300 });
    expect(calls[0].headers['X-Connect-Account']).toBe('CONNECT_1');
    expect('subaccount' in calls[0].body).toBe(false);
    expect('bearer' in calls[0].body).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Recurring / retry — chargeAuthorization
// ─────────────────────────────────────────────────────────────
describe('Paystack recurring charge_authorization (real chargeAuthorization)', () => {
  it('split recurring charge: merchant subaccount bears Paystack fee', async () => {
    const calls = stubPaystackFetch();
    const { chargeAuthorization } = await import('@/lib/payments/paystack-recurring');
    const r = await chargeAuthorization('AUTH_x', 500000, 'a@b.test', 'ref-rec', { subaccount: 'ACCT_merchant', transaction_charge: 15000 });
    expect(r.status).toBe('success');
    expect(calls[0].url).toBe('https://api.paystack.co/transaction/charge_authorization');
    expect(calls[0].body).toMatchObject({ subaccount: 'ACCT_merchant', transaction_charge: 15000, bearer: 'subaccount', amount: 500000 });
  });

  it('non-split recurring charge (Waaiio-collected): no bearer, no split params', async () => {
    const calls = stubPaystackFetch();
    const { chargeAuthorization } = await import('@/lib/payments/paystack-recurring');
    await chargeAuthorization('AUTH_x', 500000, 'a@b.test', 'ref-rec2');
    expect('bearer' in calls[0].body).toBe(false);
    expect('subaccount' in calls[0].body).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Saved card — chargeSavedCard (v0 live path and v1 pinned path)
// ─────────────────────────────────────────────────────────────
describe('Paystack saved-card charge (real chargeSavedCard)', () => {
  const savedMethod = {
    id: 'sm-1', authorization_email: 'a@b.test', gateway: 'paystack', authorization_code: 'AUTH_saved',
    customer_code: null, stripe_payment_method_id: null, stripe_customer_id: null, card_last4: '4242', card_brand: 'visa',
  };

  function savedCardDb(snapshot: Row | null) {
    return makeSupabase((table, op, terminal) => {
      if (table === 'payments' && op === 'select') return { data: null, error: null }; // no existing row
      if (table === 'payments' && op === 'insert') return { data: { id: 'pay-sc-1' }, error: null };
      if (table === 'payments' && op === 'update') return { data: terminal === 'list' ? [{ id: 'pay-sc-1' }] : { id: 'pay-sc-1' }, error: null };
      if (table === 'platform_config_versions') return snapshot ? { data: { id: 'cfg-1', config_snapshot: snapshot }, error: null } : { data: null, error: { message: 'none' } };
      if (table === 'businesses') return { data: { payout_mode: 'direct_split', subscription_tier: 'growth', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null }, error: null };
      if (table === 'payout_accounts') return { data: { subaccount_code: 'ACCT_merchant' }, error: null };
      return { data: null, error: null };
    });
  }

  it('v0 (fee policy off — live): split charge has bearer=subaccount and Waaiio fee only', async () => {
    vi.doMock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 1.5, feeFlat: 0, feeTotal: 150 }) }));
    vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
    const calls = stubPaystackFetch();
    const { client } = savedCardDb(null);
    const { chargeSavedCard } = await import('@/lib/payments/charge-saved');
    await chargeSavedCard(client as never, { savedMethod, amount: 10000, currency: 'NGN', email: 'a@b.test', reference: 'ref-sc', businessId: 'biz-1' });
    const charge = calls.find(c => c.url.includes('charge_authorization'));
    expect(charge).toBeDefined();
    expect(charge!.headers.Authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(charge!.body).toMatchObject({ subaccount: 'ACCT_merchant', transaction_charge: 15000, bearer: 'subaccount', amount: 1000000 });
  });

  it('v1 (pinned fee policy): split charge has bearer=subaccount and the pinned Waaiio fee only', async () => {
    vi.doMock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn() }));
    vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
    const calls = stubPaystackFetch();
    const { client } = savedCardDb({ fee_policy_enabled: true, pricing_tiers: { growth: { feePercentage: 1.5, feeFlat: 0 } } });
    const { chargeSavedCard } = await import('@/lib/payments/charge-saved');
    await chargeSavedCard(client as never, { savedMethod, amount: 10000, currency: 'NGN', email: 'a@b.test', reference: 'ref-sc1', businessId: 'biz-1', transactionCategory: 'scheduling' });
    const charge = calls.find(c => c.url.includes('charge_authorization'));
    expect(charge).toBeDefined();
    expect(charge!.body).toMatchObject({ subaccount: 'ACCT_merchant', transaction_charge: 15000, bearer: 'subaccount' });
  });
});

// ─────────────────────────────────────────────────────────────
// BYO fee — same plan rate on every route
// ─────────────────────────────────────────────────────────────
describe('BYO pays the same Waaiio fee (calculateFee)', () => {
  const snapshot = { pricing_tiers: { free: { feePercentage: 3, feeFlat: 0 }, growth: { feePercentage: 1.5, feeFlat: 0 }, business: { feePercentage: 1, feeFlat: 0 } } };
  const basis = (over: Row) => ({ payment_routing: 'byo', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null, ...over }) as never;

  it.each([
    ['free', 300], ['growth', 150], ['business', 100],
  ])('BYO %s tier on 10,000 → fee %d (same as platform route)', async (tier, fee) => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    const byo = calculateFee(10000, basis({ tier }), null, snapshot);
    const platform = calculateFee(10000, basis({ tier, payment_routing: 'platform' }), null, snapshot);
    const connect = calculateFee(10000, basis({ tier, payment_routing: 'connect' }), null, snapshot);
    expect(byo.feeTotal).toBe(fee);
    expect(platform.feeTotal).toBe(fee);
    expect(connect.feeTotal).toBe(fee);
  });

  it('the trial never waives the fee on any route (lane B, Owner 2026-11-08)', async () => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    expect(calculateFee(10000, basis({ is_in_trial: true }), null, snapshot).feeTotal)
      .toBe(calculateFee(10000, basis({ is_in_trial: false }), null, snapshot).feeTotal);
    expect(calculateFee(10000, basis({ is_in_trial: true }), null, snapshot).feeTotal).toBeGreaterThan(0);
  });
});

describe('BYO checkout collects the Waaiio fee through the reversed split (real initializePayment, v1)', () => {
  it('passes the plan-rate fee (not 0) to the gateway for a BYO business', async () => {
    let captured: Row | null = null;
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGatewayByName: vi.fn(() => ({
        name: 'paystack',
        initializePayment: vi.fn(async (o: Row) => { captured = o; return { url: 'https://checkout.paystack.test/x', reference: 'REF-BYO' }; }),
      })),
      getPaymentGateway: vi.fn(),
    }));
    vi.doMock('@/lib/payments/gateway-resolver', () => ({
      resolveBusinessGateway: vi.fn().mockResolvedValue({ gateway: 'paystack', currency: 'NGN', source: 'country_default' }),
      resolveCountryGateway: vi.fn(),
    }));
    vi.doMock('@/lib/payments/resolve-stripe-routing', () => ({
      resolvePaymentRoutingAuthority: vi.fn().mockResolvedValue({
        classification: 'byo', compatible: false, paymentOrigin: 'byo', stripeAccountId: null,
        platformFeeAmount: 300, providerConnectionId: 'cred-1', payoutAccountId: null, isByo: true,
        connectAccountId: null, subaccountCode: null, byoSecretKey: BYO_KEY, byoPlatformSubaccount: 'ACCT_waaiio',
        byoBusinessId: 'biz-1', squareMerchantId: null, squareAccessToken: null, feeBasis: null,
      }),
    }));
    vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));

    const { client, writes } = makeSupabase((table, op, terminal) => {
      if (table === 'platform_config_versions') return { data: { id: 'cfg-1', config_snapshot: { fee_policy_enabled: true, pricing_tiers: { free: { feePercentage: 3, feeFlat: 0 } } } }, error: null };
      if (table === 'businesses') return { data: { subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null, payment_channels: null }, error: null };
      if (table === 'payments' && op === 'insert') return { data: { id: 'pay-v1' }, error: null };
      if (table === 'payments' && op === 'update') return { data: terminal === 'list' ? [{ id: 'pay-v1' }] : { id: 'pay-v1' }, error: null };
      return { data: null, error: null };
    });

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment(client as never, {
      userId: 'u1', amount: 10000, referenceCode: 'REF-BYO', businessName: 'Biz', phone: '+2348012345678',
      businessId: 'biz-1', transactionCategory: 'scheduling',
    });

    expect(result?.url).toBe('https://checkout.paystack.test/x');
    expect(captured).not.toBeNull();
    expect(captured!.isByo).toBe(true);
    expect(captured!.byoPlatformSubaccount).toBe('ACCT_waaiio');
    expect(captured!.platformFeeAmount).toBe(300); // 3% Starter — previously forced to 0
    const preRow = writes.find(w => w.table === 'payments' && w.op === 'insert')!.payload as Row;
    expect((preRow.fee_basis as Row).payment_routing).toBe('byo');
  });
});

// ─────────────────────────────────────────────────────────────
// Ledger — platform_fees row for BYO records the Waaiio fee and gateway fee
// ─────────────────────────────────────────────────────────────
describe('Fee ledger (real recordPlatformFee)', () => {
  beforeEach(() => {
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
  });

  it('v1 BYO payment: fee_total = Waaiio plan fee, gateway_fee recorded, flagged as direct transfer (not in Waaiio payout pool)', async () => {
    vi.doMock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn() }));
    const { client, writes } = makeSupabase((table) => {
      if (table === 'platform_config_versions') return { data: { config_snapshot: { fee_policy_enabled: true, pricing_tiers: { free: { feePercentage: 3, feeFlat: 0 } } } }, error: null };
      if (table === 'businesses') return { data: { payout_mode: 'platform_managed', reseller_id: null }, error: null };
      return { data: null, error: null };
    });
    const { recordPlatformFee } = await import('@/lib/payments/process-success');
    await recordPlatformFee(client as never, {
      businessId: 'biz-1', paymentId: 'pay-1', paymentAmount: 10000, gatewayFee: 160,
      feePolicyVersion: 1, configVersionId: 'cfg-1', transactionCategory: 'scheduling',
      feeBasis: { payment_routing: 'byo', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null },
    });
    const fee = writes.find(w => w.table === 'platform_fees' && w.op === 'insert')!.payload as Row;
    expect(fee.fee_total).toBe(300);
    expect(fee.gateway_fee).toBe(160);
    expect(fee.is_direct_transfer).toBe(true);
  });

  it('v0 (live) BYO payment: fee_total = Waaiio plan fee (unchanged), gateway_fee recorded', async () => {
    vi.doMock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 3, feeFlat: 0, feeTotal: 300 }) }));
    const { client, writes } = makeSupabase((table) => {
      if (table === 'businesses') return { data: { subscription_tier: 'free', trial_ends_at: null, payout_mode: 'platform_managed', custom_fee_percentage: null, custom_fee_flat: null, reseller_id: null }, error: null };
      return { data: null, error: null };
    });
    const { recordPlatformFee } = await import('@/lib/payments/process-success');
    await recordPlatformFee(client as never, { businessId: 'biz-1', paymentId: 'pay-2', paymentAmount: 10000, gatewayFee: 160, paymentRouting: 'byo' });
    const fee = writes.find(w => w.table === 'platform_fees' && w.op === 'insert')!.payload as Row;
    expect(fee.fee_total).toBe(300);
    expect(fee.gateway_fee).toBe(160);
    expect(fee.is_direct_transfer).toBe(true);
  });

  it('duplicate fee insert (webhook + "I\'ve Paid" race) is idempotent — no throw, one logical fee', async () => {
    vi.doMock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 3, feeFlat: 0, feeTotal: 300 }) }));
    const { client } = makeSupabase((table, op) => {
      if (table === 'businesses') return { data: { subscription_tier: 'free', trial_ends_at: null, payout_mode: 'platform_managed', custom_fee_percentage: null, custom_fee_flat: null, reseller_id: null }, error: null };
      if (table === 'platform_fees' && op === 'insert') return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      return { data: null, error: null };
    });
    const { recordPlatformFee } = await import('@/lib/payments/process-success');
    await expect(recordPlatformFee(client as never, { businessId: 'biz-1', paymentId: 'pay-3', paymentAmount: 10000, paymentRouting: 'byo' })).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Refund path unchanged — split refunds still go to the original transaction
// ─────────────────────────────────────────────────────────────
describe('Paystack refund (real PaystackGateway.refundPayment) is unchanged by the fee-bearer change', () => {
  it('refund request carries only transaction + amount (no split/bearer fields)', async () => {
    const calls: Array<{ url: string; body: Row }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body || '{}')) });
      return { ok: true, json: async () => ({ status: true, data: { id: 9, status: 'processed' } }) } as unknown as Response;
    }));
    const { PaystackGateway } = await import('@/lib/payments/paystack');
    const r = await new PaystackGateway().refundPayment({ gatewayReference: 'ref-x', amount: 2500, currency: 'NGN' });
    expect(r.outcome).toBe('terminal_success');
    expect(calls[0].url).toBe('https://api.paystack.co/refund');
    expect(calls[0].body).toEqual({ transaction: 'ref-x', amount: 250000 });
  });
});

// ─────────────────────────────────────────────────────────────
// Direct-split one-off checkout uses the plan rate (Owner decision #958 rule 1)
// ─────────────────────────────────────────────────────────────
describe('direct_split one-off checkout fee (real resolvePaymentRoutingAuthority)', () => {
  beforeEach(() => {
    // Earlier blocks mock these modules; this block drives the real ones.
    vi.doUnmock('@/lib/payments/resolve-stripe-routing');
    vi.doUnmock('@/lib/payments/factory');
    vi.doUnmock('@/lib/payments/gateway-resolver');
    vi.doUnmock('@/lib/getPlatformFees');
    vi.doMock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({
      pricing_tiers: { free: { feePercentage: 3, feeFlat: 0 }, growth: { feePercentage: 1.5, feeFlat: 0 }, business: { feePercentage: 1, feeFlat: 0 } },
    }) }));
    vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
  });

  function routingDb(biz: Row, opts: { tierError?: boolean } = {}) {
    let businessReads = 0;
    return makeSupabase((table) => {
      if (table === 'business_payment_credentials') return { data: null, error: null }; // platform route
      if (table === 'businesses') {
        businessReads++;
        // 1st read: payout_mode; 2nd read: plan tier for the fee
        if (opts.tierError && businessReads > 1) return { data: null, error: { message: 'db down' } };
        return { data: { payout_mode: 'direct_split', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null, ...biz }, error: null };
      }
      if (table === 'payout_accounts') return { data: { id: 'pa-1', subaccount_code: 'ACCT_merchant', gateway: 'paystack', platform_percentage: 2.5, stripe_account_id: null, square_merchant_id: null, square_access_token: null }, error: null };
      return { data: null, error: null };
    });
  }

  it.each([['free', 300], ['growth', 150], ['business', 100]])(
    '%s merchant on 10,000 → fee %d (plan rate; legacy 2.5 percent setting ignored)', async (tier, fee) => {
      const { client } = routingDb({ subscription_tier: tier });
      const { resolvePaymentRoutingAuthority } = await import('@/lib/payments/resolve-stripe-routing');
      const r = await resolvePaymentRoutingAuthority(client as never, 'biz-1', 'paystack', 10000);
      expect(r?.subaccountCode).toBe('ACCT_merchant');
      expect(r?.payoutAccountId).toBe('pa-1');
      expect(r?.platformFeeAmount).toBe(fee);
    });

  it('per-business custom fee still applies on the split route', async () => {
    const { client } = routingDb({ subscription_tier: 'free', custom_fee_percentage: 2 });
    const { resolvePaymentRoutingAuthority } = await import('@/lib/payments/resolve-stripe-routing');
    expect((await resolvePaymentRoutingAuthority(client as never, 'biz-1', 'paystack', 10000))?.platformFeeAmount).toBe(200);
  });

  it('fails closed (no checkout) when the plan tier cannot be read', async () => {
    const { client } = routingDb({ subscription_tier: 'free' }, { tierError: true });
    const { resolvePaymentRoutingAuthority } = await import('@/lib/payments/resolve-stripe-routing');
    expect(await resolvePaymentRoutingAuthority(client as never, 'biz-1', 'paystack', 10000)).toBeNull();
  });

  it('end to end: the live Starter split merchant sends transaction_charge = 3% with bearer=subaccount', async () => {
    const { client } = routingDb({ subscription_tier: 'free' });
    const { resolvePaymentRoutingAuthority } = await import('@/lib/payments/resolve-stripe-routing');
    const r = await resolvePaymentRoutingAuthority(client as never, 'biz-1', 'paystack', 10000);
    const calls = stubPaystackFetch();
    const { PaystackGateway } = await import('@/lib/payments/paystack');
    await new PaystackGateway().initializePayment({
      supabase: makeSupabase(() => ({ data: null, error: null })).client as never,
      userId: 'u1', amount: 10000, currency: 'NGN', referenceCode: 'REF-DS', businessName: 'Biz',
      phone: '+2348012345678', businessId: 'biz-1', existingPaymentId: 'pay-ds',
      subaccountCode: r!.subaccountCode!, platformFeeAmount: r!.platformFeeAmount,
    });
    expect(calls[0].body).toMatchObject({ subaccount: 'ACCT_merchant', transaction_charge: 30000, bearer: 'subaccount' });
  });
});
