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
