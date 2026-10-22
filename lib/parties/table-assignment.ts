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

  // Fetch unassigned guests with plus_ones (needed for attendee-weighted batching)
  const { data: unassigned } = await supabase
    .from('event_invites')
    .select('id, plus_ones')
    .eq('party_id', partyId)
    .eq('business_id', businessId)
    .is('table_id', null)
    .in('status', ['accepted', 'maybe', 'pending']);

  if (!unassigned || unassigned.length === 0) {
    return { success: true, assigned: 0, skipped: 0 };
  }

  // Build attendee-weighted guest list: each guest occupies 1 + plus_ones seats
  const guests = unassigned.map(g => ({
    id: g.id,
    weight: 1 + (g.plus_ones || 0),
  }));

  let totalAssigned = 0;
  const placed = new Set<string>();

  for (const table of tables) {
    // Count current table occupancy (attendee-weighted)
    const { data: tableInvites } = await supabase
      .from('event_invites')
      .select('plus_ones')
      .eq('table_id', table.id);
    const seated = (tableInvites || []).reduce(
      (sum: number, inv: { plus_ones: number }) => sum + 1 + (inv.plus_ones || 0), 0
    );

    let available = table.capacity - seated;
    if (available <= 0) continue;

    // Greedily select guests that fit within remaining capacity
    const batch: string[] = [];
    for (const guest of guests) {
      if (placed.has(guest.id)) continue;
      if (guest.weight <= available) {
        batch.push(guest.id);
        available -= guest.weight;
      }
    }

    if (batch.length === 0) continue;

    // Use bulk RPC for atomic assignment (DB triggers are final authority)
    const { data, error } = await supabase.rpc('bulk_assign_guests_to_table', {
      p_invite_ids: batch,
      p_table_id: table.id,
    });

    if (!error && data?.success) {
      for (const id of batch) placed.add(id);
      totalAssigned += data.assigned ?? batch.length;
    }
    // If RPC rejects the batch, skip this table and try the next one
  }

  const skipped = guests.length - totalAssigned;
  return { success: true, assigned: totalAssigned, skipped };
}
