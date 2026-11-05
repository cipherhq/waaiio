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

/** All new seating operations use a server-owned snapshot and atomic commit. */
export async function seatingRequest<T>(partyId: string, payload?: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/parties/' + encodeURIComponent(partyId) + '/seating', {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    cache: 'no-store',
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to update seating');
  return data as T;
}

/** Produce a preview only. Committing always requires a separate organizer action. */
export async function autoAssign(
  _supabase: SupabaseClient, partyId: string, _businessId: string, seed = Date.now() >>> 0,
): Promise<import('./seating-planner').SeatingPreview> {
  return seatingRequest(partyId, { op: 'preview', seed });
}
