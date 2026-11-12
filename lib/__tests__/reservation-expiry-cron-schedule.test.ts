/**
 * #1000: the messaging reservation-expiry job must actually run (Owner, 2026-11-12: hourly).
 *
 * A send cut off between authorization and emission leaves its reservation holding the
 * merchant's prepaid balance and spend-cap room. /api/cron/reservation-expiry releases it via
 * safe_release_expired_reservation (M371), but the route was never in vercel.json, and
 * recover-reservations only handles growth-credit campaign reservations (M243).
 *
 * Runs the real route GET with the service client mocked at the PostgREST boundary.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const rpc = vi.fn();
let expired: Array<{ id: string }> = [];
let noDeadline: Array<{ id: string }> = [];
const queries: Array<Record<string, unknown>> = [];

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = { table };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (c: string, v: unknown) => { q[`eq:${c}`] = v; return chain; };
      chain.lt = (c: string, v: unknown) => { q[`lt:${c}`] = v; return chain; };
      chain.is = (c: string, v: unknown) => { q[`is:${c}`] = v; return chain; };
      chain.limit = async () => ({ data: 'lt:reservation_expires_at' in q ? expired : noDeadline, error: null });
      return chain;
    },
    rpc,
  }),
}));

import { GET } from '@/app/api/cron/reservation-expiry/route';

const request = (auth?: string) => new NextRequest('https://www.waaiio.com/api/cron/reservation-expiry', {
  headers: auth ? { authorization: auth } : {},
});

describe('#1000 reservation-expiry cron', () => {
  const prev = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
    rpc.mockReset();
    queries.length = 0;
    expired = [];
    noDeadline = [];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  });

  it('vercel.json runs /api/cron/reservation-expiry every hour, once', () => {
    const crons = JSON.parse(readFileSync('vercel.json', 'utf8')).crons as Array<{ path: string; schedule: string }>;
    const entries = crons.filter(c => c.path === '/api/cron/reservation-expiry');
    expect(entries).toEqual([{ path: '/api/cron/reservation-expiry', schedule: '50 * * * *' }]);
  });

  it('refuses a request without the cron secret and touches nothing', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(queries).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sends only reserved attempts to the safe release function and reports the outcome', async () => {
    expired = [{ id: 'a-safe' }, { id: 'a-ambiguous' }];
    noDeadline = [{ id: 'a-no-deadline' }];
    rpc.mockImplementation(async (_fn: string, args: { p_attempt_id: string }) => {
      if (args.p_attempt_id === 'a-safe') return { data: { released: true }, error: null };
      if (args.p_attempt_id === 'a-ambiguous') return { data: { released: false, reason: 'not_pre_emission' }, error: null };
      return { data: { released: false, reason: 'missing_deadline' }, error: null };
    });

    const res = await GET(request('Bearer test-secret'));
    expect(await res.json()).toEqual({ status: 'ok', scanned: 3, released: 1, flagged: 2, errors: 0 });
    expect(rpc.mock.calls.map(c => c[0])).toEqual(Array(3).fill('safe_release_expired_reservation'));
    expect(rpc.mock.calls.map(c => c[1].p_attempt_id).sort()).toEqual(['a-ambiguous', 'a-no-deadline', 'a-safe']);
    // Both scans read message_send_attempts in the 'reserved' disposition only
    expect(queries.every(q => q.table === 'message_send_attempts' && q['eq:financial_disposition'] === 'reserved')).toBe(true);
  });
});
