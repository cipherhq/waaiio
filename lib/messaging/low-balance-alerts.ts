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
 * - Thresholds: platform_settings `messaging_low_balance_alerts` (code defaults below).
 * - Estimated messages: balance / messaging_pricing[currency].default_cost_minor (the
 *   service-message rate). Marketing templates cost more, so the estimate is an upper bound.
 * - Deduplication: each alert's id is derived from (business, currency, newest allowance,
 *   level), so the existing primary key refuses a second copy, even from two sends at once.
 * - Reset on top-up: a top-up (or any new credit) creates a new allowance row, which gives
 *   new ids, so the levels can alert again.
 * - Only the most urgent level reached is sent; levels already passed are not sent late.
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

let settingsCache: { at: number; cfg: LowBalanceConfig; pricing: Record<string, { default_cost_minor?: number }> } | null = null;
const SETTINGS_TTL_MS = 60_000;

/** Test hook: forget cached settings. */
export function resetLowBalanceSettingsCache() { settingsCache = null; }

async function loadSettings(supabase: SupabaseClient) {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache;
  const { data, error } = await supabase.from('platform_settings')
    .select('key, value').in('key', ['messaging_low_balance_alerts', 'messaging_pricing']);
  if (error) throw new Error(`settings: ${error.message}`);
  const map = new Map((data || []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  settingsCache = {
    at: Date.now(),
    cfg: parseLowBalanceConfig(map.get('messaging_low_balance_alerts')),
    pricing: (map.get('messaging_pricing') || {}) as Record<string, { default_cost_minor?: number }>,
  };
  return settingsCache;
}

/**
 * Check one business and raise at most one new alert per currency. Non-blocking for callers:
 * never throws (errors are logged), never sends WhatsApp, never changes balances.
 */
export async function checkLowBalanceAlerts(supabase: SupabaseClient, businessId: string, now: Date = new Date()): Promise<void> {
  try {
    const { data: rows, error } = await supabase.from('messaging_allowances')
      .select('id, currency_code, remaining_minor, expires_at, created_at')
      .eq('business_id', businessId);
    if (error) { logger.warn('[LOW-BALANCE] Allowance read failed:', error.message); return; }
    if (!rows || rows.length === 0) return; // never had messaging credit: nothing to warn about

    const byCurrency = new Map<string, Allowance[]>();
    for (const a of rows as Allowance[]) byCurrency.set(a.currency_code, [...(byCurrency.get(a.currency_code) || []), a]);

    const { cfg, pricing } = await loadSettings(supabase);
    for (const [currency, list] of byCurrency) {
      // Spendable balance = non-expired allowances (as the billing page and authorization count it)
      const balance = list
        .filter(a => !a.expires_at || new Date(a.expires_at) > now)
        .reduce((sum, a) => sum + Math.max(0, Number(a.remaining_minor) || 0), 0);
      const newest = list.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      const cost = pricing[currency]?.default_cost_minor;
      const level = reachedLevel(balance, posInt(cost) ? cost! : null, currency, cfg);
      if (!level) continue;
      await raiseAlert(supabase, businessId, currency, newest.id, level, balance, posInt(cost) ? cost! : null);
    }
  } catch (err) {
    logger.warn('[LOW-BALANCE] Check failed (non-critical):', (err as Error).message);
  }
}

async function raiseAlert(
  supabase: SupabaseClient, businessId: string, currency: string, allowanceId: string,
  level: LowBalanceLevel, balance: number, cost: number | null,
) {
  const id = lowBalanceAlertId(businessId, currency, allowanceId, level.key);
  // Already raised for this top-up and level (cheap primary-key read before the insert)
  const { data: existing } = await supabase.from('alerts').select('id').eq('id', id).maybeSingle();
  if (existing) return;

  const estimated = cost ? Math.floor(balance / cost) : null;
  const amount = formatMinor(balance, currency);
  const message = estimated !== null
    ? `Your messaging balance is ${amount}, about ${estimated} message${estimated === 1 ? '' : 's'}. Top up to keep your WhatsApp replies going.`
    : `Your messaging balance is ${amount}. Top up to keep your WhatsApp replies going.`;
  const metadata: Record<string, unknown> = {
    level: level.key, currency_code: currency, balance_minor: balance, cost_per_message_minor: cost,
    estimated_messages: estimated, allowance_id: allowanceId, email: { status: 'pending' },
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

  const email = await emailOwner(supabase, businessId, amount, estimated);
  const { error: updErr } = await supabase.from('alerts')
    .update({ metadata: { ...metadata, email: { ...email, at: new Date().toISOString() } } })
    .eq('id', id);
  if (updErr) logger.warn('[LOW-BALANCE] Email outcome not recorded:', updErr.message);
}

/**
 * Email the owner. The outcome says only what is known: the provider accepted the email,
 * the send failed, or nothing was sent. It never says "delivered".
 */
async function emailOwner(supabase: SupabaseClient, businessId: string, amount: string, estimated: number | null): Promise<Record<string, unknown>> {
  const { data: biz } = await supabase.from('businesses')
    .select('name, profiles:owner_id (email)').eq('id', businessId).maybeSingle();
  const b = biz as { name?: string; profiles?: { email?: string | null } | null } | null;
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
