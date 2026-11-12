/**
 * Customer message guards: protect a business's paid messaging from one
 * customer draining it (migration 536).
 *
 * - Daily limit: paid replies per customer, per business, per UTC day. Counted
 *   once per inbound message, at that message's first business-paid send, so
 *   free platform notices never count. Over the limit the send is refused with
 *   a financial denial (no attempt row, no reservation, no Meta call), and the
 *   bot sends one free notice. A customer at a payment step is never cut off.
 * - Repeats and pauses: per phone, shared by every serverless instance (the
 *   in-memory rate limiter and abuse map are per instance; production has no
 *   Redis).
 *
 * Every guard fails open on a database error: the business's spend cap and
 * the financial gate still bound what can be spent, and a guard outage must
 * not silence real customers.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPlatformSettingsSync, type PlatformSettings } from '@/lib/platformSettings';
import { logger } from '@/lib/logger';

/** Lowest daily limit a business may set for itself. */
export const MIN_CUSTOMER_DAILY_REPLY_LIMIT = 10;

/** Identical texts within this window count as "in a row". */
export const REPEAT_WINDOW_SECONDS = 10 * 60;

/**
 * Flow steps where the customer is paying or about to pay. A customer at one
 * of these steps is never stopped by the daily limit.
 */
export const PAYMENT_STEP_IDS: ReadonlySet<string> = new Set([
  'await_payment', 'await_order_payment', 'await_ticket_payment', 'await_invoice_payment',
  'await_donation_payment', 'donation_payment', 'invoice_pay', 'payment', 'process_payment',
  'reservation_payment', 'select_checkout', 'continue_or_checkout', 'saved_card_prompt',
  'confirm_amount',
]);

export const CUSTOMER_DAILY_LIMIT_REASON = 'customer_daily_limit';

export const CUSTOMER_DAILY_LIMIT_MESSAGE =
  "You've reached today's message limit with this business. Please try again tomorrow, or contact the business directly.";

/**
 * Thrown by the sender when a customer is over the daily limit. The message
 * starts with "Financial authorization denied:" so every existing path treats
 * it as a refused send: no retry, no circuit-breaker failure, and never a
 * crash reply. The notice is not sent from here or from the bot: some bot
 * sends swallow errors, so the webhook sends it once after the bot is done
 * (CustomerReplyGuardHandle.takeLimitNotice).
 */
export class CustomerDailyLimitError extends Error {
  constructor() {
    super(`Financial authorization denied: ${CUSTOMER_DAILY_LIMIT_REASON}`);
    this.name = 'CustomerDailyLimitError';
  }
}

/** True for the daily-limit refusal, also when the flow executor wrapped it (RefusedSendError.original). */
export function isCustomerDailyLimitError(err: unknown): boolean {
  if (err instanceof CustomerDailyLimitError) return true;
  const original = (err as { original?: unknown } | null)?.original;
  return original instanceof CustomerDailyLimitError;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * The daily limit for one business: its own setting when present, clamped
 * between MIN_CUSTOMER_DAILY_REPLY_LIMIT and the platform ceiling; otherwise
 * the platform default (also clamped by the ceiling).
 */
export function resolveCustomerDailyReplyLimit(
  settings: Pick<PlatformSettings, 'customer_daily_reply_limit' | 'customer_daily_reply_limit_max'>,
  businessMetadata: Record<string, unknown> | null | undefined,
): number {
  const ceiling = Math.max(MIN_CUSTOMER_DAILY_REPLY_LIMIT, positiveInt(settings.customer_daily_reply_limit_max, 500));
  const platformDefault = Math.min(positiveInt(settings.customer_daily_reply_limit, 50), ceiling);
  const own = businessMetadata?.customer_daily_reply_limit;
  if (typeof own !== 'number' || !Number.isSafeInteger(own)) return platformDefault;
  return Math.min(Math.max(own, MIN_CUSTOMER_DAILY_REPLY_LIMIT), ceiling);
}

/** True when the customer's active session with this business is at a payment step. */
async function isAtPaymentStep(db: SupabaseClient, phone: string, businessId: string): Promise<boolean> {
  const { data, error } = await db
    .from('bot_sessions')
    .select('current_step')
    .eq('whatsapp_number', phone)
    .eq('business_id', businessId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const step = (data as { current_step?: string } | null)?.current_step;
  return typeof step === 'string' && PAYMENT_STEP_IDS.has(step);
}

export type CustomerReplyGuard = (businessId: string, recipientPhone: string) => Promise<void>;

export interface CustomerReplyGuardHandle {
  /** Set on the sender for the duration of one inbound message. */
  guard: CustomerReplyGuard;
  /** True once if a refusal in this message owes the customer today's notice. */
  takeLimitNotice(): boolean;
}

function digits(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Build the guard for one inbound message from `phone`. The sender calls it
 * before every business-paid send. Sends to anyone else (the business owner,
 * staff) are not limited. It counts the message once per business and throws
 * CustomerDailyLimitError while the customer is over the limit.
 */
export function createCustomerReplyGuard(db: SupabaseClient, phone: string): CustomerReplyGuardHandle {
  const decisions = new Map<string, Promise<void>>();
  let noticePending = false;

  async function decide(businessId: string): Promise<void> {
    let limit: number;
    try {
      const { data: biz, error } = await db
        .from('businesses')
        .select('metadata')
        .eq('id', businessId)
        .maybeSingle();
      if (error) throw error;
      limit = resolveCustomerDailyReplyLimit(
        getPlatformSettingsSync(),
        (biz as { metadata?: Record<string, unknown> } | null)?.metadata,
      );
    } catch (err) {
      logger.warn('[MESSAGE-GUARD] daily limit lookup failed; allowing reply:', (err as Error).message);
      return;
    }

    let usage: { over_limit?: boolean; notice_due?: boolean } | null;
    try {
      const { data, error } = await db.rpc('record_customer_daily_reply', {
        p_business_id: businessId, p_phone: phone, p_limit: limit,
      });
      if (error) throw error;
      usage = data as typeof usage;
    } catch (err) {
      logger.warn('[MESSAGE-GUARD] daily reply count failed; allowing reply:', (err as Error).message);
      return;
    }
    if (!usage?.over_limit) return;

    try {
      if (await isAtPaymentStep(db, phone, businessId)) return;
    } catch (err) {
      // Unknown whether the customer is paying: never cut off a possible checkout.
      logger.warn('[MESSAGE-GUARD] payment-step check failed; allowing reply:', (err as Error).message);
      return;
    }

    logger.warn(`[MESSAGE-GUARD] customer ...${phone.slice(-4)} over daily limit ${limit} for business ${businessId}`);
    if (usage.notice_due === true) noticePending = true;
    throw new CustomerDailyLimitError();
  }

  const customerDigits = digits(phone);
  return {
    guard: (businessId: string, recipientPhone: string) => {
      if (!customerDigits || digits(recipientPhone) !== customerDigits) return Promise.resolve();
      let decision = decisions.get(businessId);
      if (!decision) {
        decision = decide(businessId);
        decisions.set(businessId, decision);
      }
      return decision;
    },
    takeLimitNotice: () => {
      const due = noticePending;
      noticePending = false;
      return due;
    },
  };
}

/**
 * Send today's limit notice as a free platform message. Call after the bot
 * has finished with the message: it unbinds the business from the sender.
 */
export async function sendCustomerDailyLimitNotice(
  sender: { enterPlatformDiscovery?(): void; sendPlatformText?(msg: { to: string; text: string }): Promise<unknown> },
  phone: string,
): Promise<void> {
  try {
    sender.enterPlatformDiscovery?.();
    await sender.sendPlatformText?.({ to: phone, text: CUSTOMER_DAILY_LIMIT_MESSAGE });
  } catch (err) {
    logger.warn('[MESSAGE-GUARD] daily limit notice not sent:', (err as Error).message);
  }
}

export interface InboundGuardResult {
  /** Do not process or answer this message. */
  ignore: boolean;
  /** The customer is paused and has not been told yet. */
  pausedNoticeDue: boolean;
  /** Whole minutes left in the pause (at least 1 while paused). */
  pausedMinutes: number;
}

/** Invalid replies in a row at one flow step before the customer is paused. */
export const INVALID_INPUT_PAUSE_THRESHOLD = 5;

export function pausedNotice(minutes: number): string {
  return `You can message again in ${minutes} minute${minutes !== 1 ? 's' : ''}. 🙏`;
}

export function invalidInputPauseNotice(minutes: number): string {
  return `I'm having trouble understanding. Let's take a short break: in ${minutes} minute${minutes !== 1 ? 's' : ''}, reply *menu* to see your options. 🙏`;
}

function textHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

/**
 * Record one inbound message. Ignore it while the customer is paused, or when
 * it is the same text more than `customer_repeat_message_limit` times in a row.
 * Only plain text is compared; taps and media reset the repeat count.
 */
export async function recordCustomerInbound(
  db: SupabaseClient,
  phone: string,
  text: string,
  messageType: string | undefined,
): Promise<InboundGuardResult> {
  const isText = (messageType ?? 'text') === 'text' && text.trim().length > 0;
  try {
    const { data, error } = await db.rpc('record_customer_inbound', {
      p_phone: phone,
      p_text_hash: isText ? textHash(text) : null,
      p_repeat_window_seconds: REPEAT_WINDOW_SECONDS,
    });
    if (error) throw error;
    const result = (data ?? {}) as {
      repeat_count?: number; paused?: boolean; cooldown_until?: string | null; cooldown_notice_due?: boolean;
    };
    if (result.paused) {
      const untilMs = result.cooldown_until ? Date.parse(result.cooldown_until) : NaN;
      const pausedMinutes = Number.isFinite(untilMs) ? Math.max(1, Math.ceil((untilMs - Date.now()) / 60_000)) : 1;
      return { ignore: true, pausedNoticeDue: result.cooldown_notice_due === true, pausedMinutes };
    }
    const repeatLimit = positiveInt(getPlatformSettingsSync().customer_repeat_message_limit, 3);
    if (isText && (result.repeat_count ?? 0) > repeatLimit) {
      logger.info(`[MESSAGE-GUARD] ignoring repeated message from ...${phone.slice(-4)} (${result.repeat_count} in a row)`);
      return { ignore: true, pausedNoticeDue: false, pausedMinutes: 0 };
    }
    return { ignore: false, pausedNoticeDue: false, pausedMinutes: 0 };
  } catch (err) {
    logger.warn('[MESSAGE-GUARD] inbound guard failed; processing message:', (err as Error).message);
    return { ignore: false, pausedNoticeDue: false, pausedMinutes: 0 };
  }
}

/**
 * Pause a customer on every instance. `noticeSent` is true when the caller has
 * already told the customer, so the next message does not repeat it.
 */
export async function pauseCustomer(
  db: SupabaseClient,
  phone: string,
  minutes: number,
  noticeSent: boolean,
): Promise<void> {
  try {
    const { error } = await db.rpc('set_customer_cooldown', {
      p_phone: phone,
      p_seconds: Math.max(60, Math.round(minutes * 60)),
      p_notice_sent: noticeSent,
    });
    if (error) throw error;
  } catch (err) {
    logger.warn('[MESSAGE-GUARD] could not store pause:', (err as Error).message);
  }
}

/**
 * Record one invalid reply at a flow step. Returns true when this reply makes
 * INVALID_INPUT_PAUSE_THRESHOLD in a row at the same step: the customer is
 * then paused for the soft abuse cooldown and the caller sends one notice.
 */
export async function recordInvalidInput(
  db: SupabaseClient,
  phone: string,
  stepKey: string,
): Promise<{ paused: boolean; minutes: number }> {
  const minutes = positiveInt(getPlatformSettingsSync().abuse_cooldown_soft_minutes, 5);
  try {
    const { data, error } = await db.rpc('record_customer_invalid_input', {
      p_phone: phone, p_step_key: stepKey, p_window_seconds: REPEAT_WINDOW_SECONDS,
    });
    if (error) throw error;
    if (typeof data !== 'number' || data < INVALID_INPUT_PAUSE_THRESHOLD) return { paused: false, minutes };
  } catch (err) {
    logger.warn('[MESSAGE-GUARD] invalid-input count failed:', (err as Error).message);
    return { paused: false, minutes };
  }
  await pauseCustomer(db, phone, minutes, true);
  return { paused: true, minutes };
}
