/**
 * Platform-wide customer suspension (#1103, Owner decision 2026-11-17).
 *
 * A suspended customer's WhatsApp number is blocked from every Waaiio bot at
 * every business, and marketing sends skip it. Money is untouched: payments,
 * refunds, payouts and settlement do not read this.
 *
 * Storage: public.customer_suspensions (M547), service role only. The key is
 * the canonical phone: E.164 digits without '+', the form Meta sends as
 * msg.from.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { parsePhoneNumber, type CountryCode } from 'libphonenumber-js';
import { logger } from '@/lib/logger';
import { reportFailure } from '@/lib/observability/report-failure';

/** The one neutral reply a suspended customer gets. No reason is given. */
export const SUSPENDED_CUSTOMER_TEXT = "This service isn't available for this number.";

/** The neutral reply is sent at most once per WhatsApp conversation window. */
export const SUSPENDED_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const CANONICAL = /^[1-9]\d{6,14}$/;

/**
 * Canonical phone for suspension: E.164 digits, no '+'. International input
 * ('+234…', '00234…', '234…') is kept as is; a local number ('080…') needs the
 * business country. Returns null when the number cannot be made canonical.
 */
export function canonicalCustomerPhone(raw: unknown, countryCode?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/[\s().-]/g, '');
  if (!value) return null;
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (value.startsWith('0')) {
    if (!countryCode) return null;
    try {
      const parsed = parsePhoneNumber(value, countryCode.toUpperCase() as CountryCode);
      if (!parsed?.isValid()) return null;
      value = parsed.format('E.164');
    } catch {
      return null;
    }
  }
  const digits = value.startsWith('+') ? value.slice(1) : value;
  return CANONICAL.test(digits) ? digits : null;
}

export type SuspensionStatus = 'suspended' | 'clear' | 'unknown';

/** 'unknown' when the number is not canonical or the read failed. */
export async function customerSuspensionStatus(db: SupabaseClient, phone: string): Promise<SuspensionStatus> {
  const canonical = canonicalCustomerPhone(phone);
  if (!canonical) return 'unknown';
  try {
    const { data, error } = await db.from('customer_suspensions')
      .select('id').eq('phone', canonical).maybeSingle();
    if (error) return 'unknown';
    return data ? 'suspended' : 'clear';
  } catch {
    return 'unknown';
  }
}

/**
 * Marketing sends skip a suspended number. Fails closed: an unreadable status
 * blocks the send, like the opt-out checks next to it.
 */
export async function blocksMarketing(db: SupabaseClient, phone: string): Promise<boolean> {
  return (await customerSuspensionStatus(db, phone)) !== 'clear';
}

interface NeutralReplySender {
  sendText(msg: { to: string; text: string }): Promise<unknown>;
  sendPlatformText?(msg: { to: string; text: string }): Promise<unknown>;
}

/**
 * Inbound gate. Returns true when the sender is suspended: the caller must stop
 * (no flow, form, order or payment starts). The first message in each 24-hour
 * window gets the neutral reply; later ones get nothing.
 *
 * A failed status read lets the message through (logged and reported), so a
 * database problem never stops every customer's bot.
 */
export async function gateSuspendedCustomer(
  db: SupabaseClient, from: string, sender: NeutralReplySender,
): Promise<boolean> {
  const canonical = canonicalCustomerPhone(from);
  if (!canonical) return false;

  let row: { id: string; last_notified_at: string | null } | null;
  try {
    const { data, error } = await db.from('customer_suspensions')
      .select('id, last_notified_at').eq('phone', canonical).maybeSingle();
    if (error) throw new Error(error.message);
    row = data;
  } catch (err) {
    logger.error('[SUSPENSION] Status read failed; message allowed through');
    reportFailure(err, { area: 'bot', op: 'customer_suspension_check' });
    return false;
  }
  if (!row) return false;

  const last = row.last_notified_at ? new Date(row.last_notified_at).getTime() : 0;
  if (Date.now() - last < SUSPENDED_NOTICE_WINDOW_MS) return true;

  // Claim this window's reply: compare-and-set on the value just read, so two
  // concurrent messages send one reply.
  try {
    let claim = db.from('customer_suspensions')
      .update({ last_notified_at: new Date().toISOString() }).eq('id', row.id);
    claim = row.last_notified_at ? claim.eq('last_notified_at', row.last_notified_at) : claim.is('last_notified_at', null);
    const { data: claimed, error } = await claim.select('id');
    if (error || !claimed?.length) return true;
    const msg = { to: from, text: SUSPENDED_CUSTOMER_TEXT };
    if (sender.sendPlatformText) await sender.sendPlatformText(msg);
    else await sender.sendText(msg);
  } catch (err) {
    logger.warn('[SUSPENSION] Neutral reply not sent:', err instanceof Error ? err.message : 'unknown');
  }
  return true;
}
