// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  rows: [] as Array<Record<string, any>>, fetch: vi.fn(), readError: false,
  writes: [] as Array<Record<string, unknown>>, operations: new Map<string, any>(),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ from: (table: string) => {
    const chain: Record<string, any> = {};
    let update: Record<string, unknown> | undefined;
    for (const method of ['select', 'eq', 'in', 'is', 'order', 'limit']) chain[method] = () => chain;
    chain.update = (payload: Record<string, unknown>) => { update = payload; return chain; };
    chain.then = (resolve: (value: unknown) => unknown) => {
      if (update && table === 'events') {
        mock.writes.push(update);
        Object.assign(mock.rows[0], update, { updated_at: '2026-03-01T00:00:00Z' });
      }
      return Promise.resolve({
        data: table === 'events' ? mock.rows.map(row => ({ ...row })) : [],
        error: table === 'events' && !update && mock.readError ? { message: 'read failed' } : null,
      }).then(resolve);
    };
    return chain;
  } }),
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'biz', name: 'Business', country_code: 'NG' }) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (value: number) => '₦' + value }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/image', () => ({ default: (props: any) => <img alt={props.alt} /> }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => <div /> }));
vi.mock('@/components/dashboard/EmptyState', () => ({ default: () => <div>No events</div> }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/ui/PlacesAutocomplete', () => ({ default: (props: any) => <input aria-label="Venue" value={props.value} onChange={event => props.onChange(event.target.value)} /> }));
vi.mock('@/lib/actions/event-persistence', () => ({ createEvent: vi.fn() }));
import EventsPage from '@/app/dashboard/events/page';

function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function commit(body: any) {
  Object.assign(mock.rows[0], body.changes, { updated_at: '2026-02-01T00:00:00Z' });
  const result = { committed: true, event: { ...mock.rows[0] }, cancelled: true, operation_id: body.operation_id,
    cancelled_tickets: 3, refunds_pending: 2, notifications: { accepted: 1, pending: 1, failed: 0, ambiguous: 1, total: 3 } };
  mock.operations.set(body.operation_id, result);
  return result;
}
beforeEach(() => {
  mock.rows = [{ id: 'event', business_id: 'biz', name: 'Concert', date: '2099-01-01', time: '19:30:00',
    venue: 'Hall', price: 50, status: 'published', total_tickets: 10, tickets_sold: 3,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }];
  mock.readError = false; mock.writes = []; mock.operations.clear();
  mock.fetch.mockReset().mockImplementation(async (url, init) => {
    if (!init) {
      const key = new URL(url, 'https://example.test').searchParams.get('operation_id')!;
      return mock.operations.has(key) ? reply(mock.operations.get(key)) : reply({ code: 'operation_not_found' }, 404);
    }
    return reply(commit(JSON.parse(init.body)));
  });
  vi.stubGlobal('fetch', mock.fetch);
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open() { fireEvent.click(await screen.findByText('Concert')); await screen.findByLabelText('Event status'); }
function cancel() {
  fireEvent.change(screen.getByLabelText('Event status'), { target: { value: 'cancelled' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
}
describe('#514 merchant cancellation UI', () => {
  it('submits one revision-bound permanent cancellation and reports follow-up separately from delivery', async () => {
    render(<EventsPage />); await open(); cancel();
    await screen.findByText(/Event cancelled permanently/);
    expect(mock.fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mock.fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ event_id: 'event', business_id: 'biz', expected_updated_at: '2026-01-01T00:00:00Z',
      changes: { name: 'Concert', date: '2099-01-01', time: '19:30:00', venue: 'Hall', price: 50, status: 'cancelled' } });
    expect(body.operation_id).toEqual(expect.any(String));
    expect(confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByLabelText('Event status')).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('no refund has been executed');
    expect(screen.getByRole('status').textContent).toContain('Acceptance does not confirm delivery');
    expect(mock.writes).toHaveLength(0);
  });
  it('retains the form on rejection and does not announce cancellation', async () => {
    mock.fetch.mockResolvedValue(reply({ error: 'Event changed; refresh first' }, 409));
    render(<EventsPage />); await open(); cancel();
    await screen.findByText('Event changed; refresh first');
    expect(screen.getByLabelText('Event status')).toBeTruthy();
    expect(mock.rows[0].status).toBe('published');
  });
  it('reads back a committed lost response without resending cancellation', async () => {
    mock.fetch.mockImplementationOnce(async (_url, init) => { commit(JSON.parse(init.body)); throw new Error('response lost'); });
    render(<EventsPage />); await open(); cancel();
    fireEvent.click(await screen.findByRole('button', { name: 'Check cancellation outcome' }));
    await waitFor(() => expect(screen.queryByLabelText('Event status')).toBeNull());
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    expect(mock.fetch.mock.calls[1][1]).toBeUndefined();
    expect(mock.fetch.mock.calls[1][0]).toContain('operation_id=');
  });
  it('replays the original request only after operation-not-found readback', async () => {
    mock.fetch.mockRejectedValueOnce(new Error('network'));
    render(<EventsPage />); await open(); cancel();
    fireEvent.click(await screen.findByRole('button', { name: 'Check cancellation outcome' }));
    await waitFor(() => expect(mock.fetch).toHaveBeenCalledTimes(3));
    expect(mock.fetch.mock.calls[2][1].body).toBe(mock.fetch.mock.calls[0][1].body);
  });
  it('keeps a committed cancellation distinct from a failed refresh', async () => {
    mock.fetch.mockImplementationOnce(async (_url, init) => { const result = commit(JSON.parse(init.body)); mock.readError = true; return reply(result); });
    render(<EventsPage />); await open(); cancel();
    await screen.findByText(/Saved, but the latest record could not be verified/);
    mock.readError = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh cancelled event' }));
    await waitFor(() => expect(screen.queryByLabelText('Event status')).toBeNull());
    expect(mock.fetch).toHaveBeenCalledOnce();
  });
  it('does not issue cancellation after declined confirmation', async () => {
    vi.mocked(confirm).mockReturnValue(false);
    render(<EventsPage />); await open(); cancel();
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.rows[0].status).toBe('published');
  });
  it('keeps cancelled status terminal while ordinary detail correction uses the existing save path', async () => {
    mock.rows[0].status = 'cancelled';
    render(<EventsPage />); await open();
    const status = screen.getByLabelText('Event status') as HTMLSelectElement;
    expect(status.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Corrected concert' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mock.writes).toHaveLength(1));
    expect(mock.writes[0]).toMatchObject({ name: 'Corrected concert', status: 'cancelled' });
    expect(mock.fetch).not.toHaveBeenCalled();
  });
});
