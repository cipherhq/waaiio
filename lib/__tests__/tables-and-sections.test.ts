/**
 * Tables & Sections — Owner decisions 2026-11-04.
 *
 * Behavioural tests on the real flow steps (scheduling select_date /
 * select_time with the table-reservation flag) and the real capability
 * resolvers:
 *   1. Bot menu label "Reserve a Table / Section"; capability "Tables & Sections".
 *   2. New-business defaults: on for bar/lounge only; existing (zero-row legacy)
 *      fallback unchanged.
 *   5. Same-day bookings for tables only, in the business timezone; today's
 *      slots start after now; appointments keep the tomorrow-first rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowContext, PromptButtons, PromptList } from '@/lib/bot/flows/types';

// ── Mock database: chainable, thenable, records every query ──
type Row = { date: string; time: string; metadata?: Record<string, unknown> | null };
interface DbOpts { timezone?: string | null; bookings?: Row[]; tzError?: boolean }

function mockDb(opts: DbOpts) {
  const calls: Array<{ table: string; ops: Array<[string, ...unknown[]]> }> = [];
  const from = vi.fn((table: string) => {
    const ops: Array<[string, ...unknown[]]> = [];
    calls.push({ table, ops });
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'limit', 'order', 'update']) {
      chain[m] = vi.fn((...args: unknown[]) => { ops.push([m, ...args]); return chain; });
    }
    chain.maybeSingle = vi.fn(async () => {
      if (table !== 'businesses') return { data: null, error: null };
      if (opts.tzError) return { data: null, error: { message: 'fixture error' } };
      return { data: opts.timezone === undefined ? null : { timezone: opts.timezone }, error: null };
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
  table: boolean;
  db: ReturnType<typeof mockDb>;
  sessionData?: Record<string, unknown>;
  category?: string;
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
    supabase: opts.db.client as never,
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
      id: 'b', name: 'Club', slug: 'club', category: (opts.category || 'bar') as never,
      flow_type: 'scheduling' as never, subscription_tier: 'free', trial_ends_at: '',
      country_code: 'NG', operating_hours: {}, metadata: {},
    },
  };
}

async function steps() {
  const { getFlowStep } = await import('@/lib/bot/flows/registry');
  return { date: getFlowStep('scheduling', 'select_date')!, time: getFlowStep('scheduling', 'select_time')! };
}

const businessesQueried = (db: ReturnType<typeof mockDb>) => db.calls.some(c => c.table === 'businesses');

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

// ═══════════════════════════════════════════════════════
// 1. Labels
// ═══════════════════════════════════════════════════════
describe('Tables & Sections labels', () => {
  it('bot menu label is "Reserve a Table/Section" (en, fits the 24-char list limit) and the pcm equivalent', async () => {
    const { getCapabilityLabel } = await import('@/lib/capabilities/labels');
    expect(getCapabilityLabel('table_reservation', 'bar', null, 'en')).toBe('Reserve a Table/Section');
    expect(getCapabilityLabel('table_reservation', 'restaurant', null, 'pcm')).toBe('Reserve Table / Section');
    // Restaurants' appointment capability keeps its own label
    expect(getCapabilityLabel('appointment', 'restaurant', null, 'en')).toBe('Book a Table');
    // A merchant custom label still wins
    expect(getCapabilityLabel('table_reservation', 'bar', 'Book VIP', 'en')).toBe('Book VIP');
  });

  it('capability keeps id table_reservation, is free, and is named "Tables & Sections"', async () => {
    const { CAPABILITIES, CAPABILITY_TIER_REQUIREMENTS } = await import('@/shared/capabilities');
    const cap = CAPABILITIES.find(c => c.id === 'table_reservation')!;
    expect(cap.label).toBe('Tables & Sections');
    expect(cap.description).toBe('Let customers reserve tables, booths, VIP areas and sections, with date, time and party size.');
    expect(CAPABILITY_TIER_REQUIREMENTS.table_reservation).toBe('free');
  });

  it('the WhatsApp capability menu shows the new label', async () => {
    const { capabilitySelectionFlow } = await import('@/lib/bot/flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const backing: Record<string, number> = { seating_resources: 2, products: 3, services: 1 };
    const from = vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'limit', 'order']) chain[m] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      chain.single = vi.fn(async () => ({ data: null, error: null }));
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: backing[table] ?? 0 });
      return chain;
    });
    const ctx = ctxFor({ table: false, db: { calls: [], client: { from } } as never });
    ctx.session.current_step = 'select_capability';
    ctx.session.session_data = { capabilities: ['table_reservation', 'ordering', 'chat', 'appointment'] };
    ctx.supabase = { from, rpc: vi.fn(async () => ({ data: null, error: null })) } as never;
    const msgs = await step.prompt(ctx);
    const titles = msgs.flatMap(m => m.type === 'list' ? (m as PromptList).items.map(i => i.title)
      : m.type === 'buttons' ? (m as PromptButtons).buttons.map(b => b.title) : []);
    expect(titles).toContain('Reserve a Table/Section');
    expect(titles).not.toContain('Make a Reservation');
  });
});

// ═══════════════════════════════════════════════════════
// 2. Defaults for new businesses
// ═══════════════════════════════════════════════════════
describe('Tables & Sections defaults', () => {
  it('new bar and lounge businesses get table_reservation by default', async () => {
    const { getNewBusinessDefaultCapabilities, getOnboardingDefaultCapabilities } = await import('@/lib/capabilities/types');
    for (const cat of ['bar', 'lounge']) {
      expect(getNewBusinessDefaultCapabilities(cat)).toContain('table_reservation');
      expect(getOnboardingDefaultCapabilities(cat)).toContain('table_reservation');
    }
  });

  it('new restaurant, cafe, bakery, catering and food_truck businesses do not', async () => {
    const { getNewBusinessDefaultCapabilities, getOnboardingDefaultCapabilities, CATEGORY_DEFAULT_CAPABILITIES } = await import('@/lib/capabilities/types');
    for (const cat of ['restaurant', 'cafe', 'bakery', 'catering', 'food_truck']) {
      expect(getNewBusinessDefaultCapabilities(cat)).not.toContain('table_reservation');
      expect(getOnboardingDefaultCapabilities(cat)).not.toContain('table_reservation');
      // The rest of the food set is unchanged, in order
      expect(getNewBusinessDefaultCapabilities(cat)).toEqual(CATEGORY_DEFAULT_CAPABILITIES[cat].filter(c => c !== 'table_reservation'));
    }
  });

  it('other categories are unchanged', async () => {
    const { getNewBusinessDefaultCapabilities, CATEGORY_DEFAULT_CAPABILITIES } = await import('@/lib/capabilities/types');
    for (const [cat, caps] of Object.entries(CATEGORY_DEFAULT_CAPABILITIES)) {
      if (['restaurant', 'cafe', 'bakery', 'catering', 'food_truck'].includes(cat)) continue;
      expect(getNewBusinessDefaultCapabilities(cat)).toEqual(caps);
    }
    expect(getNewBusinessDefaultCapabilities('not_a_category')).toBeUndefined();
  });

  it('existing businesses are untouched: the zero-row legacy fallback still includes table_reservation for food categories', async () => {
    const { CATEGORY_DEFAULT_CAPABILITIES } = await import('@/lib/capabilities/types');
    const { getLegacyDefaultCapabilities } = await import('@/lib/capabilities/legacy-defaults');
    for (const cat of ['restaurant', 'cafe', 'bar', 'lounge', 'bakery', 'catering', 'food_truck']) {
      expect(CATEGORY_DEFAULT_CAPABILITIES[cat]).toContain('table_reservation');
      expect(getLegacyDefaultCapabilities(cat)).toContain('table_reservation');
    }
  });

  it('existing businesses with capability rows keep exactly their rows (no auto-merge)', async () => {
    const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
    const supabase = {
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q;
        q.order = vi.fn()
          .mockReturnValueOnce(q)
          .mockResolvedValueOnce({ data: [
            { capability: 'table_reservation', is_enabled: true, sort_order: 0 },
            { capability: 'ordering', is_enabled: true, sort_order: 1 },
          ], error: null });
        return q;
      },
    };
    expect(await getEnabledCapabilities(supabase as never, 'biz', 'restaurant')).toEqual(['table_reservation', 'ordering']);
  });

  it('initCapabilities without an explicit selection uses the new-business defaults', async () => {
    const { initCapabilities } = await import('@/lib/capabilities/service');
    const upserts: Array<Array<{ capability: string }>> = [];
    const supabase = {
      from: () => {
        const q: Record<string, unknown> = {};
        q.upsert = (rows: Array<{ capability: string }>) => { upserts.push(rows); return Promise.resolve({ error: null }); };
        q.update = () => q; q.eq = () => q;
        q.not = () => Promise.resolve({ error: null });
        return q;
      },
    };
    await initCapabilities(supabase as never, 'new-cafe', 'cafe');
    await initCapabilities(supabase as never, 'new-bar', 'bar');
    expect(upserts[0].map(r => r.capability)).not.toContain('table_reservation');
    expect(upserts[1].map(r => r.capability)).toContain('table_reservation');
    // An explicit selection (signup choice) is honoured for any category
    await initCapabilities(supabase as never, 'new-restaurant', 'restaurant', ['table_reservation', 'ordering']);
    expect(upserts[2].map(r => r.capability)).toEqual(['table_reservation', 'ordering']);
  });
});

// ═══════════════════════════════════════════════════════
// 5. Same-day bookings — tables only
// ═══════════════════════════════════════════════════════
// Wednesday 4 Nov 2026, 17:30 UTC = 18:30 in Lagos (UTC+1).
const LAGOS_1830 = new Date('2026-11-04T17:30:00Z');
// Default hours 08:00–22:00, 90-minute reservation, 90-minute interval:
// 08:00 09:30 11:00 12:30 14:00 15:30 17:00 18:30 20:00 → after 18:30 only 20:00 is left.

function shortcutIds(msgs: unknown[]) {
  const b = (msgs as Array<{ type: string }>).find(m => m.type === 'buttons') as PromptButtons | undefined;
  return b ? b.buttons.map(x => x.id) : [];
}
function listDates(msgs: unknown[]) {
  const l = (msgs as Array<{ type: string }>).find(m => m.type === 'list') as PromptList | undefined;
  return l ? l.items.map(i => i.postbackText) : [];
}

describe('select_date — same-day for tables', () => {
  it('offers Today first while a slot is left today (business timezone)', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    const msgs = await date.prompt(ctxFor({ table: true, db }));
    // Three-button limit: Today, Tomorrow, Pick a Date (This Saturday drops off)
    expect(shortcutIds(msgs)).toEqual(['date_2026-11-04', 'date_2026-11-05', 'pick_date']);
    const titles = (msgs.find(m => m.type === 'buttons') as PromptButtons).buttons.map(b => b.title);
    expect(titles[0]).toBe('Today (Wed)');
    expect(titles[1]).toBe('Tomorrow (Thu)');
  });

  it('full date list starts with today', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    const msgs = await date.prompt(ctxFor({ table: true, db, sessionData: { _show_full_date_list: true } }));
    const dates = listDates(msgs);
    expect(dates[0]).toBe('2026-11-04');
    expect(dates[1]).toBe('2026-11-05');
    expect(dates.length).toBe(10);
  });

  it('hides today once the last slot of the day has started', async () => {
    vi.setSystemTime(new Date('2026-11-04T19:00:00Z')); // 20:00 Lagos — 20:00 is not after now
    const { date } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    const msgs = await date.prompt(ctxFor({ table: true, db, sessionData: { _show_full_date_list: true } }));
    expect(listDates(msgs)[0]).toBe('2026-11-05');
    const db2 = mockDb({ timezone: 'Africa/Lagos' });
    // No Today button: back to the usual Tomorrow / This Saturday / Pick a Date
    expect(shortcutIds(await date.prompt(ctxFor({ table: true, db: db2 })))).toEqual(['date_2026-11-05', 'date_2026-11-07', 'pick_date']);
  });

  it('hides today when the only remaining slot today is already reserved on this table', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos', bookings: [{ date: '2026-11-04', time: '20:00:00', metadata: { duration_minutes: 90 } }] });
    const msgs = await date.prompt(ctxFor({ table: true, db, sessionData: { _show_full_date_list: true } }));
    expect(listDates(msgs)).not.toContain('2026-11-04');
    // Availability was read for this table only
    const todayQuery = db.calls.find(c => c.table === 'bookings' && c.ops.some(o => o[0] === 'eq' && o[1] === 'date'));
    expect(todayQuery!.ops).toContainEqual(['eq', 'seating_resource_id', 'res-vip']);
    expect(todayQuery!.ops).toContainEqual(['eq', 'business_id', 'b']);
  });

  it('uses the business timezone, not the server date', async () => {
    // 01:30 UTC on Thu 5 Nov = 20:30 Wed 4 Nov in New York (EST).
    vi.setSystemTime(new Date('2026-11-05T01:30:00Z'));
    const { date } = await steps();
    const db = mockDb({ timezone: 'America/New_York' });
    const msgs = await date.prompt(ctxFor({
      table: true, db,
      sessionData: { service_duration: 60, _seating_duration: 60, _show_full_date_list: true },
    }));
    // 21:00 (+60 = 22:00) is still free tonight in New York
    expect(listDates(msgs)[0]).toBe('2026-11-04');
  });

  it('keeps the tomorrow-first list when the timezone cannot be read', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    for (const db of [mockDb({ timezone: null }), mockDb({ tzError: true }), mockDb({ timezone: 'Not/AZone' })]) {
      const msgs = await date.prompt(ctxFor({ table: true, db, sessionData: { _show_full_date_list: true } }));
      expect(listDates(msgs)[0]).toBe('2026-11-05');
    }
  });

  it('appointments keep the tomorrow-first list and never read the timezone', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    const msgs = await date.prompt(ctxFor({ table: false, db, category: 'salon', sessionData: { _show_full_date_list: true } }));
    expect(listDates(msgs)[0]).toBe('2026-11-05');
    expect(businessesQueried(db)).toBe(false);
    const db2 = mockDb({ timezone: 'Africa/Lagos' });
    const shortcuts = shortcutIds(await date.prompt(ctxFor({ table: false, db: db2, category: 'salon' })));
    expect(shortcuts).not.toContain('date_2026-11-04');
    expect(shortcuts[shortcuts.length - 1]).toBe('pick_date');
  });
});

describe('select_date.validate — typed "today"', () => {
  it('accepts "today" for a table (local date)', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const result = await date.validate('today', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }) }));
    expect(result).toEqual({ valid: true, data: { date: '2026-11-04' } });
    const tapped = await date.validate('date_2026-11-04', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }) }));
    expect(tapped).toEqual({ valid: true, data: { date: '2026-11-04' } });
  });

  it('refuses "today" for a table when no time is left today', async () => {
    vi.setSystemTime(new Date('2026-11-04T20:30:00Z')); // 21:30 Lagos
    const { date } = await steps();
    const result = await date.validate('today', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }) }));
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('no more times left today');
  });

  it('still rejects "today" for appointments', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    const result = await date.validate('today', ctxFor({ table: false, db, category: 'salon' }));
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('That date has passed');
    expect(businessesQueried(db)).toBe(false);
    // A date two days out still works for appointments (unchanged rule; "tomorrow" itself
    // depends on the server timezone in the untouched appointment path, so it is not pinned here)
    expect((await date.validate('2026-11-06', ctxFor({ table: false, db: mockDb({}), category: 'salon' }))).valid).toBe(true);
  });

  it('rejects yesterday for a table, and "today" falls back to the old rule without a timezone', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    expect((await date.validate('2026-11-03', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }) }))).valid).toBe(false);
    const noTz = await date.validate('today', ctxFor({ table: true, db: mockDb({ timezone: null }) }));
    expect(noTz.valid).toBe(false);
    expect(noTz.errorMessage).toContain('That date has passed');
  });
});

describe('select_time — today only offers times after now (tables)', () => {
  function timePostbacks(msgs: unknown[]) {
    return listDates(msgs).filter(p => p !== 'change_date');
  }

  it("today's list only has slots after the current local time", async () => {
    vi.setSystemTime(LAGOS_1830);
    const { time } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    const msgs = await time.prompt(ctxFor({ table: true, db, sessionData: { date: '2026-11-04' } }));
    expect(timePostbacks(msgs)).toEqual(['20:00']);
  });

  it('respects available_to trimming and the slot interval for today', async () => {
    vi.setSystemTime(new Date('2026-11-04T13:10:00Z')); // 14:10 Lagos
    const { time } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    const msgs = await time.prompt(ctxFor({
      table: true, db,
      sessionData: {
        date: '2026-11-04', service_duration: 60, _seating_duration: 60,
        _service_available_from: '12:00', _service_available_to: '18:00', _seating_available_to: '18:00',
      },
    }));
    // 12:00..17:00 hourly, end ≤ 18:00, after 14:10 → 15:00 16:00 17:00
    expect(timePostbacks(msgs)).toEqual(['15:00', '16:00', '17:00']);
  });

  it('future dates are unchanged (all slots)', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { time } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    const msgs = await time.prompt(ctxFor({ table: true, db, sessionData: { date: '2026-11-05' } }));
    expect(timePostbacks(msgs)).toEqual(['08:00', '09:30', '11:00', '12:30', '14:00', '15:30', '17:00', '18:30', '20:00']);
  });

  it('a typed past time today is refused; a later time is accepted', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { time } = await steps();
    const past = await time.validate('10am', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }), sessionData: { date: '2026-11-04' } }));
    expect(past.valid).toBe(false);
    expect(past.errorMessage).toContain('already passed today');
    const now = await time.validate('18:30', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }), sessionData: { date: '2026-11-04' } }));
    expect(now.valid).toBe(false);
    const later = await time.validate('8pm', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }), sessionData: { date: '2026-11-04' } }));
    expect(later).toEqual({ valid: true, data: { time: '20:00' } });
  });

  it('a pre-filled past time today is cleared so the picker is shown', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { time } = await steps();
    const ctx = ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }), sessionData: { date: '2026-11-04', time: '12:00' } });
    expect(await time.skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data.time).toBeUndefined();
    const ok = ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }), sessionData: { date: '2026-11-04', time: '20:00' } });
    expect(await time.skipIf!(ok)).toBe(true);
  });

  it('appointments do not read the timezone in select_time', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { time } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos' });
    await time.prompt(ctxFor({ table: false, db, category: 'salon', sessionData: { date: '2026-11-05' } }));
    expect(businessesQueried(db)).toBe(false);
  });
});

describe('table-same-day helpers', () => {
  it('getLocalNow and addDaysToDateStr', async () => {
    const { getLocalNow, addDaysToDateStr } = await import('@/lib/bot/flows/shared/table-same-day');
    expect(getLocalNow('Africa/Lagos', new Date('2026-11-04T23:30:00Z'))).toEqual({ date: '2026-11-05', minutes: 30 });
    expect(getLocalNow('America/New_York', new Date('2026-11-05T01:30:00Z'))).toEqual({ date: '2026-11-04', minutes: 20 * 60 + 30 });
    expect(getLocalNow('UTC', new Date('2026-11-04T00:00:00Z'))).toEqual({ date: '2026-11-04', minutes: 0 });
    expect(getLocalNow('Bad/Zone')).toBeNull();
    expect(getLocalNow(null)).toBeNull();
    expect(addDaysToDateStr('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToDateStr('2028-02-28', 1)).toBe('2028-02-29');
  });
});
