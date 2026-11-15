/**
 * Bot date picker beyond the first 10 dates (#916, Owner option "both").
 *
 * Behavioural tests on the real scheduling select_date step (shared by
 * scheduling, appointment and table reservation) with a frozen clock, plus
 * the real FlowExecutor for the tap → re-prompt → persist path:
 *   A1 "Later dates" / "Earlier dates" paging across WhatsApp's 10-row limit
 *   A2 typed dates in every requested format
 *   A3 year rollover in December
 *   A4 closed day / service day   A5 beyond max_advance_days   A6 fully booked
 *   A7 table same-day             A8 US month/day vs day/month
 *   A9 the "type a date" hint, and every error re-shows the date list
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowContext, PromptButtons, PromptList, PromptMessage } from '@/lib/bot/flows/types';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

// ── Mock database: chainable, thenable, records every query ──
type Row = { date: string; time: string; metadata?: Record<string, unknown> | null };
interface DbOpts { timezone?: string | null; country?: string | null; bookings?: Row[] }

function mockDb(opts: DbOpts = {}) {
  const calls: Array<{ table: string; ops: Array<[string, ...unknown[]]> }> = [];
  const from = vi.fn((table: string) => {
    const ops: Array<[string, ...unknown[]]> = [];
    calls.push({ table, ops });
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'limit', 'order', 'update', 'range', 'lt', 'gt']) {
      chain[m] = vi.fn((...args: unknown[]) => { ops.push([m, ...args]); return chain; });
    }
    chain.maybeSingle = vi.fn(async () => {
      if (table !== 'businesses') return { data: null, error: null };
      return { data: opts.timezone === undefined ? null : { timezone: opts.timezone, country_code: opts.country ?? null }, error: null };
    });
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let rows: Row[] = table === 'bookings' ? (opts.bookings || []) : [];
      const dateEq = ops.find(o => o[0] === 'eq' && o[1] === 'date');
      if (dateEq) rows = rows.filter(r => r.date === dateEq[2]);
      return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
    };
    return chain;
  });
  return { calls, client: { from } };
}

function ctxFor(opts: {
  table?: boolean;
  db?: ReturnType<typeof mockDb>;
  sessionData?: Record<string, unknown>;
  country?: string;
  metadata?: Record<string, unknown>;
  operatingHours?: Record<string, { open?: string; close?: string; closed?: boolean }>;
}): FlowContext {
  const base: Record<string, unknown> = opts.table
    ? {
        _is_table_reservation: true,
        seating_resource_id: 'res-vip',
        seating_resource_name: 'VIP Section',
        _seating_duration: 90,
        _service_max_capacity: 1,
        service_duration: 90,
        _service_available_days: [],
      }
    : { _service_max_capacity: 1, service_duration: 60, _service_available_days: [], _is_appointment: true };
  return {
    supabase: (opts.db || mockDb()).client as never,
    sender: { sendText: vi.fn() } as never,
    standalone: {} as never,
    intelligence: { resetAbuse: vi.fn() } as never,
    t: async (s: string) => s,
    copyLang: 'en',
    from: '+2348000000000',
    session: {
      id: 's', user_id: 'u', business_id: 'b', current_step: 'select_date', version: 1,
      session_data: { ...base, ...(opts.sessionData || {}) },
    },
    business: {
      id: 'b', name: 'Studio', slug: 'studio', category: (opts.table ? 'bar' : 'salon') as never,
      flow_type: 'scheduling' as never, subscription_tier: 'free', trial_ends_at: '',
      country_code: opts.country || 'NG', operating_hours: opts.operatingHours || {}, metadata: opts.metadata || {},
    },
  };
}

async function dateStep() {
  const { getFlowStep } = await import('@/lib/bot/flows/registry');
  return getFlowStep('scheduling', 'select_date')!;
}

const listOf = (msgs: PromptMessage[]) => msgs.find(m => m.type === 'list') as PromptList | undefined;
const rowIds = (msgs: PromptMessage[]) => listOf(msgs)?.items.map(i => i.postbackText) || [];
const buttonsOf = (msgs: PromptMessage[]) => msgs.find(m => m.type === 'buttons') as PromptButtons | undefined;
const isDate = (id: string) => /^\d{4}-\d{2}-\d{2}$/.test(id);

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split('T')[0];
}
/** Thursday 5 Nov 2026, midday UTC (same calendar day in every server timezone from UTC-11 to UTC+11). */
const NOV5_NOON = new Date('2026-11-05T12:00:00Z');
const LAGOS_1830 = new Date('2026-11-04T17:30:00Z');
// Appointments start tomorrow: 30 open days = 6 Nov … 5 Dec
const WINDOW = Array.from({ length: 30 }, (_, i) => addDays('2026-11-06', i));

beforeAll(async () => { await import('@/lib/bot/flows/registry'); }, 60_000);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOV5_NOON); });
afterEach(() => { vi.useRealTimers(); });

// ═══════════════════════════════════════════════════════
// A1. Paging
// ═══════════════════════════════════════════════════════
describe('A1 select_date — "Later dates" paging across the 10-row limit', () => {
  it('page 1: 9 dates and "Later dates ▸" when more open dates exist', async () => {
    const step = await dateStep();
    const msgs = await step.prompt(ctxFor({ sessionData: { _show_full_date_list: true } }));
    const list = listOf(msgs)!;
    expect(list.items).toHaveLength(10);
    expect(list.items.slice(0, 9).map(i => i.postbackText)).toEqual(WINDOW.slice(0, 9));
    expect(list.items[9]).toEqual({ title: 'Later dates ▸', postbackText: 'dates_page_1' });
  });

  it('tapping "Later dates" keeps the page in session_data and shows the next dates with a way back', async () => {
    const step = await dateStep();
    const ctx = ctxFor({ sessionData: { _show_full_date_list: true } });
    await step.prompt(ctx);

    const tap = await step.validate('dates_page_1', ctx);
    expect(tap).toEqual({ valid: false, errorMessage: undefined, persistSessionDataOnFailure: true });
    expect(ctx.session.session_data._date_page).toBe(1);

    const msgs = await step.prompt(ctx);
    const items = listOf(msgs)!.items;
    expect(items).toHaveLength(10);
    expect(items[0]).toEqual({ title: '◂ Earlier dates', postbackText: 'dates_page_0' });
    expect(items.slice(1, 9).map(i => i.postbackText)).toEqual(WINDOW.slice(9, 17));
    expect(items[9]).toEqual({ title: 'Later dates ▸', postbackText: 'dates_page_2' });
    // The list stays a list on re-prompt; the shortcut flag was consumed
    expect(ctx.session.session_data._show_full_date_list).toBeUndefined();
  });

  it('every date in the window is reachable, no page exceeds 10 rows, and "Earlier dates" goes back', async () => {
    const step = await dateStep();
    const ctx = ctxFor({});
    const seen: string[] = [];
    for (let page = 0; page < 4; page++) {
      await step.validate(`dates_page_${page}`, ctx);
      const ids = rowIds(await step.prompt(ctx));
      expect(ids.length).toBeLessThanOrEqual(10);
      seen.push(...ids.filter(isDate));
      if (page === 3) {
        // Last page: "Earlier dates" plus the remaining 5 dates, no "Later dates"
        expect(ids).toEqual(['dates_page_2', ...WINDOW.slice(25)]);
      }
    }
    expect(seen).toEqual(WINDOW);

    await step.validate('dates_page_0', ctx);
    expect(rowIds(await step.prompt(ctx))).toEqual([...WINDOW.slice(0, 9), 'dates_page_1']);
  });

  it('a stale or replayed page number is clamped to the last page', async () => {
    const step = await dateStep();
    const ctx = ctxFor({});
    await step.validate('dates_page_99', ctx);
    expect(rowIds(await step.prompt(ctx))).toEqual(['dates_page_2', ...WINDOW.slice(25)]);
  });

  it('a date tapped on a later page is accepted and the page is cleared', async () => {
    const step = await dateStep();
    const ctx = ctxFor({});
    await step.validate('dates_page_3', ctx);
    await step.prompt(ctx);
    const result = await step.validate('2026-12-05', ctx);
    expect(result).toEqual({ valid: true, data: { date: '2026-12-05' } });
    expect(ctx.session.session_data._date_page).toBeUndefined();
  });

  it('10 or fewer open dates: one list, no paging rows (unchanged)', async () => {
    const step = await dateStep();
    const ten = await step.prompt(ctxFor({ metadata: { max_advance_days: 10 }, sessionData: { _show_full_date_list: true } }));
    expect(rowIds(ten)).toEqual(WINDOW.slice(0, 10));

    // 30-day window but open Mondays only → 4 dates
    const mondays = await step.prompt(ctxFor({ sessionData: { _show_full_date_list: true, _service_available_days: ['monday'] } }));
    expect(rowIds(mondays)).toEqual(['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  });

  it('the page only applies after a page tap; "Pick a Date" starts at page 1', async () => {
    const step = await dateStep();
    const ctx = ctxFor({ sessionData: { _date_page: 2 } });
    // No flag: the first prompt still shows the quick buttons
    expect(buttonsOf(await step.prompt(ctx))!.buttons.map(b => b.id)).toEqual(['date_2026-11-06', 'date_2026-11-07', 'pick_date']);
    await step.validate('pick_date', ctx);
    expect(ctx.session.session_data._date_page).toBeUndefined();
    expect(rowIds(await step.prompt(ctx))[0]).toBe('2026-11-06');
  });

  it('Today / Tomorrow / This Saturday / Pick a Date buttons and date_ postbacks are unchanged', async () => {
    const step = await dateStep();
    const ctx = ctxFor({});
    expect(buttonsOf(await step.prompt(ctx))!.buttons.map(b => b.id)).toEqual(['date_2026-11-06', 'date_2026-11-07', 'pick_date']);
    expect(await step.validate('date_2026-11-06', ctxFor({}))).toEqual({ valid: true, data: { date: '2026-11-06' } });
  });

  it('table reservations page the same way, from local today', async () => {
    vi.setSystemTime(LAGOS_1830);
    const step = await dateStep();
    const ctx = ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }), sessionData: { _show_full_date_list: true } });
    const first = rowIds(await step.prompt(ctx));
    expect(first[0]).toBe('2026-11-04');
    expect(first[9]).toBe('dates_page_1');
    await step.validate('dates_page_1', ctx);
    const second = rowIds(await step.prompt(ctx));
    expect(second[0]).toBe('dates_page_0');
    expect(second[1]).toBe('2026-11-13');
  });

  it('no open dates still offers the waitlist (unchanged)', async () => {
    const step = await dateStep();
    const msgs = await step.prompt(ctxFor({ sessionData: { _service_available_days: ['funday'], capabilities: ['waitlist'] } }));
    expect(buttonsOf(msgs)!.buttons.map(b => b.id)).toEqual(['wl_join', 'wl_skip']);
  });
});

// ═══════════════════════════════════════════════════════
// A2 / A8. Typed dates and day/month order
// ═══════════════════════════════════════════════════════
describe('A2 select_date — typed dates', () => {
  const wide = { metadata: { max_advance_days: 60 } };

  it.each(['Dec 20', '20 Dec', 'December 20', '20th December', '20/12', '20/12/2026', 'Sun, 20 Dec', 'dec 20th'])(
    '"%s" books 20 December 2026 (not 2001)',
    async input => {
      const step = await dateStep();
      expect(await step.validate(input, ctxFor(wide))).toEqual({ valid: true, data: { date: '2026-12-20' } });
    },
  );

  it('a date in the default 30-day window: "1 Dec" and "1/12"', async () => {
    const step = await dateStep();
    expect(await step.validate('1 Dec', ctxFor({}))).toEqual({ valid: true, data: { date: '2026-12-01' } });
    expect(await step.validate('1/12', ctxFor({}))).toEqual({ valid: true, data: { date: '2026-12-01' } });
  });

  it('existing words still work: tomorrow, a weekday, ISO', async () => {
    const step = await dateStep();
    expect(await step.validate('saturday', ctxFor({}))).toEqual({ valid: true, data: { date: '2026-11-07' } });
    expect(await step.validate('2026-11-20', ctxFor({}))).toEqual({ valid: true, data: { date: '2026-11-20' } });
  });

  it('a date that does not exist gets a clear message', async () => {
    const step = await dateStep();
    for (const input of ['31 Feb', '20/13', '2026-02-31']) {
      const r = await step.validate(input, ctxFor({}));
      expect(r.valid).toBe(false);
      expect(r.errorMessage).toContain("That date doesn't look right");
    }
  });

  it('text that is not a date gets help instead of a wrong year', async () => {
    const step = await dateStep();
    for (const input of ['whenever works', '1.5', '20.30']) {
      const r = await step.validate(input, ctxFor({}));
      expect(r.valid).toBe(false);
      expect(r.errorMessage).toContain('Try typing a date like *20 Dec*');
    }
  });

  it('an upcoming date past the window says "too far ahead", not "passed" (review r3 P3-A)', async () => {
    const step = await dateStep();
    expect((await step.validate('Feb 14', ctxFor({}))).errorMessage).toBe('Bookings open up to 30 days ahead. Please pick an earlier date.');
    vi.setSystemTime(new Date('2026-12-20T12:00:00Z'));
    for (const input of ['Jan 25', '25/01', 'Feb 14']) {
      expect((await step.validate(input, ctxFor({}))).errorMessage).toBe('Bookings open up to 30 days ahead. Please pick an earlier date.');
    }
  });

  it('a day that just passed, typed without a year, says it has passed (review r1 P3-1)', async () => {
    const step = await dateStep();
    const r = await step.validate('4 Nov', ctxFor({}));
    expect(r.errorMessage).toBe('That date has passed. Try *tomorrow* or pick a future date.');
    // With the year typed it is simply in the past too
    expect((await step.validate('4 Nov 2026', ctxFor({}))).errorMessage).toContain('That date has passed');
  });
});

describe('A8 select_date — US businesses read slash dates as month/day', () => {
  const wide = { metadata: { max_advance_days: 60 } };

  it('US: 12/20 is 20 December; 20/12 is not a date', async () => {
    const step = await dateStep();
    expect(await step.validate('12/20', ctxFor({ ...wide, country: 'US' }))).toEqual({ valid: true, data: { date: '2026-12-20' } });
    expect(await step.validate('12/20/2026', ctxFor({ ...wide, country: 'US' }))).toEqual({ valid: true, data: { date: '2026-12-20' } });
    expect((await step.validate('20/12', ctxFor({ ...wide, country: 'US' }))).errorMessage).toContain("doesn't look right");
  });

  it('NG / GB: 20/12 is 20 December; 12/20 is not a date', async () => {
    const step = await dateStep();
    for (const country of ['NG', 'GB']) {
      expect(await step.validate('20/12', ctxFor({ ...wide, country }))).toEqual({ valid: true, data: { date: '2026-12-20' } });
      expect((await step.validate('12/20', ctxFor({ ...wide, country }))).errorMessage).toContain("doesn't look right");
    }
  });

  it('04/12 means 4 December in NG and 12 April (next April, too far ahead) in the US', async () => {
    const step = await dateStep();
    expect(await step.validate('04/12', ctxFor({ country: 'NG' }))).toEqual({ valid: true, data: { date: '2026-12-04' } });
    expect((await step.validate('04/12', ctxFor({ country: 'US' }))).errorMessage).toContain('Bookings open up to 30 days ahead');
    // A day that just passed this year
    expect((await step.validate('11/04', ctxFor({ country: 'US' }))).errorMessage).toContain('That date has passed');
    // Not yet passed this year, but too far ahead
    expect(await step.validate('12/20', ctxFor({ country: 'US' }))).toEqual({ valid: false, errorMessage: 'Bookings open up to 30 days ahead. Please pick an earlier date.' });
  });
});

// ═══════════════════════════════════════════════════════
// A3. Year rollover
// ═══════════════════════════════════════════════════════
describe('A3 select_date — December rollover', () => {
  it('on 20 Dec, "5 Jan" books next year', async () => {
    vi.setSystemTime(new Date('2026-12-20T12:00:00Z'));
    const step = await dateStep();
    expect(await step.validate('5 Jan', ctxFor({}))).toEqual({ valid: true, data: { date: '2027-01-05' } });
    expect(await step.validate('05/01', ctxFor({}))).toEqual({ valid: true, data: { date: '2027-01-05' } });
  });

  it('on 20 Dec, "Dec 10" has passed (not "too far ahead"), and so has a past explicit year', async () => {
    vi.setSystemTime(new Date('2026-12-20T12:00:00Z'));
    const step = await dateStep();
    expect((await step.validate('Dec 10', ctxFor({}))).errorMessage).toContain('That date has passed');
    expect((await step.validate('10/12/2026', ctxFor({}))).errorMessage).toContain('That date has passed');
  });

  it('the year follows the business local date, not the server date', async () => {
    // 23:30 UTC on 31 Dec = 00:30 on 1 Jan in Lagos
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'));
    const step = await dateStep();
    const db = mockDb({ timezone: 'Africa/Lagos', country: 'NG' });
    expect(await step.validate('3 Jan', ctxFor({ db }))).toEqual({ valid: true, data: { date: '2027-01-03' } });
    expect(db.calls.some(c => c.table === 'businesses')).toBe(true);
    // In Lagos it is already 1 Jan 2027, so "31 Dec" is next December (too far), not "passed"
    const lateDec = await step.validate('31 Dec', ctxFor({ db: mockDb({ timezone: 'Africa/Lagos', country: 'NG' }) }));
    expect(lateDec.errorMessage).toContain('Bookings open up to 30 days ahead');
    // Without a usable timezone the server date is used: 31 Dec 2026 has passed
    const serverDate = await step.validate('31 Dec', ctxFor({ db: mockDb({ timezone: null }) }));
    expect(serverDate.errorMessage).toContain('That date has passed');
  });
});

// ═══════════════════════════════════════════════════════
// A4–A6. Closed day, service day, too far, fully booked
// ═══════════════════════════════════════════════════════
describe('A4–A6 select_date — the list rules apply to typed dates', () => {
  it('A4 closed day: "We\'re closed on Sundays"', async () => {
    const step = await dateStep();
    const closedSundays = { operatingHours: { sunday: { closed: true } } };
    for (const input of ['Nov 8', 'sunday', '2026-11-08']) {
      const r = await step.validate(input, ctxFor(closedSundays));
      expect(r.valid).toBe(false);
      expect(r.errorMessage).toBe("We're closed on Sundays. Please pick another date.");
    }
    expect(rowIds(await step.prompt(ctxFor({ ...closedSundays, sessionData: { _show_full_date_list: true } })))).not.toContain('2026-11-08');
  });

  it('A4 service not offered that day', async () => {
    const step = await dateStep();
    const r = await step.validate('10 Nov', ctxFor({ sessionData: { _service_available_days: ['monday'] } }));
    expect(r.errorMessage).toBe("This service isn't available on Tuesdays. Please pick another date.");
    expect(await step.validate('9 Nov', ctxFor({ sessionData: { _service_available_days: ['monday'] } }))).toEqual({ valid: true, data: { date: '2026-11-09' } });
  });

  it('A5 beyond max_advance_days: "Bookings open up to 30 days ahead"', async () => {
    const step = await dateStep();
    const r = await step.validate('Dec 20', ctxFor({}));
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toBe('Bookings open up to 30 days ahead. Please pick an earlier date.');
    expect(await step.validate('Dec 5', ctxFor({}))).toEqual({ valid: true, data: { date: '2026-12-05' } });
    expect((await step.validate('Dec 6', ctxFor({}))).errorMessage).toContain('30 days ahead');
    // The merchant's own window
    expect((await step.validate('Nov 20', ctxFor({ metadata: { max_advance_days: 10 } }))).errorMessage).toContain('10 days ahead');
  });

  it('A6 fully booked: typed or tapped, "That day is fully booked"', async () => {
    const step = await dateStep();
    // Default 08:00–18:00, 30-minute slots, capacity 1 → 20 bookings fill the day
    const full = Array.from({ length: 20 }, (_, i) => ({ date: '2026-11-20', time: `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}` }));
    for (const input of ['20 Nov', '2026-11-20', 'date_2026-11-20']) {
      const r = await step.validate(input, ctxFor({ db: mockDb({ bookings: full }) }));
      expect(r.valid).toBe(false);
      expect(r.errorMessage).toBe('That day is fully booked. Please pick another date.');
    }
    const msgs = await step.prompt(ctxFor({ db: mockDb({ bookings: full }), sessionData: { _show_full_date_list: true } }));
    expect(rowIds(msgs)).not.toContain('2026-11-20');
    // One booking short of full is still open
    expect(await step.validate('20 Nov', ctxFor({ db: mockDb({ bookings: full.slice(1) }) }))).toEqual({ valid: true, data: { date: '2026-11-20' } });
  });
});

// ═══════════════════════════════════════════════════════
// A7. Table same-day
// ═══════════════════════════════════════════════════════
describe('A7 select_date — typed dates keep the table same-day rule', () => {
  it('a table may type today while a slot is left', async () => {
    vi.setSystemTime(LAGOS_1830);
    const step = await dateStep();
    const result = await step.validate('4 Nov', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }) }));
    expect(result).toEqual({ valid: true, data: { date: '2026-11-04' } });
  });

  it('a table cannot type today once no time is left', async () => {
    vi.setSystemTime(new Date('2026-11-04T20:30:00Z')); // 21:30 Lagos
    const step = await dateStep();
    const r = await step.validate('4/11', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }) }));
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain('no more times left today');
  });

  it('appointments still cannot book today, typed or not', async () => {
    vi.setSystemTime(LAGOS_1830);
    const step = await dateStep();
    const r = await step.validate('4 Nov', ctxFor({ db: mockDb({ timezone: 'Africa/Lagos', country: 'NG' }) }));
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain('That date has passed');
  });

  it('a table without a readable timezone keeps tomorrow-first', async () => {
    // Midday UTC: the same calendar day for every server timezone (review r1 P3-5)
    const step = await dateStep();
    const r = await step.validate('5 Nov', ctxFor({ table: true, db: mockDb({ timezone: null }) }));
    expect(r.errorMessage).toContain('That date has passed');
    expect(await step.validate('6 Nov', ctxFor({ table: true, db: mockDb({ timezone: null }) }))).toEqual({ valid: true, data: { date: '2026-11-06' } });
  });
});

// ═══════════════════════════════════════════════════════
// A9. Hint and "never stuck"
// ═══════════════════════════════════════════════════════
describe('A9 select_date — the typing hint, and errors re-show the list', () => {
  it('the hint is on the quick-button prompt and on the list', async () => {
    const step = await dateStep();
    expect(buttonsOf(await step.prompt(ctxFor({})))!.body).toContain('Or type a date, like *20 Dec*.');
    expect(listOf(await step.prompt(ctxFor({ sessionData: { _show_full_date_list: true } })))!.body).toContain('Or type a date, like *20 Dec*.');
  });

  it('after any date error the re-prompt is the date list from the first page', async () => {
    const step = await dateStep();
    for (const input of ['Dec 20', 'blah', '31 Feb', 'Nov 4']) {
      const ctx = ctxFor({ sessionData: { _date_page: 2 } });
      const r = await step.validate(input, ctx);
      expect(r.valid).toBe(false);
      const msgs = await step.prompt(ctx);
      expect(buttonsOf(msgs)).toBeUndefined();
      expect(rowIds(msgs)).toEqual([...WINDOW.slice(0, 9), 'dates_page_1']);
    }
  });
});

// ═══════════════════════════════════════════════════════
// Real executor: tap → persist → re-prompt; typed date advances
// ═══════════════════════════════════════════════════════
describe('select_date through the real FlowExecutor', () => {
  type Sent = { kind: string; payload: Record<string, unknown> };
  let sent: Sent[];
  let casCalls: Array<Record<string, unknown>>;

  function executorSupabase() {
    const chain = (): Record<string, any> => {
      const c: Record<string, any> = {};
      for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'is', 'not', 'in', 'ilike', 'like', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range']) {
        c[m] = vi.fn().mockReturnValue(c);
      }
      c.single = vi.fn().mockResolvedValue({ data: null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      c.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
      return c;
    };
    return {
      from: vi.fn(() => chain()),
      rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
        if (name === 'update_session_cas') {
          casCalls.push(JSON.parse(JSON.stringify(params)));
          return { data: { success: true, version: 2 }, error: null };
        }
        return { data: null, error: null };
      }),
    };
  }
  function sender() {
    const record = (kind: string) => vi.fn(async (payload: Record<string, unknown>) => { sent.push({ kind, payload }); return {}; });
    return { sendText: record('text'), sendButtons: record('buttons'), sendList: record('list'), sendDocument: vi.fn(), sendImage: vi.fn(), markAsRead: vi.fn() };
  }
  const business = {
    id: 'biz-salon', name: 'Salon', slug: 'salon', category: 'salon', flow_type: 'scheduling',
    subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG', operating_hours: {},
  };
  function session() {
    return {
      id: 'sess-date', user_id: 'user-1', business_id: 'biz-salon', current_step: 'select_date',
      session_data: {
        active_capability: 'scheduling', capabilities: ['scheduling'],
        service_id: 'svc-1', service_name: 'Haircut', _service_max_capacity: 1, _service_available_days: [],
        _step_history: ['select_service', 'select_date'],
      },
      conversation_log: [], version: 1,
    };
  }
  const listRows = (s: Sent) => (s.payload.items as Array<{ postbackText: string }>).map(i => i.postbackText);

  beforeEach(() => { sent = []; casCalls = []; });

  it('"Later dates" tap: no error, persists _date_page, sends the next page', async () => {
    const { FlowExecutor } = await import('@/lib/bot/flows/executor');
    const executor = new FlowExecutor(executorSupabase() as any, sender() as any, {} as any, { resetAbuse: vi.fn() } as any);
    const s = session();
    await executor.execute('+2348000000001', 'dates_page_1', s as any, business as any);

    expect(sent.filter(m => m.kind === 'text')).toEqual([]);
    const lists = sent.filter(m => m.kind === 'list');
    expect(lists).toHaveLength(1);
    const ids = listRows(lists[0]);
    expect(ids[0]).toBe('dates_page_0');
    expect(ids.slice(1, 9)).toEqual(WINDOW.slice(9, 17));
    expect(ids[9]).toBe('dates_page_2');
    expect(casCalls.at(-1)).toMatchObject({ p_current_step: 'select_date', p_session_data: expect.objectContaining({ _date_page: 1 }) });
  });

  it('a typed "Dec 1" moves on with the right date', async () => {
    const { FlowExecutor } = await import('@/lib/bot/flows/executor');
    const executor = new FlowExecutor(executorSupabase() as any, sender() as any, {} as any, { resetAbuse: vi.fn() } as any);
    const s = session();
    await executor.execute('+2348000000001', 'Dec 1', s as any, business as any);

    expect(JSON.stringify(sent)).not.toMatch(/went wrong|doesn't look right|has passed/i);
    expect(s.session_data).toMatchObject({ date: '2026-12-01' });
    expect(casCalls.some(c => c.p_current_step !== 'select_date')).toBe(true);
  });

  it('a typed date that is too far ahead: the error, then the date list again', async () => {
    const { FlowExecutor } = await import('@/lib/bot/flows/executor');
    const executor = new FlowExecutor(executorSupabase() as any, sender() as any, {} as any, { resetAbuse: vi.fn() } as any);
    const s = session();
    await executor.execute('+2348000000001', 'Dec 20', s as any, business as any);

    const texts = sent.filter(m => m.kind === 'text').map(m => String(m.payload.text));
    expect(texts.some(t => t.includes('Bookings open up to 30 days ahead'))).toBe(true);
    expect(sent.filter(m => m.kind === 'list')).toHaveLength(1);
    expect(sent.filter(m => m.kind === 'buttons')).toHaveLength(0);
    expect(s.session_data).not.toHaveProperty('date');
  });
});

// ═══════════════════════════════════════════════════════
// Executor pre-processing must not misread typed dates or page rows
// ═══════════════════════════════════════════════════════
describe('typed dates and page rows pass the executor pre-checks untouched', () => {
  it('no guest count, amount or new request is read from a typed date or a page row', async () => {
    const { extractEntitiesOnly, parseSmartIntent } = await import('@/lib/bot/smart-intent');
    for (const input of ['Dec 20', '20 Dec', 'December 20', '20th December', '20/12', '20/12/2026', 'Sun, 20 Dec', 'dates_page_1']) {
      const entities = extractEntitiesOnly(input);
      expect(entities.quantity).toBeNull();
      expect(entities.amount).toBeNull();
      expect(entities.date).toBeNull();
      const intent = parseSmartIntent(input);
      expect(intent.understood).toBe(false);
    }
    // A time typed with the date still pre-fills the time step
    expect(extractEntitiesOnly('Dec 20 at 6pm').specificTime).toBe('18:00');
  });
});

describe('date row labels', () => {
  it('match the previous toLocaleDateString labels, per country', async () => {
    const step = await dateStep();
    for (const country of ['NG', 'US', 'GB']) {
      const items = listOf(await step.prompt(ctxFor({ country, sessionData: { _show_full_date_list: true } })))!.items;
      const { getLocale } = await import('@/lib/constants');
      for (const item of items.filter(i => isDate(i.postbackText))) {
        expect(item.title).toBe(new Date(item.postbackText + 'T00:00').toLocaleDateString(getLocale(country as never), { weekday: 'short', day: 'numeric', month: 'short' }));
      }
    }
  });

  it('a 365-day window pages through every date with at most 10 rows', async () => {
    const step = await dateStep();
    const ctx = ctxFor({ metadata: { max_advance_days: 365 } });
    const seen: string[] = [];
    for (let page = 0; page < 60; page++) {
      await step.validate(`dates_page_${page}`, ctx);
      const ids = rowIds(await step.prompt(ctx));
      expect(ids.length).toBeLessThanOrEqual(10);
      seen.push(...ids.filter(isDate));
      if (!ids.some(id => id === `dates_page_${page + 1}`)) break;
    }
    expect(seen).toHaveLength(365);
    expect(new Set(seen).size).toBe(365);
    expect(seen[0]).toBe('2026-11-06');
    expect(seen[364]).toBe('2027-11-05');
  });
});
