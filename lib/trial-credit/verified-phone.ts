import type { createServiceClient } from '@/lib/supabase/service';

type Service = ReturnType<typeof createServiceClient>;

/**
 * Owner phone verification for the free messaging (trial) credit.
 *
 * Owner decisions 2026-11-07: sign-up stays smooth; afterwards the owner
 * verifies a phone number to claim the free credit. Any number they receive
 * WhatsApp messages on counts (personal or everyday business number), but not
 * a number connected to Waaiio, which cannot receive the code. A number already
 * on another Waaiio login is refused for now (moving it is a follow-up).
 *
 * activate_trial_if_eligible (M465) reads the owner's auth phone_confirmed_at
 * and relies on auth.users' unique phone for "one trial per verified phone".
 */

export const digitsOf = (phone: string | null | undefined) => (phone || '').replace(/\D/g, '');

/** True when the number is an active WhatsApp channel on Waaiio (shared or a business's connected number). */
export async function isConnectedWaaiioNumber(service: Service, phone: string): Promise<boolean> {
  const target = digitsOf(phone);
  if (!target) return false;
  const { data, error } = await service.from('whatsapp_channels').select('phone_number').eq('is_active', true);
  if (error) throw new Error('channel lookup failed');
  return (data || []).some(row => digitsOf((row as { phone_number?: string | null }).phone_number) === target);
}

/** Supabase Auth's "this phone is on another login" error (422 `phone_exists`; older versions only say so in the message). */
export function isPhoneInUseError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === 'phone_exists') return true;
  const message = (error.message || '').toLowerCase();
  return message.includes('phone') && (message.includes('exist') || message.includes('registered') || message.includes('already'));
}

export type AttachResult =
  | { ok: true; alreadyVerified: boolean }
  | { ok: false; reason: 'phone_in_use' | 'other_phone_already_verified' | 'failed' };

/**
 * Attach a phone the user has just proved they own (code checked by the
 * caller) to their login as a confirmed phone.
 * - Same number already confirmed on this login: nothing to do.
 * - A different confirmed number on this login: refused, so a claim never
 *   replaces the number the owner signs in with.
 * - Number on another login: refused (auth.users phone is unique).
 */
export async function attachVerifiedPhone(service: Service, userId: string, phone: string): Promise<AttachResult> {
  const { data: current, error: readError } = await service.auth.admin.getUserById(userId);
  if (readError || !current?.user) return { ok: false, reason: 'failed' };
  const existing = digitsOf(current.user.phone);
  if (existing && current.user.phone_confirmed_at) {
    return existing === digitsOf(phone) ? { ok: true, alreadyVerified: true } : { ok: false, reason: 'other_phone_already_verified' };
  }
  const { error } = await service.auth.admin.updateUserById(userId, { phone, phone_confirm: true });
  if (error) return { ok: false, reason: isPhoneInUseError(error) ? 'phone_in_use' : 'failed' };
  return { ok: true, alreadyVerified: false };
}
