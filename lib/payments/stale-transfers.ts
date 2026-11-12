/**
 * Unused and overdue bank-transfer offers for bookings, reservations and invoices.
 * Orders are handled in SQL (apply_order_stock_once / cancel_stale_order_atomic).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TransferProofState {
  proof_protected?: boolean | null;
  proof_submitted_at?: string | null;
  proof_image_url?: string | null;
  proof_text?: string | null;
  expires_at?: string | null;
}

export interface TransferEntity {
  booking_id?: string | null;
  reservation_id?: string | null;
  invoice_id?: string | null;
}

const ENTITY_COLUMNS = ['booking_id', 'reservation_id', 'invoice_id'] as const;

function entityFilters(entity: TransferEntity): Array<[typeof ENTITY_COLUMNS[number], string]> {
  return ENTITY_COLUMNS
    .filter(col => !!entity[col])
    .map(col => [col, entity[col] as string]);
}

/**
 * A receipt the merchant must review: never expire or auto-cancel it
 * (contract #736 §5.4). Same rule as cancel_stale_order_atomic (M479):
 * already protected, a receipt submitted before the deadline, or a legacy
 * receipt with no submission time.
 */
export function hasProtectedProof(t: TransferProofState): boolean {
  if (t.proof_protected) return true;
  if (t.proof_submitted_at) {
    return !t.expires_at || new Date(t.proof_submitted_at) <= new Date(t.expires_at);
  }
  return !!(t.proof_image_url || t.proof_text);
}

/** True when the booking, reservation or invoice behind the transfer already has a successful payment. */
export async function hasSuccessfulPayment(supabase: SupabaseClient, entity: TransferEntity): Promise<boolean> {
  for (const [col, id] of entityFilters(entity)) {
    const { data, error } = await supabase
      .from('payments')
      .select('id')
      .eq(col, id)
      .eq('status', 'success')
      .limit(1);
    if (error) throw error;
    if (data && data.length > 0) return true;
  }
  return false;
}

/**
 * Close the unused bank-transfer offer once another payment has paid for the
 * booking, reservation or invoice. Owner decision (Option A, 2026-11-12): a
 * transfer with any receipt stays pending, so the merchant sees a possible
 * double payment and can refund it.
 */
export async function supersedeUnusedTransfers(supabase: SupabaseClient, entity: TransferEntity): Promise<void> {
  for (const [col, id] of entityFilters(entity)) {
    const { error } = await supabase
      .from('pending_transfers')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq(col, id)
      .eq('status', 'pending')
      .eq('proof_protected', false)
      .is('proof_submitted_at', null)
      .is('proof_image_url', null)
      .is('proof_text', null);
    if (error) throw error;
  }
}
