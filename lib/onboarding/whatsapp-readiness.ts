/** Read-only WhatsApp allocation readiness for admin assistance.
 * Never infer readiness from countries.is_active or a requested onboarding method.
 * Treat unrecognized channel types as pending, not an implicit platform fallback.
 */
export interface ReadinessBusiness {
  id: string;
  country_code: string | null;
}
export interface ReadinessChannel {
  channel_type: string | null;
  is_active: boolean;
  connection_status: string | null;
  country_code: string | null;
  business_id: string | null;
}
export function isAssignedWhatsAppChannelReady(
  business: ReadinessBusiness | null | undefined,
  channel: ReadinessChannel | null | undefined,
): boolean {
  if (!business || !channel || !channel.is_active || channel.connection_status !== 'active') return false;
  if (channel.channel_type === 'shared') {
    return !!business.country_code && channel.country_code === business.country_code && !channel.business_id;
  }
  if (channel.channel_type === 'dedicated') {
    return channel.business_id === business.id;
  }
  return false;
}

/** Match Get Started's link convention only after verifying channel readiness. */
export function buildVerifiedWhatsAppLink(
  business: (ReadinessBusiness & { bot_code: string | null; status: string }) | null | undefined,
  channel: (ReadinessChannel & { phone_number: string | null }) | null | undefined,
): string | null {
  if (!business || !channel || business.status !== 'active' || !isAssignedWhatsAppChannelReady(business, channel)) return null;
  const digits = String(channel.phone_number || '').replace(/[^0-9]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  if (channel.channel_type === 'dedicated') return 'https://wa.me/' + digits;
  const code = String(business.bot_code || '').trim();
  if (!code) return null;
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(code);
}
