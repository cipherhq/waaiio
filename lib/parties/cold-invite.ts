/**
 * Cold party invites (Owner decision 2026-11-12, issue #1005): a guest who has never
 * messaged the business gets a WhatsApp invite template with Yes / Maybe / No buttons,
 * when the host confirms the guests agreed to hear from them. The send is charged as a
 * marketing message from the host's messaging balance, and an opt-out always wins.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export const PARTY_INVITE_TEMPLATE = 'waaiio_party_invite_v1';

/** The inbound quick-reply payloads, matched by the bot's RSVP button handler. */
const RSVP_BUTTON_RE = /^rsvp_(yes|maybe|no)_[a-f0-9-]{36}$/;

export function isRsvpButtonPayload(value: unknown): value is string {
  return typeof value === 'string' && RSVP_BUTTON_RE.test(value);
}

/**
 * True when the guest must not get a cold invite from this business: they opted out of its
 * WhatsApp messages (STOP), or their latest answer to its WhatsApp marketing request is a
 * revocation ("No thanks"), as every other marketing send honours. Fails closed.
 */
export async function coldInviteBlocked(db: SupabaseClient, businessId: string, phone: string): Promise<boolean> {
  const digits = phone.replace(/\D/g, '');
  const variants = [digits, `+${digits}`];
  try {
    const { count, error } = await db.from('messaging_opt_outs')
      .select('id', { count: 'exact', head: true }).in('phone', variants)
      .or(`business_id.eq.${sanitizeFilterValue(businessId)},business_id.is.null`)
      .eq('channel', 'whatsapp').is('resubscribed_at', null);
    if (error || count === null || count === undefined || count > 0) return true;
    // Latest answer across both phone formats wins; an unanswered (pending) request is not an answer.
    const { data, error: consentError } = await db.from('customer_consents')
      .select('status').eq('business_id', businessId).in('phone', variants)
      .eq('channel', 'whatsapp').eq('purpose', 'marketing').neq('status', 'pending')
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(1).maybeSingle();
    if (consentError) return true;
    return data?.status === 'revoked';
  } catch {
    return true;
  }
}

/** Send the button invite template. Returns false when it could not be sent (for example not yet approved). */
export async function sendColdPartyInvite(
  sender: MessageSender,
  input: { to: string; details: string; inviteId: string },
): Promise<boolean> {
  if (!sender.sendTemplate) return false;
  try {
    const result = await sender.sendTemplate({
      to: input.to,
      templateName: PARTY_INVITE_TEMPLATE,
      templateParams: [input.details],
      quickReplyPayloads: ['yes', 'maybe', 'no'].map(choice => `rsvp_${choice}_${input.inviteId}`),
      messageCategory: 'marketing',
      noRetry: true,
    });
    return result.success !== false;
  } catch (err) {
    logger.warn('[INVITE] Party invite template not sent:', (err as Error).message);
    return false;
  }
}
