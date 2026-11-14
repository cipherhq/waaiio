/**
 * Tables & Sections — Owner decisions 2026-11-04.
 *
 * Behavioural tests on the real flow steps (scheduling select_date /
 * select_time with the table-reservation flag) and the real capability
 * resolvers:
 *   1. Bot menu label "Book Table / Section" (20 chars); capability "Tables & Sections".
 *   2. Defaults unchanged from main: Tables & Sections on for every food and
 *      drink category (signup, initCapabilities, WhatsApp onboarding).
 *   5. Same-day bookings for tables only, and only when the stored timezone
 *      fits the business's country; today's slots start after now;
 *      appointments keep the tomorrow-first rule.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowContext, PromptButtons, PromptList } from '@/lib/bot/flows/types';

// ── Mock database: chainable, thenable, records every query ──
type Row = { date: string; time: string; metadata?: Record<string, unknown> | null };
interface DbOpts { timezone?: string | null; country?: string | null; bookings?: Row[]; tzError?: boolean }

function mockDb(opts: DbOpts) {
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
      if (opts.tzError) return { data: null, error: { message: 'fixture error' } };
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

// The flow registry imports every flow; load it once up front so a cold import under load
// does not count against the first test's 5s timeout.
beforeAll(async () => { await import('@/lib/bot/flows/registry'); }, 60_000);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

// ═══════════════════════════════════════════════════════
// 1. Labels
// ═══════════════════════════════════════════════════════
describe('Tables & Sections labels', () => {
  it('bot menu label is "Book Table / Section" (en and pcm)', async () => {
    const { getCapabilityLabel } = await import('@/lib/capabilities/labels');
    expect(getCapabilityLabel('table_reservation', 'bar', null, 'en')).toBe('Book Table / Section');
    expect(getCapabilityLabel('table_reservation', 'restaurant', null, 'pcm')).toBe('Book Table / Section');
    // Owner decision 2026-11-04: restaurants' appointment option is 'Book Appointment' (was 'Book a Table')
    expect(getCapabilityLabel('appointment', 'restaurant', null, 'en')).toBe('Book Appointment');
    expect(getCapabilityLabel('appointment', 'restaurant', null, 'pcm')).toBe('Book Appointment');
    // A merchant custom label still wins
    expect(getCapabilityLabel('table_reservation', 'bar', 'Book VIP', 'en')).toBe('Book VIP');
  });

  it('every certified-language cap.table_reservation label is 20 chars or fewer (WhatsApp button limit)', async () => {
    const { CERTIFIED_LANGUAGES } = await import('@/lib/bot/languages');
    const { _FLOW_COPY_FOR_TESTS } = await import('@/lib/bot/flows/flow-localization');
    expect(CERTIFIED_LANGUAGES.length).toBeGreaterThan(0);
    for (const lang of CERTIFIED_LANGUAGES) {
      const label = _FLOW_COPY_FOR_TESTS[lang]['cap.table_reservation'];
      expect(label, `${lang} label missing`).toBeTruthy();
      expect(label.length, `${lang}.cap.table_reservation = "${label}" (${label.length} chars)`).toBeLessThanOrEqual(20);
    }
    // Uncertified locales also fit, so they are safe if certified later
    for (const lang of ['fr', 'es']) expect(_FLOW_COPY_FOR_TESTS[lang]['cap.table_reservation'].length).toBeLessThanOrEqual(20);
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
    expect(titles).toContain('Book Table / Section');
    expect(titles).not.toContain('Make a Reservation');
  });
});

// ═══════════════════════════════════════════════════════
// Routing: lounge works like bar; restaurants' "book a table" (Owner decisions 2026-11-04)
// ═══════════════════════════════════════════════════════
describe('Tables & Sections routing', () => {
  async function selectCapability(category: string, capabilities: string[], input: string) {
    const { capabilitySelectionFlow } = await import('@/lib/bot/flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('@/lib/bot/flows/__tests__/helpers');
    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities, _filtered_capabilities: capabilities },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: category as never, flow_type: 'scheduling' as never, subscription_tier: 'growth', trial_ends_at: '', metadata: {} },
    });
    ctx.copyLang = 'en';
    return step.validate(input, ctx);
  }

  it('generic booking at a lounge resolves to table_reservation, like bar', async () => {
    const { disambiguateByCategory } = await import('@/lib/bot/semantic-resolver');
    expect(disambiguateByCategory('lounge', ['table_reservation', 'ordering'] as never)).toBe('table_reservation');
    expect(disambiguateByCategory('bar', ['table_reservation', 'ordering'] as never)).toBe('table_reservation');
    // Same zero-silent-guessing rule as bar when Tables & Sections is off
    expect(disambiguateByCategory('lounge', ['appointment'] as never)).toBe(disambiguateByCategory('bar', ['appointment'] as never));
  });

  it.each(['book', 'I want to reserve', 'I want to book'])('lounge: "%s" starts Tables & Sections', async input => {
    const result = await selectCapability('lounge', ['table_reservation', 'ordering', 'chat'], input);
    expect(result).toMatchObject({ valid: true, data: { active_capability: 'table_reservation' } });
  });

  it('restaurant: "book a table" reaches Tables & Sections, "Book Appointment" reaches appointments', async () => {
    const caps = ['appointment', 'table_reservation', 'ordering'];
    expect(await selectCapability('restaurant', caps, 'book a table')).toMatchObject({ valid: true, data: { active_capability: 'table_reservation' } });
    expect(await selectCapability('restaurant', caps, 'Book Table / Section')).toMatchObject({ valid: true, data: { active_capability: 'table_reservation' } });
    expect(await selectCapability('restaurant', caps, 'Book Appointment')).toMatchObject({ valid: true, data: { active_capability: 'appointment' } });
  });
});

// ═══════════════════════════════════════════════════════
// 2. Defaults — unchanged from main (Owner decision 2026-11-04)
// ═══════════════════════════════════════════════════════
const FOOD = ['restaurant', 'cafe', 'bar', 'lounge', 'bakery', 'catering', 'food_truck'];

describe('Tables & Sections defaults (same as main)', () => {
  it('every food and drink category has table_reservation on by default (signup and legacy fallback)', async () => {
    const { CATEGORY_DEFAULT_CAPABILITIES, getOnboardingDefaultCapabilities } = await import('@/lib/capabilities/types');
    const { getLegacyDefaultCapabilities } = await import('@/lib/capabilities/legacy-defaults');
    for (const cat of FOOD) {
      expect(CATEGORY_DEFAULT_CAPABILITIES[cat]).toContain('table_reservation');
      expect(getOnboardingDefaultCapabilities(cat)).toContain('table_reservation');
      expect(getLegacyDefaultCapabilities(cat)).toContain('table_reservation');
    }
    // No new-business override helper exists any more
    expect('getNewBusinessDefaultCapabilities' in (await import('@/lib/capabilities/types'))).toBe(false);
  });

  it('initCapabilities without a selection turns it on for every food category; an explicit selection is honoured', async () => {
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
    for (const cat of ['cafe', 'bakery', 'catering', 'food_truck', 'bar', 'lounge']) {
      await initCapabilities(supabase as never, `new-${cat}`, cat);
      expect(upserts[upserts.length - 1].map(r => r.capability)).toContain('table_reservation');
    }
    await initCapabilities(supabase as never, 'new-salon', 'salon', ['table_reservation', 'appointment']);
    expect(upserts[upserts.length - 1].map(r => r.capability)).toEqual(['table_reservation', 'appointment']);
  });

  it('WhatsApp-native onboarding offers it for food categories, named "Tables & Sections"', async () => {
    const { handleOnboardingDataExchange } = await import('@/app/api/whatsapp/flow-data/onboarding');
    for (const cat of FOOD) {
      const res = handleOnboardingDataExchange('data_exchange', 'BUSINESS_DETAILS', { category: cat }) as {
        data: { capabilities: Array<{ id: string; title: string }> };
      };
      expect(res.data.capabilities).toContainEqual({ id: 'table_reservation', title: 'Tables & Sections' });
    }
    const salon = handleOnboardingDataExchange('data_exchange', 'BUSINESS_DETAILS', { category: 'salon' }) as {
      data: { capabilities: Array<{ id: string; title: string }> };
    };
    expect(salon.data.capabilities.map(c => c.id)).not.toContain('table_reservation');
    // Other generated titles are unchanged
    expect(salon.data.capabilities).toContainEqual({ id: 'appointment', title: 'Appointment' });
  });

  it('existing businesses with capability rows keep exactly their rows (no auto-merge)', async () => {
    const { getEnabledCapabilities } = await import('@/lib/capabilities/service');
    const supabase = {
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q;
        q.order = vi.fn()
          .mockReturnValueOnce(q)
          .mockResolvedValueOnce({ data: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }], error: null });
        return q;
      },
    };
    expect(await getEnabledCapabilities(supabase as never, 'biz', 'restaurant')).toEqual(['ordering']);
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
    const db = mockDb({ timezone: 'America/New_York', country: 'US' });
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

describe('same-day only when the stored timezone fits the country', () => {
  it('a US business still on the Africa/Lagos default gets tomorrow-first', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date, time } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos', country: 'US' });
    const msgs = await date.prompt(ctxFor({ table: true, db, sessionData: { _show_full_date_list: true } }));
    expect(listDates(msgs)[0]).toBe('2026-11-05');
    expect(shortcutIds(await date.prompt(ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos', country: 'US' }) })))).not.toContain('date_2026-11-04');
    const today = await date.validate('today', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos', country: 'US' }) }));
    expect(today.valid).toBe(false);
    expect(today.errorMessage).toContain('That date has passed');
    // No past-time filtering either: the list for a future date is the full list
    const t = await time.prompt(ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos', country: 'US' }), sessionData: { date: '2026-11-05' } }));
    expect(listDates(t)).toContain('08:00');
  });

  it('the country on the business record is used when the DB row has none', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    // ctxFor() business is NG; row has no country_code → NG + Africa/Lagos fits
    const ok = await date.validate('today', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos' }) }));
    expect(ok.valid).toBe(true);
  });

  it.each([
    ['NG', 'Africa/Lagos', true], ['NG', 'America/New_York', false],
    ['GH', 'Africa/Accra', true], ['GH', 'Africa/Lagos', false],
    ['GB', 'Europe/London', true], ['GB', 'Africa/Lagos', false],
    ['US', 'America/New_York', true], ['US', 'America/Los_Angeles', true], ['US', 'Pacific/Honolulu', true], ['US', 'Africa/Lagos', false],
    ['CA', 'America/Toronto', true], ['CA', 'Europe/London', false],
    ['ZA', 'Africa/Johannesburg', false], [null, 'Africa/Lagos', false], ['NG', null, false], ['us', 'America/Chicago', true],
  ])('timezoneFitsCountry(%s, %s) = %s', async (country, tz, expected) => {
    const { timezoneFitsCountry } = await import('@/lib/bot/flows/shared/table-same-day');
    expect(timezoneFitsCountry(tz, country)).toBe(expected);
  });

  it('GB on Europe/London gets same-day in London time', async () => {
    vi.setSystemTime(new Date('2026-11-04T19:00:00Z')); // 19:00 London (GMT); 20:00 slot left
    const { date } = await steps();
    const result = await date.validate('today', ctxFor({ table: true, db: mockDb({ timezone: 'Europe/London', country: 'GB' }) }));
    expect(result).toEqual({ valid: true, data: { date: '2026-11-04' } });
  });

  it('an unknown country never gets same-day', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const result = await date.validate('today', ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Johannesburg', country: 'ZA' }) }));
    expect(result.valid).toBe(false);
  });
});

describe('select_date.skipIf — pre-filled dates for tables', () => {
  it('keeps a pre-filled today when the timezone fits and a slot is left', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const ctx = ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos', country: 'NG' }), sessionData: { date: '2026-11-04' } });
    expect(await date.skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data.date).toBe('2026-11-04');
  });

  it('drops a pre-filled today when no slot is left today (no empty time list)', async () => {
    vi.setSystemTime(new Date('2026-11-04T20:30:00Z')); // 21:30 Lagos
    const { date } = await steps();
    const ctx = ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos', country: 'NG' }), sessionData: { date: '2026-11-04' } });
    expect(await date.skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data.date).toBeUndefined();
  });

  it('drops a pre-filled today when the timezone does not fit the country (tomorrow-first)', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const today = new Date().toISOString().split('T')[0];
    const ctx = ctxFor({ table: true, db: mockDb({ timezone: 'Africa/Lagos', country: 'US' }), sessionData: { date: today } });
    expect(await date.skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data.date).toBeUndefined();
  });

  it('keeps a pre-filled future date in every case', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    for (const db of [mockDb({ timezone: 'Africa/Lagos', country: 'NG' }), mockDb({ timezone: 'Africa/Lagos', country: 'US' })]) {
      const ctx = ctxFor({ table: true, db, sessionData: { date: '2026-11-07' } });
      expect(await date.skipIf!(ctx)).toBe(true);
    }
  });

  it('appointments keep the existing pre-fill rule and never read the timezone', async () => {
    vi.setSystemTime(LAGOS_1830);
    const { date } = await steps();
    const db = mockDb({ timezone: 'Africa/Lagos', country: 'NG' });
    const today = new Date(); const todayLocal = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const ctx = ctxFor({ table: false, db, category: 'salon', sessionData: { date: todayLocal } });
    expect(await date.skipIf!(ctx)).toBe(true);
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
