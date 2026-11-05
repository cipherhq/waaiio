/**
 * Sending a web form invitation over WhatsApp (#591 contract, Owner chose "Build into Forms").
 *
 * Rules (RECIPIENT_POLICY): only people with recorded consent for this business are
 * messaged; opt-outs always win; a failed check means skip, never send. Inside a
 * verified 24-hour customer window the invite goes as text; outside it only an
 * approved template on the sending WABA may be used. Every recipient gets an honest
 * outcome: sent (accepted by WhatsApp), failed, or skipped with a reason.
 *
 * Shared by the immediate send route and, later, the scheduled-send cron.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResolvedChannel } from '@/lib/channels/channel-resolver';
import { GateBlockError } from '@/lib/channels/attempt-recording';
import { MessagingSuspendedError } from '@/lib/channels/send-guard';
import { isInviteCompatible } from './invite-template';
import { hasRecipientPermission } from '@/lib/merchants/recipient-permission';
import { normalizeEngagePhone } from '@/lib/engage/phone-normalize';
import { logger } from '@/lib/logger';

/**
 * Consent purpose a form invitation needs. Owner decision pending (#591): until then
 * the stricter purpose applies to every invitation.
 */
export const FORM_INVITE_PURPOSE = 'marketing' as const;

/** Interim per-send cap (Owner decision pending on limits). */
export const MAX_RECIPIENTS_PER_SEND = 100;
/** Most typed entries one request may carry, valid or not. */
export const MAX_TYPED_ENTRIES = 500;
/** Stop starting new recipients after this long, well inside the 60s function limit. */
export const SEND_TIME_BUDGET_MS = 40_000;

export type SkipReason = 'invalid_phone' | 'opted_out' | 'no_consent' | 'check_failed' | 'not_attempted';
export type FailReason = 'no_template' | 'provider_error' | 'blocked';
export type RecipientOutcome =
  | { phone: string; status: 'sent'; via: 'text' | 'template' }
  | { phone: string; status: 'failed'; reason: FailReason }
  | { phone: string; status: 'skipped'; reason: SkipReason };

export interface InviteForm { id: string; title: string; description: string | null; token: string }
export interface InviteTemplate { name: string; category: 'marketing' | 'utility' }

export const SKIP_REASON_TEXT: Record<SkipReason | FailReason, string> = {
  invalid_phone: 'Not a valid phone number',
  opted_out: 'Opted out of messages',
  no_consent: 'Has not opted in to updates',
  check_failed: 'Consent could not be checked',
  not_attempted: 'Not attempted: ran out of time. Send again to these people',
  no_template: 'Outside the 24-hour window and no approved template',
  provider_error: 'WhatsApp did not confirm it accepted the message',
  blocked: 'Sending is paused for this account',
};

export class TemplateLookupUnavailableError extends Error {
  constructor() { super('Templates could not be checked with WhatsApp right now.'); this.name = 'TemplateLookupUnavailableError'; }
}

export function formUrl(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  return `${appUrl}/form/${token}`;
}

/** Free-text invite, only used inside a verified 24-hour window. */
export function inviteText(form: InviteForm, businessName: string): string {
  return [
    `📋 *${form.title}*`,
    form.description || null,
    '',
    `from *${businessName}*`,
    '',
    'Please fill out this form:',
    formUrl(form.token),
  ].filter(v => v !== null).join('\n');
}

/** Template parameters: {{1}} business name, {{2}} one line with the form title and link. */
export function inviteTemplateParams(form: InviteForm, businessName: string): [string, string] {
  // Meta rejects template parameters containing new lines, tabs or 4+ spaces.
  const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, ' ').trim();
  return [oneLine(businessName).slice(0, 200), `${oneLine(form.title).slice(0, 200)}: ${formUrl(form.token)}`];
}

/** Normalize to E.164 with the business country, dropping duplicates. Invalid entries are kept as skips. */
export function normalizeRecipients(raw: string[], countryCode: string): { phones: string[]; invalid: string[] } {
  const phones = new Set<string>();
  const invalid = new Set<string>();
  for (const value of raw) {
    const e164 = typeof value === 'string' ? normalizeEngagePhone(value, countryCode) : null;
    if (e164) phones.add(e164);
    else invalid.add(typeof value === 'string' ? value.slice(0, 30) : '');
  }
  return { phones: Array.from(phones), invalid: Array.from(invalid) };
}

/** Opt-out first (for a precise reason), then the shared permission helper (which re-checks it). */
export async function classifyRecipient(db: SupabaseClient, businessId: string, e164: string): Promise<SkipReason | null> {
  const digits = e164.replace(/\D/g, '');
  try {
    const { count, error } = await db.from('messaging_opt_outs')
      .select('id', { count: 'exact', head: true }).in('phone', [digits, `+${digits}`])
      .or(`business_id.eq.${businessId},business_id.is.null`)
      .eq('channel', 'whatsapp').is('resubscribed_at', null);
    if (error || count === null || count === undefined) return 'check_failed';
    if (count > 0) return 'opted_out';
  } catch { return 'check_failed'; }
  return await hasRecipientPermission(db, businessId, e164, FORM_INVITE_PURPOSE) ? null : 'no_consent';
}

/** Service-window evidence comes from the sending channel's inbound receipts, never a session row. */
export async function hasServiceWindow(db: SupabaseClient, channelId: string | undefined, e164: string, now = Date.now()): Promise<boolean> {
  if (!channelId) return false;
  try {
    const { data, error } = await db.from('whatsapp_inbound_receipts').select('provider_timestamp')
      .eq('channel_id', channelId).eq('sender_phone', e164.replace(/\D/g, ''))
      .gte('provider_timestamp', new Date(now - 24 * 60 * 60_000).toISOString())
      .lte('provider_timestamp', new Date(now).toISOString())
      .order('provider_timestamp', { ascending: false }).limit(1).maybeSingle();
    return !error && !!data;
  } catch { return false; }
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;

/**
 * Looks the template up on the WABA that will actually send. Returns null when it
 * is missing or unsuitable; throws TemplateLookupUnavailableError when WhatsApp
 * could not be asked, so callers never mistake an outage for a bad template.
 */
export async function loadInviteTemplate(resolved: ResolvedChannel, name: string | null | undefined): Promise<InviteTemplate | null> {
  if (!name || !TEMPLATE_NAME.test(name) || !resolved.cloud || !resolved.sender.sendTemplate) return null;
  try {
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await resolved.cloud.getTemplates({ limit: 100, after });
      const t = result.data.find(x => x.name === name && x.language === 'en_US');
      if (t) return isInviteCompatible(t) ? { name, category: t.category === 'UTILITY' ? 'utility' : 'marketing' } : null;
      if (!result.paging?.next || !result.paging.cursors?.after) break;
      after = result.paging.cursors.after;
    }
  } catch (err) {
    logger.warn('[FORMS] Template lookup unavailable:', (err as Error).message);
    throw new TemplateLookupUnavailableError();
  }
  return null;
}

/** Send to one recipient that already passed classifyRecipient. Never throws. */
export async function deliverInvite(opts: {
  db: SupabaseClient; resolved: ResolvedChannel; businessId: string; businessName: string;
  form: InviteForm; template: InviteTemplate | null; phone: string;
}): Promise<RecipientOutcome> {
  const { db, resolved, businessId, businessName, form, template, phone } = opts;
  const to = phone.replace(/\D/g, '');
  const inWindow = await hasServiceWindow(db, resolved.channel?.id, phone);
  if (!inWindow && !template) {
    await logAttempt(db, businessId, phone, form, 'failed', SKIP_REASON_TEXT.no_template);
    return { phone, status: 'failed', reason: 'no_template' };
  }
  try {
    // Single attempt: an ambiguous retry could deliver the same invite twice.
    const result = inWindow
      ? await resolved.sender.sendText({ to, text: inviteText(form, businessName), messageCategory: 'service', noRetry: true })
      : await resolved.sender.sendTemplate!({
        to, templateName: template!.name, templateParams: inviteTemplateParams(form, businessName),
        messageCategory: template!.category, noRetry: true,
      });
    if (!result || result.success === false) throw new Error('Message not accepted');
    await logAttempt(db, businessId, phone, form, 'sent');
    return { phone, status: 'sent', via: inWindow ? 'text' : 'template' };
  } catch (err) {
    // A gate or suspension block is not a WhatsApp rejection; say which it was.
    const reason: FailReason = err instanceof GateBlockError || err instanceof MessagingSuspendedError ? 'blocked' : 'provider_error';
    logger.warn(`[FORMS] Invite not accepted for ...${to.slice(-4)}:`, (err as Error).message);
    await logAttempt(db, businessId, phone, form, 'failed', SKIP_REASON_TEXT[reason]);
    return { phone, status: 'failed', reason };
  }
}

/** Delivery log, same table Broadcasts uses. Logging never changes the outcome. */
async function logAttempt(db: SupabaseClient, businessId: string, phone: string, form: InviteForm, status: 'sent' | 'failed', reason?: string) {
  try {
    await db.from('notifications').insert({
      business_id: businessId, recipient_phone: phone, type: 'system', channel: 'whatsapp', status,
      body: `Form invitation: ${form.title}`,
      ...(status === 'sent' ? { sent_at: new Date().toISOString() } : { failed_reason: reason || null }),
    });
  } catch { /* log only */ }
}

/**
 * Classify then deliver every recipient, a few at a time. Stops starting new
 * recipients once the deadline passes, so a slow provider can never leave the
 * merchant without results; those people are reported as not attempted.
 */
export async function sendFormInvites(opts: {
  db: SupabaseClient; resolved: ResolvedChannel; businessId: string; businessName: string;
  form: InviteForm; template: InviteTemplate | null; phones: string[]; deadline?: number;
}): Promise<RecipientOutcome[]> {
  const deadline = opts.deadline ?? Date.now() + SEND_TIME_BUDGET_MS;
  const outcomes: RecipientOutcome[] = [];
  for (let i = 0; i < opts.phones.length; i += 5) {
    if (Date.now() >= deadline) {
      for (const phone of opts.phones.slice(i)) outcomes.push({ phone, status: 'skipped', reason: 'not_attempted' });
      break;
    }
    const batch = await Promise.all(opts.phones.slice(i, i + 5).map(async (phone): Promise<RecipientOutcome> => {
      const skip = await classifyRecipient(opts.db, opts.businessId, phone);
      if (skip) return { phone, status: 'skipped', reason: skip };
      return deliverInvite({ ...opts, phone });
    }));
    outcomes.push(...batch);
  }
  return outcomes;
}

export function summarize(outcomes: RecipientOutcome[]) {
  return {
    sent: outcomes.filter(o => o.status === 'sent').length,
    failed: outcomes.filter(o => o.status === 'failed').length,
    skipped: outcomes.filter(o => o.status === 'skipped').length,
  };
}
