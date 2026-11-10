/**
 * #963: the public booking page's before-booking form endpoint
 * (POST /api/bookings/public/intake), run as a handler on the real intake
 * library with an in-memory database (Owner decisions 2026-11-10).
 */
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDb } from './helpers/intake-fake-db';

type Row = Record<string, unknown>;
const env = vi.hoisted(() => ({ db: null as unknown, tier: 'growth', verified: 'ada@example.com' as string | null }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => env.db }));
vi.mock('@/lib/otp-token', () => ({ verifyOtpToken: () => env.verified }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/trial-status', () => ({ resolveLimitTier: async () => env.tier }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class {} }));

import { POST } from '@/app/api/bookings/public/intake/route';

const SVC = '11111111-1111-4111-8111-111111111111';
const BIZ = 'b1';
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

function world(over: { service?: Row; intakes?: Row[] } = {}) {
  return makeDb({
    businesses: [{ id: BIZ, slug: 'healing', status: 'active', name: 'Healing Labs', subscription_tier: 'growth' }],
    services: [{ id: SVC, business_id: BIZ, intake_form_id: 'f1', intake_timing: 'before_booking', intake_frequency: 'every_booking', is_class: false, ...over.service }],
    forms: [{ id: 'f1', business_id: BIZ, title: 'Intake', is_active: true, fields: [{ id: 'q', type: 'text', required: true }] }],
    bookings: [],
    booking_intakes: over.intakes || [],
  });
}
const BODY = { businessSlug: 'healing', serviceId: SVC, guestEmail: 'Ada@example.com', guestPhone: '+234 801 234 5678', otpToken: 'otp' };
const call = async (extra: Row = {}) => {
  const res = await POST(new NextRequest('http://x/api/bookings/public/intake', { method: 'POST', body: JSON.stringify({ ...BODY, ...extra }) }));
  return { status: res.status, body: await res.json(), headers: res.headers };
};

beforeEach(() => { env.db = world(); env.tier = 'growth'; env.verified = 'ada@example.com'; });

describe('POST /api/bookings/public/intake', () => {
  it('opens a 24-hour before-booking intake for the verified client and returns its token once', async () => {
    const { status, body, headers } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ required: true });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(headers.get('Cache-Control')).toBe('no-store');
    const [row] = (env.db as ReturnType<typeof makeDb>).tables.booking_intakes;
    expect(row).toMatchObject({ id: body.intakeId, business_id: BIZ, service_id: SVC, form_id: 'f1', timing: 'before_booking', customer_phone: '+2348012345678', token_hash: sha(body.token) });
  });

  it('says no form is needed when the service has none before booking, or the business is not entitled', async () => {
    env.db = world({ service: { intake_timing: 'after_booking' } });
    expect((await call()).body).toEqual({ required: false });
    env.db = world(); env.tier = 'free';
    expect((await call()).body).toEqual({ required: false });
    expect((env.db as ReturnType<typeof makeDb>).tables.booking_intakes).toEqual([]);
  });

  it('refuses an unverified email or a missing phone, opening nothing', async () => {
    env.verified = 'someone.else@example.com';
    expect((await call()).status).toBe(403);
    env.verified = null;
    expect((await call()).status).toBe(403);
    env.verified = 'ada@example.com';
    const noPhone = await call({ guestPhone: '' });
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.code).toBe('phone_required');
    expect((env.db as ReturnType<typeof makeDb>).tables.booking_intakes).toEqual([]);
  });

  it('an intake already answered is reported as done, with no new link', async () => {
    env.db = world({ intakes: [{ id: '22222222-2222-4222-8222-222222222222', business_id: BIZ, service_id: SVC, form_id: 'f1', customer_phone: '+2348012345678', booking_id: null, timing: 'before_booking', status: 'submitted' }] });
    const { body } = await call({ intakeId: '22222222-2222-4222-8222-222222222222' });
    expect(body).toEqual({ required: true, intakeId: '22222222-2222-4222-8222-222222222222', submitted: true });
    expect((env.db as ReturnType<typeof makeDb>).tables.booking_intakes).toHaveLength(1);
  });

  it("someone else's intake id is never reused: a fresh intake is opened instead", async () => {
    const other = { id: '33333333-3333-4333-8333-333333333333', business_id: BIZ, service_id: SVC, form_id: 'f1', customer_phone: '+2340000000000', booking_id: null, timing: 'before_booking', status: 'submitted' };
    env.db = world({ intakes: [other] });
    const { body } = await call({ intakeId: other.id });
    expect(body.submitted).toBeUndefined();
    expect(body.intakeId).not.toBe(other.id);
    expect((env.db as ReturnType<typeof makeDb>).tables.booking_intakes).toHaveLength(2);
  });

  it('an unknown business is not found', async () => {
    expect((await call({ businessSlug: 'nope' })).status).toBe(404);
  });
});
