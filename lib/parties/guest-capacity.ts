/**
 * #1005 PR 3b: how many companions a party guest may bring, by the rules the database enforces
 * (M489: plus-ones allowed and at most max_plus_ones, default 3; M457: accepted, pending and maybe
 * guests plus their companions never exceed max_guests). The database stays the authority; this
 * only decides which guest counts to offer.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PartyGuestRules {
  allow_plus_ones?: boolean | null;
  max_plus_ones?: number | null;
  max_guests?: number | null;
}

/** Most companions this guest may bring. othersAttending excludes the guest's own invitation. */
export function maxPlusOnes(party: PartyGuestRules, othersAttending: number): number {
  if (!party.allow_plus_ones) return 0;
  let max = party.max_plus_ones ?? 3;
  if (party.max_guests && party.max_guests > 0) max = Math.min(max, party.max_guests - othersAttending - 1);
  return Math.max(0, Math.floor(max));
}

/** Guests who count against capacity on this party, excluding one invitation. Same count as M457. */
export async function countOtherAttendees(db: SupabaseClient, partyId: string, businessId: string, inviteId: string): Promise<number> {
  const { data, error } = await db.from('event_invites').select('plus_ones')
    .eq('party_id', partyId).eq('business_id', businessId).neq('id', inviteId)
    .in('status', ['accepted', 'pending', 'maybe']);
  if (error) throw new Error('Could not read party attendance.');
  return (data || []).reduce((sum: number, row: { plus_ones: number | null }) => sum + 1 + (row.plus_ones || 0), 0);
}
