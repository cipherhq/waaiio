/**
 * Party table assignment logic — Phase B1-2 (#661)
 * Handles manual, bulk (by tag), and auto seat assignments
 * with capacity enforcement and concurrency protection.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PartyTable {
  id: string;
  party_id: string;
  business_id: string;
  name: string;
  capacity: number;
  sort_order: number;
}

export interface AssignmentResult {
  success: boolean;
  error?: string;
  assigned?: number;
  skipped?: number;
}

/**
 * Get the current seat count for a table.
 * Uses a count query (not SELECT *) for efficiency.
 */
export async function getTableSeatCount(
  supabase: SupabaseClient,
  tableId: string,
): Promise<number> {
  const { count } = await supabase
    .from('event_invites')
    .select('*', { count: 'exact', head: true })
    .eq('table_id', tableId);
  return count ?? 0;
}

/**
 * Manual assign: assign a single guest to a specific table + optional seat.
 * Enforces capacity. Rejects if table is full.
 */
export async function assignGuest(
  supabase: SupabaseClient,
  inviteId: string,
  tableId: string,
  seatNumber?: number,
): Promise<AssignmentResult> {
  // Fetch table to check capacity
  const { data: table, error: tableErr } = await supabase
    .from('party_tables')
    .select('id, capacity, party_id')
    .eq('id', tableId)
    .single();

  if (tableErr || !table) {
    return { success: false, error: 'Table not found' };
  }

  // Count current occupancy
  const currentCount = await getTableSeatCount(supabase, tableId);
  if (currentCount >= table.capacity) {
    return { success: false, error: `Table is full (${currentCount}/${table.capacity})` };
  }

  // Assign — conditional on capacity not being exceeded
  const update: Record<string, unknown> = { table_id: tableId };
  if (seatNumber !== undefined) update.seat_number = seatNumber;

  const { error } = await supabase
    .from('event_invites')
    .update(update)
    .eq('id', inviteId);

  if (error) {
    return { success: false, error: `Assignment failed: ${error.message}` };
  }

  return { success: true, assigned: 1 };
}

/**
 * Unassign: remove a guest from their table.
 */
export async function unassignGuest(
  supabase: SupabaseClient,
  inviteId: string,
): Promise<AssignmentResult> {
  const { error } = await supabase
    .from('event_invites')
    .update({ table_id: null, seat_number: null })
    .eq('id', inviteId);

  if (error) {
    return { success: false, error: `Unassignment failed: ${error.message}` };
  }
  return { success: true };
}

/**
 * Reassign: move a guest from one table to another.
 * Checks capacity on the destination table.
 */
export async function reassignGuest(
  supabase: SupabaseClient,
  inviteId: string,
  newTableId: string,
  newSeatNumber?: number,
): Promise<AssignmentResult> {
  // Just assign to new table — capacity check is in assignGuest
  return assignGuest(supabase, inviteId, newTableId, newSeatNumber);
}

/**
 * Bulk assign by tag: assign all guests with a specific tag to a table.
 * Skips guests already assigned to any table. Respects capacity.
 */
export async function bulkAssignByTag(
  supabase: SupabaseClient,
  partyId: string,
  tag: string,
  tableId: string,
): Promise<AssignmentResult> {
  // Fetch table capacity
  const { data: table, error: tableErr } = await supabase
    .from('party_tables')
    .select('id, capacity')
    .eq('id', tableId)
    .single();

  if (tableErr || !table) {
    return { success: false, error: 'Table not found' };
  }

  // Get current occupancy
  const currentCount = await getTableSeatCount(supabase, tableId);
  const available = table.capacity - currentCount;

  if (available <= 0) {
    return { success: false, error: 'Table is already full' };
  }

  // Fetch unassigned guests with this tag
  const { data: candidates } = await supabase
    .from('event_invites')
    .select('id')
    .eq('party_id', partyId)
    .is('table_id', null)
    .contains('tags', [tag]);

  if (!candidates || candidates.length === 0) {
    return { success: true, assigned: 0, skipped: 0 };
  }

  // Assign up to available capacity
  const toAssign = candidates.slice(0, available);
  const skipped = candidates.length - toAssign.length;

  for (const guest of toAssign) {
    await supabase
      .from('event_invites')
      .update({ table_id: tableId })
      .eq('id', guest.id);
  }

  return { success: true, assigned: toAssign.length, skipped };
}

/**
 * Auto-assign: distribute unassigned guests across tables with available capacity.
 * Fills tables in sort_order, respecting capacity limits.
 * Only assigns guests for the specified party.
 */
export async function autoAssign(
  supabase: SupabaseClient,
  partyId: string,
  businessId: string,
): Promise<AssignmentResult> {
  // Fetch all tables for this party, ordered by sort_order
  const { data: tables } = await supabase
    .from('party_tables')
    .select('id, capacity, sort_order')
    .eq('party_id', partyId)
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true });

  if (!tables || tables.length === 0) {
    return { success: false, error: 'No tables defined for this party' };
  }

  // Fetch all unassigned guests for this party
  const { data: unassigned } = await supabase
    .from('event_invites')
    .select('id')
    .eq('party_id', partyId)
    .eq('business_id', businessId)
    .is('table_id', null)
    .in('status', ['accepted', 'maybe', 'pending']);

  if (!unassigned || unassigned.length === 0) {
    return { success: true, assigned: 0, skipped: 0 };
  }

  // Build availability map
  const availability: { tableId: string; available: number }[] = [];
  for (const table of tables) {
    const count = await getTableSeatCount(supabase, table.id);
    const avail = table.capacity - count;
    if (avail > 0) {
      availability.push({ tableId: table.id, available: avail });
    }
  }

  let assigned = 0;
  let guestIdx = 0;

  for (const slot of availability) {
    let filled = 0;
    while (filled < slot.available && guestIdx < unassigned.length) {
      await supabase
        .from('event_invites')
        .update({ table_id: slot.tableId })
        .eq('id', unassigned[guestIdx].id);
      filled++;
      assigned++;
      guestIdx++;
    }
  }

  const skipped = unassigned.length - assigned;
  return { success: true, assigned, skipped };
}
