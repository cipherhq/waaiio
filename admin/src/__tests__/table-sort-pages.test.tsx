/**
 * Owner request (2026-11-17): click a column header to sort, click again to reverse.
 * Renders real admin pages with fake data and proves the header sorts the whole
 * loaded list (not just the visible page) by value, with aria-sort.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fixtures: {} as Record<string, unknown[]>, orders: [] as Array<{ table: string; args: unknown[] }> }));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const q: any = {};
    for (const m of ['select', 'eq', 'in', 'limit', 'range', 'not', 'gte', 'lte', 'is', 'neq', 'gt', 'lt', 'ilike', 'or']) q[m] = () => q;
    q.order = (...args: unknown[]) => { h.orders.push({ table, args }); return q; };
    q.maybeSingle = async () => ({ data: (h.fixtures[table] || [])[0] ?? null, error: null });
    q.single = q.maybeSingle;
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: h.fixtures[table] || [], error: null, count: (h.fixtures[table] || []).length }).then(resolve, reject);
    return q;
  };
  const auth = { getSession: async () => ({ data: { session: { access_token: 'synthetic-token', user: { id: 'admin-self' } } } }) };
  return { adminDb: { from, auth }, supabase: { from, auth } };
});
const session = vi.hoisted(() => ({ userId: 'admin-self', email: 'a@example.test', role: 'admin' }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => session }));

import Payments from '@/pages/Payments';
import Orders from '@/pages/Orders';
import MessagingCredits from '@/pages/MessagingCredits';

let ordersBody: unknown = { data: [] };
beforeEach(() => {
  h.fixtures = {}; h.orders = [];
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ordersBody), { status: 200 })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row');
const firstCells = (col: number) => bodyRows().map(r => r.querySelectorAll('td')[col]?.textContent?.trim());

describe('admin Payments table sorting', () => {
  beforeEach(() => {
    // 25 payments: the page shows 20 at a time, newest first as loaded.
    h.fixtures.payments = Array.from({ length: 25 }, (_, i) => ({
      id: `pay-${String(i).padStart(2, '0')}`,
      business_id: 'biz-1',
      amount: (i * 37) % 25 * 10 + 5, // 5..245, shuffled, never equal
      refund_amount: 0,
      currency: 'NGN',
      gateway: i % 2 ? 'paystack' : 'Stripe',
      gateway_reference: `ref-${i}`,
      status: 'success',
      payment_method: 'card',
      booking_id: null,
      order_id: null,
      created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }));
    h.fixtures.businesses = [{ id: 'biz-1', name: 'Biz One', category: 'salon' }];
    h.fixtures.bookings = [];
    h.fixtures.orders = [];
    h.fixtures.refund_requests = [];
  });

  it('sorts the whole list by amount value and reverses on a second click', async () => {
    render(<Payments />);
    await waitFor(() => expect(bodyRows()).toHaveLength(20));

    const amountHeader = screen.getByRole('columnheader', { name: /Amount/ });
    fireEvent.click(within(amountHeader).getByRole('button'));
    expect(amountHeader).toHaveAttribute('aria-sort', 'ascending');
    // Smallest of all 25 rows first — page 1 of the sorted list, not a re-ordered page.
    expect(firstCells(2)[0]).toMatch(/5(\.00)?$/);
    expect(firstCells(2)[1]).toMatch(/15(\.00)?$/);

    fireEvent.click(within(amountHeader).getByRole('button'));
    expect(amountHeader).toHaveAttribute('aria-sort', 'descending');
    expect(firstCells(2)[0]).toMatch(/245(\.00)?$/);
  });

  it('sorts dates by time and gateway text case-insensitively', async () => {
    render(<Payments />);
    await waitFor(() => expect(bodyRows()).toHaveLength(20));

    fireEvent.click(within(screen.getByRole('columnheader', { name: /Date/ })).getByRole('button'));
    expect(bodyRows()[0].querySelectorAll('td')[0].textContent).toBe('ref-0');

    fireEvent.click(within(screen.getByRole('columnheader', { name: /Gateway/ })).getByRole('button'));
    const gateways = firstCells(3);
    expect(gateways.slice(0, 12).every(g => g?.toLowerCase() === 'paystack')).toBe(true);
  });
});

describe('admin Orders table sorting (rows from the admin API)', () => {
  beforeEach(() => {
    const row = (id: string, customer: string | null, total: number, created: string) => ({
      id, business_id: 'biz-1', business_name: 'Biz One', customer_name: customer, items_count: 1,
      total_amount: total, currency: 'NGN', status: 'completed', created_at: created,
    });
    ordersBody = { data: [
      row('order-b', 'zoe', 900, '2026-03-01T00:00:00Z'),
      row('order-a', null, 80, '2026-01-01T00:00:00Z'),
      row('order-c', 'Adam', 1000, '2026-02-01T00:00:00Z'),
    ] };
  });

  it('sorts totals by value and customers case-insensitively with empty names last', async () => {
    render(<Orders />);
    await waitFor(() => expect(bodyRows()).toHaveLength(3));

    const total = screen.getByRole('columnheader', { name: /Total/ });
    fireEvent.click(within(total).getByRole('button'));
    expect(bodyRows().map(r => r.querySelectorAll('td')[0].textContent?.slice(0, 7))).toEqual(['order-a', 'order-b', 'order-c']);
    fireEvent.click(within(total).getByRole('button'));
    expect(total).toHaveAttribute('aria-sort', 'descending');
    expect(bodyRows().map(r => r.querySelectorAll('td')[0].textContent?.slice(0, 7))).toEqual(['order-c', 'order-b', 'order-a']);

    for (const direction of ['ascending', 'descending']) {
      const customer = screen.getByRole('columnheader', { name: /Customer/ });
      fireEvent.click(within(customer).getByRole('button'));
      expect(customer).toHaveAttribute('aria-sort', direction);
      expect(bodyRows()[2].querySelectorAll('td')[0].textContent?.slice(0, 7)).toBe('order-a');
    }
  });
});

describe('admin Messaging Credits (server-paged) sorting', () => {
  beforeEach(() => {
    h.fixtures.businesses = [{ id: 'biz-1', name: 'Biz One', subscription_tier: 'pro', country_code: 'NG', messaging_suspended: false }];
    h.fixtures.messaging_allowances = [];
    h.fixtures.messaging_topup_purchases = [];
  });
  const bizOrders = () => h.orders.filter(o => o.table === 'businesses').map(o => o.args);

  it('re-queries the server with the whitelisted column and direction', async () => {
    render(<MessagingCredits />);
    await screen.findByRole('columnheader', { name: /Tier/ });
    expect(bizOrders()[0]).toEqual(['name', { ascending: true, nullsFirst: false }]);

    h.orders = [];
    fireEvent.click(within(screen.getByRole('columnheader', { name: /Tier/ })).getByRole('button'));
    await waitFor(() => expect(bizOrders()[0]).toEqual(['subscription_tier', { ascending: true, nullsFirst: false }]));

    h.orders = [];
    fireEvent.click(within(await screen.findByRole('columnheader', { name: /Tier/ })).getByRole('button'));
    await waitFor(() => expect(bizOrders()[0]).toEqual(['subscription_tier', { ascending: false, nullsFirst: false }]));
    expect(screen.getByRole('columnheader', { name: /Tier/ })).toHaveAttribute('aria-sort', 'descending');
    // Joined allowance columns are not offered for sorting on a server-paged list.
    expect(within(screen.getByRole('columnheader', { name: /Remaining/ })).queryByRole('button')).toBeNull();
  });
});
