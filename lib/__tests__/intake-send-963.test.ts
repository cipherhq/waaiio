/**
 * #963 lane 3: creating and sending client intake links (lib/intake/send.ts).
 * An in-memory database stands in for Supabase; the WhatsApp window check and
 * the plan resolver are mocked so each rule can be driven directly.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDb as makeFakeDb } from './helpers/intake-fake-db';

type Row = Record<string, unknown>;
const env = vi.hoisted(() => ({
  window: 'open' as 'open' | 'closed' | 'unknown',
  tier: 'growth' as string,
  failInsert: null as null | { code: string },
}));
vi.mock('@/lib/forms/form-send', () => ({ businessChatWindowState: async () => env.window }));
vi.mock('@/lib/trial-status', () => ({ resolveLimitTier: async () => env.tier }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { async resolveByBusinessId() { return null; } } }));

import {
  deliverAfterBookingIntake, hasAnsweredBefore, intakeState, intakeUrl, linkIntakeToBooking, newIntakeToken,
  openBeforeBookingIntake, sendIntakeReminder, toE164, zonedTimeToUtc, BEFORE_BOOKING_TTL_MS,
} from '@/lib/intake/send';

const BIZ = 'b1';
const NOW = Date.UTC(2026, 10, 10, 10, 0);
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

const makeDb = (t: Record<string, Row[]>) => makeFakeDb(t, { failInsert: () => env.failInsert });

function world(over: { service?: Row; booking?: Row; business?: Row; form?: Row; intakes?: Row[]; optOuts?: Row[] } = {}) {
  return makeDb({
    businesses: [{ id: BIZ, name: 'Healing Labs', subscription_tier: 'growth', timezone: 'Africa/Lagos', ...over.business }],
    services: [{ id: 's1', business_id: BIZ, name: 'Assessment', intake_form_id: 'f1', intake_timing: 'after_booking', intake_frequency: 'every_booking', ...over.service }],
    forms: [{ id: 'f1', business_id: BIZ, title: 'Intake', is_active: true, fields: [{ id: 'q', type: 'text', required: true }], ...over.form }],
    bookings: [{ id: 'k1', business_id: BIZ, service_id: 's1', guest_phone: '+2348012345678', date: '2026-11-20', time: '10:00:00', status: 'confirmed', ...over.booking }],
    booking_intakes: over.intakes || [],
    messaging_opt_outs: over.optOuts || [],
  });
}
/** Every read of `table` fails, as if the database could not answer. */
function failReads(db: ReturnType<typeof makeDb>, table: string) {
  const original = db.from;
  (db as { from: unknown }).from = (t: string) => {
    const q = original(t) as Record<string, unknown>;
    if (t === table) {
      const err = { data: null, count: null, error: { code: 'XX' } };
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(err).then(res);
      q.maybeSingle = async () => err;
    }
    return q;
  };
  return db;
}
const sender = () => {
  const sent: Array<{ to: string; text: string }> = [];
  let fail = false;
  return {
    sent, failNext: () => { fail = true; },
    resolver: { resolveByBusinessId: async () => ({ channel: { id: 'ch' }, sender: { sendText: async (m: { to: string; text: string }) => { if (fail) throw new Error('provider'); sent.push(m); return { success: true }; } } }) as never },
  };
};

beforeEach(() => { env.window = 'open'; env.tier = 'growth'; env.failInsert = null; });

describe('helpers', () => {
  it('makes a 43-character base64url token and stores only its sha256', () => {
    const { token, hash } = newIntakeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(sha(token));
    expect(intakeUrl(token)).toMatch(new RegExp(`/intake/${token}$`));
  });

  it('normalises phones to +digits within the database rule', () => {
    expect(toE164('234 801 234 5678')).toBe('+2348012345678');
    expect(toE164('+44 (20) 7946-0958')).toBe('+442079460958');
    expect(toE164('12345')).toBeNull();
    expect(toE164(null)).toBeNull();
  });

  it('converts the business wall-clock time to UTC', () => {
    expect(zonedTimeToUtc('2026-11-20', '10:00:00', 'Africa/Lagos')!.toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-01', '10:00', 'America/New_York')!.toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(zonedTimeToUtc('2026-11-20', '10:00', 'Not/AZone')!.toISOString()).toBe('2026-11-20T10:00:00.000Z');
    expect(zonedTimeToUtc('bad', '10:00', 'UTC')).toBeNull();
  });

  it('handles times next to a daylight-saving change', () => {
    // US spring forward 2026-03-08 02:00 -> 03:00 EDT (UTC-4).
    expect(zonedTimeToUtc('2026-03-08', '03:30', 'America/New_York')!.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedTimeToUtc('2026-03-08', '01:30', 'America/New_York')!.toISOString()).toBe('2026-03-08T06:30:00.000Z');
    // UK fall back 2026-10-25 02:00 BST -> 01:00 GMT.
    expect(zonedTimeToUtc('2026-10-25', '03:00', 'Europe/London')!.toISOString()).toBe('2026-10-25T03:00:00.000Z');
    expect(zonedTimeToUtc('2026-10-24', '12:00', 'Europe/London')!.toISOString()).toBe('2026-10-24T11:00:00.000Z');
  });
});

describe('deliverAfterBookingIntake', () => {
  it('sends once for a confirmed booking, storing the hash, phone and session start as expiry', async () => {
    const db = world(); const s = sender();
    const r = await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, now: NOW });
    expect(r.status).toBe('sent');
    const [row] = db.tables.booking_intakes;
    expect(row).toMatchObject({ business_id: BIZ, booking_id: 'k1', form_id: 'f1', service_id: 's1', timing: 'after_booking', customer_phone: '+2348012345678', expires_at: '2026-11-20T09:00:00.000Z' });
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].to).toBe('2348012345678');
    const token = /\/intake\/([A-Za-z0-9_-]+)/.exec(s.sent[0].text)![1];
    expect(sha(token)).toBe(row.token_hash);
    expect(JSON.stringify(db.tables)).not.toContain(token);

    const again = await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, now: NOW });
    expect(again).toEqual({ status: 'skipped', reason: 'already_exists' });
    expect(s.sent).toHaveLength(1);
  });

  it('treats a concurrent duplicate insert (23505) as already sent', async () => {
    env.failInsert = { code: '23505' };
    const r = await deliverAfterBookingIntake(world() as never, 'k1', { resolver: sender().resolver, now: NOW });
    expect(r).toEqual({ status: 'skipped', reason: 'already_exists' });
  });

  it.each([
    ['not confirmed', { booking: { status: 'pending' } }, 'not_confirmed'],
    ['appointment booking (no service)', { booking: { service_id: null } }, 'no_service'],
    ['before-booking form', { service: { intake_timing: 'before_booking' } }, 'no_after_intake'],
    ['no form linked', { service: { intake_form_id: null } }, 'no_after_intake'],
    ['session already started', { booking: { date: '2026-11-10', time: '10:00:00' } }, 'session_started'],
    ['inactive form', { form: { is_active: false } }, 'form_unusable'],
    ['form with a required file question', { form: { fields: [{ id: 'x', type: 'file', required: true }] } }, 'form_unusable'],
    ['client sent STOP', { optOuts: [{ phone: '2348012345678', channel: 'whatsapp', resubscribed_at: null }] }, 'opted_out'],
  ])('skips and creates nothing: %s', async (_name, over, reason) => {
    const db = world(over as never); const s = sender();
    const r = await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, now: NOW });
    expect(r).toEqual({ status: 'skipped', reason });
    expect(db.tables.booking_intakes).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it('skips a Starter business after its trial', async () => {
    env.tier = 'free';
    const db = world(); const s = sender();
    expect(await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'not_entitled' });
    expect(db.tables.booking_intakes).toEqual([]);
  });

  it('sends nothing outside the 24-hour window, or when the window cannot be read (Owner decision)', async () => {
    for (const w of ['closed', 'unknown'] as const) {
      env.window = w;
      const db = world(); const s = sender();
      expect(await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'window_closed' });
      expect(db.tables.booking_intakes).toEqual([]);
      expect(s.sent).toEqual([]);
    }
  });

  it('first booking only: skips a client who already answered this form', async () => {
    const db = world({
      service: { intake_frequency: 'first_booking' },
      intakes: [{ id: 'old', business_id: BIZ, form_id: 'f1', customer_phone: '+2348012345678', status: 'submitted', booking_id: 'k0' }],
    });
    expect(await deliverAfterBookingIntake(db as never, 'k1', { resolver: sender().resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'answered_before' });
  });

  it('every booking: asks again even after an earlier answer', async () => {
    const db = world({ intakes: [{ id: 'old', business_id: BIZ, form_id: 'f1', customer_phone: '+2348012345678', status: 'submitted', booking_id: 'k0' }] });
    expect((await deliverAfterBookingIntake(db as never, 'k1', { resolver: sender().resolver, now: NOW })).status).toBe('sent');
  });

  it('removes the intake when WhatsApp refuses the message, so the booking shows "Not sent"', async () => {
    const db = world(); const s = sender(); s.failNext();
    expect(await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'send_failed' });
    expect(db.tables.booking_intakes).toEqual([]);
  });

  it('a booking made by hand sends a before-booking form as in after mode; other paths do not', async () => {
    const db = world({ service: { intake_timing: 'before_booking' } }); const s = sender();
    expect(await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'no_after_intake' });
    const r = await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, includeBeforeBooking: true, now: NOW });
    expect(r.status).toBe('sent');
    expect(db.tables.booking_intakes[0]).toMatchObject({ timing: 'after_booking', booking_id: 'k1' });
    expect(s.sent).toHaveLength(1);
  });

  it('sends nothing when the STOP list cannot be read (fails closed)', async () => {
    const db = failReads(world(), 'messaging_opt_outs'); const s = sender();
    expect(await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'opted_out' });
    expect(db.tables.booking_intakes).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it('prepareOnly (bot, live chat) returns the message and link without sending or checking the window', async () => {
    env.window = 'closed';
    const db = world(); const s = sender();
    const r = await deliverAfterBookingIntake(db as never, 'k1', { resolver: s.resolver, prepareOnly: true, now: NOW });
    expect(r.status).toBe('prepared');
    if (r.status !== 'prepared') return;
    expect(r.text).toContain(r.url);
    expect(r.text).toContain('Healing Labs');
    expect(s.sent).toEqual([]);
    expect(db.tables.booking_intakes).toHaveLength(1);
  });
});

describe('before-booking intake (bot)', () => {
  it('opens a 24-hour intake with no booking yet', async () => {
    const db = world({ service: { intake_timing: 'before_booking' } });
    const r = await openBeforeBookingIntake(db as never, { businessId: BIZ, serviceId: 's1', formId: 'f1', phone: '2348012345678', now: NOW });
    expect(r).not.toBeNull();
    const [row] = db.tables.booking_intakes;
    expect(row).toMatchObject({ timing: 'before_booking', customer_phone: '+2348012345678', expires_at: new Date(NOW + BEFORE_BOOKING_TTL_MS).toISOString() });
    expect(row.booking_id ?? null).toBeNull();
    expect(sha(r!.url.split('/intake/')[1])).toBe(row.token_hash);
  });

  it('re-opening a pending intake rotates its link on the same row', async () => {
    const db = world();
    const first = await openBeforeBookingIntake(db as never, { businessId: BIZ, serviceId: 's1', formId: 'f1', phone: '2348012345678', now: NOW });
    const second = await openBeforeBookingIntake(db as never, { businessId: BIZ, serviceId: 's1', formId: 'f1', phone: '2348012345678', existingIntakeId: first!.intakeId, now: NOW + 1000 });
    expect(second!.intakeId).toBe(first!.intakeId);
    expect(second!.url).not.toBe(first!.url);
    expect(db.tables.booking_intakes).toHaveLength(1);
    expect(db.tables.booking_intakes[0].token_hash).toBe(sha(second!.url.split('/intake/')[1]));
  });

  it('reports state, and links the answered intake to the booking only once', async () => {
    const db = world({ intakes: [{ id: 'i1', business_id: BIZ, status: 'pending', expires_at: new Date(NOW + 1000).toISOString(), booking_id: null }] });
    expect(await intakeState(db as never, BIZ, 'i1', NOW)).toBe('pending');
    expect(await intakeState(db as never, BIZ, 'i1', NOW + 2000)).toBe('expired');
    expect(await intakeState(db as never, BIZ, 'nope', NOW)).toBe('missing');
    expect(await intakeState(db as never, 'other-business', 'i1', NOW)).toBe('missing');
    db.tables.booking_intakes[0].status = 'submitted';
    expect(await intakeState(db as never, BIZ, 'i1', NOW + 2000)).toBe('submitted');
    await linkIntakeToBooking(db as never, BIZ, 'i1', 'k1');
    await linkIntakeToBooking(db as never, BIZ, 'i1', 'k2');
    expect(db.tables.booking_intakes[0].booking_id).toBe('k1');
  });

  it('hasAnsweredBefore leaves out the intake of the booking in progress', async () => {
    const db = world({ intakes: [{ id: 'mine', business_id: BIZ, form_id: 'f1', customer_phone: '+2348012345678', status: 'submitted' }] });
    expect(await hasAnsweredBefore(db as never, BIZ, 'f1', '2348012345678', 'mine')).toBe(false);
    expect(await hasAnsweredBefore(db as never, BIZ, 'f1', '2348012345678')).toBe(true);
  });

  it('hasAnsweredBefore counts an unreadable answer as answered, so a first-booking form is never sent twice', async () => {
    const db = failReads(world(), 'booking_intakes');
    expect(await hasAnsweredBefore(db as never, BIZ, 'f1', '2348012345678')).toBe(true);
  });

  it('hasAnsweredBefore matches the client by phone and form within the business', async () => {
    const db = world({ intakes: [{ id: 'i', business_id: BIZ, form_id: 'f1', customer_phone: '+2348012345678', status: 'submitted' }] });
    expect(await hasAnsweredBefore(db as never, BIZ, 'f1', '2348012345678')).toBe(true);
    expect(await hasAnsweredBefore(db as never, BIZ, 'f2', '2348012345678')).toBe(false);
    expect(await hasAnsweredBefore(db as never, 'b2', 'f1', '2348012345678')).toBe(false);
  });
});

describe('sendIntakeReminder', () => {
  // NOW + 24h = 2026-11-11T10:00Z = 11:00 in Africa/Lagos (the booking k1 below).
  const pending = (over: Row = {}) => ({
    id: 'i1', business_id: BIZ, service_id: 's1', form_id: 'f1', booking_id: 'k1', customer_phone: '+2348012345678',
    status: 'pending', timing: 'after_booking', sent_at: new Date(NOW - 48 * 3_600_000).toISOString(),
    reminder_sent_at: null, expires_at: new Date(NOW + 24 * 3_600_000).toISOString(), token_hash: 'a'.repeat(64), ...over,
  });
  const due = (over: { intake?: Row; booking?: Row; optOuts?: Row[] } = {}) =>
    world({ intakes: [pending(over.intake)], booking: { date: '2026-11-11', time: '11:00:00', ...over.booking }, optOuts: over.optOuts });

  it('sends one reminder with a fresh link, then never again', async () => {
    const db = due(); const s = sender();
    expect(await sendIntakeReminder(db as never, 'i1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'sent' });
    const row = db.tables.booking_intakes[0];
    expect(row.reminder_sent_at).toBe(new Date(NOW).toISOString());
    const token = /\/intake\/([A-Za-z0-9_-]+)/.exec(s.sent[0].text)![1];
    expect(row.token_hash).toBe(sha(token));
    expect(s.sent[0].text).toContain('Reminder');
    expect((await sendIntakeReminder(db as never, 'i1', { resolver: s.resolver, now: NOW })).status).toBe('skipped');
    expect(s.sent).toHaveLength(1);
  });

  it('does not remind when the first link was sent less than a day before the session (it is the reminder)', async () => {
    const db = due({ intake: { sent_at: new Date(NOW - 15 * 60_000).toISOString() } }); const s = sender();
    expect(await sendIntakeReminder(db as never, 'i1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'sent_recently' });
    expect(db.tables.booking_intakes[0].token_hash).toBe('a'.repeat(64));
    expect(s.sent).toEqual([]);
  });

  it('two runs racing: only the one that claims the row sends', async () => {
    const db = due(); const s = sender();
    const original = db.from;
    (db as { from: unknown }).from = (t: string) => {
      const q = original(t) as Record<string, unknown>;
      if (t === 'booking_intakes') {
        const update = q.update as (p: Row) => unknown;
        // The other run claims the row between this run's read and its claim.
        q.update = (p: Row) => { db.tables.booking_intakes[0].reminder_sent_at = new Date(NOW - 1000).toISOString(); return update(p); };
      }
      return q;
    };
    expect(await sendIntakeReminder(db as never, 'i1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'already_claimed' });
    expect(db.tables.booking_intakes[0].token_hash).toBe('a'.repeat(64));
    expect(s.sent).toEqual([]);
  });

  it('a failed send releases the claim and gives back the link the client already has', async () => {
    const db = due(); const s = sender(); s.failNext();
    expect(await sendIntakeReminder(db as never, 'i1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'send_failed' });
    expect(db.tables.booking_intakes[0].reminder_sent_at).toBeNull();
    expect(db.tables.booking_intakes[0].token_hash).toBe('a'.repeat(64));
  });

  it('never reminds for a cancelled, finished or deleted booking', async () => {
    for (const status of ['cancelled', 'completed', 'no_show', 'pending']) {
      const s = sender();
      expect(await sendIntakeReminder(due({ booking: { status } }) as never, 'i1', { resolver: s.resolver, now: NOW }), status).toEqual({ status: 'skipped', reason: 'booking_inactive' });
      expect(s.sent).toEqual([]);
    }
    expect(await sendIntakeReminder(due({ intake: { booking_id: null } }) as never, 'i1', { resolver: sender().resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'booking_inactive' });
  });

  it('a rescheduled booking moves the link expiry to the new start instead of reminding now', async () => {
    const db = due({ booking: { date: '2026-11-13', time: '15:00:00' } }); const s = sender();
    expect(await sendIntakeReminder(db as never, 'i1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'rescheduled' });
    expect(db.tables.booking_intakes[0].expires_at).toBe('2026-11-13T14:00:00.000Z');
    expect(s.sent).toEqual([]);
  });

  it.each([
    ['submitted', { status: 'submitted' }, 'not_due'],
    ['before-booking intake', { timing: 'before_booking' }, 'not_due'],
    ['never sent', { sent_at: null }, 'not_due'],
  ])('does not remind: %s', async (_n, over, reason) => {
    const db = due({ intake: over }); const s = sender();
    expect(await sendIntakeReminder(db as never, 'i1', { resolver: s.resolver, now: NOW })).toEqual({ status: 'skipped', reason });
    expect(s.sent).toEqual([]);
  });

  it('does not remind once the session has started', async () => {
    // Session 1 minute away: booking 11:01 local today (NOW is 10:00Z = 11:00 Lagos).
    const db = due({ intake: { expires_at: new Date(NOW + 60_000).toISOString() }, booking: { date: '2026-11-10', time: '11:01:00' } });
    expect(await sendIntakeReminder(db as never, 'i1', { resolver: sender().resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'session_started' });
  });

  it('does not remind outside the 24-hour window, after STOP, or after the plan lapsed', async () => {
    env.window = 'closed';
    expect((await sendIntakeReminder(due() as never, 'i1', { resolver: sender().resolver, now: NOW }))).toEqual({ status: 'skipped', reason: 'window_closed' });
    env.window = 'open';
    const stopped = due({ optOuts: [{ phone: '2348012345678', channel: 'whatsapp', resubscribed_at: null }] });
    expect(await sendIntakeReminder(stopped as never, 'i1', { resolver: sender().resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'opted_out' });
    env.tier = 'free';
    expect(await sendIntakeReminder(due() as never, 'i1', { resolver: sender().resolver, now: NOW })).toEqual({ status: 'skipped', reason: 'not_entitled' });
  });
});
