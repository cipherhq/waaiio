/**
 * Admin SMS broadcasts (Owner decision 2026-11-18, #1131): Waaiio's own text
 * message to its users and account owners in Nigeria and Ghana, via BulkSMS.
 * Waaiio pays: no merchant messaging credit is reserved or charged (the same
 * rule as admin WhatsApp broadcasts, #1104).
 *
 * Recipients, opt-out and suspension checks reuse the WhatsApp broadcast
 * helpers. Each recipient is claimed in admin_broadcast_recipients before the
 * provider call, so a repeated request never texts anyone twice.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalCustomerPhone } from '@/lib/customer-suspension';
import { countSmsSegments, MAX_SMS_PAGES, type SmsSegments } from '@/lib/sms/segments';
import { isQuietHours, loadMessagingPricing, smsRateFromPricing, smsRecipient, type SmsCountry } from '@/lib/sms/pricing';
import { sendPlatformSms } from '@/lib/sms/send';
import {
  AUDIENCES, BroadcastInputError, MAX_RECIPIENTS, PLANS, SEND_INTERVAL_MS, checkRecipients, resolveRecipients,
  type Audience, type BroadcastInput, type RecipientCheck,
} from './whatsapp';

export interface SmsBroadcastInput {
  audience: Audience;
  country: SmsCountry | null;
  plan: string | null;
  phones: string[];
  message: string;
}

export function parseSmsBroadcastInput(body: unknown): SmsBroadcastInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (!message) throw new BroadcastInputError('Write the SMS message.');
  if (countSmsSegments(message).pages > MAX_SMS_PAGES) throw new BroadcastInputError('This message is longer than 10 SMS pages. Shorten it.');
  if (typeof b.audience !== 'string' || !(AUDIENCES as readonly string[]).includes(b.audience)) {
    throw new BroadcastInputError('Choose an audience.');
  }
  const audience = b.audience as Audience;
  let country: SmsCountry | null = null;
  let plan: string | null = null;
  let phones: string[] = [];
  if (audience === 'specific') {
    const raw = Array.isArray(b.phones) ? b.phones : [];
    if (!raw.length) throw new BroadcastInputError('Enter at least one phone number.');
    if (raw.length > MAX_RECIPIENTS) throw new BroadcastInputError(`Enter at most ${MAX_RECIPIENTS} numbers.`);
    const canonical = raw.map(p => canonicalCustomerPhone(p));
    const bad = canonical.filter(p => !p).length;
    if (bad) throw new BroadcastInputError(`${bad} number(s) are not valid international numbers. Include the country code, for example +2348012345678.`);
    phones = [...new Set(canonical as string[])].sort();
  } else {
    if (b.country !== undefined && b.country !== null && b.country !== '') {
      if (b.country !== 'NG' && b.country !== 'GH') throw new BroadcastInputError('SMS goes to Nigeria (NG) and Ghana (GH) only.');
      country = b.country;
    }
    if (b.plan !== undefined && b.plan !== null && b.plan !== '') {
      if (audience !== 'all_businesses') throw new BroadcastInputError('The plan filter applies to account owners only.');
      if (typeof b.plan !== 'string' || !(PLANS as readonly string[]).includes(b.plan)) throw new BroadcastInputError('Unknown plan.');
      plan = b.plan;
    }
  }
  return { audience, country, plan, phones, message };
}

/** The recipient resolver shared with WhatsApp broadcasts (template fields unused). */
function asRecipientQuery(input: SmsBroadcastInput): BroadcastInput {
  return { templateName: '', language: '', params: [], audience: input.audience, country: input.country, plan: input.plan, phones: input.phones };
}

export interface SmsBroadcastPlan {
  segments: SmsSegments;
  /** Every resolved number (canonical). */
  phones: string[];
  withoutNumber: number;
  /** Resolved numbers outside Nigeria and Ghana. */
  notSmsCountry: number;
  /** NG/GH numbers with their check result. */
  smsPhones: string[];
  checks: Map<string, RecipientCheck>;
  eligible: string[];
  quietHoursNow: boolean;
  /** Waaiio's own cost (BulkSMS, VAT included): pages x cost per recipient. */
  estimate: { byCurrency: Array<{ currency: string; amountMinor: number; recipients: number }>; unpriced: number } | null;
}

export async function planSmsBroadcast(db: SupabaseClient, input: SmsBroadcastInput, now = new Date()): Promise<SmsBroadcastPlan> {
  const segments = countSmsSegments(input.message);
  const { phones, withoutNumber } = await resolveRecipients(db, asRecipientQuery(input));
  const countries = new Map<string, SmsCountry>();
  for (const p of phones) {
    const r = smsRecipient(p);
    if (r) countries.set(r.phone, r.country);
  }
  const smsPhones = [...countries.keys()].sort();
  if (smsPhones.length > MAX_RECIPIENTS) {
    throw new BroadcastInputError(`This audience has ${smsPhones.length} SMS numbers. One broadcast can reach at most ${MAX_RECIPIENTS}; narrow it with the filters.`);
  }
  const checks = await checkRecipients(db, smsPhones);
  const eligible = smsPhones.filter(p => checks.get(p) === 'ok');

  let estimate: SmsBroadcastPlan['estimate'] = null;
  try {
    const pricing = await loadMessagingPricing(db, now);
    const totals = new Map<string, { amountMinor: number; recipients: number }>();
    let unpriced = 0;
    for (const p of eligible) {
      const rate = smsRateFromPricing(pricing, countries.get(p)!);
      if (!rate) { unpriced++; continue; }
      const t = totals.get(rate.currency) ?? { amountMinor: 0, recipients: 0 };
      t.amountMinor += rate.costMinor * segments.pages;
      t.recipients++;
      totals.set(rate.currency, t);
    }
    estimate = { byCurrency: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, t]) => ({ currency, ...t })), unpriced };
  } catch {
    estimate = null;
  }

  const quietHoursNow = eligible.some(p => isQuietHours(countries.get(p)!, now));
  return { segments, phones, withoutNumber, notSmsCountry: phones.length - smsPhones.length, smsPhones, checks, eligible, quietHoursNow, estimate };
}

export interface SmsDeliverySummary {
  sent: number;
  failed: number;
  unknown: number;
  skippedOptedOut: number;
  skippedSuspended: number;
  skippedUnverified: number;
}

const SKIP_STATUS: Record<Exclude<RecipientCheck, 'ok'>, string> = {
  opted_out: 'skipped_opted_out',
  suspended: 'skipped_suspended',
  unverified: 'skipped_unverified',
};

/** Send to each NG/GH recipient once, Waaiio-paid. */
export async function deliverSmsBroadcast(db: SupabaseClient, opts: {
  broadcastId: string;
  phones: string[];
  checks: Map<string, RecipientCheck>;
  message: string;
  intervalMs?: number;
}): Promise<SmsDeliverySummary> {
  const summary: SmsDeliverySummary = { sent: 0, failed: 0, unknown: 0, skippedOptedOut: 0, skippedSuspended: 0, skippedUnverified: 0 };
  const interval = opts.intervalMs ?? SEND_INTERVAL_MS;
  const table = () => db.from('admin_broadcast_recipients');
  const finish = (phone: string, fields: Record<string, unknown>) =>
    table().update({ ...fields, updated_at: new Date().toISOString() }).eq('broadcast_id', opts.broadcastId).eq('phone', phone);
  let first = true;

  for (const phone of opts.phones) {
    const check = opts.checks.get(phone) ?? 'unverified';
    if (check !== 'ok') {
      await table().upsert({ broadcast_id: opts.broadcastId, phone, status: SKIP_STATUS[check] },
        { onConflict: 'broadcast_id,phone', ignoreDuplicates: true });
      if (check === 'opted_out') summary.skippedOptedOut++;
      else if (check === 'suspended') summary.skippedSuspended++;
      else summary.skippedUnverified++;
      continue;
    }

    const { data: claimed, error: claimError } = await table()
      .upsert({ broadcast_id: opts.broadcastId, phone, status: 'sending' }, { onConflict: 'broadcast_id,phone', ignoreDuplicates: true })
      .select('id');
    if (claimError || !claimed?.length) { summary.failed++; continue; }

    if (!first && interval > 0) await new Promise(r => setTimeout(r, interval));
    first = false;
    const outcome = await sendPlatformSms(db, { phone, text: opts.message, idempotencyKey: `admin-broadcast:${opts.broadcastId}:${phone}` });
    if (outcome.status === 'sent') {
      await finish(phone, { status: 'sent' });
      summary.sent++;
    } else if (outcome.status === 'unknown' || outcome.status === 'duplicate') {
      await finish(phone, { status: 'unknown', error: outcome.status });
      summary.unknown++;
    } else {
      await finish(phone, { status: 'failed', error: (outcome.status === 'skipped' ? outcome.reason : outcome.reason).slice(0, 500) });
      summary.failed++;
    }
  }
  return summary;
}
