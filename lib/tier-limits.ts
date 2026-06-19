import type { SupabaseClient } from '@supabase/supabase-js';
import { TIER_TRANSACTION_LIMITS } from '@/lib/constants';

export type TierResourceType = 'bookings' | 'orders' | 'tickets' | 'giving' | 'invoices';

export interface TierLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
  /** Soft block: 100-120% usage — allow but warn owner */
  softBlock: boolean;
}

/**
 * Check whether a business has exceeded its tier transaction limit for a resource type.
 *
 * Returns:
 * - allowed=true, softBlock=false  => under limit
 * - allowed=true, softBlock=true   => 100-120% usage (grace zone, warn owner)
 * - allowed=false, softBlock=false  => over 120% (hard block)
 *
 * For tickets: counts per event (not per month). Pass eventId.
 * For giving: counts campaign_donations this month.
 * For invoices: counts invoices this month.
 */
export async function checkTierLimit(
  supabase: SupabaseClient,
  businessId: string,
  resourceType: TierResourceType,
  tier: string,
  eventId?: string,
): Promise<TierLimitResult> {
  const tierKey = tier || 'free';
  const tierLimits = TIER_TRANSACTION_LIMITS[tierKey] || TIER_TRANSACTION_LIMITS.free;

  // Map resource type to the correct limit key
  const limitKey = resourceType === 'tickets' ? 'tickets_per_event' : resourceType;
  const limit = tierLimits[limitKey];

  // Unlimited (-1) => always allowed
  if (limit === -1) {
    return { allowed: true, current: 0, limit: -1, softBlock: false };
  }

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartISO = monthStart.toISOString();

  let current = 0;

  switch (resourceType) {
    case 'bookings': {
      const { count } = await supabase
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('created_at', monthStartISO);
      current = count || 0;
      break;
    }
    case 'orders': {
      const { count } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .is('deleted_at', null)
        .gte('created_at', monthStartISO);
      current = count || 0;
      break;
    }
    case 'tickets': {
      if (!eventId) {
        return { allowed: true, current: 0, limit, softBlock: false };
      }
      const { data } = await supabase
        .from('events')
        .select('tickets_sold')
        .eq('id', eventId)
        .single();
      current = data?.tickets_sold || 0;
      break;
    }
    case 'giving': {
      const { count } = await supabase
        .from('campaign_donations')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('created_at', monthStartISO);
      current = count || 0;
      break;
    }
    case 'invoices': {
      const { count } = await supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('created_at', monthStartISO);
      current = count || 0;
      break;
    }
  }

  const ratio = current / limit;

  if (ratio < 1) {
    // Under limit
    return { allowed: true, current, limit, softBlock: false };
  } else if (ratio <= 1.2) {
    // Soft block: 100-120% — allow but warn
    return { allowed: true, current, limit, softBlock: true };
  } else {
    // Hard block: over 120%
    return { allowed: false, current, limit, softBlock: false };
  }
}
