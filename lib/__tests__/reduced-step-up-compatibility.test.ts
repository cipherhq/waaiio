import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Exercise real route/auth/prepare/verify/consume code; only external Auth and
// PostgREST boundaries are synthetic. This is not a live database proof.
const fixture = vi.hoisted(() => ({
  rows: {} as Record<string, any[]>, token: 'admin-token', session: 'session-a',
  role: 'admin', aal: 'aal2', active: true, user: 'admin-a',
  writes: [] as Array<{ table: string; values: any }>, clients: [] as any[],
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: (options: any) => {
  fixture.clients.push(options);
  return {
    auth: {
      getClaims: async (token: string) => token === fixture.token
        ? { data: { claims: { sub: fixture.user, aal: fixture.aal, session_id: fixture.session } } }
        : { error: new Error('invalid token') },
      getUser: async () => ({ data: { user: { id: fixture.user, app_metadata: { role: fixture.role } } } }),
    },
    rpc: () => ({ maybeSingle: async () => ({ data: { session_exists: fixture.active } }) }),
    from: (table: string) => {
      let mode = 'select', values: any, single = false;
      const filters: Array<(row: any) => boolean> = [];
      const query: any = {
        select: () => query,
        insert: (v: any) => { mode = 'insert'; values = v; return query; },
        update: (v: any) => { mode = 'update'; values = v; return query; },
        eq: (k: string, v: any) => { filters.push(r => r[k] === v); return query; },
        is: (k: string, v: any) => { filters.push(r => (r[k] ?? null) === v); return query; },
        not: (k: string, _op: string, v: any) => { filters.push(r => (r[k] ?? null) !== v); return query; },
        gt: (k: string, v: any) => { filters.push(r => r[k] > v); return query; },
        gte: () => query, lte: () => query, in: () => query,
        single: () => { single = true; return query; },
        maybeSingle: () => { single = true; return query; },
        then: (resolve: any, reject: any) => {
          try {
            const rows = fixture.rows[table] ||= [];
            let result = rows.filter(r => filters.every(f => f(r)));
            if (mode === 'insert') {
              const row = { id: `${table}-${rows.length}`, ...values };
              rows.push(row); result = [row]; fixture.writes.push({ table, values });
            } else if (mode === 'update') {
              result.forEach(r => Object.assign(r, values));
              if (result.length) fixture.writes.push({ table, values });
            }
            return Promise.resolve({ data: single ? result[0] ?? null : result, error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        },
      };
      return query;
    },
  };
}}));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => { throw new Error('Cookie client must not perform bearer generation'); } }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ payout_cooling_period_days: 0, fraud_velocity_threshold: 100, minimum_payout: { NG: 1 } }) }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => [] }));
vi.mock('@/lib/constants', () => ({ getCurrencyCode: () => 'NGN' }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));
vi.mock('@/lib/admin-mfa-transport', () => ({ verifyTotpOnSingleConnection: async (options: any) => {
  await options.bindChallenge('challenge-a');
  return { access_token: 'rotated-access', refresh_token: 'rotated-refresh' };
}}));

import { POST as prepare } from '@/app/api/admin/step-up/prepare/route';
import { POST as verify } from '@/app/api/admin/step-up/verify/route';
import { POST as generate } from '@/app/api/admin/payouts/generate/route';
const request = (path: string, body: any, token = fixture.token) => new NextRequest(`https://fixture.invalid/api/admin/${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function grant(params: any = { action: 'generate' }) {
  const response = await prepare(request('step-up/prepare', { actionType: 'payout_generate', targetId: null, params }));
  expect(response.status).toBe(200);
  const { stepUpId } = await response.json();
  const verified = await verify(request('step-up/verify', { stepUpId, code: '123456' }));
  expect(verified.status).toBe(200);
  expect(verified.headers.get('cache-control')).toBe('no-store');
  expect(await verified.json()).toMatchObject({ verified: true, session: { access_token: 'rotated-access', refresh_token: 'rotated-refresh' } });
  return stepUpId;
}
beforeEach(() => {
  Object.assign(fixture, { rows: {}, writes: [], clients: [], role: 'admin', aal: 'aal2', active: true, session: 'session-a', user: 'admin-a' });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.fixture.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ factors: [{ id: 'factor-a', factor_type: 'totp', status: 'verified' }] });
    if (url.endsWith('/factor-a/challenge')) return Response.json({ id: 'challenge-a' });
    if (url.endsWith('/factor-a/verify')) return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
    throw new Error(`Unexpected external request ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('reduced admin → backend prepare/verify/generate compatibility', () => {
  it.each(['payout_approve', 'payout_reject', 'refund', 'channel_change_execute', 'business_status'])('denies unsupported %s without issuing grants', async actionType => {
    expect((await prepare(request('step-up/prepare', { actionType, params: { action: 'generate' } }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.writes).toEqual([]);
  });
  it('denies support role and channel descriptors before issuing grants', async () => {
    fixture.role = 'support';
    expect((await prepare(request('step-up/prepare', { actionType: 'payout_generate', params: { action: 'generate' } }))).status).toBe(403);
    fixture.role = 'admin';
    expect((await prepare(request('step-up/prepare', { actionType: 'payout_generate', params: { action: 'generate', channel_change: {} } }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.writes).toEqual([]);
  });
  it('uses actual auth and single-use grant before bearer generation, with service audit and no-store', async () => {
    const stepUpId = await grant();
    expect((await generate(request('payouts/generate', { stepUpId }))).status).toBe(200);
    expect(fixture.rows.admin_step_up_authorizations[0].consumed_at).toBeTruthy();
    await vi.waitFor(() => expect(fixture.rows.admin_audit_logs?.some(r => r.action === 'step_up_consumed')).toBe(true));
    expect(fixture.clients.every(c => c?.noStore === true)).toBe(true);
    expect((await generate(request('payouts/generate', { stepUpId }))).status).toBe(403);
  });
  it.each(['aal1', 'missing-role', 'revoked', 'invalid-token'])('denies %s before Auth challenge or business mutation', async failure => {
    if (failure === 'aal1') fixture.aal = 'aal1';
    if (failure === 'missing-role') fixture.role = 'merchant';
    if (failure === 'revoked') fixture.active = false;
    const response = await prepare(request('step-up/prepare', { actionType: 'payout_generate', params: { action: 'generate' } }, failure === 'invalid-token' ? 'bad' : fixture.token));
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
    expect(fixture.writes.every(w => w.table === 'admin_audit_logs')).toBe(true);
  });
  it.each(['session', 'admin', 'params', 'expired', 'unverified'])('denies mismatched %s grant at actual generation boundary', async failure => {
    const id = await grant(failure === 'params' ? { action: 'other' } : undefined);
    const row = fixture.rows.admin_step_up_authorizations[0];
    if (failure === 'session') fixture.session = 'other-session';
    if (failure === 'admin') fixture.user = 'other-admin';
    if (failure === 'expired') row.expires_at = new Date(0).toISOString();
    if (failure === 'unverified') row.verified_at = null;
    fixture.writes = [];
    expect((await generate(request('payouts/generate', { stepUpId: id }))).status).toBe(403);
    expect(fixture.writes).toEqual([]); expect(row.consumed_at).toBeUndefined();
  });
  it('preserves separate currency platform-held totals while excluding connected-provider funds', async () => {
    const id = await grant();
    fixture.rows.businesses = [{ id: 'business-a', status: 'active', payout_mode: 'platform_managed', country_code: 'NG', verification_level: 'verified', created_at: '2020-01-01', payout_limit_monthly: 0 }];
    fixture.rows.platform_fees = [
      { business_id: 'business-a', transaction_amount: 100, fee_total: 10, gateway_fee: 5, is_direct_transfer: false, payments: { currency: 'NGN' } },
      { business_id: 'business-a', transaction_amount: 50, fee_total: 2, gateway_fee: 1, is_direct_transfer: false, payments: { currency: 'USD' } },
      { business_id: 'business-a', transaction_amount: 9000, fee_total: 5, gateway_fee: 1, is_direct_transfer: true, payments: { currency: 'NGN' } },
    ];
    expect((await generate(request('payouts/generate', { stepUpId: id }))).status).toBe(200);
    expect(fixture.rows.business_payouts.map(r => [r.currency, r.gross_amount, r.net_amount])).toEqual([['NGN', 100, 85], ['USD', 50, 47]]);
    expect(fixture.rows.business_payouts.map(r => r.status)).toEqual(['pending', 'held']);
    expect(fixture.rows.business_payouts[1].flags).toContainEqual(expect.objectContaining({ type: 'currency_review' }));
    expect(fetch).toHaveBeenCalledTimes(1); // Factor lookup only; paired Auth transport is mocked separately.
  });
});
