/**
 * Promotions type definitions.
 * Mirrors database schema types for TypeScript usage.
 */

export type PromoCampaignStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'ended' | 'archived';
export type PromoCodeEntryMode = 'keyword' | 'bare_code' | 'both';
export type PromoPrizeType = 'cash' | 'airtime' | 'product' | 'voucher' | 'discount' | 'custom';
export type PromoBatchStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type PromoBatchSource = 'generated' | 'imported';
export type PromoCodeStatus = 'unused' | 'claimed' | 'void';
export type PromoCodeOutcome = 'winner' | 'try_again';
export type PromoFulfillmentStatus = 'pending' | 'processing' | 'fulfilled' | 'rejected' | 'cancelled';
export type PromoAttemptResult = 'winner' | 'try_again' | 'invalid' | 'already_claimed' | 'campaign_inactive' | 'rate_limited' | 'not_eligible';

export interface PromoCampaign {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  status: PromoCampaignStatus;
  start_at: string | null;
  end_at: string | null;
  timezone: string;
  code_entry_mode: PromoCodeEntryMode;
  keyword: string | null;
  accept_bare_codes: boolean;
  code_format: string;
  code_length: number;
  code_prefix: string | null;
  max_attempts_per_phone: number;
  rate_limit_window_minutes: number;
  rate_limit_max_attempts: number;
  eligibility_mode: string;
  eligibility_prompt: string | null;
  eligibility_min_age: number | null;
  winner_message: string;
  try_again_message: string;
  invalid_message: string;
  already_used_message: string;
  expired_message: string;
  integrity_locked: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PromoPrize {
  id: string;
  campaign_id: string;
  name: string;
  prize_type: PromoPrizeType;
  quantity: number;
  allocated_count: number;
  value: number | null;
  currency: string | null;
  fulfillment_instructions: string | null;
  sort_order: number;
  created_at: string;
}

export interface PromoCodeBatch {
  id: string;
  campaign_id: string;
  source: PromoBatchSource;
  requested_count: number;
  generated_count: number;
  failed_count: number;
  status: PromoBatchStatus;
  filename: string | null;
  error_details: Record<string, unknown> | null;
  progress_cursor: number;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PromoCode {
  id: string;
  business_id: string;
  campaign_id: string;
  batch_id: string;
  normalized_code_hash: string;
  encrypted_code: string | null;
  display_suffix: string;
  outcome: PromoCodeOutcome;
  prize_id: string | null;
  status: PromoCodeStatus;
  claimed_at: string | null;
  claimed_by_phone: string | null;
  created_at: string;
}

export interface PromoRedemption {
  id: string;
  business_id: string;
  campaign_id: string;
  promo_code_id: string;
  phone_e164: string;
  inbound_message_id: string | null;
  outcome: PromoCodeOutcome;
  prize_id: string | null;
  claim_reference: string;
  claimed_at: string;
  fulfillment_status: PromoFulfillmentStatus;
  fulfillment_reference: string | null;
  fulfillment_notes: string | null;
  fulfilled_at: string | null;
  fulfilled_by: string | null;
}

export interface PromoVerificationAttempt {
  id: string;
  business_id: string;
  campaign_id: string | null;
  phone_e164: string;
  submitted_code_hash: string | null;
  result: PromoAttemptResult;
  inbound_message_id: string | null;
  promo_code_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Result from the claim_promo_code PostgreSQL function.
 */
export interface PromoClaimResult {
  success: boolean;
  result: PromoAttemptResult;
  claim_reference?: string;
  redemption_id?: string;
  prize_name?: string;
  prize_type?: string;
  prize_value?: number;
  prize_currency?: string;
  idempotent_replay?: boolean;
  /** Set to true when the user must complete eligibility acknowledgment before claiming. */
  eligibility_required?: boolean;
  eligibility_mode?: string;
  eligibility_prompt?: string;
}

/**
 * Campaign with enriched aggregates for dashboard display.
 */
export interface PromoCampaignWithStats extends PromoCampaign {
  total_codes: number;
  verified_codes: number;
  winners_count: number;
  unused_codes: number;
  total_attempts: number;
  invalid_attempts: number;
  pending_fulfillment: number;
  unique_participants: number;
}

/**
 * Valid campaign status transitions.
 */
export const VALID_STATUS_TRANSITIONS: Record<PromoCampaignStatus, PromoCampaignStatus[]> = {
  draft: ['scheduled', 'active'],
  scheduled: ['active', 'draft', 'paused', 'ended'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: ['archived'],
  archived: [],
};

/**
 * Check if a status transition is valid.
 */
export function isValidStatusTransition(from: PromoCampaignStatus, to: PromoCampaignStatus): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
