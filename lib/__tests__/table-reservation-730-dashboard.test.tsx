/**
 * @vitest-environment jsdom
 */

/**
 * Issue #730: Dashboard rendered regression tests
 *
 * Renders PRODUCTION components from components/dashboard/BookingPresentation.tsx.
 * These are the same components imported by app/dashboard/reservations/page.tsx.
 */

import { describe, it, expect } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  BookingTabBar,
  BookingColumnHeaders,
  BookingRowDisplay,
  getActionsForBooking,
  getColumnHeader,
  getRowResourceLabel,
  schedulingActions,
  tableReservationActions,
  reservationActions,
  type BookingType,
  type BookingSummary,
} from '@/components/dashboard/BookingPresentation';

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
});
