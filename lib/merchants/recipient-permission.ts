import type { SupabaseClient } from '@supabase/supabase-js';

export const RECIPIENT_POLICY = 'Cold messaging is not allowed. Only contact people who have opted in to this business for this type of message. A previous purchase alone is not consent.';

/** Merchant-initiated sends only; never changes bot replies or manufactures consent. */
export async function hasRecipientPermission(
  db: SupabaseClient, businessId: string, phone: string,
  purpose: 'utility' | 'marketing', channel: 'whatsapp' | 'email' = 'whatsapp',
): Promise<boolean> {
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (!businessId || !/^[1-9]\d{6,14}$/.test(digits)) return false;
  const variants = [digits, `+${digits}`];
  try {
    const { count, error: blockedError } = await db.from('messaging_opt_outs')
      .select('id', { count: 'exact', head: true }).in('phone', variants)
      .or(`business_id.eq.${businessId},business_id.is.null`)
      .eq('channel', channel).is('resubscribed_at', null);
    if (blockedError || count !== 0) return false;
    // Latest record across both historical phone formats wins, including revocation.
    const { data, error } = await db.from('customer_consents')
      .select('status, expires_at').eq('business_id', businessId)
      .in('phone', variants).eq('channel', channel).eq('purpose', purpose)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(1).maybeSingle();
    if (error || data?.status !== 'granted') return false;
    return !data.expires_at || new Date(data.expires_at).getTime() > Date.now();
  } catch { return false; }
}
