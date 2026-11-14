import type { SupabaseClient } from '@supabase/supabase-js';

/** Business-local wall-clock timestamps, matching bookings.date + bookings.time. */
export interface SeatingHold {
  id: string;
  group_id: string;
  business_id: string;
  seating_resource_id: string;
  starts_at: string;
  ends_at: string;
  seats: number | null;
  whole_resource: boolean;
  label: string;
  released_at: string | null;
}

/** UTC arithmetic is used only as a coordinate for local calendar fields. */
function localCoordinate(value: string): number {
  return Date.parse(`${value.replace(' ', 'T').slice(0, 19)}Z`);
}

export function seatsAvailableDuring(
  holds: SeatingHold[], capacity: number, start: string, durationMinutes: number,
): number {
  const from = localCoordinate(start);
  const until = from + durationMinutes * 60_000;
  const overlapping = holds.filter(h => !h.released_at)
    .map(h => ({ start: localCoordinate(h.starts_at), end: localCoordinate(h.ends_at), seats: h.whole_resource ? capacity : h.seats! }))
    .filter(h => h.start < until && h.end > from);
  const boundaries = [from, ...overlapping.map(h => Math.max(from, h.start))];
  const peak = Math.max(0, ...boundaries.map(at => overlapping
    .filter(h => h.start <= at && h.end > at)
    .reduce((sum, h) => sum + h.seats, 0)));
  return Math.max(0, capacity - peak);
}

export async function loadSeatingHolds(
  supabase: SupabaseClient, businessId: string, resourceId: string, from: string, until: string,
): Promise<SeatingHold[]> {
  const holds: SeatingHold[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('seating_holds')
      .select('id, group_id, business_id, seating_resource_id, starts_at, ends_at, seats, whole_resource, label, released_at')
      .range(offset, offset + pageSize - 1).order('id')
      .eq('business_id', businessId).eq('seating_resource_id', resourceId)
      .is('released_at', null).lt('starts_at', until).gt('ends_at', from);
    if (error) throw new Error('Unable to verify seating holds');
    const page = (data || []) as SeatingHold[];
    holds.push(...page);
    if (page.length < pageSize) return holds;
  }
}
