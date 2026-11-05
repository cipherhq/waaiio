/**
 * The bot never offers or accepts a date or time that is already taken (#919).
 *
 * Behavioural tests on the real scheduling steps (shared by scheduling,
 * appointment and table reservation), a frozen clock, and the real
 * FlowExecutor for the "taken at the last moment" path:
 *   R  the shared rule (lib/bot/flows/shared/slot-availability.ts)
 *   D  date list, tapped / typed / pre-filled date: a fully booked day is not offered
 *   T  time list, typed / pre-filled time: a booked time is not offered or accepted
 *   C  the time is taken between the list and the final claim: the time list
 *      again, then the summary, then the booking — not "Send Hi"
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowContext, PromptList, PromptMessage } from '@/lib/bot/flows/types';
import { openTimesOnDate, type SlotBookingRow } from '@/lib/bot/flows/shared/slot-availability';
import { getStep } from '@/lib/bot/flows/__tests__/helpers';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

// ── Mock database: chainable, thenable; bookings filtered like PostgREST ──
type Booking = SlotBookingRow & { date: string; seating_resource_id?: string | null; staff_id?: string | null };
interface DbOpts {
  bookings?: Booking[];
  rpc?: (name: string, params: Record<string, unknown>) => unknown;
  /** The booking row create_booking reads back after a claim (#806 committed amounts). */
  committed?: () => Record<string, unknown> | null;
}

function mockDb(opts: DbOpts = {}) {
  const casCalls: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    const ops: Array<[string, ...unknown[]]> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range']) {
      chain[m] = vi.fn((...args: unknown[]) => { ops.push([m, ...args]); return chain; });
    }
    const rows = (): Booking[] => {
      if (table !== 'bookings') return [];
      return (opts.bookings || []).filter(b => ops.every(([op, col, val]) => {
        if (op === 'eq' && col === 'date') return b.date === val;
        if (op === 'gte' && col === 'date') return b.date >= (val as string);
        if (op === 'lte' && col === 'date') return b.date <= (val as string);
        if (op === 'eq' && col === 'seating_resource_id') return b.seating_resource_id === val;
        if (op === 'is' && col === 'seating_resource_id') return !b.seating_resource_id;
        if (op === 'eq' && col === 'staff_id') return b.staff_id === val;
        return true;
      }));
    };
    chain.single = vi.fn(async () => ({ data: table === 'bookings' ? (opts.committed?.() ?? null) : null, error: null }));
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const data = rows();
      return Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject);
    };
    return chain;
  });
  const rpc = vi.fn((name: string, params: Record<string, unknown>) => {
    if (name === 'update_session_cas') {
      casCalls.push(JSON.parse(JSON.stringify(params)));
      return Promise.resolve({ data: { success: true, version: 2 }, error: null });
    }
    const out = opts.rpc?.(name, params);
    if (out !== undefined) return out;
    return Promise.resolve({ data: null, error: null });
  });
  return { client: { from, rpc }, casCalls };
}

/** What a `.rpc(...).single()` booking call resolves to. */
const claim = (data: Record<string, unknown>) => ({ single: async () => ({ data, error: null }) });

const SVC = { duration_minutes: 60, buffer_minutes: 0 };
const booking = (date: string, time: string, extra: Partial<Booking> = {}): Booking =>
  ({ date, time: `${time}:00`, metadata: null, services: SVC, seating_resource_id: null, staff_id: null, ...extra });

function ctxFor(opts: {
  table?: boolean;
  db: ReturnType<typeof mockDb>;
  sessionData?: Record<string, unknown>;
  operatingHours?: Record<string, { open?: string; close?: string; closed?: boolean }>;
}): FlowContext {
  const base: Record<string, unknown> = opts.table
    ? {
        active_capability: 'table_reservation',
        _is_table_reservation: true, seating_resource_id: 'res-vip', seating_resource_name: 'VIP Section',
        _seating_duration: 90, _service_max_capacity: 1, service_duration: 90, _service_available_days: [],
      }
    : {
        active_capability: 'scheduling',
        service_id: 'svc-cut', service_name: 'Haircut', service_price: 0, service_deposit: 0,
        service_duration: 60, _service_max_capacity: 1, _service_buffer_minutes: 0,
        _service_available_days: [], _service_requires_staff: false,
      };
  return {
    supabase: opts.db.client as never,
    sender: { sendText: vi.fn() } as never,
    standalone: {
      getBotTemplates: vi.fn(async () => ({})),
      checkTierLimits: vi.fn(async () => ({ allowed: true })),
      fillTemplate: vi.fn((t: string) => t),
    } as never,
    intelligence: { resetAbuse: vi.fn() } as never,
    t: async (s: string) => s,
    copyLang: 'en',
    from: '+2348000000000',
    session: {
      id: 'sess-919', user_id: 'user-1', business_id: 'biz-919', current_step: 'select_date', version: 1,
      session_data: { first_name: 'Ada', last_name: 'Obi', party_size: 1, ...base, ...(opts.sessionData || {}) },
    },
    business: {
      id: 'biz-919', name: 'Studio', slug: 'studio', category: (opts.table ? 'bar' : 'salon') as never,
      flow_type: 'scheduling' as never, subscription_tier: 'growth', trial_ends_at: '',
      country_code: 'NG', operating_hours: opts.operatingHours || {}, metadata: { require_terms_before_payment: false },
    },
  };
}

async function flow() {
  const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
  return {
    date: getStep(schedulingFlow, 'select_date'),
    time: getStep(schedulingFlow, 'select_time'),
    confirmation: getStep(schedulingFlow, 'confirmation'),
    create: getStep(schedulingFlow, 'create_booking'),
  };
}

const listOf = (msgs: PromptMessage[]) => msgs.find(m => m.type === 'list') as PromptList | undefined;
const rowIds = (msgs: PromptMessage[]) => listOf(msgs)?.items.map(i => i.postbackText) || [];

/** Thursday 5 Nov 2026, midday UTC. Appointments start tomorrow (Fri 6 Nov). */
const NOV5_NOON = new Date('2026-11-05T12:00:00Z');
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const FRIDAY_9_TO_5 = { friday: { open: '09:00', close: '17:00' } };
const EVERY_HOUR_FRI = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'].map(t => booking(FRI, t));

beforeAll(async () => { await import('@/lib/bot/flows/registry'); }, 60_000);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOV5_NOON); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════
// R. The shared rule
// ═══════════════════════════════════════════════════════
describe('R openTimesOnDate — the time list rule plus the booking function rule', () => {
  const hourly = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'];
  const svc = (o: Partial<Parameters<typeof openTimesOnDate>[2]> = {}) => ({
    date: SAT, isTable: false, maxCapacity: 1, fallbackDuration: 60, candidateDuration: 60, bufferMinutes: 0, ...o,
  });

  it('keeps the existing rule: a booking blocks the start times inside its length', () => {
    const open = openTimesOnDate(['09:00', '09:30', '10:00'], [booking(SAT, '09:00')], svc());
    expect(open.map(s => s.time)).toEqual(['10:00']);
  });

  it('with a buffer, also drops a time whose own length runs into a later booking (book_slot_atomic)', () => {
    const rows = [booking(SAT, '10:00', { services: { duration_minutes: 60, buffer_minutes: 15 } })];
    const open = openTimesOnDate(hourly, rows, svc({ bufferMinutes: 15 })).map(s => s.time);
    // 09:00–10:00 + 15 min buffer meets the 10:00 booking; the old list showed 09:00
    expect(open).toEqual(['08:00', '12:00', '13:00']);
  });

  it('without a buffer, nothing extra is hidden (book_slot_atomic accepts 09:00)', () => {
    const open = openTimesOnDate(hourly, [booking(SAT, '10:00')], svc()).map(s => s.time);
    expect(open).toEqual(['08:00', '09:00', '11:00', '12:00', '13:00']);
  });

  it('with a buffer, any overlapping booking blocks even when capacity is left (book_slot_atomic)', () => {
    // 10:00 booking, 60 min + 10 min buffer either side: 09:00 to 11:10 is blocked
    const open = openTimesOnDate(['09:00', '09:30', '11:00', '11:30'], [booking(SAT, '10:00')], svc({ maxCapacity: 3, bufferMinutes: 10 }));
    expect(open.map(s => s.time)).toEqual(['11:30']);
    expect(open[0].remaining).toBe(3);
  });

  it('exact-time capacity: two spots, one booked, one left', () => {
    const open = openTimesOnDate(['10:00'], [booking(SAT, '10:00')], svc({ maxCapacity: 2 }));
    expect(open).toEqual([{ time: '10:00', remaining: 1 }]);
  });

  it('tables: any overlap on the table blocks, both ways (book_table_atomic)', () => {
    const rows = [booking(SAT, '19:00', { services: null, metadata: { duration_minutes: 90 } })];
    const open = openTimesOnDate(['17:00', '18:30', '20:00', '20:30'], rows, { ...svc({ isTable: true, candidateDuration: 90 }) });
    // 18:30–20:00 runs into 19:00 (the old list showed it); 20:00 starts inside it
    expect(open.map(s => s.time)).toEqual(['17:00', '20:30']);
  });

  it('tables: a booking from the night before that runs past midnight blocks the early times (M510)', () => {
    const rows = [booking(FRI, '23:30', { services: null, metadata: { duration_minutes: 120 } })];
    const open = openTimesOnDate(['00:00', '01:00', '01:30', '02:00'], rows, { ...svc({ isTable: true, candidateDuration: 30 }) });
    expect(open.map(s => s.time)).toEqual(['01:30', '02:00']);
  });

  it('never shows a time the old list rule hid (random bookings)', () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const slots = Array.from({ length: 24 }, (_, i) => `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
    for (let run = 0; run < 200; run++) {
      const rows = Array.from({ length: rand(6) }, () => booking(SAT, slots[rand(slots.length)], {
        services: { duration_minutes: [30, 45, 60, 90][rand(4)], buffer_minutes: [0, 10, 15][rand(3)] },
      }));
      const o = svc({ maxCapacity: 1 + rand(3), candidateDuration: [30, 60][rand(2)], bufferMinutes: [0, 15][rand(2)] });
      const legacyOpen = openTimesOnDate(slots, rows, { ...o, bufferMinutes: 0, maxCapacity: o.maxCapacity })
        .filter(s => s.remaining > 0).map(s => s.time);
      for (const s of openTimesOnDate(slots, rows, o)) expect(legacyOpen).toContain(s.time);
    }
  });
});

// ═══════════════════════════════════════════════════════
// D. Dates
// ═══════════════════════════════════════════════════════
describe('D select_date — a fully booked day is not offered or accepted', () => {
  // 60-min service, Fridays 09:00–17:00: eight hourly times, all booked
  const LIST = { _show_full_date_list: true }; // the full list, not the Today/Tomorrow buttons
  const fullFriday = () => ctxFor({ db: mockDb({ bookings: EVERY_HOUR_FRI }), operatingHours: FRIDAY_9_TO_5, sessionData: LIST });

  it('the date list leaves out a day whose every time is booked (the old count showed it)', async () => {
    const { date } = await flow();
    const ids = rowIds(await date.prompt(fullFriday()));
    expect(ids).not.toContain(FRI);
    expect(ids).toContain(SAT);
  });

  it('one free hour left: the day stays in the list', async () => {
    const { date } = await flow();
    const ctx = ctxFor({ db: mockDb({ bookings: EVERY_HOUR_FRI.slice(1) }), operatingHours: FRIDAY_9_TO_5, sessionData: LIST });
    expect(rowIds(await date.prompt(ctx))).toContain(FRI);
  });

  it('a tapped full day is refused with a message, and the list is shown again', async () => {
    const { date } = await flow();
    const ctx = fullFriday();
    const result = await date.validate(FRI, ctx);
    expect(result).toMatchObject({ valid: false, errorMessage: 'That day is fully booked. Please pick another date.' });
    expect(ctx.session.session_data._show_full_date_list).toBe(true);
  });

  it('a typed full day ("6 Nov") is refused the same way', async () => {
    const { date } = await flow();
    const result = await date.validate('6 Nov', fullFriday());
    expect(result).toMatchObject({ valid: false, errorMessage: 'That day is fully booked. Please pick another date.' });
  });

  it('a pre-filled full day ("book me Friday") shows the date list instead', async () => {
    const { date } = await flow();
    const ctx = fullFriday();
    ctx.session.session_data.date = FRI;
    expect(await date.skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data.date).toBeUndefined();

    const open = fullFriday();
    open.session.session_data.date = SAT;
    expect(await date.skipIf!(open)).toBe(true);
    expect(open.session.session_data.date).toBe(SAT);
  });

  it('staff still to be chosen after the date: the per-day count is kept (capacity is per staff member)', async () => {
    const { date } = await flow();
    const ctx = ctxFor({
      db: mockDb({ bookings: EVERY_HOUR_FRI }), operatingHours: FRIDAY_9_TO_5,
      sessionData: { ...LIST, _service_requires_staff: true },
    });
    expect(rowIds(await date.prompt(ctx))).toContain(FRI);
  });

  it('a staff member kept from before ("Change date") does not hide a day another member has free', async () => {
    // select_staff runs again after every date, so a staff_id in the session is not final
    const { date } = await flow();
    const staffBookings = EVERY_HOUR_FRI.map(b => ({ ...b, staff_id: 'staff-a' }));
    const keptA = ctxFor({ db: mockDb({ bookings: staffBookings }), operatingHours: FRIDAY_9_TO_5, sessionData: { ...LIST, staff_id: 'staff-a', _service_requires_staff: true } });
    expect(rowIds(await date.prompt(keptA))).toContain(FRI);
    expect(await date.validate(FRI, keptA)).toMatchObject({ valid: true });
  });

  it('tables: a table booked all evening is not offered that day; another table is', async () => {
    const { date } = await flow();
    // Saturday 08:00–22:00, 90-min reservations: 08:00 … 20:00; book every one on res-vip
    const times = ['08:00', '09:30', '11:00', '12:30', '14:00', '15:30', '17:00', '18:30', '20:00'];
    const rows = times.map(t => booking(SAT, t, { services: null, metadata: { duration_minutes: 90 }, seating_resource_id: 'res-vip' }));
    const vip = ctxFor({ table: true, db: mockDb({ bookings: rows }), sessionData: LIST });
    expect(rowIds(await date.prompt(vip))).not.toContain(SAT);
    const other = ctxFor({ table: true, db: mockDb({ bookings: rows }), sessionData: { ...LIST, seating_resource_id: 'res-patio' } });
    expect(rowIds(await date.prompt(other))).toContain(SAT);
  });
});

// ═══════════════════════════════════════════════════════
// T. Times
// ═══════════════════════════════════════════════════════
describe('T select_time — a booked time is not offered or accepted', () => {
  it('the list leaves out a time the booking function would refuse (service buffer)', async () => {
    const { time } = await flow();
    const rows = [booking(SAT, '10:00', { services: { duration_minutes: 60, buffer_minutes: 15 } })];
    const ctx = ctxFor({ db: mockDb({ bookings: rows }), sessionData: { date: SAT, _service_buffer_minutes: 15 } });
    const ids = rowIds(await time.prompt(ctx));
    expect(ids).not.toContain('09:00');
    expect(ids).not.toContain('10:00');
    expect(ids).toContain('08:00');
    expect(ids).toContain('12:00');
  });

  it('tables: the list leaves out a time that would run into a later reservation', async () => {
    const { time } = await flow();
    const rows = [booking(SAT, '19:00', { services: null, metadata: { duration_minutes: 90 }, seating_resource_id: 'res-vip' })];
    const ctx = ctxFor({ table: true, db: mockDb({ bookings: rows }), sessionData: { date: SAT } });
    const ids = rowIds(await time.prompt(ctx));
    expect(ids).not.toContain('18:30'); // 18:30–20:00 overlaps 19:00 (shown before #919)
    expect(ids).not.toContain('20:00');
    expect(ids).toContain('17:00');
  });

  it('a typed time inside a booking, or outside the hours, is refused (both were accepted before)', async () => {
    const { time } = await flow();
    const ctx = () => ctxFor({ db: mockDb({ bookings: [booking(SAT, '10:00')] }), sessionData: { date: SAT } });
    const taken = 'Sorry, this time slot just got booked. Please choose another time.';
    // 10:30 is inside the 60-min 10:00 booking (book_slot_atomic, no buffer, would accept it)
    expect(await time.validate('10:30', ctx())).toMatchObject({ valid: false, errorMessage: taken });
    expect(await time.validate('10:00', ctx())).toMatchObject({ valid: false, errorMessage: taken });
    expect(await time.validate('3am', ctx())).toMatchObject({ valid: false, errorMessage: "That time isn't available. Please pick a time from the list." });
    expect(await time.validate('12:00', ctx())).toMatchObject({ valid: true, data: { time: '12:00' } });
    expect(await time.validate('2pm', ctx())).toMatchObject({ valid: true, data: { time: '14:00' } });
  });

  it('a free time between list times is still accepted, typed or pre-filled', async () => {
    const { time } = await flow();
    // 45-min service: the list runs 08:00, 08:45, 09:30, 10:15 … — "10am" is not on it
    const ctx = (extra: Record<string, unknown> = {}) => ctxFor({ db: mockDb({ bookings: [booking(SAT, '12:00')] }), sessionData: { date: SAT, service_duration: 45, ...extra } });
    expect(rowIds(await time.prompt(ctx()))).not.toContain('10:00');
    expect(await time.validate('10am', ctx())).toMatchObject({ valid: true, data: { time: '10:00' } });
    expect(await time.validate('12:30', ctx())).toMatchObject({ valid: false }); // inside the 12:00 booking
    const prefilled = ctx({ time: '10:00' });
    expect(await time.skipIf!(prefilled)).toBe(true);
    expect(prefilled.session.session_data.time).toBe('10:00');
  });

  it('a time from the afternoon list is accepted (its own 12:00 start)', async () => {
    const { time } = await flow();
    const ctx = ctxFor({
      db: mockDb(), operatingHours: { saturday: { open: '08:30', close: '20:00' } },
      sessionData: { date: SAT, _time_preference: 'afternoon' },
    });
    expect(rowIds(await time.prompt(ctx))).toContain('12:00');
    expect(await time.validate('12:00', ctx)).toMatchObject({ valid: true });
  });

  it('tables: a typed time that runs into a reservation is refused with the table message', async () => {
    const { time } = await flow();
    const rows = [booking(SAT, '19:00', { services: null, metadata: { duration_minutes: 90 }, seating_resource_id: 'res-vip' })];
    const ctx = ctxFor({ table: true, db: mockDb({ bookings: rows }), sessionData: { date: SAT } });
    expect(await time.validate('18:30', ctx)).toMatchObject({ valid: false, errorMessage: 'That time is already reserved for this table. Try a different time.' });
    expect(await time.validate('17:00', ctx)).toMatchObject({ valid: true });
  });

  it('a pre-filled time that is booked shows the time list; a free one is kept', async () => {
    const { time } = await flow();
    const taken = ctxFor({ db: mockDb({ bookings: [booking(SAT, '10:00')] }), sessionData: { date: SAT, time: '10:00' } });
    expect(await time.skipIf!(taken)).toBe(false);
    expect(taken.session.session_data.time).toBeUndefined();
    const free = ctxFor({ db: mockDb({ bookings: [booking(SAT, '10:00')] }), sessionData: { date: SAT, time: '12:00' } });
    expect(await time.skipIf!(free)).toBe(true);
    expect(free.session.session_data.time).toBe('12:00');
  });
});

describe('T tables whose business hours close at or after midnight (M510)', () => {
  const lateSat = { saturday: { open: '18:00', close: '00:00' } };
  const lateCtx = (sessionData: Record<string, unknown> = {}, hours: Record<string, { open?: string; close?: string }> = lateSat) =>
    ctxFor({ table: true, db: mockDb(), operatingHours: hours, sessionData: { date: SAT, ...sessionData } });

  it('closing at 00:00: the evening times are offered and accepted, the day is in the date list', async () => {
    const { date, time } = await flow();
    // 90-min tables from 18:00: 18:00, 19:30, 21:00, 22:30 (ends at 00:00)
    expect(rowIds(await time.prompt(lateCtx()))).toEqual(['18:00', '19:30', '21:00', '22:30', 'change_date']);
    expect(await time.validate('20:00', lateCtx())).toMatchObject({ valid: true, data: { time: '20:00' } });
    expect(await time.validate('23:00', lateCtx())).toMatchObject({ valid: false }); // ends 00:30, after closing
    const prefilled = lateCtx({ time: '20:00' });
    expect(await time.skipIf!(prefilled)).toBe(true);
    const list = lateCtx({ _show_full_date_list: true });
    delete list.session.session_data.date;
    expect(rowIds(await date.prompt(list))).toContain(SAT);
  });

  it('closing at 02:00: a 23:30 table (ends 01:00) is offered', async () => {
    const { time } = await flow();
    const ids = rowIds(await time.prompt(lateCtx({}, { saturday: { open: '20:00', close: '02:00' } })));
    expect(ids).toEqual(['20:00', '21:30', '23:00', '00:30', 'change_date']);
  });
});

describe('T businesses open 24 hours (open and close both 00:00, M510)', () => {
  const allDaySat = { saturday: { open: '00:00', close: '00:00' } };

  it('services: the day is listed, has times, and a typed or pre-filled time is accepted', async () => {
    const { date, time } = await flow();
    const ctx = (extra: Record<string, unknown> = {}) => ctxFor({ db: mockDb(), operatingHours: allDaySat, sessionData: { date: SAT, ...extra } });
    const ids = rowIds(await time.prompt(ctx()));
    // Hourly from 00:00; the list shows the first 10 (WhatsApp limit), later ones can be typed
    expect(ids.slice(0, 10)).toEqual(['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00']);
    expect(await time.validate('23:00', ctx())).toMatchObject({ valid: true, data: { time: '23:00' } });
    expect(await time.validate('10am', ctx())).toMatchObject({ valid: true, data: { time: '10:00' } });
    expect(await time.validate('10:30', ctx())).toMatchObject({ valid: true, data: { time: '10:30' } });
    const prefilled = ctx({ time: '10:00' });
    expect(await time.skipIf!(prefilled)).toBe(true);
    const list = ctx({ _show_full_date_list: true });
    delete list.session.session_data.date;
    expect(rowIds(await date.prompt(list))).toContain(SAT);
    const pre = ctx();
    expect(await date.skipIf!(pre)).toBe(true);
  });

  it('tables: the day is listed and a late table is accepted', async () => {
    const { date, time } = await flow();
    const ctx = (extra: Record<string, unknown> = {}) => ctxFor({ table: true, db: mockDb(), operatingHours: allDaySat, sessionData: { date: SAT, ...extra } });
    expect(rowIds(await time.prompt(ctx()))).toContain('00:00');
    expect(await time.validate('22:30', ctx())).toMatchObject({ valid: true });
    const list = ctx({ _show_full_date_list: true });
    delete list.session.session_data.date;
    expect(rowIds(await date.prompt(list))).toContain(SAT);
  });
});

// ═══════════════════════════════════════════════════════
// C. Taken between the list and the final claim
// ═══════════════════════════════════════════════════════
describe('C create_booking — the time was taken at the last moment', () => {
  beforeEach(async () => {
    vi.spyOn(await import('@/lib/capabilities/service'), 'getEnabledCapabilities').mockResolvedValue([]);
    vi.spyOn(await import('@/lib/tier-limits'), 'checkTierLimit').mockResolvedValue({ allowed: true } as never);
    vi.spyOn(await import('@/lib/bot/flows/shared/capability-guard'), 'requireCurrentCapability').mockResolvedValue({ allowed: true } as never);
    vi.spyOn(await import('@/lib/integrations/google-calendar'), 'syncBookingToCalendar').mockResolvedValue(undefined as never);
    vi.spyOn(await import('@/lib/bot/automation/rules-engine'), 'evaluateRules').mockResolvedValue(undefined as never);
    vi.spyOn(await import('@/lib/bot/automation/sequence-service'), 'triggerSequences').mockResolvedValue(undefined as never);
    vi.spyOn(await import('@/lib/bot/flows/shared/notifications'), 'createNotification').mockResolvedValue(undefined as never);
    vi.spyOn(await import('@/lib/bot/flows/shared/notify-owner'), 'notifyOwnerNewBooking').mockResolvedValue(undefined as never);
    vi.spyOn(await import('@/lib/bot/flows/shared/post-completion'), 'handlePostCompletion').mockResolvedValue(undefined as never);
    const { savedPaymentAdapter } = await import('@/lib/payments/saved-payment-adapter');
    vi.spyOn(savedPaymentAdapter, 'getSavedMethods').mockResolvedValue([]);
  });

  const TAKEN = 'Sorry, this time slot just got booked. Please choose another time.';

  /** Saturday 10:00 picked; someone else booked 10:00 first (it is now in the bookings table). */
  function raced(rpc: DbOpts['rpc'], extra: Record<string, unknown> = {}, committed?: DbOpts['committed']) {
    const db = mockDb({ bookings: [booking(SAT, '10:00')], rpc, committed });
    return { db, ctx: ctxFor({ db, sessionData: { date: SAT, time: '10:00', _action: 'confirm', ...extra } }) };
  }

  it('says so, sends the open times on that day again, and waits for a new time', async () => {
    const { create } = await flow();
    const { ctx } = raced(name => name === 'book_slot_authoritative_604' ? claim({ booking_id: null, reference_code: null, slot_available: false }) : undefined);
    const messages = await create.prompt(ctx);

    expect(messages[0]).toEqual({ type: 'text', text: TAKEN });
    const ids = rowIds(messages);
    expect(ids).not.toContain('10:00');
    expect(ids).toEqual(expect.arrayContaining(['12:00', 'change_date']));
    expect(JSON.stringify(messages)).not.toMatch(/Send \*Hi\*/);
    expect(ctx.session.session_data).toMatchObject({ _slot_taken_return: true, _slot_taken_count: 1, time: '10:00' });
    expect(typeof create.nextAfterPrompt === 'function' && create.nextAfterPrompt(ctx)).toBe('select_time');
  });

  it('a new time goes back to the summary, then straight to booking that new time', async () => {
    const { create, time, confirmation } = await flow();
    let refuse = true;
    const { ctx, db } = raced(name => name === 'book_slot_authoritative_604'
      ? claim(refuse
        ? { booking_id: null, reference_code: null, slot_available: false }
        : { booking_id: 'bk-new', reference_code: 'REF12', slot_available: true })
      : undefined, {}, () => ({
      id: 'bk-new', service_id: 'svc-cut', appointment_id: null, party_size: 1, date: SAT, time: '12:00:00',
      class_session_id: null, staff_id: null, total_amount: 0, deposit_amount: 0,
    }));
    await create.prompt(ctx);

    const picked = await time.validate('12:00', ctx);
    expect(picked).toMatchObject({ valid: true, data: { time: '12:00' } });
    Object.assign(ctx.session.session_data, picked.data);
    expect(await time.next(ctx)).toBe('confirmation');

    const summary = await confirmation.prompt(ctx);
    expect(JSON.stringify(summary)).toContain('12:00 PM');
    const confirmed = await confirmation.validate('confirm', ctx);
    Object.assign(ctx.session.session_data, confirmed.data);
    expect(await confirmation.next(ctx)).toBe('create_booking');
    expect(ctx.session.session_data._slot_taken_return).toBeUndefined();

    refuse = false;
    await create.prompt(ctx);
    const claims = db.client.rpc.mock.calls.filter(([name]) => name === 'book_slot_authoritative_604');
    expect(claims.map(([, p]) => p.p_time)).toEqual(['10:00', '12:00']);
    expect(claims[1][1]).toMatchObject({ p_date: SAT, p_time: '12:00' });
    expect(ctx.session.session_data).toMatchObject({ booking_id: 'bk-new', reference_code: 'REF12' });
    expect(ctx.session.session_data).not.toHaveProperty('_slot_taken_count');
    expect(typeof create.nextAfterPrompt === 'function' && create.nextAfterPrompt(ctx)).not.toBe('select_time');
  });

  it('"Change date" from the re-sent list clears the taken time', async () => {
    const { create, time } = await flow();
    const { ctx } = raced(name => name === 'book_slot_authoritative_604' ? claim({ slot_available: false }) : undefined);
    await create.prompt(ctx);
    const result = await time.validate('change_date', ctx);
    Object.assign(ctx.session.session_data, result.data);
    expect(await time.next(ctx)).toBe('select_date');
    expect(ctx.session.session_data).not.toHaveProperty('time');
    expect(ctx.session.session_data).not.toHaveProperty('date');
    expect(ctx.session.session_data._slot_taken_return).toBe(true);
  });

  it('reaching the booking step again without confirming a new time never claims', async () => {
    const { create } = await flow();
    const { ctx, db } = raced(name => name === 'book_slot_authoritative_604' ? claim({ slot_available: false }) : undefined);
    await create.prompt(ctx); // refused: flag set
    const again = await create.prompt(ctx); // e.g. "back" from the summary
    expect(db.client.rpc.mock.calls.filter(([name]) => name === 'book_slot_authoritative_604')).toHaveLength(1);
    expect(rowIds(again)).toContain('12:00');
    expect(typeof create.nextAfterPrompt === 'function' && create.nextAfterPrompt(ctx)).toBe('select_time');
    // A reply that lands on create_booking goes to the time list, not the end of the flow
    expect(await create.next(ctx)).toBe('select_time');
    // After "Change date" (no date): the date list, never a claim with no date
    delete ctx.session.session_data.date;
    delete ctx.session.session_data.time;
    ctx.session.session_data._show_full_date_list = true;
    const dates = await create.prompt(ctx);
    expect(rowIds(dates)).toContain(SAT);
    expect(db.client.rpc.mock.calls.filter(([name]) => name === 'book_slot_authoritative_604')).toHaveLength(1);
    expect(typeof create.nextAfterPrompt === 'function' && create.nextAfterPrompt(ctx)).toBe('select_date');
    expect(await create.next(ctx)).toBe('select_date');
  });

  it('after three refusals in one session: the old message, no loop', async () => {
    const { create } = await flow();
    const { ctx } = raced(name => name === 'book_slot_authoritative_604' ? claim({ slot_available: false }) : undefined, { _slot_taken_count: 2 });
    const messages = await create.prompt(ctx);
    expect(messages).toEqual([{ type: 'text', text: 'Sorry, that slot was just taken by another customer. Send *Hi* to pick a different time.' }]);
    expect(ctx.session.session_data._slot_taken_return).toBeUndefined();
    expect(typeof create.nextAfterPrompt === 'function' && create.nextAfterPrompt(ctx)).not.toBe('select_time');
  });

  it('tables: book_table_atomic refuses → the table\'s open times again', async () => {
    const { create } = await flow();
    const rows = [booking(SAT, '19:00', { services: null, metadata: { duration_minutes: 90 }, seating_resource_id: 'res-vip' })];
    const db = mockDb({ bookings: rows, rpc: name => name === 'book_table_atomic' ? claim({ slot_available: false }) : undefined });
    const ctx = ctxFor({ table: true, db, sessionData: { date: SAT, time: '19:00', party_size: 2, _seating_deposit: 0 } });
    const messages = await create.prompt(ctx);
    expect(messages[0]).toEqual({ type: 'text', text: TAKEN });
    const ids = rowIds(messages);
    expect(ids).toContain('17:00');
    expect(ids).not.toContain('18:30');
    expect(messages.filter(m => m.type === 'image')).toEqual([]); // table photos are not sent again
    expect(typeof create.nextAfterPrompt === 'function' && create.nextAfterPrompt(ctx)).toBe('select_time');
  });

  it('classes are unchanged: a full class keeps its own message', async () => {
    const { create } = await flow();
    const { ctx } = raced(name => name === 'book_slot_authoritative_604' ? claim({ slot_available: false }) : undefined, {
      _service_is_class: true, _class_session_id: 'cs-1',
    });
    const messages = await create.prompt(ctx);
    expect(JSON.stringify(messages)).not.toContain(TAKEN);
    expect(ctx.session.session_data._slot_taken_return).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// C. Through the real FlowExecutor
// ═══════════════════════════════════════════════════════
describe('C through the real FlowExecutor', () => {
  beforeEach(async () => {
    vi.spyOn(await import('@/lib/capabilities/service'), 'getEnabledCapabilities').mockResolvedValue(['scheduling'] as never);
    vi.spyOn(await import('@/lib/tier-limits'), 'checkTierLimit').mockResolvedValue({ allowed: true } as never);
    vi.spyOn(await import('@/lib/bot/flows/shared/capability-guard'), 'requireCurrentCapability').mockResolvedValue({ allowed: true } as never);
  });

  function sender(sent: Array<{ kind: string; payload: Record<string, unknown> }>) {
    const record = (kind: string) => vi.fn(async (payload: Record<string, unknown>) => { sent.push({ kind, payload }); return {}; });
    return { sendText: record('text'), sendButtons: record('buttons'), sendList: record('list'), sendDocument: vi.fn(), sendImage: vi.fn(), markAsRead: vi.fn() };
  }
  const business = {
    id: 'biz-919', name: 'Studio', slug: 'studio', category: 'salon', flow_type: 'scheduling',
    subscription_tier: 'growth', trial_ends_at: null, metadata: { require_terms_before_payment: false }, country_code: 'NG', operating_hours: {},
  };

  it('confirm → refused claim → the taken message and time list, current step select_time', async () => {
    const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const db = mockDb({ bookings: [booking(SAT, '10:00')], rpc: name => name === 'book_slot_authoritative_604' ? claim({ slot_available: false }) : undefined });
    const { FlowExecutor } = await import('@/lib/bot/flows/executor');
    const executor = new FlowExecutor(db.client as never, sender(sent) as never, {} as never, { resetAbuse: vi.fn() } as never);
    const session = {
      id: 'sess-exec', user_id: 'user-1', business_id: 'biz-919', current_step: 'confirmation', version: 1,
      conversation_log: [],
      session_data: {
        ...ctxFor({ db }).session.session_data, capabilities: ['scheduling'],
        date: SAT, time: '10:00', email: 'ada@example.com', _slot_taken_return: true,
        _step_history: ['select_time', 'confirmation'],
      },
    };
    await executor.execute('+2348000000000', 'confirm', session as never, business as never);

    const texts = sent.filter(m => m.kind === 'text').map(m => String(m.payload.text));
    expect(texts).toContain(TAKEN_TEXT);
    const lists = sent.filter(m => m.kind === 'list');
    expect(lists).toHaveLength(1);
    const ids = (lists[0].payload.items as Array<{ postbackText: string }>).map(i => i.postbackText);
    expect(ids).not.toContain('10:00');
    expect(ids).toContain('12:00');
    expect(JSON.stringify(sent)).not.toMatch(/Send \*Hi\*/);
    expect(db.casCalls.at(-1)).toMatchObject({ p_current_step: 'select_time' });
  });

  it('"back" on the re-shown summary does not book the new time without a confirm', async () => {
    const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const db = mockDb({ bookings: [booking(SAT, '10:00')], rpc: name => name === 'book_slot_authoritative_604' ? claim({ booking_id: 'bk-x', reference_code: 'X', slot_available: true }) : undefined });
    const { FlowExecutor } = await import('@/lib/bot/flows/executor');
    const executor = new FlowExecutor(db.client as never, sender(sent) as never, {} as never, { resetAbuse: vi.fn() } as never);
    // After a refusal the customer picked 12:00 and sees the summary again
    const session = {
      id: 'sess-back', user_id: 'user-1', business_id: 'biz-919', current_step: 'confirmation', version: 1,
      conversation_log: [],
      session_data: {
        ...ctxFor({ db }).session.session_data, capabilities: ['scheduling'],
        date: SAT, time: '12:00', email: 'ada@example.com', _slot_taken_return: true, _slot_taken_count: 1,
        _step_history: ['select_time', 'confirmation', 'create_booking', 'confirmation'],
      },
    };
    await executor.execute('+2348000000000', 'back', session as never, business as never);

    expect(db.client.rpc.mock.calls.filter(([name]) => name === 'book_slot_authoritative_604')).toEqual([]);
    expect(session.session_data).not.toHaveProperty('booking_id');
    const lists = sent.filter(m => m.kind === 'list');
    expect(lists).toHaveLength(1);
    expect((lists[0].payload.items as Array<{ postbackText: string }>).map(i => i.postbackText)).toContain('12:00');

    // The next tap on that list is the new pick: 13:00 is kept and the summary shows it
    sent.length = 0;
    await executor.execute('+2348000000000', '13:00', session as never, business as never);
    expect(session.session_data).toMatchObject({ time: '13:00' });
    expect(db.client.rpc.mock.calls.filter(([name]) => name === 'book_slot_authoritative_604')).toEqual([]);
    expect(JSON.stringify(sent)).toContain('1:00 PM');
    expect(db.casCalls.at(-1)).toMatchObject({ p_current_step: 'confirmation' });
  });

  it('"Change date", then "back", then a date tap: the date is taken and the times for it follow', async () => {
    const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const db = mockDb({ bookings: [booking(SAT, '10:00')] });
    const { FlowExecutor } = await import('@/lib/bot/flows/executor');
    const executor = new FlowExecutor(db.client as never, sender(sent) as never, {} as never, { resetAbuse: vi.fn() } as never);
    // After a refusal and "Change date", "back" left the session on create_booking with no date
    const session = {
      id: 'sess-cd', user_id: 'user-1', business_id: 'biz-919', current_step: 'create_booking', version: 1,
      conversation_log: [],
      session_data: {
        ...ctxFor({ db }).session.session_data, capabilities: ['scheduling'],
        email: 'ada@example.com', _slot_taken_return: true, _slot_taken_count: 1, _action: 'confirm',
        _step_history: ['confirmation', 'create_booking'],
      },
    };
    await executor.execute('+2348000000000', '2026-11-09', session as never, business as never);
    expect(session.session_data).toMatchObject({ date: '2026-11-09', _slot_taken_return: true });
    expect(session.session_data).not.toHaveProperty('_slot_taken_picker');
    expect(db.client.rpc.mock.calls.filter(([name]) => name === 'book_slot_authoritative_604')).toEqual([]);
    const lists = sent.filter(m => m.kind === 'list');
    expect(lists.length).toBeGreaterThan(0);
    expect(JSON.stringify(lists.at(-1)!.payload)).toMatch(/Pick a time on/);
  });
});

const TAKEN_TEXT = 'Sorry, this time slot just got booked. Please choose another time.';
