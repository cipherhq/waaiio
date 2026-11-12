/**
 * #963: rescheduling a booking from the dashboard moves its pending after-booking
 * form link to the new start (the link lasts until the session starts). The
 * reschedule route runs as a handler with mocked dependencies; the intake
 * library is spied. The bot's reschedule path is covered in intake-send-963
 * (syncIntakeExpiry itself) and calls the same helper.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ result: { rescheduled: true, old_date: '2026-11-20' } as Record<string, unknown> }));
const sync = vi.hoisted(() => vi.fn(async () => undefined));
const service = vi.hoisted(() => {
  const chain = (data: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update']) c[m] = () => c;
    c.maybeSingle = async () => ({ data, error: null });
    c.single = async () => ({ data, error: null });
    c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
    return c;
  };
  return {
    from: (t: string) => chain(t === 'bookings' ? { flow_type: 'scheduling', id: 'bk-1', business_id: 'biz-1', service_id: 's1', businesses: { name: 'Healing Labs' } } : null),
    rpc: async () => ({ data: env.result, error: null }),
  };
});

vi.mock('@/lib/intake/send', () => ({ syncIntakeExpiry: sync }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: async () => ({ user: { id: 'owner-1' }, businessId: 'biz-1', service }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireAnyCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { async resolveByBusinessId() { return null; } } }));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: () => ({ subject: 'T', html: '' }) }));
vi.mock('@/lib/waitlist/auto-notify', () => ({ notifyWaitlistOnSlotOpen: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST } from '@/app/api/bookings/[id]/reschedule/route';

const move = () => POST(new NextRequest('http://x/api/bookings/bk-1/reschedule', {
  method: 'POST', body: JSON.stringify({ newDate: '2026-11-25', newTime: '15:30', businessId: 'biz-1' }),
}), { params: Promise.resolve({ id: 'bk-1' }) });

beforeEach(() => { sync.mockClear(); env.result = { rescheduled: true, old_date: '2026-11-20' }; });

describe('dashboard reschedule and the intake link', () => {
  it('moves the pending link expiry for the rescheduled booking', async () => {
    const res = await move();
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(service, 'biz-1', 'bk-1');
  });

  it('touches nothing when the reschedule was refused or changed nothing', async () => {
    env.result = { rescheduled: false, reason: 'slot_full' };
    expect((await move()).status).toBe(409);
    env.result = { rescheduled: true, already_at_target: true };
    expect((await move()).status).toBe(200);
    expect(sync).not.toHaveBeenCalled();
  });
});
