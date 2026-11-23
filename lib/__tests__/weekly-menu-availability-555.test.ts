/**
 * M555 — menu items on sale only on certain days (Owner decision 2026-11-23).
 *
 * Runs the real helpers, the real ordering-flow step prompts, the capability
 * menu and smart product matching against a recording Supabase stub, at fixed
 * clock times either side of midnight in Lagos (UTC+1). 2026-11-23 is a
 * Monday: at 23:01 UTC it is already Tuesday 00:01 in Lagos.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  availabilityLabel, hasAvailabilityLimit, isAvailableOn, isoWeekday, normaliseAvailability, weekEnd, weekStart,
} from '@/lib/products/availability';
import { availabilityTimezone, filterAvailableToday, localDayIn } from '@/lib/products/availability-today';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';
import { orderingFlow } from '@/lib/bot/flows/ordering.flow';
import { capabilitySelectionFlow } from '@/lib/bot/flows/capability-selection.flow';
import { matchProductsFromKeywords } from '@/lib/bot/smart-intent';
import type { FlowContext } from '@/lib/bot/flows/types';

const MON_2359_LAGOS = new Date('2026-11-23T22:59:00Z');
const TUE_0001_LAGOS = new Date('2026-11-23T23:01:00Z');
const BIZ = 'biz-555';

const RICE_BOWL = { id: 'p-bowl', name: 'Rice bowl', price: 2500, category: 'Mains', has_variants: false, track_inventory: false, stock_quantity: null, available_days: null, available_from: null, available_until: null };
const PLATTER_MON = { ...RICE_BOWL, id: 'p-platter', name: 'Rice platter', available_days: [1] };
const SALMON_TUE = { ...RICE_BOWL, id: 'p-salmon', name: 'Salmon', available_days: [2] };
const PRODUCTS = [RICE_BOWL, PLATTER_MON, SALMON_TUE];

type Rows = Record<string, unknown>;
function makeSupabase(tables: Record<string, unknown>, opts: { count?: number } = {}) {
  const calls: string[] = [];
  const from = vi.fn((table: string) => {
    calls.push(table);
    const result = () => Promise.resolve({ data: tables[table] ?? null, error: null, count: opts.count ?? (Array.isArray(tables[table]) ? (tables[table] as Rows[]).length : 0) });
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'is', 'order', 'limit', 'neq', 'not', 'gte', 'lte', 'eq', 'or']) b[m] = vi.fn(() => b);
    b.single = vi.fn(result);
    b.maybeSingle = vi.fn(result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => result().then(res, rej);
    return b;
  });
  return { client: { from, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as unknown, calls };
}

function ctxWith(supabase: unknown, sessionData: Record<string, unknown> = {}): FlowContext {
  const base = createMockContext();
  return createMockContext({
    supabase: supabase as FlowContext['supabase'],
    session: { ...base.session, business_id: BIZ, session_data: sessionData },
    business: { ...base.business!, id: BIZ, flow_type: 'ordering' as never, country_code: 'NG' } as FlowContext['business'],
  });
}

function postbacks(messages: unknown): string[] {
  return [...JSON.stringify(messages).matchAll(/"(?:postbackText|id)":"([^"]+)"/g)].map(m => m[1]);
}

const LAGOS_BIZ = { timezone: 'Africa/Lagos', country_code: 'NG' };

afterEach(() => { vi.useRealTimers(); });

describe('availability rules', () => {
  it('items with no limit are on sale every day', () => {
    expect(hasAvailabilityLimit(RICE_BOWL)).toBe(false);
    expect(hasAvailabilityLimit({})).toBe(false);
    expect(hasAvailabilityLimit({ available_days: [] })).toBe(false);
    for (let wd = 1; wd <= 7; wd++) expect(isAvailableOn(RICE_BOWL, { date: '2026-11-23', weekday: wd })).toBe(true);
  });

  it('days and dates both apply', () => {
    const p = { available_days: [2], available_from: '2026-11-23', available_until: '2026-11-29' };
    expect(isAvailableOn(p, { date: '2026-11-24', weekday: 2 })).toBe(true);
    expect(isAvailableOn(p, { date: '2026-11-23', weekday: 1 })).toBe(false);
    expect(isAvailableOn(p, { date: '2026-12-01', weekday: 2 })).toBe(false);
    expect(isAvailableOn({ available_from: '2026-11-25' }, { date: '2026-11-24', weekday: 2 })).toBe(false);
    expect(isAvailableOn({ available_until: '2026-11-23' }, { date: '2026-11-24', weekday: 2 })).toBe(false);
  });

  it('weekday and week bounds', () => {
    expect(isoWeekday('2026-11-23')).toBe(1);
    expect(isoWeekday('2026-11-29')).toBe(7);
    expect(weekStart('2026-11-26')).toBe('2026-11-23');
    expect(weekEnd('2026-11-26')).toBe('2026-11-29');
    expect(weekStart('2026-11-29')).toBe('2026-11-23');
  });

  it('today flips at Lagos midnight, not UTC midnight', () => {
    expect(localDayIn('Africa/Lagos', MON_2359_LAGOS)).toEqual({ date: '2026-11-23', weekday: 1 });
    expect(localDayIn('Africa/Lagos', TUE_0001_LAGOS)).toEqual({ date: '2026-11-24', weekday: 2 });
  });

  it('timezone: stored zone when it fits the country, else the country default', () => {
    expect(availabilityTimezone('Africa/Lagos', 'NG')).toBe('Africa/Lagos');
    expect(availabilityTimezone(null, 'NG')).toBe('Africa/Lagos');
    expect(availabilityTimezone('Africa/Lagos', 'GB')).toBe('Europe/London');
    expect(availabilityTimezone('America/Chicago', 'US')).toBe('America/Chicago');
    expect(availabilityTimezone('Not/AZone', 'XX')).toBe('Africa/Lagos');
  });

  it('merchant labels', () => {
    expect(availabilityLabel(RICE_BOWL, '2026-11-25')).toBeNull();
    expect(availabilityLabel({ available_days: [2, 1] }, '2026-11-25')).toBe('Mon, Tue');
    expect(availabilityLabel({ available_from: '2026-11-23', available_until: '2026-11-29' }, '2026-11-25')).toBe('this week');
    expect(availabilityLabel({ available_days: [3], available_from: '2026-11-23', available_until: '2026-11-29' }, '2026-11-25')).toBe('Wed · this week');
    expect(availabilityLabel({ available_until: '2026-11-30' }, '2026-11-25')).toBe('until 30 Nov');
  });

  it('save normalisation: every day or no day is NULL, blank dates are NULL', () => {
    expect(normaliseAvailability({ available_days: [], available_from: '', available_until: '' })).toEqual({ available_days: null, available_from: null, available_until: null });
    expect(normaliseAvailability({ available_days: [1, 2, 3, 4, 5, 6, 7] }).available_days).toBeNull();
    expect(normaliseAvailability({ available_days: [3, 1, 3, 9] }).available_days).toEqual([1, 3]);
  });
});

describe('filterAvailableToday', () => {
  it('does not look up the business when no item has a limit (existing menus unchanged)', async () => {
    const { client, calls } = makeSupabase({ businesses: LAGOS_BIZ });
    const out = await filterAvailableToday(client, BIZ, [RICE_BOWL], 'NG', MON_2359_LAGOS);
    expect(out).toEqual([RICE_BOWL]);
    expect(calls).not.toContain('businesses');
  });

  it('uses the business timezone across midnight', async () => {
    const { client } = makeSupabase({ businesses: LAGOS_BIZ });
    expect((await filterAvailableToday(client, BIZ, PRODUCTS, 'NG', MON_2359_LAGOS)).map(p => p.id)).toEqual(['p-bowl', 'p-platter']);
    expect((await filterAvailableToday(client, BIZ, PRODUCTS, 'NG', TUE_0001_LAGOS)).map(p => p.id)).toEqual(['p-bowl', 'p-salmon']);
  });
});

describe('ordering flow shows only today\'s dishes plus standard items', () => {
  const browse = getStep(orderingFlow, 'browse_catalog');
  const category = getStep(orderingFlow, 'browse_category_items');

  it('browse_catalog: Monday 23:59 Lagos', async () => {
    vi.useFakeTimers({ now: MON_2359_LAGOS, toFake: ['Date'] });
    const { client } = makeSupabase({ products: PRODUCTS, businesses: LAGOS_BIZ, product_variants: [] });
    const ids = postbacks(await browse.prompt(ctxWith(client)));
    expect(ids).toContain('p-bowl');
    expect(ids).toContain('p-platter');
    expect(ids).not.toContain('p-salmon');
  });

  it('browse_catalog: Tuesday 00:01 Lagos (still Monday in UTC)', async () => {
    vi.useFakeTimers({ now: TUE_0001_LAGOS, toFake: ['Date'] });
    const { client } = makeSupabase({ products: PRODUCTS, businesses: LAGOS_BIZ, product_variants: [] });
    const ids = postbacks(await browse.prompt(ctxWith(client)));
    expect(ids).toContain('p-bowl');
    expect(ids).toContain('p-salmon');
    expect(ids).not.toContain('p-platter');
  });

  it('browse_category_items filters before taking the first 10', async () => {
    vi.useFakeTimers({ now: TUE_0001_LAGOS, toFake: ['Date'] });
    const mondays = Array.from({ length: 12 }, (_, i) => ({ ...PLATTER_MON, id: `p-mon-${i}`, name: `Mon dish ${i}` }));
    const { client } = makeSupabase({ products: [...mondays, SALMON_TUE], businesses: LAGOS_BIZ, product_variants: [] });
    const ids = postbacks(await category.prompt(ctxWith(client, { _selected_category: 'Mains' })));
    expect(ids).toContain('p-salmon');
    expect(ids.some(id => id.startsWith('p-mon-'))).toBe(false);
  });

  it('checkout does not remove a cart item because the day rolled over', async () => {
    vi.useFakeTimers({ now: TUE_0001_LAGOS, toFake: ['Date'] });
    const review = getStep(orderingFlow, 'review_order_summary');
    const { client } = makeSupabase({
      products: [{ ...PLATTER_MON, is_active: true, deleted_at: null }],
      businesses: { ...LAGOS_BIZ, name: 'Test' },
    });
    const ctx = ctxWith(client, {
      cart: [{ product_id: 'p-platter', name: 'Rice platter', quantity: 1, price: 2500 }],
      customer_name: 'Ada', delivery_address: '1 Road',
    });
    const text = JSON.stringify(await review.prompt(ctx));
    expect(text).not.toContain('no longer available');
    expect((ctx.session.session_data.cart as unknown[]).length).toBe(1);
  });
});

describe('capability menu backing data', () => {
  const step = getStep(capabilitySelectionFlow, 'select_capability');
  function capCtx(products: unknown[]) {
    const { client } = makeSupabase({ products, businesses: LAGOS_BIZ });
    const ctx = ctxWith(client, { capabilities: ['ordering', 'chat'], _force_capability_menu: true });
    return ctx;
  }

  it('hides Order when only another day\'s dishes exist', async () => {
    vi.useFakeTimers({ now: TUE_0001_LAGOS, toFake: ['Date'] });
    const ids = postbacks(await step.prompt(capCtx([PLATTER_MON])));
    expect(ids).not.toContain('cap_ordering');
  });

  it('shows Order when a dish is on sale today', async () => {
    vi.useFakeTimers({ now: MON_2359_LAGOS, toFake: ['Date'] });
    const ids = postbacks(await step.prompt(capCtx([PLATTER_MON])));
    expect(ids).toContain('cap_ordering');
  });
});

describe('smart product matching', () => {
  it('never matches a dish that is not on sale today', async () => {
    vi.useFakeTimers({ now: MON_2359_LAGOS, toFake: ['Date'] });
    const { client } = makeSupabase({ products: PRODUCTS, businesses: LAGOS_BIZ, product_variants: [] });
    const matches = await matchProductsFromKeywords(client as never, BIZ, ['salmon']);
    expect(matches.map(m => m.id)).not.toContain('p-salmon');
    vi.setSystemTime(TUE_0001_LAGOS);
    const later = await matchProductsFromKeywords(client as never, BIZ, ['salmon']);
    expect(later.map(m => m.id)).toContain('p-salmon');
  });
});
