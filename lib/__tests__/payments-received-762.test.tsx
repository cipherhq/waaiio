// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { method: string; args: unknown[] };
type Result = { data: Record<string, unknown>[] | null; count: number | null; error: { message: string } | null };
const state = vi.hoisted(() => ({
  queries: [] as Array<Array<{ method: string; args: unknown[] }>>,
  respond: vi.fn(),
  push: vi.fn(),
  params: new URLSearchParams(),
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
      for (const method of ['select', 'eq', 'is', 'not', 'ilike', 'order', 'range']) {
        chain[method] = (...args: unknown[]) => { calls.push({ method, args }); return chain; };
      }
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve().then(() => state.respond(calls)).then(resolve, reject);
      return chain;
    },
  }),
}));
import PaymentsReceivedPage from '@/app/dashboard/payments/page';

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-fixture', amount: 1200, currency: 'NGN', gateway: 'paystack',
    gateway_reference: 'gateway-fixture', payment_method: 'bank_transfer', status: 'success',
    paid_at: '2026-10-01T12:00:00Z', created_at: '2026-10-01T11:00:00Z',
    booking_id: 'booking-fixture', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null,
    bookings: {
      guest_name: 'Fixture Customer', guest_phone: '+15555550100', flow_type: 'payment',
      channel: 'whatsapp', payment_source: 'payment_request', reference_code: 'BOOK-FIXTURE', notes: 'Fixture note',
    },
    ...overrides,
  };
}
function success(rows: Record<string, unknown>[] = [payment()], count = rows.length): Result {
  return { data: rows, count, error: null };
}
function latest() { return state.queries[state.queries.length - 1]; }
function assertQuery(calls: Call[], inner = false, from = 0, to = 24) {
  expect(calls).toContainEqual({ method: 'from', args: ['payments'] });
  expect(calls).toContainEqual({ method: 'eq', args: ['business_id', 'business-fixture'] });
  expect(calls).toContainEqual({ method: 'eq', args: ['status', 'success'] });
  expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
  const select = calls.find(call => call.method === 'select')!;
  expect(select.args[0]).toBe(
    'id, amount, currency, gateway, gateway_reference, payment_method, status, paid_at, created_at, booking_id, invoice_id, campaign_id, reservation_id, order_id, bookings!payments_reservation_id_fkey' +
    (inner ? '!inner' : '') + '(guest_name, guest_phone, flow_type, channel, payment_source, reference_code, notes)',
  );
  expect(select.args[1]).toEqual({ count: 'exact' });
  expect(calls.filter(call => call.method === 'order')).toEqual([
    { method: 'order', args: ['paid_at', { ascending: false, nullsFirst: false }] },
    { method: 'order', args: ['created_at', { ascending: false }] },
    { method: 'order', args: ['id', { ascending: false }] },
  ]);
  expect(calls).toContainEqual({ method: 'range', args: [from, to] });
}
beforeEach(() => {
  state.queries = [];
  state.params = new URLSearchParams();
  state.push.mockReset();
  state.respond.mockReset().mockResolvedValue(success());
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('W22 Payments Received mounted page', () => {
  it('renders the outgoing booking object in the row and detail modal', async () => {
    render(<PaymentsReceivedPage />);
    const row = await screen.findByRole('button', { name: /View payment from Fixture Customer/ });
    assertQuery(latest());
    expect(within(row).getByText('+15555550100')).toBeTruthy();
    expect(within(row).getByText('WhatsApp')).toBeTruthy();
    expect(within(row).getByText('BOOK-FIXTURE')).toBeTruthy();
    fireEvent.click(row);
    const modal = screen.getByRole('dialog');
    for (const text of ['Fixture Customer', '+15555550100', 'WhatsApp', 'BOOK-FIXTURE', 'Fixture note', 'gateway-fixture', 'bank transfer']) {
      expect(within(modal).getByText(text)).toBeTruthy();
    }
    fireEvent.click(within(modal).getByRole('button', { name: 'Close payment details' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps successful booking-less payments visible under All', async () => {
    state.respond.mockResolvedValue(success([payment({ booking_id: null, bookings: null, invoice_id: 'invoice-fixture' })]));
    render(<PaymentsReceivedPage />);
    const row = await screen.findByRole('button', { name: /View payment from Customer/ });
    assertQuery(latest());
    expect(within(row).getByText('Invoice')).toBeTruthy();
    fireEvent.click(row);
    const modal = screen.getByRole('dialog');
    expect(within(modal).getByText('Customer', { selector: 'span.font-medium' })).toBeTruthy();
    expect(within(modal).queryByText('Contact')).toBeNull();
    expect(within(modal).queryByText('Note')).toBeNull();
  });

  it.each([
    ['Requests', 'payment_request', 'Payment Request'],
    ['Subscriptions', 'subscription', 'Subscription'],
    ['Bookings', 'booking', 'Booking'],
    ['Events', 'event', 'Event'],
  ])('uses the outgoing inner relationship and renders %s', async (button, source, label) => {
    const row = payment();
    state.respond.mockResolvedValue(success([{
      ...row, bookings: { ...(row.bookings as object), channel: 'dashboard', payment_source: source },
    }]));
    render(<PaymentsReceivedPage />);
    await screen.findByRole('button', { name: /View payment from/ });
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => {
      assertQuery(latest(), true);
      expect(latest()).toContainEqual({ method: 'eq', args: ['bookings.payment_source', source] });
    });
    expect(within(screen.getByRole('button', { name: /View payment from/ })).getByText(label)).toBeTruthy();
  });

  it.each([['Invoices', 'invoice_id'], ['Orders', 'order_id']])('keeps the left relationship for %s', async (button, column) => {
    render(<PaymentsReceivedPage />);
    await screen.findByText('Fixture Customer');
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => {
      assertQuery(latest());
      expect(latest()).toContainEqual({ method: 'not', args: [column, 'is', null] });
    });
    expect(latest().some(call => call.args[0] === 'bookings.payment_source')).toBe(false);
  });

  it('renders legacy source classification from the booking object', async () => {
    const row = payment();
    state.respond.mockResolvedValue(success([{
      ...row, bookings: { ...(row.bookings as object), payment_source: null, flow_type: 'ticketing' },
    }]));
    render(<PaymentsReceivedPage />);
    const rendered = await screen.findByRole('button', { name: /View payment from/ });
    expect(within(rendered).getByText('Event')).toBeTruthy();
  });

  it('shows the existing empty state only after a successful zero-row result', async () => {
    state.respond.mockResolvedValue(success([]));
    render(<PaymentsReceivedPage />);
    expect(await screen.findByText('No payments received yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it.each(['query error', 'network rejection'])('shows %s and recovers through Retry without an empty state', async mode => {
    if (mode === 'query error') {
      state.respond.mockResolvedValueOnce({ data: null, count: null, error: { message: 'Query failed' } });
    } else {
      state.respond.mockRejectedValueOnce(new Error('Network failed'));
    }
    render(<PaymentsReceivedPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed to load payments');
    expect(screen.queryByText('No payments received yet')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByText('Fixture Customer');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('No payments received yet')).toBeNull();
  });

  it('preserves count, page range and page-size reset', async () => {
    state.params = new URLSearchParams('page=2');
    state.respond.mockResolvedValue(success([payment()], 60));
    const view = render(<PaymentsReceivedPage />);
    await screen.findByText('Showing 26–50 of 60');
    assertQuery(latest(), false, 25, 49);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(state.push).toHaveBeenLastCalledWith('/dashboard/payments?page=3');
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '50' } });
    expect(state.push).toHaveBeenLastCalledWith('/dashboard/payments?');
    state.params = new URLSearchParams();
    view.rerender(<PaymentsReceivedPage />);
    await waitFor(() => assertQuery(latest(), false, 0, 49));
  });

  it('preserves debounced escaped reference search', async () => {
    render(<PaymentsReceivedPage />);
    await screen.findByText('Fixture Customer');
    vi.useFakeTimers();
    fireEvent.change(screen.getByPlaceholderText('Search by name, phone, or reference...'), { target: { value: 'ref%_' } });
    expect(latest().some(call => call.method === 'ilike')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(latest()).toContainEqual({ method: 'ilike', args: ['gateway_reference', '%ref\\%\\_%'] });
    assertQuery(latest());
  });

  it.each(['success', 'query error', 'network rejection'])('ignores a stale %s after a newer filter result', async mode => {
    let finish!: (value: Result) => void;
    let fail!: (reason: Error) => void;
    const pending = new Promise<Result>((resolve, reject) => { finish = resolve; fail = reject; });
    state.respond.mockResolvedValueOnce(success()).mockReturnValueOnce(pending).mockResolvedValue(success([
      payment({ id: 'newer-payment', booking_id: null, bookings: null, order_id: 'order-fixture' }),
    ]));
    render(<PaymentsReceivedPage />);
    await screen.findByText('Fixture Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Requests' }));
    await waitFor(() => expect(state.respond).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
    await screen.findByRole('button', { name: /View payment from Customer.*Order/ });
    await act(async () => {
      if (mode === 'network rejection') fail(new Error('Late network failure'));
      else finish(mode === 'query error' ? { data: null, count: null, error: { message: 'Late query failure' } } : success());
      await pending.catch(() => undefined);
    });
    expect(screen.queryByText('Fixture Customer')).toBeNull();
    expect(screen.getByRole('button', { name: /View payment from Customer.*Order/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
