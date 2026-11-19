/**
 * SMS pricing, countries and quiet hours (Owner decisions 2026-11-18, #1131).
 *
 * - The BulkSMS cost per page, VAT included, is entered by an admin per
 *   country in minor units: messaging_pricing[currency].rates[country].sms_cost.
 * - The merchant pays ceil(cost x 1.2) per page, from messaging credit. The
 *   database (authorize_message_send, M551) applies the same formula when it
 *   reserves the credit; this module only shows it before sending.
 * - NG and GH only, and a merchant texts only numbers in its own country.
 * - Campaigns (merchant and admin) are not sent 20:00-08:00 local time.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalCustomerPhone } from '@/lib/customer-suspension';
import { resolveRecipientCountry } from '@/lib/channels/phone-country';

export const SMS_COUNTRIES = ['NG', 'GH'] as const;
export type SmsCountry = typeof SMS_COUNTRIES[number];

/** Waaiio's margin on the provider cost: price = ceil(cost x 1.2). */
export function smsPricePerPage(costMinor: number): number {
  // Integer arithmetic, so the result equals the database's ceil(cost * 1.2).
  return Math.ceil((costMinor * 12) / 10);
}

export function isSmsCountry(country: string | null | undefined): country is SmsCountry {
  return !!country && (SMS_COUNTRIES as readonly string[]).includes(country);
}

/**
 * The canonical NG/GH number (E.164 digits, no '+') and its country, or null.
 * A local number ('080…') is read in the given country.
 */
export function smsRecipient(raw: string, countryHint?: string | null): { phone: string; country: SmsCountry } | null {
  const phone = canonicalCustomerPhone(raw, countryHint);
  if (!phone) return null;
  const country = resolveRecipientCountry(phone);
  return isSmsCountry(country) ? { phone, country } : null;
}

type Pricing = Record<string, { rates?: Record<string, Record<string, unknown>> }>;

export interface SmsRate {
  currency: string;
  /** Provider cost per page (minor units, VAT included). */
  costMinor: number;
  /** Merchant price per page (minor units). */
  priceMinor: number;
}

/** The rate for a country from a messaging_pricing map, or null when unpriced. */
export function smsRateFromPricing(pricing: Pricing, country: string): SmsRate | null {
  const matches = Object.keys(pricing).filter(c => pricing[c]?.rates?.[country] != null);
  if (matches.length !== 1) return null; // billing refuses no/ambiguous currency too
  const cost = pricing[matches[0]].rates![country].sms_cost;
  if (typeof cost !== 'number' || !Number.isInteger(cost) || cost <= 0) return null;
  return { currency: matches[0], costMinor: cost, priceMinor: smsPricePerPage(cost) };
}

/** The effective messaging_pricing, as billing reads it (newest effective config version). */
export async function loadMessagingPricing(db: SupabaseClient, now = new Date()): Promise<Pricing> {
  const { data, error } = await db.from('platform_config_versions').select('config_snapshot')
    .lte('effective_from', now.toISOString()).order('effective_from', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('Pricing unavailable');
  return ((data as { config_snapshot?: Record<string, unknown> } | null)?.config_snapshot?.messaging_pricing || {}) as Pricing;
}

/** UTC offset in hours: Nigeria is WAT (UTC+1), Ghana is GMT (UTC+0). Neither has daylight saving. */
const UTC_OFFSET: Record<SmsCountry, number> = { NG: 1, GH: 0 };
export const QUIET_HOURS = { start: 20, end: 8 } as const;

/** True from 20:00 to 08:00 local time, when campaigns are not sent. */
export function isQuietHours(country: SmsCountry, now = new Date()): boolean {
  const hour = (now.getUTCHours() + UTC_OFFSET[country]) % 24;
  return hour >= QUIET_HOURS.start || hour < QUIET_HOURS.end;
}
