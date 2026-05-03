import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { loadPlatformSettings } from '@/lib/platformSettings';

/**
 * Conversation Guard
 *
 * Enforces monthly conversation limits based on subscription tier.
 * Reads limits from platform_settings (admin-editable) with hardcoded fallbacks.
 *
 * A "conversation" = 1 unique customer 24h window (matches Meta billing).
 */

interface ConversationCheckResult {
  allowed: boolean;
  tier: string;
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Check if a business can send more messages this month.
 * Reads limits from platform_settings (admin-editable via Admin Console).
 */
export async function checkConversationLimit(
  supabase: SupabaseClient,
  businessId: string,
): Promise<ConversationCheckResult> {
  try {
    // Get business tier
    const { data: biz } = await supabase
      .from('businesses')
      .select('subscription_tier')
      .eq('id', businessId)
      .single();

    const tier = (biz?.subscription_tier || 'free') as 'free' | 'growth' | 'business';

    // Get limits from platform_settings (admin-editable)
    const settings = await loadPlatformSettings({ useServiceClient: true });
    const tierLimit = settings.conversation_limits[tier] ?? 200;

    // Get current month usage
    const monthKey = new Date().toISOString().slice(0, 7);
    const { data: usage } = await supabase
      .from('conversation_usage')
      .select('conversation_count')
      .eq('business_id', businessId)
      .eq('month_key', monthKey)
      .maybeSingle();

    const used = usage?.conversation_count || 0;

    return {
      allowed: used < tierLimit,
      tier,
      used,
      limit: tierLimit,
      remaining: Math.max(0, tierLimit - used),
    };
  } catch (err) {
    logger.error('[CONV-GUARD] Check failed:', (err as Error).message);
    // Fail-open: allow if check fails (don't block due to DB error)
    return { allowed: true, tier: 'unknown', used: 0, limit: 999999, remaining: 999999 };
  }
}

/**
 * Track an outbound message (bot response, broadcast, reminder, etc.)
 * Non-blocking — doesn't fail the request if tracking fails.
 */
export async function trackOutboundMessage(
  supabase: SupabaseClient,
  businessId: string,
  isTemplate: boolean = false,
): Promise<void> {
  try {
    await supabase.rpc('increment_message_usage', {
      p_business_id: businessId,
      p_direction: isTemplate ? 'template' : 'outbound',
      p_is_new_conversation: false,
    });
  } catch (err) {
    logger.error('[CONV-GUARD] Track outbound failed:', (err as Error).message);
  }
}

/**
 * Get the conversation limit exhausted message to send to customers.
 */
export function getConversationLimitMessage(): string {
  return 'This business has reached its monthly messaging limit. Please try again next month or contact the business directly.';
}

/**
 * Check if a business is within 80% of their limit (for dashboard warnings).
 */
export function isApproachingLimit(used: number, limit: number): boolean {
  if (limit >= 999999) return false;
  return used >= limit * 0.8;
}
