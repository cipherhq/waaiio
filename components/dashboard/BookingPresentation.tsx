'use client';

/**
 * Production-owned booking presentation logic.
 *
 * Extracted from app/dashboard/reservations/page.tsx for testability.
 * The page imports these; tests render them directly.
 */

import React from 'react';

// ── Types ──

export type BookingType = 'reservations' | 'bookings' | 'table_reservations';

export interface StatusAction {
  label: string;
  next: string;
  color: string;
}

export interface BookingSummary {
  flow_type: string | null;
  seating_resource_name: string | null;
  staff_name: string | null;
  status: string;
  _isReservation?: boolean;
}

// ── Action maps (canonical, used by the page) ──

export const schedulingActions: Record<string, StatusAction[]> = {
  pending: [
    { label: 'Confirm', next: 'confirmed', color: 'text-green-600 hover:bg-green-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  confirmed: [
    { label: 'Start', next: 'in_progress', color: 'text-blue-600 hover:bg-blue-50' },
    { label: 'No Show', next: 'no_show', color: 'text-red-600 hover:bg-red-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  in_progress: [
    { label: 'Complete', next: 'completed', color: 'text-gray-600 hover:bg-gray-50' },
  ],
};

export const tableReservationActions: Record<string, StatusAction[]> = {
  pending: [
    { label: 'Confirm', next: 'confirmed', color: 'text-green-600 hover:bg-green-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  confirmed: [
    { label: 'Seat', next: 'in_progress', color: 'text-blue-600 hover:bg-blue-50' },
    { label: 'No Show', next: 'no_show', color: 'text-red-600 hover:bg-red-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  in_progress: [
    { label: 'Complete', next: 'completed', color: 'text-gray-600 hover:bg-gray-50' },
  ],
};

export const reservationActions: Record<string, StatusAction[]> = {
  pending: [
    { label: 'Confirm', next: 'confirmed', color: 'text-green-600 hover:bg-green-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  confirmed: [
    { label: 'Check In', next: 'checked_in', color: 'text-blue-600 hover:bg-blue-50' },
    { label: 'No Show', next: 'no_show', color: 'text-red-600 hover:bg-red-50' },
    { label: 'Cancel', next: 'cancelled', color: 'text-red-600 hover:bg-red-50' },
  ],
  checked_in: [
    { label: 'Check Out', next: 'checked_out', color: 'text-gray-600 hover:bg-gray-50' },
  ],
  in_progress: [
    { label: 'Check Out', next: 'checked_out', color: 'text-gray-600 hover:bg-gray-50' },
  ],
};

/** Resolve actions per booking row type */
export function getActionsForBooking(b: BookingSummary): Record<string, StatusAction[]> {
  if (b._isReservation) return reservationActions;
  if (b.flow_type === 'table_reservation') return tableReservationActions;
  return schedulingActions;
}

// ── Column header logic ──

export function getColumnHeader(bookingType: BookingType): string {
  if (bookingType === 'reservations') return 'Property';
  if (bookingType === 'table_reservations') return 'Table / Seating';
  return 'Staff';
}

export function isLodgingTab(bookingType: BookingType): boolean {
  return bookingType === 'reservations';
}

// ── Row display ──

export function getRowResourceLabel(b: BookingSummary): string {
  if (b.flow_type === 'table_reservation') return b.seating_resource_name || '\u2014';
  return b.staff_name || '\u2014';
}

// ── Rendered tab component ──

interface BookingTabBarProps {
  hasScheduling: boolean;
  hasReservation: boolean;
  hasTableReservation: boolean;
  activeTab: BookingType;
  onSwitch: (tab: BookingType) => void;
}

export function BookingTabBar({ hasScheduling, hasReservation, hasTableReservation, activeTab, onSwitch }: BookingTabBarProps) {
  const tabs: Array<{ id: BookingType; label: string }> = [
    ...(hasScheduling ? [{ id: 'bookings' as const, label: 'Appointments' }] : []),
    ...(hasTableReservation ? [{ id: 'table_reservations' as const, label: 'Table Reservations' }] : []),
    ...(hasReservation ? [{ id: 'reservations' as const, label: 'Stays' }] : []),
  ];

  return (
    <div data-testid="booking-tab-bar" className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
      {tabs.map(t => (
        <button
          key={t.id}
          data-testid={`tab-${t.id}`}
          onClick={() => onSwitch(t.id)}
          className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
            activeTab === t.id ? 'border-brand text-brand' : 'border-transparent text-gray-500'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Column header row component ──

export function BookingColumnHeaders({ bookingType }: { bookingType: BookingType }) {
  const header = getColumnHeader(bookingType);
  const lodging = isLodgingTab(bookingType);

  return (
    <tr data-testid="column-headers">
      <th data-testid="col-resource">{header}</th>
      {lodging ? (
        <>
          <th data-testid="col-checkin">Check-in</th>
          <th data-testid="col-checkout">Check-out</th>
          <th data-testid="col-nights">Nights</th>
        </>
      ) : (
        <th data-testid="col-datetime">Date &amp; Time</th>
      )}
      <th data-testid="col-guests">Guests</th>
    </tr>
  );
}

// ── Booking row component ──

export function BookingRowDisplay({ booking }: { booking: BookingSummary }) {
  const resourceLabel = getRowResourceLabel(booking);
  const actions = getActionsForBooking(booking)[booking.status] || [];

  return (
    <div data-testid="booking-row">
      <span data-testid="row-resource">{resourceLabel}</span>
      <span data-testid="row-actions">
        {actions.map(a => (
          <button key={a.label} data-testid={`action-${a.label}`}>{a.label}</button>
        ))}
      </span>
    </div>
  );
}
