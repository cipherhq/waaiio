/**
 * Cold party invites (Owner decision 2026-11-12, issue #1005): a guest who has never
 * messaged the business gets a WhatsApp invite template with Yes / Maybe / No buttons,
 * when the host confirms the guests agreed to hear from them. The send is charged as a
 * marketing message from the host's messaging balance, and an opt-out always wins.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';

export const PARTY_INVITE_TEMPLATE = 'waaiio_party_invite_v1';

/** The inbound quick-reply payloads, matched by the bot's RSVP button handler. */
const RSVP_BUTTON_RE = /^rsvp_(yes|maybe|no)_[a-f0-9-]{36}$/;

export function isRsvpButtonPayload(value: unknown): value is string {
  return typeof value === 'string' && RSVP_BUTTON_RE.test(value);
}

/** True unless the guest is known not to have opted out of WhatsApp from this business. Fails closed. */
export async function whatsappOptedOut(db: SupabaseClient, businessId: string, phone: string): Promise<boolean> {
  const digits = phone.replace(/\D/g, '');
  try {
    const { count, error } = await db.from('messaging_opt_outs')
      .select('id', { count: 'exact', head: true }).in('phone', [digits, `+${digits}`])
      .or(`business_id.eq.${businessId},business_id.is.null`)
      .eq('channel', 'whatsapp').is('resubscribed_at', null);
    if (error || count === null || count === undefined) return true;
    return count > 0;
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
