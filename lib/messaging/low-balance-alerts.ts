import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';

/**
 * Low messaging-balance alerts for merchants (TestBiz staging, 10 Nov 2026: the prepaid
 * balance fell below one message and replies stopped with no warning).
 *
 * A business is alerted when its spendable messaging balance in a currency reaches about
 * 200, 100 or 50 messages, or a money amount for that currency (₦250 for NGN). The record is
 * an `alerts` row (merchant dashboard); the owner is also emailed and the email outcome is
 * written back onto that row. Nothing here changes billing, prices or what can be sent.
 *
 * - Billing facts as billing reads them: the newest effective platform_config_versions
 *   snapshot (financial gate, pricing), the business-country currency, and the bot-reply
 *   ('service') rate. No alert while the gate is off (balances are not enforced then).
 * - Thresholds: platform_settings `messaging_low_balance_alerts` (code defaults below).
 * - Estimated messages: balance / that rate. Marketing templates cost more, so the estimate
 *   is an upper bound.
 * - Deduplication: each alert's id is derived from (business, currency, newest allowance,
 *   level), so the existing primary key refuses a second copy, even from two sends at once.
 * - Reset on top-up: a top-up (or any new credit) creates a new allowance row, which gives
 *   new ids, so the levels can alert again.
 * - Only the most urgent level reached is sent; levels already passed are not sent late.
 * - An email still pending (function stopped) or failed is sent again by a later check after
 *   10 minutes, at most 3 attempts; a compare-and-set claim stops two checks sending it.
 */

export const LOW_BALANCE_ALERT_TYPE = 'messaging_low_balance';

export interface LowBalanceConfig {
  /** Estimated messages left at which to alert, any order. */
  message_thresholds: number[];
  /** Money amount (minor units) per currency at which to alert. */
  money_thresholds_minor: Record<string, number>;
}

export const DEFAULT_LOW_BALANCE_CONFIG: LowBalanceConfig = {
  message_thresholds: [200, 100, 50],
  money_thresholds_minor: { NGN: 25000 },
};

type Allowance = { id: string; currency_code: string; remaining_minor: number; expires_at: string | null; created_at: string };
export type LowBalanceLevel = { key: string; minor: number; messages: number | null };

const posInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Admin value when it is well formed, otherwise the default for that part. */
export function parseLowBalanceConfig(raw: unknown): LowBalanceConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const msgs = Array.isArray(r.message_thresholds) && r.message_thresholds.every(posInt)
    ? (r.message_thresholds as number[]) : DEFAULT_LOW_BALANCE_CONFIG.message_thresholds;
  const money = r.money_thresholds_minor && typeof r.money_thresholds_minor === 'object'
    && Object.values(r.money_thresholds_minor as Record<string, unknown>).every(posInt)
    ? (r.money_thresholds_minor as Record<string, number>) : DEFAULT_LOW_BALANCE_CONFIG.money_thresholds_minor;
  return { message_thresholds: msgs, money_thresholds_minor: money };
}

/**
 * The most urgent level the balance has reached, or null. A message level is reached when
 * floor(balance / cost) <= N; the money level when balance <= the amount.
 */
export function reachedLevel(balanceMinor: number, costMinor: number | null, currency: string, cfg: LowBalanceConfig): LowBalanceLevel | null {
  const levels: LowBalanceLevel[] = [];
  if (costMinor && costMinor > 0) {
    const estimated = Math.floor(balanceMinor / costMinor);
    for (const n of cfg.message_thresholds) {
      if (estimated <= n) levels.push({ key: `messages_${n}`, minor: n * costMinor, messages: n });
    }
  }
  const money = cfg.money_thresholds_minor[currency];
  if (posInt(money) && balanceMinor <= money) levels.push({ key: `money_${money}`, minor: money, messages: null });
  if (levels.length === 0) return null;
  return levels.reduce((a, b) => (b.minor < a.minor ? b : a));
}

/** Stable alert id: same business, currency, top-up and level → same row. */
export function lowBalanceAlertId(businessId: string, currency: string, allowanceId: string, levelKey: string): string {
  const h = createHash('sha256').update(`low-balance:v1:${businessId}:${currency}:${allowanceId}:${levelKey}`).digest('hex');
  // UUID layout with version 8 (custom) and the RFC 4122 variant
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function formatMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

type Pricing = Record<string, { rates?: Record<string, Record<string, unknown>>; default_cost_minor?: unknown }>;
let settingsCache: { at: number; cfg: LowBalanceConfig; gateOn: boolean; pricing: Pricing } | null = null;
const SETTINGS_TTL_MS = 60_000;

/** Test hook: forget cached settings. */
export function resetLowBalanceSettingsCache() { settingsCache = null; }

/**
 * Billing facts come from where billing reads them (check_or_authorize_send): the newest
 * effective platform_config_versions snapshot — its messaging_financial_gate and
 * messaging_pricing. Only the alert thresholds come from platform_settings.
 */
async function loadSettings(supabase: SupabaseClient, now: Date) {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache;
  const [{ data: version, error: vErr }, { data: rows, error: sErr }] = await Promise.all([
    supabase.from('platform_config_versions').select('config_snapshot')
      .lte('effective_from', now.toISOString()).order('effective_from', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('platform_settings').select('key, value').eq('key', 'messaging_low_balance_alerts'),
  ]);
  if (vErr) throw new Error(`config version: ${vErr.message}`);
  if (sErr) throw new Error(`settings: ${sErr.message}`);
  const snapshot = ((version as { config_snapshot?: Record<string, unknown> } | null)?.config_snapshot || {});
  settingsCache = {
    at: Date.now(),
    cfg: parseLowBalanceConfig((rows || [])[0]?.value),
    gateOn: snapshot.messaging_financial_gate === true,
    pricing: (snapshot.messaging_pricing || {}) as Pricing,
  };
  return settingsCache;
}

/**
 * The currency and per-message rate billing would use for a bot reply ('service') from a
 * business in this country (authorize_message_send): the one currency whose rates name the
 * country; rates[country][category], then rates[country]['*'], then default_cost_minor.
 */
export function billingCurrencyAndRate(pricing: Pricing, country: string, category = 'service'): { currency: string; cost: number | null } | null {
  const matches = Object.keys(pricing).filter(c => pricing[c]?.rates?.[country] != null);
  if (matches.length !== 1) return null; // billing refuses no/ambiguous currency too
  const bucket = pricing[matches[0]];
  const byCountry = bucket.rates![country] || {};
  const cost = [byCountry[category], byCountry['*'], bucket.default_cost_minor].find(v => typeof v === 'number');
  return { currency: matches[0], cost: posInt(cost) ? (cost as number) : null };
}

type Biz = { country_code?: string | null; name?: string | null; profiles?: { email?: string | null } | null };

/**
 * Check one business and raise at most one new alert. Non-blocking for callers: never
 * throws (errors are logged), never sends WhatsApp, never changes balances.
 */
export async function checkLowBalanceAlerts(supabase: SupabaseClient, businessId: string, now: Date = new Date()): Promise<void> {
  try {
    const { cfg, gateOn, pricing } = await loadSettings(supabase, now);
    // Balance is not enforced while the financial gate is off: nothing would stop, so no alert
    if (!gateOn) return;

    const { data: biz } = await supabase.from('businesses')
      .select('country_code, name, profiles:owner_id (email)').eq('id', businessId).maybeSingle();
    const b = biz as Biz | null;
    const billing = b?.country_code ? billingCurrencyAndRate(pricing, b.country_code) : null;
    if (!billing) return;

    const { data: rows, error } = await supabase.from('messaging_allowances')
      .select('id, currency_code, remaining_minor, expires_at, created_at')
      .eq('business_id', businessId).eq('currency_code', billing.currency);
    if (error) { logger.warn('[LOW-BALANCE] Allowance read failed:', error.message); return; }
    if (!rows || rows.length === 0) return; // never had messaging credit: nothing to warn about

    const list = rows as Allowance[];
    // Spendable balance = non-expired allowances in the billing currency (as authorization spends them)
    const balance = list
      .filter(a => !a.expires_at || new Date(a.expires_at) > now)
      .reduce((sum, a) => sum + Math.max(0, Number(a.remaining_minor) || 0), 0);
    const newest = list.reduce((a, c) => (c.created_at > a.created_at ? c : a));
    const level = reachedLevel(balance, billing.cost, billing.currency, cfg);
    if (!level) return;
    await raiseAlert(supabase, businessId, b!, billing.currency, newest.id, level, balance, billing.cost, now);
  } catch (err) {
    logger.warn('[LOW-BALANCE] Check failed (non-critical):', (err as Error).message);
  }
}

/** A pending or failed email is sent again by a later check, at most this many times in all. */
const MAX_EMAIL_ATTEMPTS = 3;
/** A claim older than this is treated as lost (the function stopped before recording). */
const EMAIL_RETRY_AFTER_MS = 10 * 60_000;

type EmailState = { status: string; attempts?: number; claimed_at?: string; [k: string]: unknown };

async function raiseAlert(
  supabase: SupabaseClient, businessId: string, biz: Biz, currency: string, allowanceId: string,
  level: LowBalanceLevel, balance: number, cost: number | null, now: Date,
) {
  const id = lowBalanceAlertId(businessId, currency, allowanceId, level.key);
  const estimated = cost ? Math.floor(balance / cost) : null;
  const amount = formatMinor(balance, currency);

  // Already raised for this top-up and level (cheap primary-key read before the insert)
  const { data: existing } = await supabase.from('alerts').select('id, metadata').eq('id', id).maybeSingle();
  if (existing) {
    const meta = ((existing as { metadata?: Record<string, unknown> }).metadata || {});
    const email = (meta.email || {}) as EmailState;
    const attempts = Number(email.attempts) || 0;
    const stale = !email.claimed_at || now.getTime() - new Date(email.claimed_at).getTime() >= EMAIL_RETRY_AFTER_MS;
    if ((email.status === 'pending' || email.status === 'failed') && attempts < MAX_EMAIL_ATTEMPTS && stale) {
      await claimAndEmail(supabase, id, meta, email.claimed_at ?? null, attempts + 1, biz, amount, estimated, now);
    }
    return;
  }

  const message = estimated !== null
    ? `Your messaging balance is ${amount}, about ${estimated} message${estimated === 1 ? '' : 's'}. Top up to keep your WhatsApp replies going.`
    : `Your messaging balance is ${amount}. Top up to keep your WhatsApp replies going.`;
  const claimedAt = now.toISOString();
  const metadata: Record<string, unknown> = {
    level: level.key, currency_code: currency, balance_minor: balance, cost_per_message_minor: cost,
    estimated_messages: estimated, allowance_id: allowanceId,
    email: { status: 'pending', attempts: 1, claimed_at: claimedAt },
  };
  const { error: insertErr } = await supabase.from('alerts').insert({
    id, business_id: businessId, type: LOW_BALANCE_ALERT_TYPE,
    severity: level.messages !== null && level.messages > 50 ? 'warning' : 'critical',
    title: 'Messaging balance is low', message, metadata,
  });
  if (insertErr) {
    // 23505: another send raised the same alert first; it sends the email
    if (insertErr.code !== '23505') logger.warn('[LOW-BALANCE] Alert insert failed:', insertErr.message);
    return;
  }
  await emailAndRecord(supabase, id, metadata, 1, claimedAt, biz, amount, estimated);
}

/**
 * Take over a pending/failed email: the update only applies while claimed_at is still the
 * value we read, so two checks cannot both send it.
 */
async function claimAndEmail(
  supabase: SupabaseClient, id: string, meta: Record<string, unknown>, oldClaim: string | null, attempt: number,
  biz: Biz, amount: string, estimated: number | null, now: Date,
) {
  const claimedAt = now.toISOString();
  const email = { ...(meta.email as EmailState), status: 'pending', attempts: attempt, claimed_at: claimedAt };
  let q = supabase.from('alerts').update({ metadata: { ...meta, email } }).eq('id', id);
  q = oldClaim ? q.eq('metadata->email->>claimed_at', oldClaim) : q.is('metadata->email->>claimed_at', null);
  const { data: claimed, error } = await q.select('id');
  if (error || !claimed || claimed.length === 0) return; // another check took it
  await emailAndRecord(supabase, id, { ...meta, email }, attempt, claimedAt, biz, amount, estimated);
}

async function emailAndRecord(
  supabase: SupabaseClient, id: string, metadata: Record<string, unknown>, attempt: number, claimedAt: string,
  biz: Biz, amount: string, estimated: number | null,
) {
  const outcome = await emailOwner(biz, amount, estimated);
  const { error: updErr } = await supabase.from('alerts')
    .update({ metadata: { ...metadata, email: { ...outcome, attempts: attempt, claimed_at: claimedAt, at: new Date().toISOString() } } })
    .eq('id', id);
  if (updErr) logger.warn('[LOW-BALANCE] Email outcome not recorded:', updErr.message);
}

/**
 * Email the owner. The outcome says only what is known: the provider accepted the email,
 * the send failed, or nothing was sent. It never says "delivered".
 */
async function emailOwner(b: Biz, amount: string, estimated: number | null): Promise<Record<string, unknown>> {
  const to = b?.profiles?.email;
  if (!to) return { status: 'not_sent', reason: 'no_owner_email' };
  const name = escapeHtml(b?.name || 'your business');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  const left = estimated !== null ? ` That is about ${estimated} message${estimated === 1 ? '' : 's'}.` : '';
  try {
    const r = await sendEmail({
      to,
      subject: `Messaging balance is low — ${b?.name || 'Waaiio'}`,
      html: `<p>Hi,</p><p>The WhatsApp messaging balance for <strong>${name}</strong> is ${escapeHtml(amount)}.${left}</p>`
        + `<p>When it runs out, replies to your customers stop until you top up.</p>`
        + `<p><a href="${appUrl}/dashboard/billing">Top up messaging credit</a></p>`,
      noRetry: true,
    }) as { success: boolean; id?: string; dev?: boolean };
    if (r.dev) return { status: 'not_sent', reason: 'email_not_configured' };
    return r.success ? { status: 'provider_accepted', provider_id: r.id ?? null } : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
