// @vitest-environment jsdom
/**
 * #899: dashboard overview cards say what they count, and "today" is the
 * business's own date (Owner decision 2026-11-05, option A).
 *
 * Renders the real app/dashboard/page.tsx against a fake Supabase client that
 * records every query, so the assertions cover both the visible labels and the
 * date the page actually asks the database for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { CATEGORY_LABELS } from '@/lib/constants';

// The first render loads the whole dashboard page; allow for a busy machine.
vi.setConfig({ testTimeout: 30_000 });

type Filter = [op: string, column: string, value: unknown];
type Query = { table: string; filters: Filter[] };

const state = vi.hoisted(() => ({
  business: {} as Record<string, unknown>,
  capabilities: [] as string[],
  queries: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
}));

vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('qrcode.react', () => ({ QRCodeCanvas: () => null }));
vi.mock('@/components/dashboard/PayoutBanner', () => ({ PayoutBanner: () => null }));
vi.mock('@/components/dashboard/UpgradeBanner', () => ({ UpgradeBanner: () => null }));
vi.mock('@/components/dashboard/OnboardingChecklist', () => ({ OnboardingChecklist: () => null }));
vi.mock('@/components/dashboard/AISetupCard', () => ({ AISetupCard: () => null }));
vi.mock('@/components/dashboard/DirectWhatsAppLink', () => ({ DirectWhatsAppLink: () => null }));
vi.mock('@/components/dashboard/ResponsiveTable', () => ({ ResponsiveTable: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
  useCapabilities: () => ({ hasCapability: (cap: string) => state.capabilities.includes(cap) }),
}));
// Category labels as shipped in lib/constants.ts. On staging (2026-11-05), category_templates
// gives entityName 'order' to the same shop-type keys; keys without DB labels fall back to these.
vi.mock('@/hooks/useCategoryConfig', async () => {
  const { CATEGORY_LABELS: labels } = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants');
  return {
    useCategoryConfig: (key?: string) => ({ labels: labels[(key || 'other') as keyof typeof labels] ?? labels.other }),
  };
});

// Counts the fake database returns. Only the "scheduled today" query and the
// monthly usage queries are date-dependent; they are checked through state.queries.
function countFor(q: Query): number {
  const has = (op: string, column: string, value?: unknown) =>
    q.filters.some(([o, c, v]) => o === op && c === column && (value === undefined || v === value));
  if (q.table === 'bookings') {
    if (has('eq', 'date')) return 0;
    if (has('eq', 'status', 'pending')) return 2;
    if (has('eq', 'status', 'completed')) return 0;
    if (has('eq', 'channel', 'web')) return 0;
    if (has('gte', 'created_at')) return 12;
    return 43;
  }
  if (q.table === 'orders') return has('gte', 'created_at') ? 5 : 19;
  if (q.table === 'services') return 6;
  if (q.table === 'invoices') return 1;
  return 0;
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner-899' } } }) },
    rpc: async (name: string) => ({
      data: name === 'get_business_revenue' ? 6353721 : name === 'get_order_revenue' ? 4739500 : name === 'get_outstanding_invoices' ? 2020 : 0,
      error: null,
    }),
    from(table: string) {
      const query: Query = { table, filters: [] };
      state.queries.push(query);
      const result = () => ({ data: [], count: countFor(query), error: null });
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'order', 'limit']) builder[op] = () => builder;
      for (const op of ['eq', 'is', 'in', 'gte']) {
        builder[op] = (column: string, value: unknown) => { query.filters.push([op, column, value]); return builder; };
      }
      builder.maybeSingle = async () => ({ data: null, error: null });
      builder.then = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
  }),
}));

import DashboardOverview from '@/app/dashboard/page';

function shopBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-899', name: 'TestBiz', category: 'shop', country_code: 'NG', timezone: 'Africa/Lagos',
    subscription_tier: 'growth', bot_code: 'TESTBIZ', operating_hours: { monday: { open: '09:00', close: '17:00' } },
    ...overrides,
  };
}

/** The stat card (or usage bar) whose label is exactly `label`. */
function card(label: string): HTMLElement {
  const node = screen.getByText(label, { exact: true });
  return node.closest('div.rounded-xl') as HTMLElement ?? node.parentElement!.parentElement!;
}
/** The value of the bookings `eq('date', …)` filter the page sent. */
function scheduledDateQueried(): unknown {
  const q = state.queries.find(x => x.table === 'bookings' && x.filters.some(([op, c]) => op === 'eq' && c === 'date'));
  return q?.filters.find(([op, c]) => op === 'eq' && c === 'date')?.[2];
}
/** The created_at lower bound of the monthly usage query on `table`. */
function monthStartQueried(table: string): unknown {
  const q = state.queries.find(x => x.table === table && x.filters.some(([op, c]) => op === 'gte' && c === 'created_at'));
  return q?.filters.find(([op, c]) => op === 'gte' && c === 'created_at')?.[2];
}

async function renderAt(isoUtc: string) {
  vi.setSystemTime(new Date(isoUtc));
  state.business = { ...state.business, capabilities: state.capabilities };
  render(<DashboardOverview />);
  await screen.findAllByText(/^Total /);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  state.queries = [];
  state.business = shopBusiness();
  state.capabilities = ['ordering', 'payment'];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ recommendations: [] })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('#899 shop dashboard: bookings cards say "bookings", orders cards say "orders"', () => {
  it('fixture: shop labels its entity as an order', () => {
    expect(CATEGORY_LABELS.shop.entityName).toBe('order');
  });

  it('labels each card by the table it counts', async () => {
    await renderAt('2026-11-05T10:00:00Z');
    expect(card('Total bookings').textContent).toContain('43');
    expect(card('Total Orders').textContent).toContain('19');
    expect(card('Bookings scheduled today').textContent).toContain('0');
    expect(card('Pending bookings').textContent).toContain('2');
    expect(card('Order Revenue').textContent).toContain('4,739,500');
    expect(card('Total revenue').textContent).toContain('6,353,721');
    expect(screen.getByText('bookings this month')).toBeTruthy();
    expect(screen.getByText('Orders this month')).toBeTruthy();
    expect(screen.getByText(/^Recent bookings$/)).toBeTruthy();
    // The old, misleading labels are gone.
    for (const old of ['Total orders', "Today's orders", 'Pending orders', 'Orders Revenue', 'orders this month']) {
      expect(screen.queryByText(old, { exact: true }), old).toBeNull();
    }
  });

  it('a shop without ordering shows the same bookings wording and plain "Revenue"', async () => {
    state.capabilities = ['payment'];
    await renderAt('2026-11-05T10:00:00Z');
    expect(card('Total bookings').textContent).toContain('43');
    expect(card('Revenue').textContent).toContain('6,353,721');
    expect(screen.queryByText('Total revenue')).toBeNull();
  });
});

describe('#899 other categories keep their own word', () => {
  it('a salon still says "appointments", with the scheduled-today wording', async () => {
    state.business = shopBusiness({ category: 'salon' });
    state.capabilities = ['scheduling', 'payment'];
    const plural = CATEGORY_LABELS.salon.entityNamePlural;
    expect(CATEGORY_LABELS.salon.entityName).not.toBe('order');
    await renderAt('2026-11-05T10:00:00Z');
    expect(card(`Total ${plural}`).textContent).toContain('43');
    expect(card(`${plural.charAt(0).toUpperCase()}${plural.slice(1)} scheduled today`)).toBeTruthy();
    expect(card(`Pending ${plural}`).textContent).toContain('2');
  });

  it('with ordering, the all-payments revenue card is "Total revenue" for every category', async () => {
    state.business = shopBusiness({ category: 'salon' });
    state.capabilities = ['scheduling', 'payment', 'ordering'];
    await renderAt('2026-11-05T10:00:00Z');
    expect(card('Order Revenue').textContent).toContain('4,739,500');
    expect(card('Total revenue').textContent).toContain('6,353,721');
  });
});

describe('#899 "today" is the business date; the usage month stays on the limit clock', () => {
  it('23:30 UTC on 4 Nov is already 5 Nov in Lagos', async () => {
    await renderAt('2026-11-04T23:30:00Z');
    expect(scheduledDateQueried()).toBe('2026-11-05');
  });

  it('a US business with a fitting zone gets its earlier date (New York, 01:30 UTC on 5 Nov = 4 Nov)', async () => {
    state.business = shopBusiness({ country_code: 'US', timezone: 'America/New_York' });
    await renderAt('2026-11-05T01:30:00Z');
    expect(scheduledDateQueried()).toBe('2026-11-04');
  });

  it('a GB business on Europe/London uses London\'s date', async () => {
    state.business = shopBusiness({ country_code: 'GB', timezone: 'Europe/London' });
    await renderAt('2026-11-05T23:30:00Z');
    expect(scheduledDateQueried()).toBe('2026-11-05');
  });

  // businesses.timezone defaults to Africa/Lagos and the app never sets it, so a
  // zone that does not fit the country is not trusted (as in the bot): UTC date.
  it('a US or GB business still on the Lagos default keeps the UTC date', async () => {
    for (const country_code of ['US', 'GB']) {
      cleanup(); state.queries = [];
      state.business = shopBusiness({ country_code, timezone: 'Africa/Lagos' });
      await renderAt('2026-11-05T23:30:00Z');
      expect(scheduledDateQueried(), country_code).toBe('2026-11-05');
    }
  });

  it('a zone that does not fit the country (NG on UTC) keeps the UTC date', async () => {
    state.business = shopBusiness({ timezone: 'UTC' });
    await renderAt('2026-11-04T23:30:00Z');
    expect(scheduledDateQueried()).toBe('2026-11-04');
  });

  it('a missing or invalid time zone falls back to the UTC date', async () => {
    for (const timezone of [null, 'Not/AZone']) {
      cleanup(); state.queries = [];
      state.business = shopBusiness({ timezone });
      await renderAt('2026-11-04T23:30:00Z');
      expect(scheduledDateQueried(), String(timezone)).toBe('2026-11-04');
    }
  });

  it('on 1 Nov 00:30 Lagos the usage bars still count October, matching lib/tier-limits.ts (UTC month)', async () => {
    await renderAt('2026-10-31T23:30:00Z');
    expect(scheduledDateQueried()).toBe('2026-11-01');
    expect(monthStartQueried('bookings')).toBe('2026-10-01');
    expect(monthStartQueried('orders')).toBe('2026-10-01');
  });
});
