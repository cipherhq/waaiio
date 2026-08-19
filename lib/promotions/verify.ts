/**
 * Promo code verification service.
 *
 * This is the APPLICATION-LEVEL verification entry point.
 * It calls the ATOMIC claim_promo_code PostgreSQL function
 * which handles all locking, validation, and state transitions.
 *
 * This module handles:
 * - Code normalization
 * - Hashing for lookup
 * - Campaign resolution (keyword or bare-code routing)
 * - Calling the atomic claim function
 * - Formatting the response message
 */
import { createServiceClient } from '@/lib/supabase/service';
import { normalizePromoCode } from './normalize';
import { hashPromoCode } from './crypto';
import type { PromoClaimResult, PromoCampaign, PromoAttemptResult } from './types';

interface VerificationInput {
  businessId: string;
  rawCode: string;
  phoneE164: string;
  inboundMessageId?: string;
  keyword?: string; // If provided, routes to keyword campaign
}

interface VerificationResponse {
  result: PromoAttemptResult;
  message: string;
  claimReference?: string;
  prizeName?: string;
  eligibilityRequired?: boolean;
  eligibilityMode?: string;
  eligibilityPrompt?: string;
  campaignId?: string;
}

/**
 * Resolve which campaign a code submission should be verified against.
 *
 * Routing rules:
 * 1. If keyword provided → find active campaign with that keyword for this business
 * 2. If no keyword → find active bare-code campaign for this business
 * 3. Only one active bare-code campaign allowed per business (enforced by DB unique index)
 */
async function resolveCampaign(
  businessId: string,
  keyword?: string,
): Promise<PromoCampaign | null> {
  const supabase = createServiceClient();

  if (keyword) {
    const { data } = await supabase
      .from('promo_campaigns')
      .select('*')
      .eq('business_id', businessId)
      .ilike('keyword', keyword)
      .eq('status', 'active')
      .limit(1)
      .single();
    return data as PromoCampaign | null;
  }

  // Bare code mode: find the single active bare-code campaign
  const { data } = await supabase
    .from('promo_campaigns')
    .select('*')
    .eq('business_id', businessId)
    .eq('accept_bare_codes', true)
    .eq('status', 'active')
    .limit(1)
    .single();
  return data as PromoCampaign | null;
}

/**
 * Format response message using campaign templates.
 */
function formatResponseMessage(
  campaign: PromoCampaign,
  claimResult: PromoClaimResult,
): string {
  switch (claimResult.result) {
    case 'winner':
      return campaign.winner_message
        .replace('{prize_name}', claimResult.prize_name || 'Prize')
        .replace('{claim_ref}', claimResult.claim_reference || '')
        .replace('{prize_value}', claimResult.prize_value?.toString() || '')
        .replace('{prize_currency}', claimResult.prize_currency || '');

    case 'try_again':
      return campaign.try_again_message;

    case 'already_claimed':
      return campaign.already_used_message;

    case 'invalid':
      return campaign.invalid_message;

    case 'campaign_inactive':
      return campaign.expired_message;

    case 'rate_limited':
      return 'You have made too many attempts. Please try again later.';

    case 'not_eligible':
      return 'You have exceeded the maximum number of attempts for this promotion.';

    default:
      return campaign.invalid_message;
  }
}

/**
 * Verify a promo code submission.
 *
 * This is the main entry point called by the WhatsApp bot.
 */
export async function verifyPromoCode(input: VerificationInput): Promise<VerificationResponse> {
  const supabase = createServiceClient();

  // 1. Resolve campaign
  const campaign = await resolveCampaign(input.businessId, input.keyword);

  if (!campaign) {
    return {
      result: 'campaign_inactive',
      message: 'No active promotion found.',
    };
  }

  // 2. Normalize and hash the submitted code
  const normalized = normalizePromoCode(input.rawCode);
  const codeHash = hashPromoCode(normalized);

  // 3. Call the atomic claim function
  const { data, error } = await supabase.rpc('claim_promo_code', {
    p_business_id: input.businessId,
    p_campaign_id: campaign.id,
    p_normalized_code_hash: codeHash,
    p_phone_e164: input.phoneE164,
    p_inbound_message_id: input.inboundMessageId || null,
  });

  if (error) {
    // RPC error is non-critical — returns invalid message to user
    return {
      result: 'invalid',
      message: campaign.invalid_message,
    };
  }

  const claimResult = data as PromoClaimResult;

  // 4. Handle eligibility gate — user must acknowledge before claiming
  if (claimResult.eligibility_required) {
    return {
      result: 'not_eligible',
      message: claimResult.eligibility_prompt || campaign.eligibility_prompt ||
        'You must complete the eligibility acknowledgment before participating.',
      eligibilityRequired: true,
      eligibilityMode: claimResult.eligibility_mode,
      eligibilityPrompt: claimResult.eligibility_prompt,
      campaignId: campaign.id,
    };
  }

  // 5. Format and return the response
  return {
    result: claimResult.result,
    message: formatResponseMessage(campaign, claimResult),
    claimReference: claimResult.claim_reference,
    prizeName: claimResult.prize_name,
  };
}

/**
 * Check if a message looks like a promo code.
 * Used by bot routing to detect bare-code submissions.
 *
 * Promo codes are typically 6-24 alphanumeric characters
 * with optional hyphens as group separators.
 *
 * CRITICAL: Must NOT match natural language (booking intents,
 * greetings, commands) or common inputs that happen to be 6+ chars.
 */
export function looksLikePromoCode(text: string): boolean {
  const trimmed = text.trim();
  // Reject if it contains spaces (natural language) — promo codes use hyphens, not spaces
  // Exception: allow single-token inputs (no spaces)
  if (trimmed.includes(' ')) return false;
  // Strip presentation separators (hyphens, dots, underscores)
  const cleaned = trimmed.replace(/[\-._]/g, '');
  // Must be 10-24 alphanumeric chars (hardened minimum matching isRoutablePromoCode)
  if (cleaned.length < 10 || cleaned.length > 24) return false;
  // Must be all alphanumeric
  if (!/^[A-Za-z0-9]+$/.test(cleaned)) return false;
  // Must contain at least one digit (pure-alpha words are likely natural language)
  if (!/\d/.test(cleaned)) return false;
  return true;
}

/**
 * Check if a business has an active bare-code campaign.
 * Used by bot routing to determine if bare code mode is active.
 */
export async function hasActiveBareCodeCampaign(businessId: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { count } = await supabase
    .from('promo_campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('accept_bare_codes', true)
    .eq('status', 'active');
  return (count ?? 0) > 0;
}

/**
 * Check if a business has an active campaign with a specific keyword.
 */
export async function hasActiveKeywordCampaign(
  businessId: string,
  keyword: string,
): Promise<boolean> {
  const supabase = createServiceClient();
  const { count } = await supabase
    .from('promo_campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .ilike('keyword', keyword)
    .eq('status', 'active');
  return (count ?? 0) > 0;
}
