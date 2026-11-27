/**
 * #1166 S1(b): mark a booking whose guest email was just proved with a
 * one-time code, so the admin's email list can label it "Proved with a code".
 *
 * Service role only (the M559 trigger refuses any other database role). The
 * first proof is kept. A failed write is logged without the address and never
 * affects the checkout: the mark only changes an admin label.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export async function markBookingEmailVerified(db: SupabaseClient, bookingId: string, route: string): Promise<void> {
  try {
    const { error } = await db.from('bookings')
      .update({ email_verified_at: new Date().toISOString() })
      .eq('id', bookingId)
      .is('email_verified_at', null);
    if (error) throw new Error(error.message);
  } catch {
    logger.withContext({ op: 'customer_block.email_proof_not_saved', route }).warn('customer_block.email_proof_not_saved');
  }
}
