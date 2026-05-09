import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

interface MembershipTier {
  id: string;
  name: string;
  min_spend: number;
  discount_percent: number;
  points_multiplier: number;
}

/**
 * Evaluate and assign the correct membership tier for a customer
 * based on their lifetime spend.
 *
 * Call this after payment completion or order completion.
 */
export async function assignCustomerTier(
  supabase: SupabaseClient,
  businessId: string,
  customerId: string,
): Promise<MembershipTier | null> {
  try {
    // 1. Get customer's total_spent
    const { data: customer, error: custErr } = await supabase
      .from('customer_profiles')
      .select('id, total_spent, membership_tier_id')
      .eq('id', customerId)
      .eq('business_id', businessId)
      .single();

    if (custErr || !customer) {
      logger.warn('[MEMBERSHIP] Customer not found', { businessId, customerId, error: custErr });
      return null;
    }

    // 2. Get business tiers ordered by min_spend DESC (highest first)
    const { data: tiers, error: tierErr } = await supabase
      .from('membership_tiers')
      .select('id, name, min_spend, discount_percent, points_multiplier')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('min_spend', { ascending: false });

    if (tierErr || !tiers || tiers.length === 0) {
      return null;
    }

    // 3. Find the highest tier the customer qualifies for
    const totalSpent = Number(customer.total_spent) || 0;
    const qualifiedTier = tiers.find((t) => totalSpent >= Number(t.min_spend)) || null;

    // 4. Update if tier changed
    const newTierId = qualifiedTier?.id || null;
    if (newTierId !== customer.membership_tier_id) {
      await supabase
        .from('customer_profiles')
        .update({
          membership_tier_id: newTierId,
          tier_earned_at: newTierId ? new Date().toISOString() : null,
        })
        .eq('id', customerId);

      logger.info('[MEMBERSHIP] Tier updated', {
        customerId,
        businessId,
        oldTier: customer.membership_tier_id,
        newTier: newTierId,
        tierName: qualifiedTier?.name,
      });
    }

    return qualifiedTier;
  } catch (err) {
    logger.error('[MEMBERSHIP] Failed to assign tier', err);
    return null;
  }
}
