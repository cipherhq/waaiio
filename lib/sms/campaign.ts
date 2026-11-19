/**
 * Merchant SMS campaigns (Owner decisions 2026-11-18, #1131): the estimate
 * shown before sending, and the charged send.
 *
 * - Pages and Unicode follow lib/sms/segments.ts; the price per page is
 *   ceil(BulkSMS cost x 1.2) from the admin-entered cost for the business's
 *   country. The database charges the same amount when it reserves credit.
 * - Only NG/GH businesses, only numbers in the business's own country.
 * - Only people who opted in to this business's marketing (SMS or WhatsApp
 *   consent); any opt-out, a suspension, or quiet hours (20:00-08:00) skips.
 * - Each recipient is sent at most once per request id.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasRecipientPermission } from '@/lib/merchants/recipient-permission';
import { isSmsConfigured } from './bulksms-ng';
import { countSmsSegments, MAX_SMS_PAGES } from './segments';
import { isQuietHours, isSmsCountry, loadMessagingPricing, smsRateFromPricing, smsRecipient, type SmsCountry } from './pricing';
import { sendBusinessSms, type SmsSkipReason } from './send';

export interface SmsCampaignEstimate {
  /** False when SMS cannot be used at all; `problem` says why. */
  available: boolean;
  problem: 'not_configured' | 'country_not_supported' | 'not_priced' | null;
  pages: number;
  unicode: boolean;
  characters: number;
  perPage: number;
  tooLong: boolean;
  currency: string | null;
  pricePerPageMinor: number | null;
  /** Numbers in the business's country that will be offered the SMS. */
  recipients: number;
  /** Numbers that cannot get an SMS (not NG/GH, other country, invalid). */
  notSmsNumbers: number;
  /** pages x price x recipients, before opt-out/consent checks (an upper bound). */
  totalMinor: number | null;
  quietHoursNow: boolean;
}

export async function estimateSmsCampaign(db: SupabaseClient, opts: {
  businessCountry: string | null;
  phones: string[];
  message: string;
  now?: Date;
}): Promise<SmsCampaignEstimate> {
  const segments = countSmsSegments(opts.message);
  const base = {
    pages: segments.pages, unicode: segments.unicode, characters: segments.characters,
    perPage: segments.perPage, tooLong: segments.pages > MAX_SMS_PAGES,
  };
  const country = opts.businessCountry;
  const recipients = new Set<string>();
  let notSmsNumbers = 0;
  for (const raw of opts.phones) {
    const r = isSmsCountry(country) ? smsRecipient(raw, country) : null;
    if (r && r.country === country) recipients.add(r.phone);
    else notSmsNumbers++;
  }
  const empty = { ...base, currency: null, pricePerPageMinor: null, recipients: recipients.size, notSmsNumbers, totalMinor: null, quietHoursNow: false };
  if (!isSmsConfigured()) return { ...empty, available: false, problem: 'not_configured' };
  if (!isSmsCountry(country)) return { ...empty, available: false, problem: 'country_not_supported' };
  const rate = smsRateFromPricing(await loadMessagingPricing(db, opts.now), country);
  if (!rate) return { ...empty, available: false, problem: 'not_priced', quietHoursNow: isQuietHours(country, opts.now) };
  return {
    ...base,
    available: true,
    problem: null,
    currency: rate.currency,
    pricePerPageMinor: rate.priceMinor,
    recipients: recipients.size,
    notSmsNumbers,
    totalMinor: rate.priceMinor * segments.pages * recipients.size,
    quietHoursNow: isQuietHours(country as SmsCountry, opts.now),
  };
}

export interface SmsCampaignResult {
  sent: number;
  /** Charged total for the sent messages, in `currency` minor units. */
  chargedMinor: number;
  currency: string | null;
  failed: number;
  unknown: number;
  alreadySent: number;
  skipped: Partial<Record<SmsSkipReason | 'no_consent' | 'not_attempted', number>>;
}

/** Send one campaign. The caller has authorized the business and checked limits. */
export async function sendSmsCampaign(db: SupabaseClient, opts: {
  businessId: string;
  businessCountry: string;
  requestId: string;
  phones: string[];
  message: string;
  now?: Date;
}): Promise<SmsCampaignResult> {
  const result: SmsCampaignResult = { sent: 0, chargedMinor: 0, currency: null, failed: 0, unknown: 0, alreadySent: 0, skipped: {} };
  const skip = (reason: keyof SmsCampaignResult['skipped'], n = 1) => { result.skipped[reason] = (result.skipped[reason] || 0) + n; };
  const seen = new Set<string>();
  const phones = opts.phones.map(p => smsRecipient(p, opts.businessCountry)?.phone ?? p);
  for (let i = 0; i < phones.length; i++) {
    const phone = phones[i];
    if (seen.has(phone)) continue;
    seen.add(phone);
    const consented = await hasRecipientPermission(db, opts.businessId, phone, 'marketing', 'sms')
      || await hasRecipientPermission(db, opts.businessId, phone, 'marketing', 'whatsapp');
    if (!consented) { skip('no_consent'); continue; }
    const outcome = await sendBusinessSms(db, {
      businessId: opts.businessId, phone, text: opts.message, purpose: 'campaign',
      idempotencyKey: `campaign:${opts.requestId}:${phone}`, now: opts.now,
    });
    if (outcome.status === 'sent') {
      result.sent++;
      result.chargedMinor += outcome.priceMinor ?? 0;
      result.currency = outcome.currency ?? result.currency;
    } else if (outcome.status === 'duplicate') result.alreadySent++;
    else if (outcome.status === 'unknown') result.unknown++;
    else if (outcome.status === 'failed') result.failed++;
    else {
      skip(outcome.reason);
      // Every later recipient would be refused the same way: stop here.
      if (outcome.reason === 'insufficient_credit' || outcome.reason === 'not_authorized'
        || outcome.reason === 'quiet_hours' || outcome.reason === 'not_configured') {
        const rest = new Set(phones.slice(i + 1).filter(p => !seen.has(p))).size;
        if (rest) skip('not_attempted', rest);
        break;
      }
    }
  }
  return result;
}
