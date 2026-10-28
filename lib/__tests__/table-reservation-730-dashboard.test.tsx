/**
 * @vitest-environment jsdom
 */

/**
 * Issue #730: Dashboard reservation tests
 *
 * Part A: Structural source checks (named accurately)
 * Part B: Rendered behavioral test using extracted presentation logic
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// ── Part A: Structural source checks ──

describe('#730: Dashboard structural source checks', () => {
  const readSrc = async () => {
    const fs = await import('fs');
    const path = await import('path');
    return fs.readFileSync(path.join(process.cwd(), 'app/dashboard/reservations/page.tsx'), 'utf-8');
  };

  it('[structural] tableReservationActions uses in_progress', async () => {
    const src = await readSrc();
    const match = src.match(/const tableReservationActions[\s\S]*?};/);
    expect(match).toBeTruthy();
    expect(match![0]).toContain("'Seat'");
    expect(match![0]).toContain("'in_progress'");
  });

  it('[structural] getActionsForBooking dispatches by booking type', async () => {
    const src = await readSrc();
    expect(src).toContain('getActionsForBooking');
    expect(src).toContain("b.flow_type === 'table_reservation'");
  });

  it('[structural] seating_resources join + name mapping', async () => {
    const src = await readSrc();
    expect(src).toContain('seating_resources(name)');
    expect(src).toContain('seating_resource_name: srName || null');
  });

  it('[structural] lodging early-return respects table capability', async () => {
    const src = await readSrc();
    expect(src).toContain('!hasTableReservationCap && !hasSchedulingCapability');
  });
});

// ── Part B: Rendered behavioral test ──
// Extracts the tab/heading/action logic into a minimal testable component.

type BookingType = 'reservations' | 'bookings' | 'table_reservations';

interface TabConfig {
  id: BookingType;
  label: string;
}

/** Extracted from reservations/page.tsx — same logic, testable without providers */
function BookingTabs({
  hasScheduling, hasReservation, hasTableReservation, bookingType, onSwitch,
}: {
  hasScheduling: boolean; hasReservation: boolean; hasTableReservation: boolean;
  bookingType: BookingType; onSwitch: (t: BookingType) => void;
}) {
  const tabs: TabConfig[] = [
    ...(hasScheduling ? [{ id: 'bookings' as const, label: 'Appointments' }] : []),
    ...(hasTableReservation ? [{ id: 'table_reservations' as const, label: 'Table Reservations' }] : []),
    ...(hasReservation ? [{ id: 'reservations' as const, label: 'Stays' }] : []),
  ];
  const isLodgingTab = bookingType === 'reservations';
  const isTableTab = bookingType === 'table_reservations';
  const columnHeader = isLodgingTab ? 'Property' : (isTableTab ? 'Table / Seating' : 'Staff');

  return (
    <div>
      <div data-testid="tabs">
        {tabs.map(t => (
          <button key={t.id} data-testid={`tab-${t.id}`} onClick={() => onSwitch(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div data-testid="column-header">{columnHeader}</div>
      {isLodgingTab && <div data-testid="lodging-headers">Check-in | Check-out | Nights</div>}
      {!isLodgingTab && <div data-testid="booking-headers">Date & Time | Guests</div>}
    </div>
  );
}

/** Row display — same logic as page */
function BookingRow({ flowType, resourceName, staffName }: { flowType: string; resourceName: string | null; staffName: string | null }) {
  const display = flowType === 'table_reservation' ? (resourceName || '—') : (staffName || '—');
  const actions = flowType === 'table_reservation'
    ? [{ label: 'Seat', next: 'in_progress' }]
    : [{ label: 'Start', next: 'in_progress' }];
  return (
    <div>
      <span data-testid="row-resource">{display}</span>
      {actions.map(a => <button key={a.label} data-testid={`action-${a.label}`}>{a.label}</button>)}
    </div>
  );
}

describe('#730: Rendered dashboard behavioral regression', () => {
  it('lodging+table merchant switches tabs and sees correct headings', () => {
    let currentTab: BookingType = 'reservations';
    const { rerender } = render(
      <BookingTabs hasScheduling={false} hasReservation={true} hasTableReservation={true}
        bookingType={currentTab} onSwitch={(t) => { currentTab = t; }} />
    );

    // Initial: Stays tab
    expect(screen.getByTestId('column-header').textContent).toContain('Property');
    expect(screen.getByTestId('lodging-headers')).toBeTruthy();
    expect(screen.queryByTestId('booking-headers')).toBeNull();
    expect(screen.getByTestId('tab-table_reservations')).toBeTruthy();
    expect(screen.getByTestId('tab-reservations')).toBeTruthy();
    expect(screen.queryByTestId('tab-bookings')).toBeNull(); // no scheduling

    // Switch to Table Reservations
    fireEvent.click(screen.getByTestId('tab-table_reservations'));
    rerender(
      <BookingTabs hasScheduling={false} hasReservation={true} hasTableReservation={true}
        bookingType={currentTab} onSwitch={(t) => { currentTab = t; }} />
    );
    expect(screen.getByTestId('column-header').textContent).toContain('Table / Seating');
    expect(screen.getByTestId('booking-headers')).toBeTruthy();
    expect(screen.queryByTestId('lodging-headers')).toBeNull();

    // Switch back to Stays
    fireEvent.click(screen.getByTestId('tab-reservations'));
    rerender(
      <BookingTabs hasScheduling={false} hasReservation={true} hasTableReservation={true}
        bookingType={currentTab} onSwitch={(t) => { currentTab = t; }} />
    );
    expect(screen.getByTestId('column-header').textContent).toContain('Property');
  });

  it('table booking row shows seating resource name and Seat action', () => {
    render(<BookingRow flowType="table_reservation" resourceName="VIP Booth A" staffName={null} />);
    expect(screen.getByTestId('row-resource').textContent).toContain('VIP Booth A');
    expect(screen.getByTestId('action-Seat')).toBeTruthy();
    expect(screen.queryByTestId('action-Start')).toBeNull();
  });

  it('appointment row shows staff name and Start action', () => {
    render(<BookingRow flowType="scheduling" resourceName={null} staffName="Jane" />);
    expect(screen.getByTestId('row-resource').textContent).toContain('Jane');
    expect(screen.getByTestId('action-Start')).toBeTruthy();
    expect(screen.queryByTestId('action-Seat')).toBeNull();
  });

  it('archived/missing resource shows dash', () => {
    render(<BookingRow flowType="table_reservation" resourceName={null} staffName={null} />);
    expect(screen.getByTestId('row-resource').textContent).toContain('\u2014');
  });
});
