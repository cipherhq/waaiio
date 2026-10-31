/**
 * @vitest-environment jsdom
 */

/**
 * Issue #730: Dashboard rendered regression tests
 *
 * Renders PRODUCTION components from components/dashboard/BookingPresentation.tsx.
 * These are the same components imported by app/dashboard/reservations/page.tsx.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import {
  BookingTabBar,
  BookingColumnHeaders,
  BookingRowDisplay,
  isTableReservationsTabRow,
  getActionsForBooking,
  getColumnHeader,
  getRowResourceLabel,
  schedulingActions,
  tableReservationActions,
  reservationActions,
  type BookingType,
  type BookingSummary,
} from '@/components/dashboard/BookingPresentation';

const pageFixture = vi.hoisted(() => ({
  business: {} as any,
  bookings: [] as any[],
  reservations: [] as any[],
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]>; select: string }>,
  writes: [] as Array<{ table: string; payload: any; filters: Array<[string, unknown]> }>,
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => pageFixture.business }));
vi.mock('@/hooks/useCategoryConfig', () => ({
  useCategoryConfig: () => ({ labels: {
    hiddenStatuses: [], entityNamePlural: 'bookings', quantityLabel: 'Guests', propertyName: 'Property',
  } }),
}));
vi.mock('@/components/dashboard/RefundModal', () => ({ RefundModal: () => null }));
vi.mock('@/components/dashboard/CsvExportButton', () => ({ CsvExportButton: () => null }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let payload: any;
      let selected = '';
      const q: any = {
        select: vi.fn((columns: string) => { selected = columns; return q; }),
        eq: vi.fn((key: string, value: unknown) => { filters.push([key, value]); return q; }),
        update: vi.fn((value: any) => { payload = value; return q; }),
        then(resolve: any, reject: any) {
          if (payload) {
            pageFixture.writes.push({ table, payload, filters: [...filters] });
            const rows = table === 'reservations' ? pageFixture.reservations : pageFixture.bookings;
            const id = filters.find(([key]) => key === 'id')?.[1];
            const row = rows.find(r => r.id === id);
            if (row) Object.assign(row, payload);
          } else {
            pageFixture.reads.push({ table, filters: [...filters], select: selected });
          }
          const data = table === 'bookings' ? pageFixture.bookings
            : table === 'reservations' ? pageFixture.reservations : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      for (const method of ['neq', 'order', 'limit', 'in', 'gte', 'lte', 'is']) q[method] = vi.fn(() => q);
      return q;
    },
    channel: () => {
      const channel: any = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: vi.fn(),
  }),
}));

import BookingsPage from '@/app/dashboard/reservations/page';

// ── Part A: Unit tests on exported production functions ──

describe('#730: Production booking presentation logic', () => {
  it('getActionsForBooking: table reservation → Seat action', () => {
    const b: BookingSummary = { flow_type: 'table_reservation', seating_resource_name: 'T1', staff_name: null, status: 'confirmed' };
    const actions = getActionsForBooking(b);
    expect(actions.confirmed?.[0].label).toBe('Seat');
    expect(actions.confirmed?.[0].next).toBe('in_progress');
  });

  it('getActionsForBooking: lodging → Check In action', () => {
    const b: BookingSummary = { flow_type: 'reservation', seating_resource_name: null, staff_name: null, status: 'confirmed', _isReservation: true };
    const actions = getActionsForBooking(b);
    expect(actions.confirmed?.[0].label).toBe('Check In');
  });

  it('getActionsForBooking: scheduling → Start action', () => {
    const b: BookingSummary = { flow_type: 'scheduling', seating_resource_name: null, staff_name: 'Jane', status: 'confirmed' };
    const actions = getActionsForBooking(b);
    expect(actions.confirmed?.[0].label).toBe('Start');
  });

  it('getColumnHeader by tab', () => {
    expect(getColumnHeader('reservations')).toBe('Property');
    expect(getColumnHeader('table_reservations')).toBe('Table / Seating');
    expect(getColumnHeader('bookings')).toBe('Staff');
  });

  it('getRowResourceLabel: table → resource name', () => {
    expect(getRowResourceLabel({ flow_type: 'table_reservation', seating_resource_name: 'VIP Booth', staff_name: null, status: 'confirmed' })).toBe('VIP Booth');
  });

  it('getRowResourceLabel: service → staff name', () => {
    expect(getRowResourceLabel({ flow_type: 'scheduling', seating_resource_name: null, staff_name: 'Alice', status: 'confirmed' })).toBe('Alice');
  });

  it('getRowResourceLabel: missing → dash', () => {
    expect(getRowResourceLabel({ flow_type: 'table_reservation', seating_resource_name: null, staff_name: null, status: 'confirmed' })).toBe('\u2014');
  });
});

// ── Part B: Rendered production component tests ──

describe('#730: Rendered production dashboard components', () => {
  afterEach(() => cleanup());

  it('BookingTabBar: lodging+table shows correct tabs', () => {
    render(
      <BookingTabBar hasScheduling={false} hasReservation={true} hasTableReservation={true}
        activeTab="reservations" onSwitch={() => {}} />
    );
    expect(screen.getByTestId('tab-reservations')).toBeTruthy();
    expect(screen.getByTestId('tab-table_reservations')).toBeTruthy();
    expect(screen.queryByTestId('tab-bookings')).toBeNull();
  });

  it('BookingTabBar: switching tabs calls onSwitch', () => {
    let switched: BookingType | null = null;
    render(
      <BookingTabBar hasScheduling={false} hasReservation={true} hasTableReservation={true}
        activeTab="reservations" onSwitch={(t) => { switched = t; }} />
    );
    fireEvent.click(screen.getByTestId('tab-table_reservations'));
    expect(switched).toBe('table_reservations');
  });

  it('BookingColumnHeaders: Stays tab shows Property/Check-in/Check-out', () => {
    render(<table><thead><BookingColumnHeaders bookingType="reservations" /></thead></table>);
    expect(screen.getByTestId('col-resource').textContent).toBe('Property');
    expect(screen.getByTestId('col-checkin')).toBeTruthy();
    expect(screen.getByTestId('col-checkout')).toBeTruthy();
    expect(screen.getByTestId('col-nights')).toBeTruthy();
    expect(screen.queryByTestId('col-datetime')).toBeNull();
  });

  it('BookingColumnHeaders: Table Reservations tab shows Table / Seating', () => {
    render(<table><thead><BookingColumnHeaders bookingType="table_reservations" /></thead></table>);
    expect(screen.getByTestId('col-resource').textContent).toBe('Table / Seating');
    expect(screen.getByTestId('col-datetime')).toBeTruthy();
    expect(screen.queryByTestId('col-checkin')).toBeNull();
  });

  it('BookingColumnHeaders: Appointments tab shows Staff', () => {
    render(<table><thead><BookingColumnHeaders bookingType="bookings" /></thead></table>);
    expect(screen.getByTestId('col-resource').textContent).toBe('Staff');
  });

  it('BookingRowDisplay: table reservation shows resource name + Seat', () => {
    render(<BookingRowDisplay booking={{ flow_type: 'table_reservation', seating_resource_name: 'Patio Table 3', staff_name: null, status: 'confirmed' }} />);
    expect(screen.getByTestId('row-resource').textContent).toBe('Patio Table 3');
    expect(screen.getByTestId('action-Seat')).toBeTruthy();
    expect(screen.queryByTestId('action-Start')).toBeNull();
    expect(screen.queryByTestId('action-Check In')).toBeNull();
  });

  it('BookingRowDisplay: scheduling shows staff name + Start', () => {
    render(<BookingRowDisplay booking={{ flow_type: 'scheduling', seating_resource_name: null, staff_name: 'Dr. Smith', status: 'confirmed' }} />);
    expect(screen.getByTestId('row-resource').textContent).toBe('Dr. Smith');
    expect(screen.getByTestId('action-Start')).toBeTruthy();
  });

  it('BookingRowDisplay: lodging reservation shows Check In', () => {
    render(<BookingRowDisplay booking={{ flow_type: 'reservation', seating_resource_name: null, staff_name: null, status: 'confirmed', _isReservation: true }} />);
    expect(screen.getByTestId('action-Check In')).toBeTruthy();
  });

  it('BookingRowDisplay: archived table resource shows dash', () => {
    render(<BookingRowDisplay booking={{ flow_type: 'table_reservation', seating_resource_name: null, staff_name: null, status: 'confirmed' }} />);
    expect(screen.getByTestId('row-resource').textContent).toBe('\u2014');
  });

  it('Full tab-switching regression: Stays ↔ Table Reservations', () => {
    function TestHarness() {
      const [tab, setTab] = useState<BookingType>('reservations');
      return (
        <div>
          <BookingTabBar hasScheduling={false} hasReservation={true} hasTableReservation={true} activeTab={tab} onSwitch={setTab} />
          <table><thead><BookingColumnHeaders bookingType={tab} /></thead></table>
        </div>
      );
    }

    render(<TestHarness />);

    // Initial: Stays
    expect(screen.getByTestId('col-resource').textContent).toBe('Property');
    expect(screen.getByTestId('col-checkin')).toBeTruthy();

    // Switch to Table Reservations
    fireEvent.click(screen.getByTestId('tab-table_reservations'));
    expect(screen.getByTestId('col-resource').textContent).toBe('Table / Seating');
    expect(screen.queryByTestId('col-checkin')).toBeNull();
    expect(screen.getByTestId('col-datetime')).toBeTruthy();

    // Switch back to Stays
    fireEvent.click(screen.getByTestId('tab-reservations'));
    expect(screen.getByTestId('col-resource').textContent).toBe('Property');
    expect(screen.getByTestId('col-checkin')).toBeTruthy();
  });

  it('table+stays without scheduling: badge matches displayed rows using production predicate', () => {
    // Scenario: table_reservation + reservation enabled, scheduling disabled.
    // Bookings: 1 table, 1 legacy scheduling, 1 stay
    const bookings = [
      { flow_type: 'table_reservation', _isReservation: false },
      { flow_type: 'scheduling', _isReservation: false },      // Legacy
      { flow_type: 'reservation', _isReservation: true },       // Stay
    ];

    const hasScheduling = false;

    // Table Reservations tab filter (production predicate)
    const tableTabRows = bookings.filter(b => isTableReservationsTabRow(b as any, hasScheduling));
    expect(tableTabRows.length).toBe(2); // Both table + legacy

    // Stays tab
    const staysRows = bookings.filter(b => b._isReservation);
    expect(staysRows.length).toBe(1);

    // Appointments tab should NOT exist (no scheduling capability)
    // Verify no rows are orphaned — all 3 bookings accounted for
    expect(tableTabRows.length + staysRows.length).toBe(3);

    // Badge count must equal displayed row count
    const badgeCount = bookings.filter(b => isTableReservationsTabRow(b as any, hasScheduling)).length;
    expect(badgeCount).toBe(tableTabRows.length);

    // Tab bar should NOT show Appointments
    const { container } = render(
      <BookingTabBar hasScheduling={false} hasReservation={true} hasTableReservation={true}
        activeTab="table_reservations" onSwitch={() => {}} />
    );
    expect(screen.queryByTestId('tab-bookings')).toBeNull();
    expect(screen.getByTestId('tab-table_reservations')).toBeTruthy();
    expect(screen.getByTestId('tab-reservations')).toBeTruthy();
    cleanup();
  });
});


// ── Part C: Actual route component, including loaders and mutations ──
describe('#731: actual BookingsPage', () => {
  function booking(id: string, flow_type = 'scheduling', extra: Record<string, unknown> = {}) {
    return {
      id, flow_type, reference_code: id.toUpperCase(), guest_name: id,
      guest_phone: '+15550000000', guest_email: '', date: '2020-01-07', time: '18:00',
      party_size: 4, status: 'confirmed', deposit_amount: 0, deposit_status: 'none',
      total_amount: 0, staff_id: null, staff_name: 'Staff One',
      payment_id: null, channel: 'whatsapp', created_at: '2020-01-01T00:00:00Z',
      seating_resource_id: flow_type === 'table_reservation' ? 'resource-a' : null,
      seating_resources: flow_type === 'table_reservation' ? { name: 'Patio A' } : null,
      ...extra,
    };
  }
  function stay(extra: Record<string, unknown> = {}) {
    return {
      ...booking('stay-one', 'reservation'),
      check_in: '2020-01-07', check_out: '2020-01-09', nights: 2, guests: 2,
      property: { name: 'Room One' }, ...extra,
    };
  }
  function tab(name: string) {
    return screen.getByRole('button', { name: new RegExp('^' + name + '\\s*\\d+$') });
  }
  function row(name: string) {
    return within(screen.getByRole('table')).getByText(name).closest('tr')!;
  }
  async function mount() {
    render(<BookingsPage />);
    await screen.findByRole('table');
  }

  beforeEach(() => {
    pageFixture.business = {
      id: 'business-a', name: 'Fixture Business', category: 'restaurant',
      flow_type: 'scheduling', country_code: 'NG', metadata: {},
      capabilities: ['scheduling', 'table_reservation', 'reservation'],
    };
    pageFixture.bookings = [booking('appointment-one'), booking('table-one', 'table_reservation')];
    pageFixture.reservations = [stay()];
    pageFixture.reads = [];
    pageFixture.writes = [];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads real scheduling, table and stay rows with matching tabs, headers, resources and badges', async () => {
    await mount();
    expect(tab('Appointments').textContent).toMatch(/Appointments\s*1/);
    expect(tab('Table Reservations').textContent).toMatch(/Table Reservations\s*1/);
    expect(tab('Stays').textContent).toMatch(/Stays\s*1/);
    expect(screen.getByRole('columnheader', { name: 'Staff' })).toBeTruthy();
    expect(within(row('appointment-one')).getByText('Staff One')).toBeTruthy();
    expect(within(row('appointment-one')).getByRole('button', { name: 'Start' })).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('table-one')).toBeNull();
    fireEvent.click(tab('Table Reservations'));
    expect(screen.getByRole('columnheader', { name: 'Table / Seating' })).toBeTruthy();
    expect(within(row('table-one')).getByText('Patio A')).toBeTruthy();
    expect(within(row('table-one')).getByRole('button', { name: 'Seat' })).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('appointment-one')).toBeNull();
    fireEvent.click(tab('Stays'));
    for (const name of ['Property', 'Check-in', 'Check-out', 'Nights']) expect(screen.getByRole('columnheader', { name })).toBeTruthy();
    expect(within(row('stay-one')).getByText('Room One')).toBeTruthy();
    expect(within(row('stay-one')).getByRole('button', { name: 'Check In' })).toBeTruthy();
    for (const table of ['bookings', 'reservations']) {
      expect(pageFixture.reads).toContainEqual(expect.objectContaining({ table, filters: expect.arrayContaining([['business_id', 'business-a']]) }));
    }
    expect(pageFixture.reads.find(r => r.table === 'bookings')?.select).toContain('seating_resources(name)');
  });

  it.each([
    ['Appointments', 'appointment-one', 'Start', 'bookings', 'in_progress', 'seated_at'],
    ['Table Reservations', 'table-one', 'Seat', 'bookings', 'in_progress', 'seated_at'],
    ['Stays', 'stay-one', 'Check In', 'reservations', 'checked_in', 'checked_in_at'],
  ])('%s action mutates the correct row and table', async (tabName, id, action, table, status, timestamp) => {
    await mount();
    fireEvent.click(tab(tabName));
    fireEvent.click(within(row(id)).getByRole('button', { name: action }));
    await waitFor(() => expect(pageFixture.writes).toHaveLength(1));
    expect(pageFixture.writes[0]).toEqual({
      table, payload: expect.objectContaining({ status, [timestamp]: expect.any(String) }),
      filters: [['id', id]],
    });
    if (action === 'Check In') {
      await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/reservations/notify-checkin', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ reservationId: id, businessId: 'business-a' }),
      })));
    } else expect(fetch).not.toHaveBeenCalled();
  });

  it('lodging-primary plus tables still loads and displays both data sources', async () => {
    pageFixture.business.flow_type = 'reservation';
    pageFixture.business.category = 'hotel';
    pageFixture.business.capabilities = ['reservation', 'table_reservation'];
    pageFixture.bookings = [booking('table-one', 'table_reservation')];
    await mount();
    expect(row('table-one')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Appointments/ })).toBeNull();
    expect(tab('Table Reservations').textContent).toMatch(/1$/);
    fireEvent.click(tab('Stays'));
    expect(row('stay-one')).toBeTruthy();
    expect(pageFixture.reads.some(r => r.table === 'bookings')).toBe(true);
    expect(pageFixture.reads.some(r => r.table === 'reservations')).toBe(true);
  });

  it('tables plus stays preserves legacy scheduling rows and badge count without an Appointments tab', async () => {
    pageFixture.business.capabilities = ['table_reservation', 'reservation'];
    await mount();
    expect(screen.queryByRole('button', { name: /^Appointments/ })).toBeNull();
    expect(tab('Table Reservations').textContent).toMatch(/2$/);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    expect(within(row('table-one')).getByRole('button', { name: 'Seat' })).toBeTruthy();
    expect(within(row('appointment-one')).getByRole('button', { name: 'Start' })).toBeTruthy();
    fireEvent.click(tab('Stays'));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    expect(row('stay-one')).toBeTruthy();
  });

  it.each([{ relation: null }, { relation: [] }, { relation: [{ name: 'Archived Patio' }] }])('handles missing or retained archived seating relations: $relation', async ({ relation }) => {
    pageFixture.bookings = [booking('table-one', 'table_reservation', { seating_resources: relation })];
    await mount();
    fireEvent.click(tab('Table Reservations'));
    expect(within(row('table-one')).getAllByRole('cell')[2].textContent).toBe(relation && relation.length ? 'Archived Patio' : '—');
    expect(within(row('table-one')).getByRole('button', { name: 'Seat' })).toBeTruthy();
  });

  it('table detail offers no reschedule while scheduling detail retains it', async () => {
    await mount();
    fireEvent.click(row('appointment-one'));
    expect(await screen.findByRole('button', { name: 'Reschedule' })).toBeTruthy();
    cleanup();
    await mount();
    fireEvent.click(tab('Table Reservations'));
    fireEvent.click(row('table-one'));
    await waitFor(() => expect(pageFixture.reads.some(r => r.table === 'payments')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('tab switch resets the existing client pagination without losing table rows', async () => {
    pageFixture.bookings = [
      ...Array.from({ length: 21 }, (_, i) => booking('appointment-' + i)),
      booking('table-one', 'table_reservation'),
    ];
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    fireEvent.click(tab('Table Reservations'));
    expect(row('table-one')).toBeTruthy();
    expect(screen.queryByText('Page 2 of 2')).toBeNull();
  });
});
