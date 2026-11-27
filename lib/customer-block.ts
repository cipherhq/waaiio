/**
 * Customer blocking covers email and website checkouts (#1166 r7, Owner
 * approval 2026-11-27). Builds on the phone suspension of #1103
 * (lib/customer-suspension.ts, M547).
 *
 * One read-only check answers "is this phone or this email blocked" for:
 *  - website checkouts and the email code step (webCheckoutBlocked): refuse
 *    before anything is created; a failed read lets the request through and
 *    is reported (Owner Q10 A);
 *  - customer email sends (customerEmailSendBlocked): skip a blocked email,
 *    or the email copy for a blocked phone; a failed read skips (fail closed,
 *    as the #1103 sends do).
 *
 * Money is untouched: payments, refunds, payouts, settlement and payment
 * confirmations must never import this module.
 *
 * Storage: public.customer_suspensions (M547, phones) and
 * public.customer_email_blocks (M559, emails), service role only. Logs never
 * carry the phone or email.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalCustomerPhone, lookupKey } from '@/lib/customer-suspension';
import { logger } from '@/lib/logger';
import { reportFailure } from '@/lib/observability/report-failure';

/** The one neutral website refusal (Owner wording, #1166). No reason is given. */
export const CUSTOMER_BLOCKED_WEB_TEXT =
  "This service isn't available. If you think this is a mistake, contact support@waaiio.com";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Blocked-email key: trimmed and lower-cased. Dots and "+tag" aliases are not
 * folded (Owner Q11 A). Null when the value cannot be an email address, so it
 * can never match a stored block.
 */
export function normalizeBlockEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/**
 * Lookup key for a phone typed on the website. The number is read in the
 * business country (local numbers like '080…') and reduced to the bot's
 * digits-only key. When the phone library rejects the number, the digits of
 * the typed value are tried instead, so an out-of-date number plan cannot miss
 * a match. Null when neither gives a canonical key.
 */
export function customerPhoneBlockKey(raw: unknown, countryCode?: string | null): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const canonical = canonicalCustomerPhone(raw, countryCode);
  return lookupKey(canonical ?? raw);
}

export type CustomerBlockMatch = 'phone' | 'email';

export interface CustomerBlockStatus {
  /** 'unknown' only when a read failed and nothing matched. */
  status: 'blocked' | 'clear' | 'unknown';
  matched?: CustomerBlockMatch;
}

interface BlockKeys { phoneKey: string | null; emailKey: string | null }

async function readBlock(db: SupabaseClient, { phoneKey, emailKey }: BlockKeys): Promise<CustomerBlockStatus> {
  let failed = false;

  if (phoneKey) {
    try {
      const { data, error } = await db.from('customer_suspensions').select('id').eq('phone', phoneKey).maybeSingle();
      if (error) failed = true;
      else if (data) return { status: 'blocked', matched: 'phone' };
    } catch {
      failed = true;
    }
  }

  if (emailKey) {
    try {
      const { data, error } = await db.from('customer_email_blocks').select('id').eq('email', emailKey).maybeSingle();
      if (error) failed = true;
      else if (data) return { status: 'blocked', matched: 'email' };
    } catch {
      failed = true;
    }
  }

  return { status: failed ? 'unknown' : 'clear' };
}

/**
 * Status for a phone and/or email typed or proved on the website. A value that
 * cannot be a key (empty, malformed) is simply not checked.
 */
export async function customerBlockStatus(
  db: SupabaseClient,
  input: { phone?: unknown; email?: unknown; countryCode?: string | null },
): Promise<CustomerBlockStatus> {
  return readBlock(db, {
    phoneKey: customerPhoneBlockKey(input.phone, input.countryCode),
    emailKey: normalizeBlockEmail(input.email),
  });
}

/**
 * Website checkout gate. Returns true when the request must be refused with
 * CUSTOMER_BLOCKED_WEB_TEXT, before anything is created or charged. Logs one
 * `customer_block.refused` event (route, business, which kind matched; never
 * the value). A failed read lets the request through and is reported
 * (Owner Q10 A).
 */
export async function webCheckoutBlocked(
  db: SupabaseClient,
  input: { route: string; businessId?: string | null; phone?: unknown; email?: unknown; countryCode?: string | null },
): Promise<boolean> {
  const result = await customerBlockStatus(db, input);
  if (result.status === 'blocked') {
    logger.withContext({
      op: 'customer_block.refused', route: input.route, business_id: input.businessId ?? null, matched: result.matched,
    }).info('customer_block.refused');
    return true;
  }
  if (result.status === 'unknown') {
    logger.error('[CUSTOMER_BLOCK] Status read failed; request allowed through');
    reportFailure(new Error('customer block status read failed'), {
      area: 'customer_block', op: 'web_checkout_check', businessId: input.businessId ?? null,
    });
  }
  return false;
}

/**
 * Customer email sends on the skip list (#1166 S9). Returns true when the
 * email must not be sent: the email is blocked, or the send's phone is
 * blocked (F16). Fails closed: an unreadable status skips the send. Logs one
 * `customer_block.email_skipped` event (send name, business; never the
 * address). Money emails must not call this.
 */
export async function customerEmailSendBlocked(
  db: SupabaseClient,
  input: { send: string; businessId?: string | null; email?: unknown; phone?: unknown },
): Promise<boolean> {
  const keys: BlockKeys = {
    // Stored phones are messaged as-is, so use the bot's digits-only key.
    phoneKey: typeof input.phone === 'string' ? lookupKey(input.phone) : null,
    emailKey: normalizeBlockEmail(input.email),
  };
  if (!keys.phoneKey && !keys.emailKey) return false;

  const result = await readBlock(db, keys);
  if (result.status === 'clear') return false;
  if (result.status === 'unknown') {
    reportFailure(new Error('customer block status read failed'), {
      area: 'customer_block', op: 'email_send_check', businessId: input.businessId ?? null, level: 'warning',
    });
  }
  logger.withContext({
    op: 'customer_block.email_skipped', send: input.send, business_id: input.businessId ?? null,
  }).info('customer_block.email_skipped');
  return true;
}
