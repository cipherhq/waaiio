/**
 * Bounded "wait until WhatsApp delivered it" for media messages (#1070).
 *
 * After sending an image or document that must reach the phone before the
 * next message, the server registers the WAMID in whatsapp_delivery_waits
 * (M545), the Meta status webhook moves the row forward, and the caller polls
 * until every awaited message is delivered/read/failed or the wait times out.
 * A timeout never blocks: the next message is simply sent. Nothing here throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';

const TABLE = 'whatsapp_delivery_waits';

export const DELIVERY_WAIT_POLL_MS = 400;
/** Longest single wait, per media message or media group. */
export const DELIVERY_WAIT_TIMEOUT_MS = 6000;
/** Total waiting allowed in one payment confirmation (webhook maxDuration is 60 s). */
export const CONFIRMATION_DELIVERY_BUDGET_MS = 15_000;
/** Total waiting allowed in one bot prompt batch. */
export const PROMPT_DELIVERY_BUDGET_MS = 10_000;

type WaitStatus = 'sent' | 'delivered' | 'read' | 'failed';

/** Shared time allowance across several waits. */
export class DeliveryWaitBudget {
  private spentMs = 0;
  constructor(private readonly totalMs: number) {}
  remainingMs(): number { return Math.max(0, this.totalMs - this.spentMs); }
  spend(ms: number): void { this.spentMs += Math.max(0, ms); }
}

function uniqueWamids(wamids: Array<string | undefined | null>): string[] {
  return [...new Set(wamids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];
}

/** Record that this WAMID will be awaited. Keeps a status the webhook already advanced. */
export async function registerDeliveryWait(supabase: SupabaseClient, wamid: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert({ wamid, status: 'sent' }, { onConflict: 'wamid', ignoreDuplicates: true });
    if (error) {
      logger.warn('[DELIVERY-WAIT] register failed (non-fatal):', error.message);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('[DELIVERY-WAIT] register threw (non-fatal):', (err as Error)?.message);
    return false;
  }
}

/**
 * Meta status webhook: advance an existing row only, only forward
 * (sent -> delivered -> read); 'failed' always wins. Never throws.
 */
export async function advanceDeliveryWait(supabase: SupabaseClient, wamid: string, status: string): Promise<void> {
  if (!wamid) return;
  let from: WaitStatus[];
  if (status === 'failed') from = ['sent', 'delivered', 'read'];
  else if (status === 'read') from = ['sent', 'delivered'];
  else if (status === 'delivered') from = ['sent'];
  else return;
  try {
    const { error } = await supabase
      .from(TABLE)
      .update({ status, updated_at: new Date().toISOString() })
      .eq('wamid', wamid)
      .in('status', from);
    if (error) logger.warn('[DELIVERY-WAIT] advance failed (non-fatal):', error.message);
  } catch (err) {
    logger.warn('[DELIVERY-WAIT] advance threw (non-fatal):', (err as Error)?.message);
  }
}

export interface AwaitDeliveryOptions {
  timeoutMs?: number;
  budget?: DeliveryWaitBudget;
  pollMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type AwaitDeliveryResult = 'settled' | 'timeout' | 'skipped';

/**
 * Wait until every WAMID is delivered, read or failed, or the time runs out.
 * Rows that cannot be registered or read are not waited for. Deletes its rows
 * at the end. Never throws.
 */
export async function awaitWhatsAppDelivery(
  supabase: SupabaseClient | null | undefined,
  wamids: Array<string | undefined | null>,
  options: AwaitDeliveryOptions = {},
): Promise<AwaitDeliveryResult> {
  const ids = uniqueWamids(wamids);
  if (!supabase || ids.length === 0) return 'skipped';
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? DELIVERY_WAIT_POLL_MS;
  const timeoutMs = Math.min(options.timeoutMs ?? DELIVERY_WAIT_TIMEOUT_MS, options.budget?.remainingMs() ?? Infinity);
  const start = now();
  let result: AwaitDeliveryResult = 'skipped';
  try {
    if (timeoutMs <= 0) return 'skipped';
    for (const id of ids) await registerDeliveryWait(supabase, id);
    for (;;) {
      const { data, error } = await supabase.from(TABLE).select('wamid, status').in('wamid', ids);
      if (error || !Array.isArray(data)) { result = 'skipped'; break; }
      const pending = (data as Array<{ wamid: string; status: string }>).filter(row => row.status === 'sent');
      if (pending.length === 0) { result = data.length > 0 ? 'settled' : 'skipped'; break; }
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) { result = 'timeout'; break; }
      await sleep(Math.min(pollMs, timeoutMs - elapsed));
    }
  } catch (err) {
    logger.warn('[DELIVERY-WAIT] wait failed (non-fatal):', (err as Error)?.message);
    result = 'skipped';
  } finally {
    options.budget?.spend(now() - start);
    try {
      await supabase.from(TABLE).delete().in('wamid', ids);
    } catch { /* best effort: rows are tiny and unused after this */ }
  }
  if (result === 'timeout') logger.info(`[DELIVERY-WAIT] timed out after ${timeoutMs}ms for ${ids.length} message(s); continuing`);
  return result;
}

/**
 * Wrap a sender so the WAMIDs of its image/document sends are registered at
 * once and collected for a later group wait. Other methods pass through.
 */
export function trackMediaDeliveries(
  sender: MessageSender,
  supabase: SupabaseClient | null | undefined,
): { sender: MessageSender; take: () => string[] } {
  let collected: string[] = [];
  const tracked = new Proxy(sender, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if ((prop === 'sendImage' || prop === 'sendDocument') && typeof value === 'function') {
        return async (msg: unknown) => {
          const result = await (value as (m: unknown) => Promise<{ messageId?: string } | undefined>).call(target, msg);
          const wamid = result?.messageId;
          if (wamid && supabase) {
            await registerDeliveryWait(supabase, wamid);
            collected.push(wamid);
          }
          return result;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
  return {
    sender: tracked,
    take: () => {
      const out = collected;
      collected = [];
      return out;
    },
  };
}
