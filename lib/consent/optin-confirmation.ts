/**
 * Confirming a web form "send me updates" tick on WhatsApp (#591, Owner option C part B1).
 *
 * Owner decisions (2026-11-06, issue #591):
 *  - A web tick alone never counts; the customer must confirm on WhatsApp (Q2).
 *  - A confirmed Yes grants BOTH `marketing` and `utility` (Q1).
 *  - A newer Yes clears an OLDER STOP for that business only. A STOP newer than the
 *    request always wins. Global opt-outs (business_id NULL) are never cleared (Q3).
 *  - Merchants cannot mark people opted in (Q4): only the signature-verified Meta
 *    webhook reaches the handler, and only with a nonce the merchant never sees.
 *  - A pending request expires after 30 days; a granted opt-in never expires (Q5).
 *
 * The nonce is sent only to the typed phone number and never stored: the pending
 * consent row keeps sha256(nonce) in evidence_reference, which merchants can read.
 * The business is always taken from that pending row, never from the session,
 * the channel or the payload.
 */
import { createHash, randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver, type ResolvedChannel } from '@/lib/channels/channel-resolver';
import type { MessageSender } from '@/lib/channels/message-sender';
import { businessChatWindowState } from '@/lib/forms/form-send';
import { getPoweredByInteractiveFooter } from '@/lib/whitelabel';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export const OPTIN_PAYLOAD_RE = /^optin_(yes|no):([A-Za-z0-9_-]{20,})$/;
export const OPTIN_POLICY_VERSION = 'optin-v1';
/** Owner submits this template (see PR description); it is not auto-provisioned. */
export const OPTIN_TEMPLATE_NAME = 'waaiio_updates_optin_v1';
export const OPTIN_TEMPLATE_LANGUAGE = 'en';
export const OPTIN_REQUEST_TTL_MS = 30 * 24 * 60 * 60_000;
/** At most this many confirmation requests per phone (all businesses) per rolling 24 hours. */
export const MAX_REQUESTS_PER_PHONE_PER_DAY = 3;
/** At most this many confirmation requests per business per UTC day. */
export const MAX_REQUESTS_PER_BUSINESS_PER_DAY = 200;

const DAY_MS = 24 * 60 * 60_000;
const YES_TITLE = 'Yes, send updates';
const NO_TITLE = 'No thanks';
const MENU_BUTTONS = [{ id: 'menu', title: 'Main menu' }];

export function isOptInPayload(value: unknown): value is string {
  return typeof value === 'string' && OPTIN_PAYLOAD_RE.test(value);
}

export function newOptInNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOptInNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/** evidence_reference of the pending request row. Only the hash is stored. */
export function pendingEvidence(formId: string, nonce: string): string {
  return `form:${formId}|confirm:${hashOptInNonce(nonce)}`;
}

/**
 * A request that was actually delivered gets "|sent:<iso>" appended. A request that
 * was never sent does not block a fresh tick (see the form submit route).
 */
export const SENT_REQUEST_RE = /\|confirm:[0-9a-f]{64}\|sent:[^|]+$/;

/** Meta rejects template parameters containing new lines, tabs or 4+ spaces. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, ' ').trim().slice(0, 200);
}

function requestText(businessName: string): string {
  return `You asked *${businessName}* to send you updates on WhatsApp. Tap Yes to confirm. Reply STOP at any time to opt out.`;
}

/**
 * The opt-in template on the WABA that will actually send: approved, `en`, body takes
 * only {{1}}, and its buttons are exactly two quick replies. Null when missing,
 * unsuitable or the lookup failed (the request then stays pending, nothing is sent).
 */
export async function loadOptInTemplate(resolved: ResolvedChannel): Promise<{ category: 'marketing' | 'utility' } | null> {
  if (!resolved.cloud || !resolved.sender.sendTemplate) return null;
  try {
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await resolved.cloud.getTemplates({ limit: 100, after });
      const t = result.data.find(x => x.name === OPTIN_TEMPLATE_NAME && x.language === OPTIN_TEMPLATE_LANGUAGE);
      if (t) {
        if (t.status !== 'APPROVED' || (t.category !== 'MARKETING' && t.category !== 'UTILITY')) return null;
        const body = t.components?.find(c => c.type === 'BODY');
        const slots = [...(body?.text || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]);
        if (slots.length !== 1 || slots[0] !== '1') return null;
        const buttons = t.components?.find(c => c.type === 'BUTTONS')?.buttons || [];
        if (buttons.length !== 2 || buttons.some(b => b.type !== 'QUICK_REPLY')) return null;
        if (t.components.some(c => c.type === 'HEADER' && /\{\{/.test(c.text || ''))) return null;
        return { category: t.category === 'UTILITY' ? 'utility' : 'marketing' };
      }
      if (!result.paging?.next || !result.paging.cursors?.after) break;
      after = result.paging.cursors.after;
    }
  } catch (err) {
    logger.warn('[OPTIN] Template lookup unavailable:', (err as Error).message);
  }
  return null;
}

export type ConfirmationSendOutcome =
  | 'sent_buttons' | 'sent_template' | 'failed'
  | 'skipped_opted_out' | 'skipped_phone_cap' | 'skipped_business_cap'
  | 'skipped_no_business' | 'skipped_no_channel' | 'skipped_no_template' | 'skipped_window_unknown'
  | 'skipped_no_window_dedicated';

/**
 * Send the confirmation request for a NEW pending row. Never throws, so it can never
 * fail the form submit. Any failed check means skip; the row then stays pending.
 * A delivered request is marked "|sent:<iso>" on its evidence_reference.
 */
export async function sendOptInConfirmationRequest(
  db: SupabaseClient,
  request: { businessId: string; phone: string; requestId: string; nonce: string; evidenceReference: string },
  now = Date.now(),
): Promise<ConfirmationSendOutcome> {
  const outcome = await deliverConfirmationRequest(db, request, now);
  if (outcome === 'sent_buttons' || outcome === 'sent_template') {
    try {
      const { error } = await db.from('customer_consents')
        .update({ evidence_reference: `${request.evidenceReference}|sent:${new Date(now).toISOString()}` })
        .eq('id', request.requestId).eq('status', 'pending').eq('evidence_reference', request.evidenceReference);
      if (error) logger.warn('[OPTIN] Request not marked sent:', error.message);
    } catch (err) { logger.warn('[OPTIN] Request not marked sent:', (err as Error).message); }
  }
  return outcome;
}

async function deliverConfirmationRequest(
  db: SupabaseClient,
  request: { businessId: string; phone: string; requestId: string; nonce: string },
  now: number,
): Promise<ConfirmationSendOutcome> {
  const { businessId, requestId, nonce } = request;
  const digits = request.phone.replace(/\D/g, '');
  const variants = [digits, `+${digits}`];
  try {
    const { count: blocked, error: blockedError } = await db.from('messaging_opt_outs')
      .select('id', { count: 'exact', head: true }).in('phone', variants)
      .or(`business_id.eq.${sanitizeFilterValue(businessId)},business_id.is.null`)
      .eq('channel', 'whatsapp').is('resubscribed_at', null);
    if (blockedError || blocked !== 0) return 'skipped_opted_out';

    // Caps are counted in the database. Only request rows carry "|confirm:" (granted
    // rows start with "confirm:"). The new row itself is not counted.
    const { count: perPhone, error: phoneError } = await db.from('customer_consents')
      .select('id', { count: 'exact', head: true }).in('phone', variants)
      .eq('status', 'pending').like('evidence_reference', '%|confirm:%')
      .gte('created_at', new Date(now - DAY_MS).toISOString()).neq('id', requestId);
    if (phoneError || perPhone === null || perPhone === undefined || perPhone >= MAX_REQUESTS_PER_PHONE_PER_DAY) return 'skipped_phone_cap';

    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const { count: perBusiness, error: businessError } = await db.from('customer_consents')
      .select('id', { count: 'exact', head: true }).eq('business_id', businessId)
      .eq('status', 'pending').like('evidence_reference', '%|confirm:%')
      .gte('created_at', dayStart.toISOString()).neq('id', requestId);
    if (businessError || perBusiness === null || perBusiness === undefined || perBusiness >= MAX_REQUESTS_PER_BUSINESS_PER_DAY) return 'skipped_business_cap';

    const { data: biz } = await db.from('businesses')
      .select('name, subscription_tier, is_whitelabel').eq('id', businessId).maybeSingle();
    if (!biz?.name) return 'skipped_no_business';

    const resolved = await new ChannelResolver(db).resolveByBusinessId(businessId);
    if (!resolved?.channel?.id) return 'skipped_no_channel';

    const yes = `optin_yes:${nonce}`;
    const no = `optin_no:${nonce}`;
    // Free-form only inside THIS business's own window: on a shared number a receipt
    // alone may come from a chat with another business. Unreadable evidence: skip.
    const window = await businessChatWindowState(db, businessId, resolved.channel, request.phone, now);
    if (window === 'unknown') return 'skipped_window_unknown';
    if (window === 'open') {
      // Single attempt: an ambiguous retry could deliver the request twice.
      const result = await resolved.sender.sendButtons({
        to: digits, body: requestText(biz.name),
        buttons: [{ id: yes, title: YES_TITLE }, { id: no, title: NO_TITLE }],
        footer: getPoweredByInteractiveFooter(biz.subscription_tier, biz.is_whitelabel),
        messageCategory: 'service', noRetry: true,
      });
      return result?.success === false ? 'failed' : 'sent_buttons';
    }

    // Templates are used only on Waaiio's shared number (the platform account).
    if (resolved.channel.channel_type !== 'shared') return 'skipped_no_window_dedicated';
    const template = await loadOptInTemplate(resolved);
    if (!template) return 'skipped_no_template';
    // Single attempt: an ambiguous retry could deliver the request twice.
    const result = await resolved.sender.sendTemplate!({
      to: digits, templateName: OPTIN_TEMPLATE_NAME, languageCode: OPTIN_TEMPLATE_LANGUAGE,
      templateParams: [oneLine(biz.name)], quickReplyPayloads: [yes, no],
      messageCategory: template.category, noRetry: true,
    });
    return result?.success === false ? 'failed' : 'sent_template';
  } catch (err) {
    logger.warn(`[OPTIN] Confirmation request not sent for ...${digits.slice(-4)}:`, (err as Error).message);
    return 'failed';
  }
}

export interface OptInReply { body: string; buttons: Array<{ id: string; title: string }>; footer?: string }

/** Control reply on the inbound channel; buttons give the customer a next step. */
export function sendOptInControlReply(sender: Pick<MessageSender, 'sendPlatformButtons' | 'sendPlatformText'>, to: string, reply: OptInReply) {
  if (sender.sendPlatformButtons) return sender.sendPlatformButtons({ to, body: reply.body, buttons: reply.buttons, footer: reply.footer });
  if (sender.sendPlatformText) return sender.sendPlatformText({ to, text: reply.body });
  throw new Error('Platform control replies unavailable');
}

const EXPIRED = 'This request has expired or is no longer valid. If you still want updates, tick "send me updates" on the business\'s form again.';

/**
 * Called only by the signature-verified Meta transport, before the bot. Returns true
 * for every opt-in payload (so it never reaches flows), false for anything else.
 */
export async function handleOptInConfirmation(input: {
  db: SupabaseClient;
  provenance: 'verified_meta_webhook';
  from: string; text: string; messageType: string; messageId?: string;
  channel: { id: string; channel_type: string; business_id?: string | null; is_active: boolean; provider: string };
  sendReply: (reply: OptInReply) => Promise<unknown>;
  /** Sending channel id of a business (its shared-number allocation). Injectable for tests. */
  resolveBusinessChannelId?: (businessId: string) => Promise<string | null>;
  now?: number;
}): Promise<boolean> {
  if (input.provenance !== 'verified_meta_webhook') return false;
  // Only a tapped button counts; typed text is never accepted (no typed "YES").
  if (input.messageType !== 'button') return false;
  const match = OPTIN_PAYLOAD_RE.exec(input.text);
  if (!match) return false;

  const { db, channel } = input;
  const now = input.now ?? Date.now();
  const reply = (r: OptInReply) => input.sendReply(r).catch(err => {
    logger.warn('[OPTIN] Reply not sent:', (err as Error).message);
  });
  const expired = () => reply({ body: EXPIRED, buttons: MENU_BUTTONS });

  try {
    const digits = input.from.replace(/\D/g, '');
    if (!/^[1-9]\d{6,14}$/.test(digits) || !channel.is_active || channel.provider !== 'meta_cloud') {
      await expired(); return true;
    }
    const variants = [digits, `+${digits}`];
    const hash = hashOptInNonce(match[2]);

    // The request row for THIS verified sender. The business comes from this row only.
    const { data: row, error: rowError } = await db.from('customer_consents')
      .select('id, business_id, created_at').in('phone', variants)
      .eq('channel', 'whatsapp').eq('purpose', 'marketing').eq('status', 'pending')
      .like('evidence_reference', `%|confirm:${hash}%`)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (rowError || !row) { await expired(); return true; }
    const businessId = row.business_id as string;

    // The tap must arrive on the number that business sends from.
    if (channel.channel_type === 'shared') {
      const resolve = input.resolveBusinessChannelId
        ?? (async (id: string) => (await new ChannelResolver(db).resolveByBusinessId(id))?.channel?.id ?? null);
      if ((await resolve(businessId)) !== channel.id) { await expired(); return true; }
    } else if (channel.business_id !== businessId) {
      await expired(); return true;
    }

    // Only a Yes needs a live request (Q5); recording a decline is always safe.
    const requestedAt = Date.parse(row.created_at as string);
    const isExpired = !Number.isFinite(requestedAt) || now - requestedAt > OPTIN_REQUEST_TTL_MS;
    if (match[1] === 'yes' && isExpired) { await expired(); return true; }

    const { data: biz } = await db.from('businesses')
      .select('name, subscription_tier, is_whitelabel').eq('id', businessId).maybeSingle();
    const name = (biz?.name as string | undefined) || 'this business';
    const footer = getPoweredByInteractiveFooter(biz?.subscription_tier, biz?.is_whitelabel);
    const nowIso = new Date(now).toISOString();
    const evidence = `confirm:${hash}|req:${row.id}|wamid:${input.messageId || 'unknown'}`;
    const base = {
      business_id: businessId, phone: `+${digits}`, channel: 'whatsapp', source: 'whatsapp',
      policy_version: OPTIN_POLICY_VERSION, evidence_reference: evidence, expires_at: null,
    };

    if (match[1] === 'no') {
      // Owner decision 2026-11-06 ("Promotions only"): a decline revokes marketing only;
      // any existing utility permission is left as it is.
      const { error } = await db.from('customer_consents').insert({
        ...base, purpose: 'marketing', status: 'revoked', revoked_at: nowIso,
      });
      if (error) {
        logger.warn('[OPTIN] Decline not recorded:', error.message);
        await reply({ body: 'Sorry, we could not save your answer. Please tap the button again.', buttons: MENU_BUTTONS, footer });
        return true;
      }
      await reply({ body: `No problem. *${name}* will not send you updates on WhatsApp.`, buttons: MENU_BUTTONS, footer });
      return true;
    }

    // STOP check: a STOP newer than the request always wins; a global opt-out is never cleared.
    const { data: optOuts, error: optOutError } = await db.from('messaging_opt_outs')
      .select('id, business_id, opted_out_at').in('phone', variants)
      .or(`business_id.eq.${sanitizeFilterValue(businessId)},business_id.is.null`)
      .eq('channel', 'whatsapp').is('resubscribed_at', null);
    if (optOutError || !optOuts) {
      await reply({ body: 'Sorry, we could not confirm this right now. Please tap the button again in a few minutes.', buttons: MENU_BUTTONS, footer });
      return true;
    }
    const newerStop = optOuts.some(o => {
      const at = Date.parse(o.opted_out_at as string);
      return !Number.isFinite(at) || at > requestedAt;
    });
    if (newerStop) {
      await reply({ body: `You unsubscribed from *${name}* after this request, so updates stay off.`, buttons: MENU_BUTTONS, footer });
      return true;
    }
    if (optOuts.some(o => o.business_id === null || o.business_id === undefined)) {
      await reply({ body: 'You have opted out of all messages on this number, so updates stay off.', buttons: MENU_BUTTONS, footer });
      return true;
    }

    // The request must still be the latest marketing record for this business and phone.
    const { data: latest, error: latestError } = await db.from('customer_consents')
      .select('id, status').eq('business_id', businessId).in('phone', variants)
      .eq('channel', 'whatsapp').eq('purpose', 'marketing')
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(1).maybeSingle();
    if (latestError || !latest) { await expired(); return true; }
    if (latest.id !== row.id) {
      if (latest.status === 'granted') {
        await reply({ body: `You're already subscribed to updates from *${name}*. Reply STOP at any time to opt out.`, buttons: MENU_BUTTONS, footer });
      } else {
        await expired();
      }
      return true;
    }

    // Write the grants first; if clearing the old STOP then fails, it still blocks (safe).
    const { error: grantError } = await db.from('customer_consents').insert(['marketing', 'utility'].map(purpose => ({
      ...base, purpose, status: 'granted', granted_at: nowIso,
    })));
    if (grantError) {
      logger.warn('[OPTIN] Grant not recorded:', grantError.message);
      await reply({ body: 'Sorry, we could not save your answer. Please tap the button again.', buttons: MENU_BUTTONS, footer });
      return true;
    }
    if (optOuts.length > 0) {
      const { error: clearError } = await db.from('messaging_opt_outs')
        .update({ resubscribed_at: nowIso })
        .in('phone', variants).eq('business_id', businessId).eq('channel', 'whatsapp')
        .lt('opted_out_at', row.created_at as string).is('resubscribed_at', null);
      if (clearError) logger.warn('[OPTIN] Older opt-out not cleared:', clearError.message);
    }
    await reply({ body: `You're subscribed ✅ *${name}* can now send you updates on WhatsApp. Reply STOP at any time to opt out.`, buttons: MENU_BUTTONS, footer });
    return true;
  } catch (err) {
    logger.warn('[OPTIN] Confirmation failed:', (err as Error).message);
    await reply({ body: 'Sorry, we could not confirm this right now. Please tap the button again in a few minutes.', buttons: MENU_BUTTONS });
    return true;
  }
}
