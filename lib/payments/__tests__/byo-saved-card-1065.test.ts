/**
 * #1065 step 1: Save Card on a merchant's own Paystack account (BYO).
 * A BYO card belongs to the merchant whose Paystack account took the payment (and stays
 * with it when the merchant re-enters its key, Owner decision 2026-11-16), is offered and
 * charged only at that merchant (with that merchant's key and the normal BYO reversed
 * split), and never mixes with the customer's Waaiio shared-account card.
 * Real saved-card-scope / saved-card-compat / charge-saved / saved-card-offer modules;
 * only the gateway resolver, routing authority, provider HTTP and the database are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  // charge-saved reads the platform key at import time.
  process.env.PAYSTACK_SECRET_KEY = 'platform-key-1065';
  return { gateway: vi.fn(), routing: vi.fn(), calculateFee: vi.fn() };
});
vi.mock('@/lib/trial-status', () => ({ resolveTrialStatus: async () => false }));
vi.mock('@/lib/payments/calculateFee', () => ({
  calculateFee: (...a: unknown[]) => h.calculateFee(...a),
  validateV1Snapshot: () => null,
}));
vi.mock('../gateway-resolver', () => ({ resolveBusinessGateway: (...a: unknown[]) => h.gateway(...a) }));
vi.mock('../resolve-stripe-routing', () => ({ resolvePaymentRoutingAuthority: (...a: unknown[]) => h.routing(...a) }));
vi.mock('@/lib/logger', () => {
  const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
  l.withContext = () => l;
  return { logger: l };
});
vi.mock('@/lib/observability', () => ({
  observeProvider: (_ctx: unknown, fn: () => unknown) => fn(),
  logSplitResolved: vi.fn(), logSplitMissing: vi.fn(),
}));

import { paystackPaymentMatchesSavedCardScope, resolvePaystackSavedCardScope } from '../saved-card-scope';
import { chargeSavedCard, getSavedPaymentMethod } from '../charge-saved';
import { checkSavedCardOfferEligibility } from '../saved-card-offer';
import { savedPaymentAdapter } from '../saved-payment-adapter';

type Row = Record<string, unknown>;
const BIZ = 'b0000000-0000-4000-8000-000000001065';
const CRED = 'c0000000-0000-4000-8000-000000001065';
const OLD_CRED = 'c0000000-0000-4000-8000-000000000001';
const PHONE = '+2348012345678';
const BYO_CREDENTIAL = { id: CRED, gateway: 'paystack', secret_key: 'enc', platform_subaccount_code: 'ACCT_waaiio', connect_account_id: null };

/** Fake Supabase: records every filter per table; each table answers from `rows`. */
function fakeDb(rows: Record<string, Row | Row[] | null>) {
  const calls: Array<{ table: string; op: string; filters: unknown[][]; payload?: unknown }> = [];
  const from = vi.fn((table: string) => {
    const call = { table, op: 'select', filters: [] as unknown[][], payload: undefined as unknown };
    calls.push(call);
    const answer = () => {
      const r = rows[table];
      return Array.isArray(r) ? r : (r ? [r] : []);
    };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'not', 'order', 'limit', 'or', 'lte', 'gte']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        if (m !== 'select') call.filters.push([m, ...args]);
        return chain;
      });
    }
    chain.insert = vi.fn((p: unknown) => { call.op = 'insert'; call.payload = p; return chain; });
    chain.update = vi.fn((p: unknown) => { call.op = 'update'; call.payload = p; return chain; });
    chain.delete = vi.fn(() => { call.op = 'delete'; return chain; });
    chain.single = vi.fn(async () => ({ data: call.op === 'insert' ? { id: 'pay-new' } : answer()[0] ?? null, error: null }));
    chain.maybeSingle = vi.fn(async () => ({ data: call.op === 'insert' ? { id: 'pay-new' } : answer()[0] ?? null, error: null }));
    // A guarded UPDATE ... select('id') proves exactly one row moved.
    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: call.op === 'update' ? [{ id: 'pay-new' }] : answer(), error: null }).then(res);
    return chain;
  });
  return { db: { from, rpc: vi.fn(async (): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null })) }, calls };
}
const scopeFilter = (calls: Array<{ table: string; filters: unknown[][] }>) =>
  calls.filter(c => c.table === 'saved_payment_methods')
    .flatMap(c => c.filters.filter(f => f[1] === 'byo_business_id'));

beforeEach(() => {
  vi.clearAllMocks();
  h.gateway.mockResolvedValue({ gateway: 'paystack', currency: 'NGN', source: 'country_default' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('saved-card scope', () => {
  it('shared-account business → shared scope; own Paystack account → that merchant; others ineligible', async () => {
    expect(await resolvePaystackSavedCardScope(fakeDb({ business_payment_credentials: null }).db as never, BIZ))
      .toEqual({ eligible: true, byoBusinessId: null });
    expect(await resolvePaystackSavedCardScope(fakeDb({ business_payment_credentials: BYO_CREDENTIAL }).db as never, BIZ))
      .toEqual({ eligible: true, byoBusinessId: BIZ });
    expect(await resolvePaystackSavedCardScope(fakeDb({ business_payment_credentials: { ...BYO_CREDENTIAL, gateway: 'flutterwave' } }).db as never, BIZ))
      .toEqual({ eligible: false, reason: 'byo_paystack_credential_unavailable' });
    expect(await resolvePaystackSavedCardScope(fakeDb({ business_payment_credentials: { id: 'x', gateway: 'paystack', secret_key: null, platform_subaccount_code: null, connect_account_id: 'ACCT_c' } }).db as never, BIZ))
      .toEqual({ eligible: false, reason: 'paystack_connect' });
    h.gateway.mockResolvedValue({ gateway: 'stripe', currency: 'USD', source: 'country_default' });
    expect(await resolvePaystackSavedCardScope(fakeDb({ business_payment_credentials: BYO_CREDENTIAL }).db as never, BIZ))
      .toEqual({ eligible: false, reason: 'gateway_mismatch' });
  });

  it('a payment matches only the account that took it', () => {
    const byo = { metadata: { payment_origin: 'byo', byo_business_id: BIZ, provider_connection_id: OLD_CRED } };
    // Taken on an earlier key entry of the same merchant: still this merchant's card.
    expect(paystackPaymentMatchesSavedCardScope(byo, BIZ, { byoBusinessId: BIZ })).toBe(true);
    expect(paystackPaymentMatchesSavedCardScope(byo, 'other-biz', { byoBusinessId: 'other-biz' })).toBe(false);
    expect(paystackPaymentMatchesSavedCardScope(byo, BIZ, { byoBusinessId: null })).toBe(false);
    expect(paystackPaymentMatchesSavedCardScope({ metadata: { payment_origin: 'platform' } }, BIZ, { byoBusinessId: null })).toBe(true);
    expect(paystackPaymentMatchesSavedCardScope({ metadata: { payment_origin: 'platform' } }, BIZ, { byoBusinessId: BIZ })).toBe(false);
  });
});

describe('checkout lookup shows only the card for this business\'s account', () => {
  it('own-account merchant → its own card only; shared merchant → shared card only', async () => {
    const byo = fakeDb({ business_payment_credentials: BYO_CREDENTIAL, saved_payment_methods: [{ id: 'm-byo', gateway: 'paystack', customer_phone: PHONE, byo_business_id: BIZ }] });
    expect((await getSavedPaymentMethod(byo.db as never, BIZ, PHONE))?.id).toBe('m-byo');
    expect(scopeFilter(byo.calls)).toEqual([['eq', 'byo_business_id', BIZ]]);

    const shared = fakeDb({ business_payment_credentials: null, saved_payment_methods: [{ id: 'm-shared', gateway: 'paystack', customer_phone: PHONE, byo_business_id: null }] });
    expect((await getSavedPaymentMethod(shared.db as never, BIZ, PHONE))?.id).toBe('m-shared');
    expect(scopeFilter(shared.calls)).toEqual([['is', 'byo_business_id', null]]);
  });

  it.each([
    ['another merchant\'s card', 'other-biz'],
    ['a Waaiio shared-account card', null],
  ])('%s is never charged at an own-account merchant', async (_label, cardScope) => {
    const { db } = fakeDb({
      business_payment_credentials: BYO_CREDENTIAL,
      saved_payment_methods: { id: 'm-old', gateway: 'paystack', customer_phone: PHONE, authorization_email: 'a@b.co', byo_business_id: cardScope },
    });
    const outcome = await savedPaymentAdapter.chargeSavedMethod(db as never, {
      methodId: 'm-old', businessId: BIZ, customerPhone: PHONE, amount: 100, currency: 'NGN', reference: 'REF-x',
    } as never);
    expect(outcome).toEqual({ status: 'method_not_found' });
  });
});

describe('save offer after an own-account payment', () => {
  const auth = { reusable: true, authorization_code: 'AUTH_byo', email: 'ada@gmail.com', brand: 'visa', last4: '4081' };
  const payment = (meta: Row) => ({
    id: 'pay-1', status: 'success', gateway: 'paystack', business_id: BIZ, user_id: 'u1',
    metadata: { _card_authorization: auth, ...meta },
  });

  it('offers Save after an own-account payment at this merchant', async () => {
    const { db, calls } = fakeDb({
      payments: payment({ payment_origin: 'byo', byo: true, byo_business_id: BIZ, provider_connection_id: CRED }),
      profiles: { phone: PHONE }, business_payment_credentials: BYO_CREDENTIAL, saved_payment_methods: null,
    });
    expect(await checkSavedCardOfferEligibility(db as never, 'pay-1', PHONE, BIZ)).toMatchObject({ eligible: true, offerType: 'save' });
    expect(scopeFilter(calls)).toEqual([['eq', 'byo_business_id', BIZ]]);
  });

  it('does not offer for an own-account payment recorded for a different merchant', async () => {
    const { db } = fakeDb({
      payments: payment({ payment_origin: 'byo', byo: true, byo_business_id: 'other-biz', provider_connection_id: CRED }),
      profiles: { phone: PHONE }, business_payment_credentials: BYO_CREDENTIAL,
    });
    expect(await checkSavedCardOfferEligibility(db as never, 'pay-1', PHONE, BIZ)).toEqual({ eligible: false, reason: 'payment_scope_mismatch' });
  });

  it('still never offers for a Connect payment', async () => {
    const { db } = fakeDb({ payments: payment({ payment_origin: 'connect' }), profiles: { phone: PHONE } });
    expect(await checkSavedCardOfferEligibility(db as never, 'pay-1', PHONE, BIZ)).toEqual({ eligible: false, reason: 'not_platform' });
  });
});

describe('paying with an own-account saved card', () => {
  const method = {
    id: 'm-byo', gateway: 'paystack', authorization_code: 'AUTH_byo', customer_code: 'CUS_1', authorization_email: 'ada@gmail.com',
    stripe_payment_method_id: null, stripe_customer_id: null, card_last4: '4081', card_brand: 'visa', byo_business_id: BIZ,
  };
  const routing = { isByo: true, byoSecretKey: 'merchant-key-1065', byoPlatformSubaccount: 'ACCT_waaiio', providerConnectionId: CRED, platformFeeAmount: 3 };

  function stubPaystack() {
    const sent: Array<{ url: string; headers: Record<string, string>; body: Row }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, headers: (init?.headers || {}) as Record<string, string>, body: JSON.parse(String(init?.body || '{}')) });
      return { json: async () => ({ status: true, data: { status: 'success', reference: 'REF-byo' } }) } as unknown as Response;
    }));
    return sent;
  }

  it('charges with the merchant\'s key and the normal own-account split, recorded as an own-account payment', async () => {
    h.routing.mockResolvedValue(routing);
    const sent = stubPaystack();
    const { db, calls } = fakeDb({ payments: null });
    const outcome = await chargeSavedCard(db as never, {
      savedMethod: method, amount: 100, currency: 'NGN', email: 'ada@gmail.com', reference: 'REF-byo', businessId: BIZ,
    });
    expect(outcome).toMatchObject({ outcome: 'charged', paymentId: 'pay-new' });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.paystack.co/transaction/charge_authorization');
    expect(sent[0].headers.Authorization).toBe('Bearer merchant-key-1065');
    // Waaiio's 3.00 fee goes to Waaiio's subaccount on the merchant's account; merchant keeps 97.00 and bears Paystack's fee.
    expect(sent[0].body).toMatchObject({ authorization_code: 'AUTH_byo', amount: 10000, subaccount: 'ACCT_waaiio', transaction_charge: 9700, bearer: 'account' });
    const insert = calls.find(c => c.table === 'payments' && c.op === 'insert')?.payload as Row;
    expect(insert.metadata).toMatchObject({ payment_origin: 'byo', byo: true, byo_business_id: BIZ, provider_connection_id: CRED, saved_method: true });
  });

  it('keeps working after the merchant re-enters its key (new connection id); charge uses the current one', async () => {
    h.routing.mockResolvedValue({ ...routing, providerConnectionId: OLD_CRED });
    const sent = stubPaystack();
    const { db, calls } = fakeDb({ payments: null });
    const outcome = await chargeSavedCard(db as never, {
      savedMethod: method, amount: 100, currency: 'NGN', email: 'ada@gmail.com', reference: 'REF-byo', businessId: BIZ,
    });
    expect(outcome).toMatchObject({ outcome: 'charged' });
    expect(sent[0].headers.Authorization).toBe('Bearer merchant-key-1065');
    const insert = calls.find(c => c.table === 'payments' && c.op === 'insert')?.payload as Row;
    expect((insert.metadata as Row).provider_connection_id).toBe(OLD_CRED);
  });

  it('declines without calling Paystack when the merchant no longer uses its own Paystack account', async () => {
    h.routing.mockResolvedValue({ isByo: false });
    const sent = stubPaystack();
    const outcome = await chargeSavedCard(fakeDb({ payments: null }).db as never, {
      savedMethod: method, amount: 100, currency: 'NGN', email: 'ada@gmail.com', reference: 'REF-byo', businessId: BIZ,
    });
    expect(outcome).toMatchObject({ outcome: 'declined' });
    expect(sent).toHaveLength(0);
  });

  it('a shared-account card is still charged with Waaiio\'s key as before', async () => {
    const sent = stubPaystack();
    const { db, calls } = fakeDb({ payments: null, businesses: { payout_mode: 'platform_managed' } });
    await chargeSavedCard(db as never, {
      savedMethod: { ...method, byo_business_id: null }, amount: 100, currency: 'NGN', email: 'x@whatsapp.waaiio.com', reference: 'REF-p', businessId: BIZ,
    });
    expect(h.routing).not.toHaveBeenCalled();
    expect(sent[0]?.headers.Authorization).toBe('Bearer platform-key-1065');
    const insert = calls.find(c => c.table === 'payments' && c.op === 'insert')?.payload as Row;
    expect((insert.metadata as Row).payment_origin).toBe('platform');
  });
});

describe('saving and removing an own-account card in the bot', () => {
  const byoPayment = {
    id: 'pay-1', status: 'success', gateway: 'paystack', business_id: BIZ,
    metadata: {
      payment_origin: 'byo', byo: true, byo_business_id: BIZ, provider_connection_id: CRED,
      _card_authorization: { reusable: true, authorization_code: 'AUTH_byo', email: 'ada@gmail.com' },
    },
  };
  const session = (data: Row) => ({
    id: 'sess-1', version: 1, business_id: BIZ, whatsapp_number: PHONE.slice(1), current_step: 'save_card_pin',
    session_data: {
      _save_card_pending: true, _save_card_business_id: BIZ, _save_card_gateway: 'paystack', _save_card_payment_id: 'pay-1',
      _save_card_auth: { reusable: true, authorization_code: 'AUTH_byo', email: 'ada@gmail.com', last4: '4081', brand: 'visa' },
      ...data,
    },
  });

  it('PIN save stores the card for the merchant whose account took the payment', async () => {
    const { db, calls } = fakeDb({ payments: byoPayment, business_payment_credentials: BYO_CREDENTIAL, saved_payment_methods: null });
    db.rpc.mockResolvedValue({ data: { success: true, version: 2 }, error: null });
    const { handleCardPinStep } = await import('@/lib/bot/handlers/saved-cards');
    await handleCardPinStep(db as never, vi.fn(async () => {}), PHONE.slice(1), session({}) as never, '4321');
    const insert = calls.find(c => c.table === 'saved_payment_methods' && c.op === 'insert')?.payload as Row;
    expect(insert).toMatchObject({ business_id: BIZ, byo_business_id: BIZ, authorization_code: 'AUTH_byo', gateway: 'paystack' });
  });

  it('PIN save refuses an own-account payment recorded for a different merchant', async () => {
    const { db, calls } = fakeDb({
      payments: { ...byoPayment, metadata: { ...byoPayment.metadata, byo_business_id: 'other-biz' } },
      business_payment_credentials: BYO_CREDENTIAL,
    });
    const send = vi.fn(async () => {});
    const { handleCardPinStep } = await import('@/lib/bot/handlers/saved-cards');
    await handleCardPinStep(db as never, send, PHONE.slice(1), session({}) as never, '4321');
    expect(calls.some(c => c.table === 'saved_payment_methods' && c.op === 'insert')).toBe(false);
    expect(send).toHaveBeenCalledWith(PHONE.slice(1), 'This payment cannot be used to save a card.');
  });

  it('a shared-account payment still saves a shared card', async () => {
    const { db, calls } = fakeDb({ payments: { ...byoPayment, metadata: { ...byoPayment.metadata, payment_origin: 'platform' } }, saved_payment_methods: null });
    db.rpc.mockResolvedValue({ data: { success: true, version: 2 }, error: null });
    const { handleCardPinStep } = await import('@/lib/bot/handlers/saved-cards');
    await handleCardPinStep(db as never, vi.fn(async () => {}), PHONE.slice(1), session({}) as never, '4321');
    const insert = calls.find(c => c.table === 'saved_payment_methods' && c.op === 'insert')?.payload as Row;
    expect(insert).toMatchObject({ byo_business_id: null });
  });

  it('remove card at an own-account merchant removes only that merchant\'s card; elsewhere only the shared card', async () => {
    const { handleRemoveCard } = await import('@/lib/bot/handlers/saved-cards');
    const byo = fakeDb({ business_payment_credentials: BYO_CREDENTIAL, saved_payment_methods: [{ card_last4: '4081', card_brand: 'visa' }] });
    await handleRemoveCard(byo.db as never, vi.fn(async () => {}), PHONE, { business_id: BIZ } as never);
    expect(byo.calls.find(c => c.table === 'saved_payment_methods' && c.op === 'delete')?.filters)
      .toContainEqual(['eq', 'byo_business_id', BIZ]);

    const shared = fakeDb({ saved_payment_methods: [{ card_last4: '1111', card_brand: 'visa' }] });
    await handleRemoveCard(shared.db as never, vi.fn(async () => {}), PHONE, null);
    expect(shared.calls.find(c => c.table === 'saved_payment_methods' && c.op === 'delete')?.filters)
      .toContainEqual(['is', 'byo_business_id', null]);
  });
});

describe('review follow-ups (#1065)', () => {
  it('fee policy v1: own-account split uses the pinned fee with routing "byo"', async () => {
    h.routing.mockResolvedValue({ isByo: true, byoSecretKey: 'merchant-key-1065', byoPlatformSubaccount: 'ACCT_waaiio', providerConnectionId: CRED, platformFeeAmount: 99 });
    const sent: Array<{ body: Row }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body || '{}')) });
      return { json: async () => ({ status: true, data: { status: 'success' } }) } as unknown as Response;
    }));
    const snapshot = {
      fee_policy_enabled: true,
      tiers: { free: { feePercentage: 5, feeFlat: 0 } },
    };
    const { db, calls } = fakeDb({
      payments: null,
      platform_config_versions: { id: 'cfg-1', config_snapshot: snapshot },
      businesses: { subscription_tier: 'free', trial_ends_at: null, custom_fee_percentage: null, custom_fee_flat: null, payout_mode: 'platform_managed' },
    });
    h.calculateFee.mockReturnValue({ feeTotal: 5 });
    const v1 = h.calculateFee;
    const outcome = await chargeSavedCard(db as never, {
      savedMethod: { id: 'm-byo', gateway: 'paystack', authorization_code: 'AUTH_byo', customer_code: null, authorization_email: 'ada@gmail.com',
        stripe_payment_method_id: null, stripe_customer_id: null, card_last4: '4081', card_brand: 'visa', byo_business_id: BIZ },
      amount: 100, currency: 'NGN', email: 'ada@gmail.com', reference: 'REF-v1', businessId: BIZ, transactionCategory: 'scheduling',
    });
    expect(outcome).toEqual({ outcome: 'charged', paymentId: 'pay-new', reference: 'REF-v1' });
    expect(v1.mock.calls[0][1]).toMatchObject({ payment_routing: 'byo' });
    // Pinned v1 fee (5.00), not the live routing fee (99): merchant keeps 95.00 of 100.00.
    expect(sent[0].body).toMatchObject({ subaccount: 'ACCT_waaiio', transaction_charge: 9500, bearer: 'account' });
    const insert = calls.find(c => c.table === 'payments' && c.op === 'insert')?.payload as Row;
    expect(insert).toMatchObject({ fee_policy_version: 1, fee_basis: expect.objectContaining({ payment_routing: 'byo' }) });
  });

  it('remove card never falls back to the shared card when the merchant account cannot be read', async () => {
    const { handleRemoveCard } = await import('@/lib/bot/handlers/saved-cards');
    h.gateway.mockRejectedValue(new Error('db down'));
    const { db, calls } = fakeDb({ saved_payment_methods: [{ card_last4: '1111', card_brand: 'visa' }] });
    const send = vi.fn(async () => {});
    await handleRemoveCard(db as never, send, PHONE, { business_id: BIZ } as never);
    expect(calls.some(c => c.table === 'saved_payment_methods' && c.op === 'delete')).toBe(false);
    expect(send).toHaveBeenCalledWith(PHONE, 'Could not check your saved card. Please try again.');
  });
});
