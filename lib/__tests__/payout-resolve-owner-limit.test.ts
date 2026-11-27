/**
 * /api/payouts/resolve — business owners only, 10 lookups per user per hour,
 * and every lookup recorded in audit_log with the last 4 digits only.
 *
 * Handler-level tests: Supabase (session + service), logger and the Paystack
 * fetch are mocked. The limiter is the real lib/rate-limit module (in-memory
 * path, Upstash env unset) except where its call arguments are asserted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = 'owner-user-1';
const OTHER_ID = 'other-user-2';
const BIZ_ID = 'biz-owned-1';
const FULL_ACCOUNT = '0123456789';
const BODY = { business_id: BIZ_ID, gateway: 'paystack', bank_code: '058', account_number: FULL_ACCOUNT };

function makePost(body: Record<string, unknown>) {
  return new NextRequest(new URL('/api/payouts/resolve', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function noopLogger() {
  const noop = (..._args: unknown[]) => {};
  return {
    error: noop, info: noop, debug: noop, warn: noop,
    withContext: () => ({ error: noop, info: noop, debug: noop, warn: noop }),
  };
}

function setup(opts: { userId?: string | null; paystack?: unknown } = {}) {
  const userId = opts.userId === undefined ? OWNER_ID : opts.userId;

  // Session client: ownership lookup returns the business only for its owner
  const ownerFilter: { owner_id?: string; id?: string } = {};
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockImplementation((col: string, val: string) => {
    (ownerFilter as Record<string, string>)[col] = val;
    return chain;
  });
  chain.single = vi.fn().mockImplementation(async () => (
    ownerFilter.id === BIZ_ID && ownerFilter.owner_id === OWNER_ID
      ? { data: { id: BIZ_ID }, error: null }
      : { data: null, error: { message: 'not found' } }
  ));
  const sessionFrom = vi.fn().mockReturnValue(chain);
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }) },
      from: sessionFrom,
    }),
  }));

  // Service client: audit_log insert capture
  const auditInsert = vi.fn().mockResolvedValue({ error: null });
  const serviceFrom = vi.fn().mockReturnValue({ insert: auditInsert });
  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn().mockReturnValue({ from: serviceFrom }),
  }));
  vi.doMock('@/lib/logger', () => ({ logger: noopLogger() }));

  const paystack = vi.fn().mockResolvedValue({
    json: async () => opts.paystack ?? ({ status: true, data: { account_name: 'Fixture Merchant' } }),
  });
  vi.stubGlobal('fetch', paystack);

  return { paystack, auditInsert, serviceFrom, sessionFrom };
}

describe('POST /api/payouts/resolve — owner only, limited, audited', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.stubEnv('PAYSTACK_SECRET_KEY', 'fixture-paystack-key');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('owner: 200 with the unchanged response shape and the same Paystack call', async () => {
    const fx = setup();
    const { POST } = await import('@/app/api/payouts/resolve/route');
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account_name: 'Fixture Merchant' });
    expect(fx.paystack).toHaveBeenCalledTimes(1);
    expect(fx.paystack).toHaveBeenCalledWith(
      `https://api.paystack.co/bank/resolve?account_number=${FULL_ACCOUNT}&bank_code=058`,
      { headers: { Authorization: 'Bearer fixture-paystack-key' } },
    );
  });

  it('owner: Paystack refusal keeps the existing 400 response', async () => {
    const fx = setup({ paystack: { status: false, message: 'Could not resolve account name' } });
    const { POST } = await import('@/app/api/payouts/resolve/route');
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Could not resolve account name' });
    expect(fx.paystack).toHaveBeenCalledTimes(1);
  });

  it('signed-in non-owner: 403 and Paystack is not called', async () => {
    const fx = setup({ userId: OTHER_ID });
    const { POST } = await import('@/app/api/payouts/resolve/route');
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(403);
    expect(fx.paystack).not.toHaveBeenCalled();
    expect(fx.auditInsert).not.toHaveBeenCalled();
  });

  it('signed-in user without a business id: 400 and Paystack is not called', async () => {
    const fx = setup();
    const { POST } = await import('@/app/api/payouts/resolve/route');
    const { business_id: _omit, ...noBiz } = BODY;
    const res = await POST(makePost(noBiz));
    expect(res.status).toBe(400);
    expect(fx.paystack).not.toHaveBeenCalled();
  });

  it('unauthenticated: 401 and Paystack is not called', async () => {
    const fx = setup({ userId: null });
    const { POST } = await import('@/app/api/payouts/resolve/route');
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(401);
    expect(fx.paystack).not.toHaveBeenCalled();
  });

  it('11th lookup within an hour: 429 with a neutral message and Paystack is not called', async () => {
    const fx = setup();
    const { POST } = await import('@/app/api/payouts/resolve/route');
    for (let i = 0; i < 10; i++) {
      const ok = await POST(makePost(BODY));
      expect(ok.status).toBe(200);
    }
    expect(fx.paystack).toHaveBeenCalledTimes(10);
    const blocked = await POST(makePost(BODY));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'Too many requests. Please try again later.' });
    expect(fx.paystack).toHaveBeenCalledTimes(10);
    expect(fx.auditInsert).toHaveBeenCalledTimes(10);
  });

  it('uses the shared limiter keyed per user: 10 per hour', async () => {
    setup();
    const limiter = vi.fn().mockResolvedValue(null);
    vi.doMock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: limiter }));
    const { POST } = await import('@/app/api/payouts/resolve/route');
    await POST(makePost(BODY));
    expect(limiter).toHaveBeenCalledWith(`payout-resolve:${OWNER_ID}`, 10, 60 * 60 * 1000);
  });

  it('audit entry: who, business, bank code, last 4 digits only, result and time', async () => {
    const fx = setup();
    const { POST } = await import('@/app/api/payouts/resolve/route');
    await POST(makePost(BODY));
    expect(fx.serviceFrom).toHaveBeenCalledWith('audit_log');
    expect(fx.auditInsert).toHaveBeenCalledTimes(1);
    const row = fx.auditInsert.mock.calls[0][0];
    expect(row).toMatchObject({
      business_id: BIZ_ID,
      user_id: OWNER_ID,
      action: 'payout_account_lookup',
      entity_type: 'payout',
      changes: { bank_code: '058', account_last4: '6789', result: 'ok', looked_up_at: expect.any(String) },
    });
    expect(Number.isNaN(Date.parse(row.changes.looked_up_at))).toBe(false);
    expect(JSON.stringify(row)).not.toContain(FULL_ACCOUNT);
    expect(JSON.stringify(row)).not.toContain('012345');
  });

  it('audit entry records a failed lookup as fail', async () => {
    const fx = setup({ paystack: { status: false, message: 'nope' } });
    const { POST } = await import('@/app/api/payouts/resolve/route');
    await POST(makePost(BODY));
    expect(fx.auditInsert).toHaveBeenCalledTimes(1);
    const row = fx.auditInsert.mock.calls[0][0];
    expect(row.changes).toMatchObject({ account_last4: '6789', result: 'fail' });
    expect(JSON.stringify(row)).not.toContain(FULL_ACCOUNT);
  });

  it('a failed audit write does not change the owner response', async () => {
    const fx = setup();
    fx.auditInsert.mockResolvedValue({ error: { message: 'insert failed' } });
    const { POST } = await import('@/app/api/payouts/resolve/route');
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account_name: 'Fixture Merchant' });
  });
});
