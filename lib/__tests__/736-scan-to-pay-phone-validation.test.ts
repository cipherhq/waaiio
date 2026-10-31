/**
 * #736/#747: actual route + unchanged Paystack/Stripe adapters.
 * Provider transport is synthetic; this stateful PostgREST-shaped fixture
 * enforces nullable profile identity and unique references. Not PostgreSQL proof.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, any>;
let rows: Row[];
let link: Row | null;
let provider: 'paystack' | 'stripe';
let inserts: Row[];
let effects: string[];
let insertFailure: 'error' | 'empty' | 'throw' | null;
let referenceFailure: 'error' | 'empty' | 'throw' | 'duplicate' | null;
let cleanupFailure: 'error' | 'throw' | null;
let transportMode: 'success' | 'reject' | 'throw' | 'no_url' | 'no_reference' | 'blank_url' | 'blank_reference';
let settleBeforeReturn: boolean;
let initSpy: ReturnType<typeof vi.spyOn>;
let transport: ReturnType<typeof vi.fn>;
let rpc: ReturnType<typeof vi.fn>;
let route: typeof import('@/app/api/pay-link/pay/route');
const logError = vi.fn();
const PHONE = '+2348012345678';
const BODY = { token: 'synthetic-link', amount: 1000, customer_name: 'Guest', customer_phone: PHONE };

function database() {
  return {
    from(table: string) {
      let operation: 'read' | 'insert' | 'update' = 'read';
      let values: Row = {};
      const filters: Array<[string, unknown]> = [];
      let executed: Promise<{ data: any; error: any }> | undefined;
      const execute = () => {
        if (executed) return executed;
        executed = (async () => {
          if (table === 'payment_links') {
            if (operation === 'update') { effects.push('use-fallback'); return { data: null, error: null }; }
            return { data: link, error: null };
          }
          if (table !== 'payments') throw new Error('Unexpected table: ' + table);
          if (operation === 'insert') {
            inserts.push(structuredClone(values)); effects.push('insert');
            if (insertFailure === 'throw') throw new Error('synthetic insert transport');
            if (insertFailure === 'error') return { data: null, error: { code: 'synthetic' } };
            if (insertFailure === 'empty') return { data: null, error: null };
            // The anonymous payer has no profiles row. NULL is valid, zero UUID is not.
            if (values.user_id !== null) return { data: null, error: { code: '23503' } };
            if (rows.some(row => row.gateway_reference === values.gateway_reference))
              return { data: null, error: { code: '23505' } };
            const row = { ...structuredClone(values), id: 'canonical-payment' };
            rows.push(row);
            return { data: structuredClone(row), error: null };
          }
          const matches = rows.filter(row => filters.every(([key, value]) => row[key] === value));
          if (operation === 'update') {
            const isReference = Object.hasOwn(values, 'gateway_reference');
            effects.push(isReference ? 'reference' : 'cleanup');
            const failure = isReference ? referenceFailure : cleanupFailure;
            if (failure === 'throw') throw new Error('synthetic update transport');
            if (failure === 'error') return { data: null, error: { code: 'synthetic' } };
            if (failure === 'empty') return { data: null, error: null };
            if (isReference && (failure === 'duplicate' || rows.some(row =>
              !matches.includes(row) && row.gateway_reference === values.gateway_reference)))
              return { data: null, error: { code: '23505' } };
            for (const row of matches) Object.assign(row, values);
          }
          return { data: matches[0] ? structuredClone(matches[0]) : null, error: null };
        })();
        return executed;
      };
      const chain: any = {
        select: () => chain,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
        insert: (value: Row) => { operation = 'insert'; values = value; return chain; },
        update: (value: Row) => { operation = 'update'; values = value; return chain; },
        single: execute, maybeSingle: execute,
        then: (resolve: any, reject: any) => execute().then(resolve, reject),
      };
      return chain;
    },
    rpc,
  };
}
function request(body: Row = BODY) {
  return new NextRequest('http://localhost/api/pay-link/pay', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
function stripe() {
  provider = 'stripe';
  if (link) {
    link.currency = 'USD';
    link.businesses.country_code = 'US';
  }
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('PAYSTACK_SECRET_KEY', 'synthetic-paystack-fixture');
  vi.stubEnv('STRIPE_SECRET_KEY', 'synthetic-stripe-fixture');
  provider = 'paystack';
  rows = []; inserts = []; effects = [];
  insertFailure = null; referenceFailure = null; cleanupFailure = null;
  transportMode = 'success'; settleBeforeReturn = false;
  link = { id: 'link', title: 'Synthetic', amount: null, currency: 'NGN', uses_count: 0,
    expires_at: null, max_uses: null, business_id: 'business', is_active: true,
    businesses: { name: 'Shop', country_code: 'NG', payment_gateway: 'paystack', status: 'active' } };
  rpc = vi.fn(async () => { effects.push('use'); return { data: null, error: null }; });
  vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: database }));
  vi.doMock('@/lib/rate-limit', () => ({
    rateLimitResponseAsync: vi.fn(async () => null), getRateLimitKey: () => 'synthetic',
  }));
  vi.doMock('@/lib/logger', () => ({
    logger: { error: logError, warn: vi.fn(), info: vi.fn(),
      withContext: () => ({ error: logError, warn: vi.fn() }) },
  }));
  vi.doMock('@/lib/observability', () => ({
    observeProvider: (_context: unknown, work: () => unknown) => work(),
  }));
  vi.doMock('@/lib/payments/gateway-resolver', () => ({
    resolveBusinessGateway: async () => ({ gateway: provider, currency: provider === 'stripe' ? 'USD' : 'NGN' }),
  }));
  // Factory selects REAL adapters; only the network transport is synthetic.
  const { PaystackGateway } = await import('@/lib/payments/paystack');
  const { StripeGateway } = await import('@/lib/payments/stripe');
  const paystack = new PaystackGateway();
  const stripeGateway = new StripeGateway();
  vi.doMock('@/lib/payments/factory', () => ({
    getPaymentGatewayByName: (name: string) => {
      const gateway = name === 'stripe' ? stripeGateway : paystack;
      initSpy = vi.spyOn(gateway, 'initializePayment'); // call through unchanged implementation
      return gateway;
    },
  }));
  transport = vi.fn(async (url: string, _init?: RequestInit) => {
    effects.push('provider');
    expect(url).toMatch(/^https:\/\/api\.(paystack\.co\/transaction\/initialize|stripe\.com\/v1\/checkout\/sessions)$/);
    if (settleBeforeReturn) rows[0].status = 'success';
    if (transportMode === 'throw') throw new Error('synthetic provider timeout');
    const checkout = transportMode === 'no_url' ? undefined : transportMode === 'blank_url' ? ' ' : 'https://checkout.example.test/session';
    const reference = transportMode === 'no_reference' ? undefined : transportMode === 'blank_reference' ? ' ' : 'provider-reference';
    return {
      ok: true,
      json: async () => url.includes('paystack')
        ? { status: transportMode !== 'reject', data: { authorization_url: checkout, reference, access_code: 'synthetic' } }
        : transportMode === 'reject' ? { error: { message: 'synthetic rejection' } } : { id: reference, url: checkout },
    };
  });
  vi.stubGlobal('fetch', transport);
  route = await import('@/app/api/pay-link/pay/route');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('scan-to-pay guards before side effects', () => {
  it.each([undefined, '', '   ', '08012345678', 'invalid', 123])('rejects invalid required phone %s', async phone => {
    const response = await route.POST(request({ ...BODY, customer_phone: phone }));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('PHONE_REQUIRED');
    expect(inserts).toEqual([]); expect(transport).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...BODY, token: undefined }, 400],
    [{ ...BODY, amount: -100 }, 400],
    [{ ...BODY, amount: 0 }, 400],
  ])('rejects invalid token/amount without effects', async (body, status) => {
    expect((await route.POST(request(body))).status).toBe(status);
    expect(effects).toEqual([]);
  });
  it('retains fixed-amount mismatch rejection', async () => {
    link!.amount = 5000;
    expect((await route.POST(request())).status).toBe(400);
    expect(effects).toEqual([]);
  });
  it('retains matching fixed amount', async () => {
    link!.amount = BODY.amount;
    expect((await route.POST(request())).status).toBe(200);
    expect(inserts).toHaveLength(1);
  });
  it('retains max-use guard', async () => {
    Object.assign(link!, { max_uses: 1, uses_count: 1 });
    expect((await route.POST(request())).status).toBe(410);
    expect(effects).toEqual([]);
  });
  it('retains expiry and inactive-business guards', async () => {
    link!.expires_at = '2000-01-01';
    expect((await route.POST(request())).status).toBe(410);
    link!.expires_at = null; link!.businesses.status = 'pending';
    expect((await route.POST(request())).status).toBe(503);
    expect(effects).toEqual([]);
  });
});

describe('canonical row with actual adapters', () => {
  it.each(['paystack', 'stripe'] as const)('%s reuses one NULL-payer row and persists the actual reference before use', async gateway => {
    if (gateway === 'stripe') stripe();
    const response = await route.POST(request(gateway === 'stripe' ? { ...BODY, customer_phone: undefined } : BODY));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://checkout.example.test/session' });
    expect(inserts).toHaveLength(1); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'canonical-payment', user_id: null, gateway, gateway_reference: 'provider-reference',
      status: 'pending', business_id: 'business', amount: 1000,
      metadata: { payment_link_id: 'link', customer_name: 'Guest',
        customer_phone: gateway === 'stripe' ? null : PHONE, source: 'scan_to_pay' },
    });
    expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({
      existingPaymentId: rows[0].id, userId: null, businessId: 'business',
    }));
    expect(effects).toEqual(['insert', 'provider', 'reference', 'use']);
    if (gateway === 'stripe') {
      const body = new URLSearchParams(transport.mock.calls[0][1].body);
      expect(body.has('metadata[user_id]')).toBe(false);
    } else {
      expect(JSON.parse(transport.mock.calls[0][1].body).metadata.user_id).toBeNull();
    }
  });
  it.each(['+234 801-234-5678', '2348012345678'])('normalizes phone %s in canonical metadata and real adapter input', async phone => {
    expect((await route.POST(request({ ...BODY, customer_phone: phone }))).status).toBe(200);
    expect(rows[0].metadata.customer_phone).toBe(PHONE);
    expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE }));
  });
  it.each(['error', 'empty', 'throw'] as const)('insert %s prevents provider initialization and use', async failure => {
    insertFailure = failure;
    const response = await route.POST(request());
    expect(response.status).toBe(500); expect((await response.json()).url).toBeUndefined();
    expect(rows).toEqual([]); expect(transport).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it('fixture rejects the previous placeholder profile identity', async () => {
    const result = await database().from('payments').insert({ user_id: '00000000-0000-0000-0000-000000000000' }).single();
    expect(result.error.code).toBe('23503'); expect(rows).toEqual([]);
  });
  it('fixture enforces unique references instead of allowing duplicate canonical records', async () => {
    const db = database();
    await db.from('payments').insert({ user_id: null, gateway_reference: 'same' }).single();
    const second = await db.from('payments').insert({ user_id: null, gateway_reference: 'same' }).single();
    expect(second.error.code).toBe('23505'); expect(rows).toHaveLength(1);
  });
});

describe('checkout failures with conditional local cleanup', () => {
  it.each(['reject', 'throw', 'no_url', 'no_reference', 'blank_url', 'blank_reference'] as const)('real Paystack adapter outcome %s never returns checkout or consumes use', async mode => {
    transportMode = mode;
    const response = await route.POST(request());
    expect(response.status).toBe(500); expect((await response.json()).url).toBeUndefined();
    expect(inserts).toHaveLength(1); expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed'); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['reject', 'throw', 'no_url', 'no_reference', 'blank_url', 'blank_reference'] as const)('real Stripe adapter outcome %s fails closed', async mode => {
    stripe(); transportMode = mode;
    const response = await route.POST(request({ ...BODY, customer_phone: undefined }));
    expect(response.status).toBe(500); expect((await response.json()).url).toBeUndefined();
    expect(rows[0].status).toBe('failed'); expect(inserts).toHaveLength(1); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['error', 'empty', 'throw', 'duplicate'] as const)('reference persistence %s withholds checkout and use', async failure => {
    referenceFailure = failure;
    const response = await route.POST(request());
    expect(response.status).toBe(500); expect((await response.json()).url).toBeUndefined();
    expect(rows[0].status).toBe('failed'); expect(rows[0].gateway_reference).not.toBe('provider-reference');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('does not demote an already-successful row during failure cleanup', async () => {
    settleBeforeReturn = true; referenceFailure = 'error';
    const response = await route.POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty('code', 'PAYMENT_STATUS_UNCONFIRMED');
    expect(rows[0].status).toBe('success'); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['error', 'throw'] as const)('reports cleanup %s honestly without a checkout URL or session-cancellation claim', async failure => {
    transportMode = 'reject'; cleanupFailure = failure;
    const response = await route.POST(request());
    const body = await response.json();
    expect(response.status).toBe(500); expect(body.url).toBeUndefined();
    expect(body.code).toBe('PAYMENT_STATUS_UNCONFIRMED');
    expect(rows[0].status).toBe('pending'); expect(rpc).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith('[PAY-LINK] Payment failure status could not be confirmed', { payment_id: 'canonical-payment' });
    expect(JSON.stringify(body)).not.toMatch(/cancelled|canceled/i);
  });
});
