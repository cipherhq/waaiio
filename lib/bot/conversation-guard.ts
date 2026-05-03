import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

/**
 * Conversation Guard
 *
 * Enforces monthly conversation limits based on subscription tier.
 * Tracks outbound messages and blocks business-initiated messages
 * when the limit is reached.
 *
 * Limits:
 * - Free/Starter: 200 conversations/month
 * - Growth: 1,000 conversations/month
 * - Premium: 5,000 conversations/month (effectively unlimited for most businesses)
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
 * Uses the DB function check_conversation_limit for accuracy.
 */
export async function checkConversationLimit(
  supabase: SupabaseClient,
  businessId: string,
): Promise<ConversationCheckResult> {
  try {
    const { data, error } = await supabase.rpc('check_conversation_limit', {
      p_business_id: businessId,
    });

    if (error || !data || data.length === 0) {
      // If check fails, allow by default (don't block due to DB error)
      return { allowed: true, tier: 'unknown', used: 0, limit: 999999, remaining: 999999 };
    }

    const row = data[0];
    return {
      allowed: row.allowed,
      tier: row.tier || 'free',
      used: row.monthly_conversations || 0,
      limit: row.monthly_limit || 200,
      remaining: Math.max(0, (row.monthly_limit || 200) - (row.monthly_conversations || 0)),
    };
  } catch (err) {
    logger.error('[CONV-GUARD] Check failed:', (err as Error).message);
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
