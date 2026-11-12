/**
 * The deferred trial-activation job must actually run (Owner, 2026-11-07:
 * "Make it safe first" before message charging is switched on).
 *
 * activate_trial_if_eligible is called at go-live (onboarding verify,
 * embedded signup) and when an owner claims the credit (#955). While messaging_financial_gate is off it answers
 * financial_gate_off and grants nothing; the only retry is the
 * /api/cron/trial-activation route, which was never in vercel.json. Without
 * it, businesses that went live before charging was switched on never get
 * their trial credit, and their messages are blocked once charging is on.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const rpc = vi.fn();
const upsert = vi.fn(async () => ({ error: null }));
let businesses: Array<{ id: string; name: string }> = [];

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'alerts') return { upsert };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'or', 'order']) chain[m] = () => chain;
      chain.limit = async () => ({ data: businesses, error: null });
      return chain;
    },
    rpc,
  }),
}));

const request = (auth?: string) => new NextRequest('https://www.waaiio.com/api/cron/trial-activation', {
  headers: auth ? { authorization: auth } : {},
});

describe('trial-activation cron schedule', () => {
  it('vercel.json runs /api/cron/trial-activation every hour', () => {
    const crons = JSON.parse(readFileSync('vercel.json', 'utf8')).crons as Array<{ path: string; schedule: string }>;
    const entry = crons.filter(c => c.path === '/api/cron/trial-activation');
    expect(entry).toEqual([{ path: '/api/cron/trial-activation', schedule: '30 * * * *' }]);
  });
});

describe('GET /api/cron/trial-activation', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
    rpc.mockReset();
    upsert.mockClear();
    businesses = [];
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('refuses a request without the cron secret (no activation attempted)', async () => {
    const { GET } = await import('@/app/api/cron/trial-activation/route');
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('activates an eligible business once charging is on', async () => {
    businesses = [{ id: 'biz-1', name: 'Salon' }];
    rpc.mockImplementation(async (name: string) => name === 'activate_trial_if_eligible'
      ? { data: { activated: true }, error: null }
      : { data: [], error: null });
    const { GET } = await import('@/app/api/cron/trial-activation/route');
    const res = await GET(request('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ activated: 1, pending: 0, errors: 0, total: 1 });
    expect(rpc).toHaveBeenCalledWith('activate_trial_if_eligible', { p_business_id: 'biz-1' });
  });

  it('while charging is off it grants nothing (activation answers financial_gate_off)', async () => {
    businesses = [{ id: 'biz-2', name: 'Cafe' }];
    rpc.mockImplementation(async (name: string) => name === 'activate_trial_if_eligible'
      ? { data: { activated: false, reason: 'financial_gate_off' }, error: null }
      : { data: [], error: null });
    const { GET } = await import('@/app/api/cron/trial-activation/route');
    const res = await GET(request('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ activated: 0, pending: 1, errors: 0 });
    expect(rpc).toHaveBeenCalledWith('activate_trial_if_eligible', { p_business_id: 'biz-2' });
    expect(rpc).not.toHaveBeenCalledWith('grant_messaging_allowance', expect.anything());
    // The pending alert is not asserted here; fixing how it is written is a
    // known follow-up (see the changelog fragment).
  });
});
