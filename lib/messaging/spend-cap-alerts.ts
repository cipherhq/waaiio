import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';
import { billingCurrencyAndRate } from '@/lib/messaging/low-balance-alerts';

/**
 * Monthly messaging spend-cap alerts for merchants (#992, Owner decisions 2026-11-12).
 *
 * A business is alerted when its spend this month (reserved + spent) reaches 50, 75 or 90%
 * of its cap, and when the cap is reached. Used by the bot's check after each reply
 * (checkSpendThresholds) and by the hourly cron (broadcasts, reminders and other sends).
 *
 * - "Reached" (100%) also means the room left is less than one bot reply at the billing rate:
 *   billing refuses the reply that would cross the cap, so a strict 100% rarely happens.
 * - Only the highest level reached gets an alert; lower levels are not sent later.
 * - The `alerts` row is written first, with an id derived from (business, currency, period,
 *   level), so the primary key refuses a second copy. The messaging_spend_threshold_alerts
 *   audit rows are written after it, so a stop between the two writes loses nothing.
 * - 90% and 100% are also emailed to the owner (same rules as the low-balance email).
 * - No alert while the financial gate is off (caps are not enforced then).
 * Never throws to the caller, never sends WhatsApp, never changes balances or caps.
 */

export const SPEND_CAP_ALERT_TYPE = 'messaging_spend_warning';
export const SPEND_CAP_LEVELS = [50, 75, 90, 100] as const;
export type SpendCapLevel = typeof SPEND_CAP_LEVELS[number];
const EMAIL_LEVELS: ReadonlySet<number> = new Set([90, 100]);

export interface SpendPeriod {
  currency_code: string;
  period_start: string;
  cap_minor: number;
  reserved_minor: number;
  spent_minor: number;
}

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Levels reached by this period, lowest first. Integer maths, no rounding at the edges. */
export function reachedSpendLevels(period: SpendPeriod, rateMinor: number | null): SpendCapLevel[] {
  const cap = Number(period.cap_minor);
  if (!(cap > 0)) return [];
  const used = Number(period.reserved_minor) + Number(period.spent_minor);
  const levels: SpendCapLevel[] = SPEND_CAP_LEVELS.filter(l => used * 100 >= l * cap);
  if (!levels.includes(100) && posInt(rateMinor) && cap - used < rateMinor) levels.push(100);
  return levels;
}

/** Stable alert id: same business, currency, month and level → same row. */
export function spendCapAlertId(businessId: string, currency: string, periodStart: string, level: number): string {
  const period = new Date(periodStart).toISOString();
  const h = createHash('sha256').update(`spend-cap:v1:${businessId}:${currency}:${period}:${level}`).digest('hex');
  // UUID layout with version 8 (custom) and the RFC 4122 variant
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function formatSpendAmount(minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency', currency, currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(whole ? 0 : 2)}`;
  }
}

/** First day of the month after the period, e.g. "1 December" (periods are UTC months). */
function resetDate(periodStart: string): string {
  const d = new Date(periodStart);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Owner-approved text (#992, 2026-11-12). */
export function spendCapAlertText(period: SpendPeriod, level: SpendCapLevel): { title: string; message: string; severity: 'warning' | 'critical' } {
  const cur = period.currency_code;
  const cap = Number(period.cap_minor);
  const used = Number(period.reserved_minor) + Number(period.spent_minor);
  const reset = resetDate(period.period_start);
  const severity = level >= 90 ? 'critical' : 'warning';
  if (level === 100) {
    return {
      severity,
      title: 'Monthly messaging limit reached',
      message: `Your business has reached its monthly WhatsApp messaging limit of ${formatSpendAmount(cap, cur)}. `
        + `Bot replies to customers are paused until the limit resets on ${reset}. `
        + 'Topping up your balance does not raise this limit. Contact Waaiio support if you have questions.',
    };
  }
  const pct = Math.min(99, Math.floor((used * 100) / cap));
  return {
    severity,
    title: `Monthly messaging limit: ${pct}% used`,
    message: `Your business has used ${pct}% of its monthly WhatsApp messaging limit (${formatSpendAmount(used, cur)} of ${formatSpendAmount(cap, cur)}). `
      + `If the limit is reached, bot replies to customers pause until it resets on ${reset}.`,
  };
}

type Pricing = Record<string, { rates?: Record<string, Record<string, unknown>>; default_cost_minor?: unknown }>;
let configCache: { at: number; gateOn: boolean; pricing: Pricing } | null = null;
const CONFIG_TTL_MS = 60_000;

/** Test hook: forget the cached billing config. */
export function resetSpendCapConfigCache() { configCache = null; }

/** Gate and pricing from where billing reads them: the newest effective config snapshot. */
async function loadConfig(supabase: SupabaseClient, now: Date) {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache;
  const { data, error } = await supabase.from('platform_config_versions').select('config_snapshot')
    .lte('effective_from', now.toISOString()).order('effective_from', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`config version: ${error.message}`);
  const snapshot = ((data as { config_snapshot?: Record<string, unknown> } | null)?.config_snapshot || {});
  configCache = {
    at: Date.now(),
    gateOn: snapshot.messaging_financial_gate === true,
    pricing: (snapshot.messaging_pricing || {}) as Pricing,
  };
  return configCache;
}

/** The bot-reply rate for this business in the period's currency, or null when unknown. */
function replyRate(pricing: Pricing, country: string | null | undefined, currency: string): number | null {
  const billing = country ? billingCurrencyAndRate(pricing, country) : null;
  if (billing && billing.currency === currency) return billing.cost;
  const fallback = pricing[currency]?.default_cost_minor;
  return posInt(fallback) ? fallback : null;
}

type Biz = { country_code?: string | null; name?: string | null; profiles?: { email?: string | null } | null };

/**
 * Check one spend period of one business and raise at most one new alert.
 * Returns true when a new alert row was created. Never throws.
 */
export async function checkSpendCapPeriod(
  supabase: SupabaseClient, businessId: string, period: SpendPeriod, now: Date = new Date(),
): Promise<boolean> {
  try {
    const cap = Number(period.cap_minor);
    if (!(cap > 0)) return false;
    // Below 50% nothing can be reached (the room-based 100% needs a cap under two replies)
    if ((Number(period.reserved_minor) + Number(period.spent_minor)) * 2 < cap) return false;

    const { gateOn, pricing } = await loadConfig(supabase, now);
    if (!gateOn) return false;

    const { data: biz } = await supabase.from('businesses')
      .select('country_code, name, profiles:owner_id (email)').eq('id', businessId).maybeSingle();
    const b = (biz || {}) as Biz;
    const levels = reachedSpendLevels(period, replyRate(pricing, b.country_code, period.currency_code));
    if (levels.length === 0) return false;
    const level = levels[levels.length - 1];
    return await raiseAlert(supabase, businessId, b, period, level, levels, now);
  } catch (err) {
    logger.warn('[SPEND-CAP] Check failed (non-critical):', (err as Error).message);
    return false;
  }
}

/** A pending or failed email is sent again by a later check, at most this many times in all. */
const MAX_EMAIL_ATTEMPTS = 3;
/** A claim older than this is treated as lost (the function stopped before recording). */
const EMAIL_RETRY_AFTER_MS = 10 * 60_000;

type EmailState = { status: string; attempts?: number; claimed_at?: string; [k: string]: unknown };

async function raiseAlert(
  supabase: SupabaseClient, businessId: string, biz: Biz, period: SpendPeriod,
  level: SpendCapLevel, levels: SpendCapLevel[], now: Date,
): Promise<boolean> {
  const id = spendCapAlertId(businessId, period.currency_code, period.period_start, level);
  const text = spendCapAlertText(period, level);
  const wantsEmail = EMAIL_LEVELS.has(level);

  const { data: existing } = await supabase.from('alerts').select('id, metadata').eq('id', id).maybeSingle();
  if (existing) {
    if (!wantsEmail) return false;
    const meta = ((existing as { metadata?: Record<string, unknown> }).metadata || {});
    const email = (meta.email || {}) as EmailState;
    const attempts = Number(email.attempts) || 0;
    const stale = !email.claimed_at || now.getTime() - new Date(email.claimed_at).getTime() >= EMAIL_RETRY_AFTER_MS;
    if ((email.status === 'pending' || email.status === 'failed') && attempts < MAX_EMAIL_ATTEMPTS && stale) {
      await claimAndEmail(supabase, id, meta, email.claimed_at ?? null, attempts + 1, biz, text, now);
    }
    return false;
  }

  const reserved = Number(period.reserved_minor);
  const spent = Number(period.spent_minor);
  const used = reserved + spent;
  const cap = Number(period.cap_minor);
  const claimedAt = now.toISOString();
  const metadata: Record<string, unknown> = {
    threshold_pct: level, utilization_pct: Math.floor((used * 100) / cap),
    cap_minor: cap, reserved_minor: reserved, spent_minor: spent,
    currency_code: period.currency_code, period_start: period.period_start,
    ...(wantsEmail ? { email: { status: 'pending', attempts: 1, claimed_at: claimedAt } } : {}),
  };
  const { error: insertErr } = await supabase.from('alerts').insert({
    id, business_id: businessId, type: SPEND_CAP_ALERT_TYPE,
    severity: text.severity, title: text.title, message: text.message, metadata,
  });
  if (insertErr) {
    // 23505: another check raised the same alert first; it writes the audit rows and email
    if (insertErr.code !== '23505') logger.warn('[SPEND-CAP] Alert insert failed:', insertErr.message);
    return false;
  }

  // Audit rows for every level reached (lower ones are recorded, not alerted)
  const utilization = Math.min(999.99, Math.round((used * 10000) / cap) / 100);
  for (const l of levels) {
    const { error } = await supabase.from('messaging_spend_threshold_alerts').insert({
      business_id: businessId, currency_code: period.currency_code, period_start: period.period_start,
      threshold_pct: l, utilization_at_alert: utilization, cap_minor: cap, reserved_minor: reserved, spent_minor: spent,
    });
    if (error && error.code !== '23505') logger.warn('[SPEND-CAP] Audit row insert failed:', error.message);
  }

  if (wantsEmail) await emailAndRecord(supabase, id, metadata, 1, claimedAt, biz, text);
  return true;
}

/** Take over a pending/failed email; the update applies only while claimed_at is unchanged. */
async function claimAndEmail(
  supabase: SupabaseClient, id: string, meta: Record<string, unknown>, oldClaim: string | null, attempt: number,
  biz: Biz, text: { title: string; message: string }, now: Date,
) {
  const claimedAt = now.toISOString();
  const email = { ...(meta.email as EmailState), status: 'pending', attempts: attempt, claimed_at: claimedAt };
  let q = supabase.from('alerts').update({ metadata: { ...meta, email } }).eq('id', id);
  q = oldClaim ? q.eq('metadata->email->>claimed_at', oldClaim) : q.is('metadata->email->>claimed_at', null);
  const { data: claimed, error } = await q.select('id');
  if (error || !claimed || claimed.length === 0) return; // another check took it
  await emailAndRecord(supabase, id, { ...meta, email }, attempt, claimedAt, biz, text);
}

async function emailAndRecord(
  supabase: SupabaseClient, id: string, metadata: Record<string, unknown>, attempt: number, claimedAt: string,
  biz: Biz, text: { title: string; message: string },
) {
  const outcome = await emailOwner(biz, text);
  const { error } = await supabase.from('alerts')
    .update({ metadata: { ...metadata, email: { ...outcome, attempts: attempt, claimed_at: claimedAt, at: new Date().toISOString() } } })
    .eq('id', id);
  if (error) logger.warn('[SPEND-CAP] Email outcome not recorded:', error.message);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Email the owner. The outcome never says "delivered", only what is known. */
async function emailOwner(b: Biz, text: { title: string; message: string }): Promise<Record<string, unknown>> {
  const to = b?.profiles?.email;
  if (!to) return { status: 'not_sent', reason: 'no_owner_email' };
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  try {
    const r = await sendEmail({
      to,
      subject: `${text.title} — ${b?.name || 'Waaiio'}`,
      html: `<p>Hi,</p><p>${escapeHtml(text.message)}</p>`
        + `<p><a href="${appUrl}/dashboard/billing">View your messaging usage</a></p>`,
      noRetry: true,
    }) as { success: boolean; id?: string; dev?: boolean };
    if (r.dev) return { status: 'not_sent', reason: 'email_not_configured' };
    return r.success ? { status: 'provider_accepted', provider_id: r.id ?? null } : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
