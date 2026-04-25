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
      .in('key', ['pricing_tiers', 'broadcast_limits', 'conversation_limits', 'trial_days', 'booking_defaults']);

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

/** Clear cache — call after admin edits to platform_settings */
export function invalidatePlatformSettingsCache(): void {
  cache = null;
  cacheTime = 0;
}
