// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
const state = vi.hoisted(() => ({
  business: { id: 'biz', category: 'other', country_code: 'NG', capabilities: ['scheduling'], flow_type: 'appointment' },
  rows: {} as Record<string, any[]>, updates: [] as any[], zero: false, refresh: undefined as undefined | (() => void),
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => state.business }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { hiddenStatuses: [], entityNamePlural: 'bookings', quantityLabel: 'Guests' } }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/CsvExportButton', () => ({ CsvExportButton: () => null }));
vi.mock('@/components/dashboard/BookingIntakePanel', () => ({ BookingIntakePanel: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: (table: string) => {
    const filters: Array<[string, unknown]> = []; let patch: any;
    const result = () => {
      if (patch) { state.updates.push({ table, filters, patch }); return { data: state.zero ? null : { id: filters.find(([key]) => key === 'id')?.[1] }, error: null }; }
      return { data: (state.rows[table] ?? []).filter(row => filters.every(([key, value]) => row[key] === value)), error: null };
    };
    const query: any = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      neq: () => query, order: () => query, limit: () => query, update: (value: any) => { patch = value; return query; },
      maybeSingle: async () => result(), then: (resolve: any) => Promise.resolve(result()).then(resolve) };
    return query;
  },
  channel: () => { const channel = { on: (_event: string, _filter: unknown, callback: () => void) => { state.refresh = callback; return channel; }, subscribe: () => channel }; return channel; }, removeChannel: vi.fn(),
}) }));
import BookingsPage from '../page';
const booking = (id: string) => ({ id, business_id: 'biz', reference_code: `REF-${id}`, guest_name: `Guest ${id}`, date: '2026-11-20', time: '14:00', status: 'confirmed', flow_type: 'appointment', party_size: 1, total_amount: 0, guest_phone: '2348000000000', created_at: '2026-11-01T00:00:00Z', deposit_status: 'pending', staff_id: null });
beforeEach(() => {
  state.business.capabilities = ['scheduling']; state.business.flow_type = 'appointment';
  state.rows = { bookings: [booking('one'), booking('two')] }; state.updates = []; state.zero = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function ready() { render(<BookingsPage />); await screen.findByText('Guest one'); }
const cancellationRequests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/status'));
describe('Bookings page cancellation entrypoints', () => {
  it.each(['row', 'detail', 'bulk'])('%s cancellation waits for explicit confirmation', async path => {
    await ready();
    if (path === 'row') fireEvent.click(within(screen.getByText('Guest one').closest('tr')!).getByRole('button', { name: 'Cancel' }));
    if (path === 'detail') { fireEvent.click(screen.getByText('Guest one')); fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!); }
    if (path === 'bulk') { fireEvent.click(screen.getAllByRole('checkbox')[0]); fireEvent.click(screen.getByRole('button', { name: 'Cancel All' })); }
    expect(screen.getByRole('dialog')).toBeTruthy(); expect(cancellationRequests()).toHaveLength(0); expect(state.updates).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(cancellationRequests()).toHaveLength(path === 'bulk' ? 2 : 1);
    expect(cancellationRequests().every(([, options]) => JSON.parse(String(options?.body)).action === 'cancel')).toBe(true);
  });
  it('does not submit after safe dismissal or a denied cancellation response', async () => {
    await ready();
    const cancel = () => fireEvent.click(within(screen.getByText('Guest one').closest('tr')!).getByRole('button', { name: 'Cancel' }));
    cancel(); fireEvent.click(screen.getByRole('button', { name: 'Keep booking' }));
    expect(cancellationRequests()).toHaveLength(0);
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"denied"}', { status: 403 }));
    cancel(); fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Failed to update');
    expect(screen.getByRole('dialog')).toBeTruthy(); expect(cancellationRequests()).toHaveLength(1);
  });
  it('requires a returned reservation row, uses captured kind and scopes the cancellation to its business', async () => {
    state.business.capabilities = ['reservation']; state.business.flow_type = 'reservation';
    state.rows = { reservations: [{ ...booking('one'), check_in: '2026-11-20', check_out: '2026-11-21', nights: 1, guests: 1 }] };
    state.zero = true;
    await ready();
    fireEvent.click(within(screen.getByText('Guest one').closest('tr')!).getByRole('button', { name: 'Cancel' }));
    state.rows.reservations = [];
    await act(async () => { state.refresh?.(); });
    expect(screen.queryByText('Guest one')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    await screen.findByRole('alert');
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ table: 'reservations', patch: { status: 'cancelled' } });
    expect(state.updates[0].filters).toEqual(expect.arrayContaining([['id', 'one'], ['business_id', 'biz']]));
    expect(cancellationRequests()).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
