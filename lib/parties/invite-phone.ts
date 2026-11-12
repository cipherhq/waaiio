import { normalizeEngagePhone } from '@/lib/engage/phone-normalize';
import type { SupabaseClient } from '@supabase/supabase-js';
import { stripPlus } from '@/lib/utils/phone';
import { logger } from '@/lib/logger';

/**
 * Canonical event/party invite guest phone: international digits without '+'
 * (e.g. NG business, '0803 123 4567' → '2348031234567'). WhatsApp delivers the
 * sender as international digits, so local-format storage never matches the bot's
 * RSVP lookup. Falls back to the input's digits when the number cannot be parsed.
 */
export function toInviteGuestPhone(raw: string, businessCountryCode?: string | null): string {
  const digits = String(raw || '').replace(/\D/g, '');
  const e164 = normalizeEngagePhone(String(raw || ''), businessCountryCode || undefined)
    || normalizeEngagePhone(`+${digits}`);
  return e164 ? stripPlus(e164) : digits;
}

/** Stored forms an existing invite for this guest may have: canonical plus pre-normalization raw digits. */
export function inviteGuestPhoneVariants(phone: string, raw: string): string[] {
  return [...new Set([phone, String(raw || '').replace(/\D/g, '')].filter(Boolean))];
}

/**
 * Resolve the existing invite among rows matched by inviteGuestPhoneVariants.
 * Prefers the canonical row; a legacy local-format row is upgraded in place so a
 * resend does not create a duplicate invite and the bot can match the guest.
 */
export async function adoptExistingInvite<T extends { id: string; guest_phone: string }>(
  supabase: SupabaseClient,
  rows: T[] | null,
  phone: string,
): Promise<T | null> {
  if (!rows?.length) return null;
  const canonical = rows.find(r => r.guest_phone === phone);
  if (canonical) return canonical;
  const legacy = rows[0];
  const { error } = await supabase.from('event_invites').update({ guest_phone: phone }).eq('id', legacy.id);
  if (error) {
    logger.warn('[INVITE] Legacy guest phone upgrade failed (keeping stored form):', error.message);
    return legacy;
  }
  return { ...legacy, guest_phone: phone };
}
