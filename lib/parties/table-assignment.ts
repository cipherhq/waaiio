/**
 * Party table assignment logic — Phase B1-2 (#661)
 *
 * All assignments go through database RPCs that enforce:
 *   - Party membership (guest.party_id = table.party_id)
 *   - Business isolation (guest.business_id = table.business_id)
 *   - Capacity limits (FOR UPDATE serialization on party_tables row)
 *   - All-or-nothing bulk operations
 *
 * Direct UPDATE of event_invites.table_id is also protected by triggers.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface AssignmentResult {
  success: boolean;
  error?: string;
  assigned?: number;
  skipped?: number;
}

/**
 * Assign a single guest to a table via RPC.
 * The database trigger enforces capacity, party membership, and business isolation.
 */
export async function assignGuest(
  supabase: SupabaseClient,
  inviteId: string,
  tableId: string,
  seatNumber?: number,
): Promise<AssignmentResult> {
  const { data, error } = await supabase.rpc('assign_guest_to_table', {
    p_invite_id: inviteId,
    p_table_id: tableId,
    p_seat_number: seatNumber ?? null,
  });

  if (error) {
    return { success: false, error: `Assignment failed: ${error.message}` };
  }

  const result = data as { success: boolean; error?: string };
  if (!result.success) {
    return { success: false, error: result.error || 'Assignment denied' };
  }

  return { success: true, assigned: 1 };
}

/**
 * Unassign a guest from their table via RPC (pass null table_id).
 */
export async function unassignGuest(
  supabase: SupabaseClient,
  inviteId: string,
): Promise<AssignmentResult> {
  const { data, error } = await supabase.rpc('assign_guest_to_table', {
    p_invite_id: inviteId,
    p_table_id: null,
    p_seat_number: null,
  });

  if (error) {
    return { success: false, error: `Unassignment failed: ${error.message}` };
  }

  const result = data as { success: boolean; error?: string };
  if (!result.success) {
    return { success: false, error: result.error || 'Unassignment failed' };
  }

  return { success: true };
}

/**
 * Reassign a guest to a different table.
 * Capacity check on destination is enforced by the database trigger.
 */
export async function reassignGuest(
  supabase: SupabaseClient,
  inviteId: string,
  newTableId: string,
  newSeatNumber?: number,
): Promise<AssignmentResult> {
  return assignGuest(supabase, inviteId, newTableId, newSeatNumber);
}

/**
 * Bulk assign guests to a table via RPC.
 * All-or-nothing: if any guest violates constraints, entire batch rolls back.
 */
export async function bulkAssignByTag(
  supabase: SupabaseClient,
  partyId: string,
  tag: string,
  tableId: string,
): Promise<AssignmentResult> {
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

  const inviteIds = candidates.map(c => c.id);

  // Use bulk RPC — all-or-nothing with capacity enforcement
  const { data, error } = await supabase.rpc('bulk_assign_guests_to_table', {
    p_invite_ids: inviteIds,
    p_table_id: tableId,
  });

  if (error) {
    return { success: false, error: `Bulk assignment failed: ${error.message}` };
  }

  const result = data as { success: boolean; assigned?: number; error?: string };
  if (!result.success) {
    return { success: false, error: result.error || 'Bulk assignment denied' };
  }

  return { success: true, assigned: result.assigned ?? inviteIds.length, skipped: 0 };
}

/**
 * Auto-assign: distribute unassigned guests across tables with available capacity.
 * Each table assignment is a separate bulk RPC call.
 * Fills tables in sort_order.
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

  // Get current occupancy per table
  let totalAssigned = 0;
  let guestIdx = 0;

  for (const table of tables) {
    if (guestIdx >= unassigned.length) break;

    const { count } = await supabase
      .from('event_invites')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', table.id);

    const available = table.capacity - (count ?? 0);
    if (available <= 0) continue;

    // Take up to 'available' guests
    const batch = unassigned.slice(guestIdx, guestIdx + available).map(g => g.id);

    // Use bulk RPC for atomic assignment
    const { data, error } = await supabase.rpc('bulk_assign_guests_to_table', {
      p_invite_ids: batch,
      p_table_id: table.id,
    });

    if (!error && data?.success) {
      totalAssigned += data.assigned ?? batch.length;
      guestIdx += batch.length;
    }
    // If a table fails, skip it and try the next one
  }

  const skipped = unassigned.length - totalAssigned;
  return { success: true, assigned: totalAssigned, skipped };
}
