/**
 * #963 lane 3: the intake reminder cron and the owner-only after-confirm route,
 * run as route handlers with the send library mocked.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  cronOk: true,
  user: { id: 'owner' } as { id: string } | null,
  role: { ok: true, role: 'owner', isOwner: true } as { ok: boolean; role?: string; isOwner?: boolean; error?: string },
  bookingExists: true,
  due: [{ id: 'i1' }, { id: 'i2' }] as Array<{ id: string }>,
  dueFilters: [] as Array<[string, string, unknown]>,
  reminders: [] as string[],
  deliveries: [] as string[],
}));

vi.mock('@/lib/cron-auth', () => ({
  verifyCronAuth: () => (env.cronOk ? null : new Response('no', { status: 401 })),
}));
vi.mock('@/lib/capabilities/resolve-role', () => ({ resolveBusinessRole: async () => env.role }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class {} }));
vi.mock('@/lib/intake/send', () => ({
  sendIntakeReminder: async (_db: unknown, id: string) => { env.reminders.push(id); return id === 'i1' ? { status: 'sent' } : { status: 'skipped', reason: 'window_closed' }; },
  deliverAfterBookingIntake: async (_db: unknown, id: string) => { env.deliveries.push(id); return { status: 'sent', intakeId: 'x' }; },
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      const record = (op: string) => (c: string, v: unknown) => { if (table === 'booking_intakes') env.dueFilters.push([op, c, v]); return q; };
      Object.assign(q, {
        select: () => q, eq: record('eq'), is: record('is'), not: (c: string, _o: string, v: unknown) => record('not')(c, v),
        gt: record('gt'), lte: record('lte'), order: () => q, limit: () => q, range: () => q,
        maybeSingle: async () => ({ data: table === 'bookings' && env.bookingExists ? { id: 'k1' } : null, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: env.due, error: null }).then(r),
      });
      return q;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: env.user } }) },
    from() {
      const q: Record<string, unknown> = {};
      Object.assign(q, { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null }) });
      return q;
    },
  }),
}));

import { GET as cron } from '@/app/api/cron/intake-reminders/route';
import { POST as afterConfirm } from '@/app/api/intake/after-confirm/route';

const BOOKING = '11111111-1111-4111-8111-111111111111';
const BUSINESS = '22222222-2222-4222-8222-222222222222';
const post = (body: unknown) => afterConfirm(new NextRequest('http://x/api/intake/after-confirm', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  Object.assign(env, { cronOk: true, user: { id: 'owner' }, role: { ok: true, role: 'owner', isOwner: true }, bookingExists: true, due: [{ id: 'i1' }, { id: 'i2' }], dueFilters: [], reminders: [], deliveries: [] });
});

describe('GET /api/cron/intake-reminders', () => {
  it('requires the cron secret', async () => {
    env.cronOk = false;
    expect((await cron(new NextRequest('http://x/api/cron/intake-reminders'))).status).toBe(401);
    expect(env.reminders).toEqual([]);
  });

  it('selects only unanswered, sent, after-booking intakes whose session is 22-25 hours away, and reminds each', async () => {
    const before = Date.now();
    const res = await cron(new NextRequest('http://x/api/cron/intake-reminders'));
    expect(await res.json()).toEqual({ due: 2, sent: 1, window_closed: 1 });
    expect(env.reminders).toEqual(['i1', 'i2']);
    const f = env.dueFilters;
    expect(f).toContainEqual(['eq', 'status', 'pending']);
    expect(f).toContainEqual(['eq', 'timing', 'after_booking']);
    expect(f).toContainEqual(['is', 'reminder_sent_at', null]);
    expect(f).toContainEqual(['not', 'sent_at', null]);
    const gt = Date.parse(f.find(x => x[0] === 'gt')![2] as string);
    const lte = Date.parse(f.find(x => x[0] === 'lte')![2] as string);
    expect(gt - before).toBeGreaterThanOrEqual(22 * 3_600_000);
    expect(gt - before).toBeLessThan(22 * 3_600_000 + 5_000);
    expect(lte - gt).toBe(3 * 3_600_000);
  });
});

describe('POST /api/intake/after-confirm', () => {
  it('sends for the owner of the booking business', async () => {
    const res = await post({ bookingId: BOOKING, businessId: BUSINESS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'sent' });
    expect(env.deliveries).toEqual([BOOKING]);
  });

  it('sends for an active team member of the business (Owner decision 2026-11-10)', async () => {
    env.role = { ok: true, role: 'staff', isOwner: false };
    const res = await post({ bookingId: BOOKING, businessId: BUSINESS });
    expect(res.status).toBe(200);
    expect(env.deliveries).toEqual([BOOKING]);
  });

  it('rejects a signed-out user, an outsider, a failed role lookup, an unknown booking and bad input, sending nothing', async () => {
    env.user = null;
    expect((await post({ bookingId: BOOKING, businessId: BUSINESS })).status).toBe(401);
    env.user = { id: 'owner' };
    env.role = { ok: false, error: 'not_found' };
    expect((await post({ bookingId: BOOKING, businessId: BUSINESS })).status).toBe(403);
    env.role = { ok: false, error: 'db_error' };
    expect((await post({ bookingId: BOOKING, businessId: BUSINESS })).status).toBe(500);
    env.role = { ok: true, role: 'owner', isOwner: true };
    env.bookingExists = false;
    expect((await post({ bookingId: BOOKING, businessId: BUSINESS })).status).toBe(404);
    expect((await post({ bookingId: 'nope', businessId: BUSINESS })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(env.deliveries).toEqual([]);
  });
});
