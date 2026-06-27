import { createClient } from '@/lib/supabase/client';
import { createServiceClient } from '@/lib/supabase/service';
import {
  PRICING_TIERS,
  BROADCAST_LIMITS,
  CONVERSATION_LIMITS,
  TRIAL_DAYS,
  BOOKING_DEFAULTS,
  type SubscriptionTier,
} from '@/lib/constants';

// ── Types ──

export interface PricingTierConfig {
  feePercentage: number;
  feeFlat: number;
  maxBookings: number;
  whitelabel: boolean;
}

export interface BroadcastLimitConfig {
  maxBroadcasts: number;
  maxRecipients: number;
}

export interface BookingDefaultsConfig {
  maxPartySize: number;
  maxAdvanceDays: number;
  reminderHours: number[];
}

export interface PlatformSettings {
  pricing_tiers: Record<SubscriptionTier, PricingTierConfig>;
  broadcast_limits: Record<SubscriptionTier, BroadcastLimitConfig>;
  conversation_limits: Record<SubscriptionTier, number>;
  trial_days: number;
  booking_defaults: BookingDefaultsConfig;
  /** Annual billing discount percentage (e.g., 20 = 20% off). Admin-configurable. */
  annual_discount_percentage: number;
  /** Hours before a pending bank transfer expires (default: 4) */
  transfer_expiry_hours: number;
  /** Days a new business must wait before payouts are eligible (default: 7) */
  payout_cooling_period_days: number;
  /** Minimum payout amount per country in local currency minor units */
  minimum_payout: Record<string, number>;
  /** Max transactions per day before flagging for fraud review (default: 50) */
  fraud_velocity_threshold: number;
  /** Default platform fee percentage when no tier-specific override exists (default: 2.5) */
  default_platform_fee_percent: number;
  /** Bot messages allowed per phone per minute (default: 20) */
  bot_rate_limit_per_minute: number;
  /** Max businesses a single user can create (default: 20) */
  max_businesses_per_user: number;
  /** Minimum OCR confidence to accept a receipt match (default: 0.7) */
  ocr_confidence_threshold: number;
  /** Days before an invoice token expires (default: 30) */
  invoice_expiry_days: number;
  /** Hours before a contract signing link expires (default: 72) */
  contract_signing_hours: number;
  /** Minutes for soft abuse cooldown after gibberish (default: 5) */
  abuse_cooldown_soft_minutes: number;
  /** Minutes for hard abuse cooldown after profanity (default: 30) */
  abuse_cooldown_hard_minutes: number;
  /** Monthly payout limits per verification level (in local currency minor units) */
  payout_verification_limits: Record<string, number>;
}

// ── Sentinel Utility ──

const INFINITY_SENTINEL = 999999999;

/** Convert the DB sentinel 999999999 to JS Infinity */
export function parseInfinity(val: number): number {
  return val >= INFINITY_SENTINEL ? Infinity : val;
}

/** Deep-convert all sentinel values in an object to Infinity */
function convertSentinels<T>(obj: T): T {
  if (typeof obj === 'number') return parseInfinity(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(convertSentinels) as unknown as T;
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = convertSentinels(v);
    }
    return result as T;
  }
  return obj;
}

// ── Hardcoded Fallback ──

function buildFallback(): PlatformSettings {
  return {
    pricing_tiers: {
      free: { feePercentage: PRICING_TIERS.free.feePercentage, feeFlat: PRICING_TIERS.free.feeFlat, maxBookings: PRICING_TIERS.free.maxBookings, whitelabel: PRICING_TIERS.free.whitelabel },
      growth: { feePercentage: PRICING_TIERS.growth.feePercentage, feeFlat: PRICING_TIERS.growth.feeFlat, maxBookings: PRICING_TIERS.growth.maxBookings, whitelabel: PRICING_TIERS.growth.whitelabel },
      business: { feePercentage: PRICING_TIERS.business.feePercentage, feeFlat: PRICING_TIERS.business.feeFlat, maxBookings: PRICING_TIERS.business.maxBookings, whitelabel: PRICING_TIERS.business.whitelabel },
    },
    broadcast_limits: {
      free: { ...BROADCAST_LIMITS.free },
      growth: { ...BROADCAST_LIMITS.growth },
      business: { ...BROADCAST_LIMITS.business },
    },
    conversation_limits: { ...CONVERSATION_LIMITS },
    trial_days: TRIAL_DAYS,
    booking_defaults: { ...BOOKING_DEFAULTS, reminderHours: [...BOOKING_DEFAULTS.reminderHours] },
    annual_discount_percentage: 20,
    transfer_expiry_hours: 4,
    payout_cooling_period_days: 7,
    minimum_payout: { NG: 5000, US: 2500, GB: 2000, CA: 2500, GH: 50 },
    fraud_velocity_threshold: 50,
    default_platform_fee_percent: 2.5,
    bot_rate_limit_per_minute: 20,
    max_businesses_per_user: 20,
    ocr_confidence_threshold: 0.7,
    invoice_expiry_days: 30,
    contract_signing_hours: 72,
    abuse_cooldown_soft_minutes: 5,
    abuse_cooldown_hard_minutes: 30,
    payout_verification_limits: { unverified: 0, basic: 500000, standard: 2000000, full: 999999999 },
  };
}

// ── Cache ──

let cache: PlatformSettings | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

function isFresh(): boolean {
  return cache !== null && Date.now() - cacheTime < CACHE_TTL;
}

// ── Loader ──

/**
 * Async: fetch platform_settings from DB, populate cache.
 * Pass `useServiceClient: true` from server-side API routes
 * to bypass RLS (though a public SELECT policy also exists).
 */
export async function loadPlatformSettings(
  opts?: { useServiceClient?: boolean },
): Promise<PlatformSettings> {
  if (isFresh()) return cache!;

  try {
    const supabase = opts?.useServiceClient ? createServiceClient() : createClient();
    const { data, error } = await supabase
      .from('platform_settings')
      .select('key, value')
      .in('key', [
        'pricing_tiers', 'broadcast_limits', 'conversation_limits', 'trial_days',
        'booking_defaults', 'annual_discount_percentage',
        'transfer_expiry_hours', 'payout_cooling_period_days', 'minimum_payout',
        'fraud_velocity_threshold', 'default_platform_fee_percent', 'bot_rate_limit_per_minute',
        'max_businesses_per_user', 'ocr_confidence_threshold', 'invoice_expiry_days',
        'contract_signing_hours', 'abuse_cooldown_soft_minutes', 'abuse_cooldown_hard_minutes',
        'payout_verification_limits',
      ]);

    if (error) throw error;

    const fallback = buildFallback();
    const map = new Map((data ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));

    cache = {
      pricing_tiers: map.has('pricing_tiers')
        ? convertSentinels(map.get('pricing_tiers') as Record<SubscriptionTier, PricingTierConfig>)
        : fallback.pricing_tiers,
      broadcast_limits: map.has('broadcast_limits')
        ? convertSentinels(map.get('broadcast_limits') as Record<SubscriptionTier, BroadcastLimitConfig>)
        : fallback.broadcast_limits,
      conversation_limits: map.has('conversation_limits')
        ? convertSentinels(map.get('conversation_limits') as Record<SubscriptionTier, number>)
        : fallback.conversation_limits,
      trial_days: map.has('trial_days')
        ? (map.get('trial_days') as number)
        : fallback.trial_days,
      booking_defaults: map.has('booking_defaults')
        ? (map.get('booking_defaults') as BookingDefaultsConfig)
        : fallback.booking_defaults,
      annual_discount_percentage: map.has('annual_discount_percentage')
        ? (map.get('annual_discount_percentage') as number)
        : fallback.annual_discount_percentage,
      transfer_expiry_hours: map.has('transfer_expiry_hours')
        ? (map.get('transfer_expiry_hours') as number)
        : fallback.transfer_expiry_hours,
      payout_cooling_period_days: map.has('payout_cooling_period_days')
        ? (map.get('payout_cooling_period_days') as number)
        : fallback.payout_cooling_period_days,
      minimum_payout: map.has('minimum_payout')
        ? (map.get('minimum_payout') as Record<string, number>)
        : fallback.minimum_payout,
      fraud_velocity_threshold: map.has('fraud_velocity_threshold')
        ? (map.get('fraud_velocity_threshold') as number)
        : fallback.fraud_velocity_threshold,
      default_platform_fee_percent: map.has('default_platform_fee_percent')
        ? (map.get('default_platform_fee_percent') as number)
        : fallback.default_platform_fee_percent,
      bot_rate_limit_per_minute: map.has('bot_rate_limit_per_minute')
        ? (map.get('bot_rate_limit_per_minute') as number)
        : fallback.bot_rate_limit_per_minute,
      max_businesses_per_user: map.has('max_businesses_per_user')
        ? (map.get('max_businesses_per_user') as number)
        : fallback.max_businesses_per_user,
      ocr_confidence_threshold: map.has('ocr_confidence_threshold')
        ? (map.get('ocr_confidence_threshold') as number)
        : fallback.ocr_confidence_threshold,
      invoice_expiry_days: map.has('invoice_expiry_days')
        ? (map.get('invoice_expiry_days') as number)
        : fallback.invoice_expiry_days,
      contract_signing_hours: map.has('contract_signing_hours')
        ? (map.get('contract_signing_hours') as number)
        : fallback.contract_signing_hours,
      abuse_cooldown_soft_minutes: map.has('abuse_cooldown_soft_minutes')
        ? (map.get('abuse_cooldown_soft_minutes') as number)
        : fallback.abuse_cooldown_soft_minutes,
      abuse_cooldown_hard_minutes: map.has('abuse_cooldown_hard_minutes')
        ? (map.get('abuse_cooldown_hard_minutes') as number)
        : fallback.abuse_cooldown_hard_minutes,
      payout_verification_limits: map.has('payout_verification_limits')
        ? (map.get('payout_verification_limits') as Record<string, number>)
        : fallback.payout_verification_limits,
    };
    cacheTime = Date.now();
    return cache;
  } catch {
    // On error, keep stale cache or return fallback
    return cache ?? buildFallback();
  }
}

/** Sync: return cached settings or hardcoded fallback (never fetches) */
export function getPlatformSettingsSync(): PlatformSettings {
  return cache ?? buildFallback();
}

/**
 * Get annual discount multiplier (e.g., 0.8 for 20% off).
 * Reads from platform_settings (admin-configurable).
 * Use sync version for client-side, async for server-side.
 */
export function getAnnualDiscountSync(): { multiplier: number; percentage: number } {
  const settings = getPlatformSettingsSync();
  const pct = settings.annual_discount_percentage;
  return { multiplier: (100 - pct) / 100, percentage: pct };
}

export async function getAnnualDiscount(opts?: { useServiceClient?: boolean }): Promise<{ multiplier: number; percentage: number }> {
  const settings = await loadPlatformSettings(opts);
  const pct = settings.annual_discount_percentage;
  return { multiplier: (100 - pct) / 100, percentage: pct };
}

/** Clear cache — call after admin edits to platform_settings */
export function invalidatePlatformSettingsCache(): void {
  cache = null;
  cacheTime = 0;
}
