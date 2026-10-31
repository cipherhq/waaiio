/**
 * Actual GET + requirePlatformAdmin with synthetic Auth/DB boundaries.
 * Handler evidence only; not live HTTP, JWT cryptography or RLS certification.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const f = vi.hoisted(() => ({
  role: 'admin', aal: 'aal2', valid: true, sessionExists: true,
  business: { subscription_tier: 'growth' } as { subscription_tier: string } | null,
  failTable: '', caps: [{ capability: 'booking' }], overrides: [{ capability: 'booking' }],
  reads: [] as Array<{ table: string; select: string; filters: Array<[string, unknown]> }>,
  claims: vi.fn(), user: vi.fn(), audit: vi.fn(),
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: (...args: unknown[]) => f.audit(...args) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getSession: async () => ({ data: { session: null }, error: null }) } }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: {
      getClaims: (token: string) => {
        f.claims(token);
        return Promise.resolve(f.valid
          ? { data: { claims: { sub: 'synthetic-admin', aal: f.aal, session_id: 'synthetic-session' } }, error: null }
          : { data: null, error: { message: 'invalid' } });
      },
      getUser: (token: string) => {
        f.user(token);
        return Promise.resolve({ data: { user: { id: 'synthetic-admin', app_metadata: { role: f.role } } }, error: null });
      },
    },
    rpc: (name: string) => {
      if (name !== 'check_session_exists') throw new Error('Unexpected RPC');
      return { maybeSingle: async () => ({ data: { session_exists: f.sessionExists }, error: null }) };
    },
    from: (table: string) => {
      if (!['businesses', 'business_capabilities', 'capability_overrides'].includes(table)) throw new Error('Unexpected table');
      const query = { table, select: '', filters: [] as Array<[string, unknown]> };
      f.reads.push(query);
      const result = () => ({
        data: f.failTable === table ? null : table === 'businesses' ? f.business : table === 'business_capabilities' ? f.caps : f.overrides,
        error: f.failTable === table ? { message: 'sensitive database detail' } : null,
      });
      const chain = {
        select: (columns: string) => { query.select = columns; return chain; },
        eq: (column: string, value: unknown) => { query.filters.push([column, value]); return chain; },
        maybeSingle: async () => result(),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return chain;
    },
  }),
}));
import { GET } from '@/app/api/admin/businesses/[id]/capabilities/route';

function request(authorization: string | null = 'Bearer synthetic-token') {
  return new NextRequest('https://example.test/api/admin/businesses/synthetic-business/capabilities', {
    headers: authorization === null ? {} : { Authorization: authorization },
  });
}
function run(authorization: string | null = 'Bearer synthetic-token') {
  return GET(request(authorization), { params: Promise.resolve({ id: 'synthetic-business' }) });
}
beforeEach(() => {
  f.role = 'admin'; f.aal = 'aal2'; f.valid = true; f.sessionExists = true;
  f.business = { subscription_tier: 'growth' }; f.failTable = '';
  f.caps = [{ capability: 'booking' }]; f.overrides = [{ capability: 'booking' }];
  f.reads.length = 0; vi.clearAllMocks();
});
describe('secured capability GET', () => {
  it('reads the selected business only after verified Bearer/admin/aal2 checks', async () => {
    const response = await run();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tier: 'growth', capabilities: ['booking'], overrides: ['booking'] });
    expect(f.claims).toHaveBeenCalledWith('synthetic-token');
    expect(f.user).toHaveBeenCalledWith('synthetic-token');
    expect(f.reads).toEqual([
      { table: 'businesses', select: 'subscription_tier', filters: [['id', 'synthetic-business']] },
      { table: 'business_capabilities', select: 'capability', filters: [['business_id', 'synthetic-business'], ['is_enabled', true]] },
      { table: 'capability_overrides', select: 'capability', filters: [['business_id', 'synthetic-business']] },
    ]);
  });
  it.each(['support', 'finance', 'operations', 'customer'])('denies role %s before business reads', async role => {
    f.role = role; expect((await run()).status).toBe(403); expect(f.reads).toEqual([]);
  });
  it('denies aal1 before business reads', async () => {
    f.aal = 'aal1'; expect((await run()).status).toBe(403); expect(f.reads).toEqual([]);
  });
  it('denies missing session/token', async () => {
    expect((await run(null)).status).toBe(403); expect(f.reads).toEqual([]);
  });
  it('denies invalid bearer without cookie fallback', async () => {
    f.valid = false; expect((await run()).status).toBe(403); expect(f.reads).toEqual([]);
  });
  it('denies a revoked session', async () => {
    f.sessionExists = false; expect((await run()).status).toBe(403); expect(f.reads).toEqual([]);
  });
  it('returns 404 only for a successful missing-business lookup', async () => {
    f.business = null; expect((await run()).status).toBe(404); expect(f.reads).toHaveLength(1);
  });
  it.each(['businesses', 'business_capabilities', 'capability_overrides'])('returns sanitized 500 for %s failure', async table => {
    f.failTable = table; const response = await run();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Could not load capabilities. Please retry.' });
  });
  it('returns legitimate empty selections as 200', async () => {
    f.caps = []; f.overrides = [];
    const response = await run(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tier: 'growth', capabilities: [], overrides: [] });
  });
});
