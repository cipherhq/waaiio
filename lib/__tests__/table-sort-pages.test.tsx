// @vitest-environment jsdom
/**
 * Owner request (2026-11-17): click a column header to sort, click again to reverse.
 * Payments Received is paged on the server, so a header click must re-query with a
 * whitelisted .order() and go back to page 1, never re-order just the visible page.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { method: string; args: unknown[] };
const state = vi.hoisted(() => ({
  queries: [] as Call[][],
  push: vi.fn(),
  params: new URLSearchParams('page=3'),
  fixtures: {} as Record<string, { data: unknown[]; count: number }>,
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => state.params,
  useRouter: () => ({ push: state.push }),
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'business-fixture', country_code: 'NG' }),
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const calls: Call[] = [{ method: 'from', args: [table] }];
      state.queries.push(calls);
      const chain: Record<string, (...args: any[]) => any> = {};
      for (const method of ['select', 'eq', 'is', 'not', 'ilike', 'or', 'order', 'range']) {
        chain[method] = (...args: unknown[]) => { calls.push({ method, args }); return chain; };
      }
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(state.fixtures[table] ? { ...state.fixtures[table], error: null } : {
          data: [{
            id: 'payment-fixture', amount: 1200, currency: 'NGN', gateway: 'paystack', gateway_reference: 'g',
            payment_method: 'card', status: 'success', paid_at: '2026-10-01T12:00:00Z', created_at: '2026-10-01T11:00:00Z',
            booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, bookings: null,
          }],
          count: 80,
          error: null,
        }).then(resolve, reject);
      return chain;
    },
  }),
}));
import PaymentsReceivedPage from '@/app/dashboard/payments/page';
import TicketsPage from '@/app/dashboard/tickets/page';
import GrowthContactsPage from '@/app/dashboard/growth/contacts/page';

const orders = () => state.queries[state.queries.length - 1].filter(c => c.method === 'order').map(c => c.args);

beforeEach(() => { state.queries = []; state.fixtures = {}; state.push.mockReset(); });
afterEach(cleanup);

describe('dashboard Payments Received server-side sorting', () => {
  it('keeps the default newest-first order until a header is clicked', async () => {
    render(<PaymentsReceivedPage />);
    await screen.findByText('Payments');
    expect(orders()[0]).toEqual(['paid_at', { ascending: false, nullsFirst: false }]);
    expect(screen.getByRole('columnheader', { name: /Amount/ }).getAttribute('aria-sort')).toBeNull();
  });

  it('re-queries by the whitelisted column, reverses on a second click and returns to page 1', async () => {
    render(<PaymentsReceivedPage />);
    await screen.findByText('Payments');
    const amount = screen.getByRole('columnheader', { name: /Amount/ });

    fireEvent.click(within(amount).getByRole('button'));
    await waitFor(() => expect(orders()).toEqual([
      ['amount', { ascending: true, nullsFirst: false }],
      ['id', { ascending: false }],
    ]));
    expect(amount.getAttribute('aria-sort')).toBe('ascending');
    expect(state.push).toHaveBeenCalledWith('/dashboard/payments?');

    fireEvent.click(within(amount).getByRole('button'));
    await waitFor(() => expect(orders()[0]).toEqual(['amount', { ascending: false, nullsFirst: false }]));
    expect(amount.getAttribute('aria-sort')).toBe('descending');

    fireEvent.click(within(screen.getByRole('columnheader', { name: /Paid/ })).getByRole('button'));
    await waitFor(() => expect(orders()[0]).toEqual(['paid_at', { ascending: true, nullsFirst: false }]));
  });

  it('does not offer sorting on joined or derived columns', async () => {
    render(<PaymentsReceivedPage />);
    await screen.findByText('Payments');
    for (const name of [/Customer/, /Source/, /Reference/]) {
      expect(within(screen.getByRole('columnheader', { name })).queryByRole('button')).toBeNull();
    }
  });
});

describe('dashboard Tickets client-side sorting', () => {
  beforeEach(() => {
    const t = (code: string, guest: string | null, num: number | null, scanned: string | null) => ({
      id: code, ticket_code: code, ticket_number: num, guest_name: guest, guest_phone: null, booking_id: null,
      status: 'valid', scanned_at: scanned, created_at: '2026-01-01T00:00:00Z', event_id: 'e1', business_id: 'business-fixture',
      event: { name: 'Gala', date: '2026-02-01', venue: null },
    });
    state.fixtures.event_tickets = { count: 4, data: [
      t('T-1', 'bola', 10, '2026-05-02T09:00:00Z'),
      t('T-2', null, 2, null),
      t('T-3', 'Ada', 100, '2026-05-01T09:00:00Z'),
      t('T-4', 'chidi', null, '2026-05-03T09:00:00Z'),
    ] };
  });
  const codes = () => screen.getAllByRole('row').slice(1).map(r => r.querySelector('td')?.textContent);

  it('sorts ticket numbers by value, guests case-insensitively and dates by time; empties last', async () => {
    render(<TicketsPage />);
    await waitFor(() => expect(codes()).toEqual(['T-1', 'T-2', 'T-3', 'T-4']));
    const click = (name: RegExp) => fireEvent.click(within(screen.getByRole('columnheader', { name })).getByRole('button'));

    click(/Ticket #/);
    expect(codes()).toEqual(['T-2', 'T-1', 'T-3', 'T-4']);
    click(/Ticket #/);
    expect(codes()).toEqual(['T-3', 'T-1', 'T-2', 'T-4']);
    expect(screen.getByRole('columnheader', { name: /Ticket #/ }).getAttribute('aria-sort')).toBe('descending');

    click(/Guest/);
    expect(codes()).toEqual(['T-3', 'T-1', 'T-4', 'T-2']);

    click(/Scanned/);
    expect(codes()).toEqual(['T-3', 'T-1', 'T-4', 'T-2']);
    click(/Scanned/);
    expect(codes()).toEqual(['T-4', 'T-1', 'T-3', 'T-2']);
  });
});

describe('dashboard Growth Contacts server-side sorting', () => {
  beforeEach(() => {
    state.fixtures.growth_contacts = { count: 60, data: [{
      id: 'c1', first_name: 'Ada', last_name: 'Obi', phone: '+2348000000000', email: 'ada@example.test',
      tags: [], has_consent: true, opted_out: false, created_at: '2026-01-01T00:00:00Z',
    }] };
  });
  const contactOrders = () => state.queries.filter(q => q[0].args[0] === 'growth_contacts').at(-1)!
    .filter(c => c.method === 'order').map(c => c.args);

  it('orders on the server by whitelisted columns and leaves masked/derived columns unsortable', async () => {
    render(<GrowthContactsPage />);
    await screen.findAllByText('ada@example.test');
    expect(contactOrders()).toEqual([['created_at', { ascending: false }]]);

    fireEvent.click(within(screen.getByRole('columnheader', { name: /Name/ })).getByRole('button'));
    await waitFor(() => expect(contactOrders()).toEqual([
      ['first_name', { ascending: true, nullsFirst: false }],
      ['last_name', { ascending: true, nullsFirst: false }],
      ['id', { ascending: false }],
    ]));
    fireEvent.click(within(screen.getByRole('columnheader', { name: /Imported/ })).getByRole('button'));
    await waitFor(() => expect(contactOrders()[0]).toEqual(['created_at', { ascending: true, nullsFirst: false }]));

    for (const name of [/Phone/, /Tags/, /Consent/]) {
      expect(within(screen.getByRole('columnheader', { name })).queryByRole('button')).toBeNull();
    }
  });
});
