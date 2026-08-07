/**
 * Property occupancy helpers.
 *
 * The canonical reservation lifecycle uses `checked_in` (set by the check-in
 * API). Legacy data may still carry `in_progress`, so both values are treated
 * as "currently occupied".
 */

/** Reservation statuses that mean a guest is currently staying. */
export const OCCUPIED_STATUSES: ReadonlySet<string> = new Set([
  'checked_in',
  'in_progress', // legacy — kept for backward compatibility
]);

export type OccupancyStatus = 'vacant' | 'occupied' | 'blocked';

export interface OccupancyInput {
  reservations: { status: string }[];
  isDateBlocked: boolean;
}

/**
 * Derive the current occupancy status for a property.
 *
 * Priority: occupied (guest checked-in) > blocked (date blocked) > vacant.
 */
export function getOccupancyStatus(input: OccupancyInput): OccupancyStatus {
  const isOccupied = input.reservations.some(r => OCCUPIED_STATUSES.has(r.status));
  if (isOccupied) return 'occupied';
  if (input.isDateBlocked) return 'blocked';
  return 'vacant';
}
