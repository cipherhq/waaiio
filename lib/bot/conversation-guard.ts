import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { resolveLimitTier } from '@/lib/trial-status';
import { checkSpendCapPeriod, type SpendPeriod } from '@/lib/messaging/spend-cap-alerts';

/**
 * Conversation Guard
 *
 * Enforces monthly conversation limits based on subscription tier.
 * Reads limits from platform_settings (admin-editable) with hardcoded fallbacks.
 *
 * conversation_count is an internal analytics and soft rate-limiting metric.
 * It is NOT on the financial authorization path (authorize_message_send uses
 * messaging_allowances / messaging_spend_periods — separate tables and RPCs).
 *
 * "New conversation" detection uses a rolling 24-hour inactivity window based on
 * bot_sessions.updated_at. This is an approximation — not a proven equivalence to
 * Meta's fixed-window billing model. It may conservatively undercount for
 * long-running multi-hour sessions.
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
  /** BOT-PERF: pass known tier to skip redundant business fetch */
  knownTier?: string,
): Promise<ConversationCheckResult> {
  try {
    // Get business tier — skip DB fetch if already known from caller context
    let tier: 'free' | 'growth' | 'business';
    if (knownTier) {
      tier = knownTier as 'free' | 'growth' | 'business';
    } else {
      const { data: biz } = await supabase
        .from('businesses')
        .select('subscription_tier')
        .eq('id', businessId)
        .single();
      tier = (biz?.subscription_tier || 'free') as 'free' | 'growth' | 'business';
    }

    // Get limits from platform_settings (admin-editable)
    const settings = await loadPlatformSettings({ useServiceClient: true });
    // During the Pro/Premium feature trial a Starter business uses Premium limits.
    const limitTier = await resolveLimitTier(supabase, businessId, tier);
    const tierLimit = settings.conversation_limits[limitTier] ?? 200;

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
 * Track an inbound message from a customer.
 * Detects new conversations using a rolling 24h inactivity window
 * (internal analytics approximation — not proven Meta billing equivalence).
 * Non-blocking — doesn't fail the request if tracking fails.
 *
 * @param sessionUpdatedAt - The session's updated_at timestamp. If null or >24h old,
 *   this is counted as a new conversation.
 */
export async function trackInboundMessage(
  supabase: SupabaseClient,
  businessId: string,
  sessionUpdatedAt: string | null,
): Promise<void> {
  try {
    const isNew = isNewConversation(sessionUpdatedAt);
    await supabase.rpc('increment_message_usage', {
      p_business_id: businessId,
      p_direction: 'inbound',
      p_is_new_conversation: isNew,
    });
  } catch (err) {
    logger.error('[CONV-GUARD] Track inbound failed:', (err as Error).message);
  }
}

/**
 * Track an outbound message (bot response, broadcast, reminder, etc.)
 * Non-blocking — doesn't fail the request if tracking fails.
 *
 * @param isNewConv - Whether this outbound starts a new conversation (template-initiated).
 *   For bot replies to inbound messages, the inbound tracking already counted the conversation.
 */
export async function trackOutboundMessage(
  supabase: SupabaseClient,
  businessId: string,
  isTemplate: boolean = false,
  isNewConv: boolean = false,
): Promise<void> {
  try {
    await supabase.rpc('increment_message_usage', {
      p_business_id: businessId,
      p_direction: isTemplate ? 'template' : 'outbound',
      p_is_new_conversation: isNewConv,
    });
  } catch (err) {
    logger.error('[CONV-GUARD] Track outbound failed:', (err as Error).message);
  }
}

/**
 * Determine if a message starts a new conversation based on a rolling 24h
 * inactivity window. Uses bot_sessions.updated_at as the reference timestamp.
 * This is an internal analytics approximation — not a proven equivalence to
 * Meta's fixed-window billing model.
 */
export function isNewConversation(sessionUpdatedAt: string | null): boolean {
  if (!sessionUpdatedAt) return true;
  const lastActivity = new Date(sessionUpdatedAt).getTime();
  if (isNaN(lastActivity)) return true;
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  return Date.now() - lastActivity > twentyFourHoursMs;
}

/**
 * Get the conversation limit exhausted message to send to customers.
 */
export function getConversationLimitMessage(): string {
  return 'This business has reached its monthly messaging limit. Please try again next month or contact the business directly.';
}

/**
 * #682 / #992: Check messaging spend utilization after a bot send (also after a refused one)
 * and raise the merchant spend-cap alert (dashboard, plus email at 90% and 100%).
 * Non-blocking: never throws. The alert logic lives in lib/messaging/spend-cap-alerts.ts,
 * shared with the hourly messaging-spend-warnings cron.
 */
export async function checkSpendThresholds(
  supabase: SupabaseClient,
  businessId: string,
): Promise<void> {
  try {
    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);

    const { data: periods } = await supabase
      .from('messaging_spend_periods')
      .select('currency_code, cap_minor, reserved_minor, spent_minor, period_start')
      .eq('business_id', businessId)
      .eq('period_start', periodStart.toISOString());

    for (const period of (periods || []) as SpendPeriod[]) {
      await checkSpendCapPeriod(supabase, businessId, period);
    }
  } catch (err) {
    logger.error('[CONV-GUARD] Threshold check failed (non-critical):', (err as Error).message);
  }
}

/**
 * Check if a business is within 80% of their limit (for dashboard warnings).
 */
export function isApproachingLimit(used: number, limit: number): boolean {
  if (limit >= 999999) return false;
  return used >= limit * 0.8;
}
