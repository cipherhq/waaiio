import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver, type ResolvedChannel } from '@/lib/channels/channel-resolver';
import { sendEmail } from '@/lib/email/client';
import { isMerchantNotificationsEnabled, MERCHANT_NOTIFICATION_TEMPLATE, type MerchantNotificationDelivery } from './types';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function merchantNotificationEmail(business: string, payload: MerchantNotificationDelivery['payload']) {
  return {
    subject: `${payload.title} — ${business}`,
    html: `<h1>${escape(payload.title)}</h1><p>${escape(business)}</p><p>Reference: ${escape(payload.reference)}</p><p>${escape(payload.detail)}</p><p><a href="https://www.waaiio.com/dashboard">Open Waaiio</a></p><p>You receive these operational alerts because you opted in. The business owner can update your notification preferences.</p>`,
  };
}
/** Safe retries stop at the durable dispatch fence. Provider acceptance is not delivery. */
export async function deliverMerchantNotification(db: SupabaseClient, d: MerchantNotificationDelivery) {
  if (!isMerchantNotificationsEnabled()) return 'disabled';
  const finish = async (state: 'pending'|'accepted'|'unknown'|'failed', reason: string, providerId: string|null = null) => {
    const result = await db.rpc('finish_merchant_notification', {p_id:d.id,p_claim_token:d.claim_token,p_state:state,p_provider_id:providerId,p_reason:reason});
    if (result.error || result.data !== true) throw new Error('Merchant notification outcome could not be persisted');
    return state;
  };
  let resolved: ResolvedChannel|null = null;
  let businessName: string;
  try {
    const business = await db.from('businesses').select('name').eq('id',d.business_id).single();
    if (business.error || !business.data) return finish('pending','business_unavailable');
    businessName = business.data.name;
    if (d.channel === 'email') {
      if (!process.env.RESEND_API_KEY) return finish('pending','email_unavailable');
    } else {
      if (!d.whatsapp_channel_id) return finish('failed','consent_channel_missing');
      resolved = await new ChannelResolver(db).resolveByChannelIdForBusiness(d.whatsapp_channel_id,d.business_id);
      if (!resolved?.cloud || !resolved.sender.sendTemplate) return finish('pending','channel_unavailable');
      const templates = await resolved.cloud.getTemplates();
      const approved = templates.data.some(t => t.name===MERCHANT_NOTIFICATION_TEMPLATE && t.status==='APPROVED' && t.category==='UTILITY' && t.language==='en_US');
      if (!approved) return finish('pending','template_unavailable');
    }
  } catch {
    return finish('pending','preflight_unavailable');
  }
  const fence = await db.rpc('fence_merchant_notification',{p_id:d.id,p_claim_token:d.claim_token});
  if (fence.error) throw new Error('Merchant notification dispatch fence unavailable');
  if (fence.data !== true) return 'suppressed';
  let providerId: string|null = null;
  try {
    if (d.channel === 'email') {
      const result = await sendEmail({to:d.address,...merchantNotificationEmail(businessName!,d.payload),noRetry:true});
      if (result.success === true && !('dev' in result && result.dev) && 'id' in result && result.id) providerId=result.id;
    } else {
      const result = await resolved!.sender.sendTemplate!({to:d.address,templateName:MERCHANT_NOTIFICATION_TEMPLATE,templateParams:[businessName!,d.payload.title,d.payload.reference,d.payload.detail],messageCategory:'utility',noRetry:true});
      if (result.success === true && result.messageId) providerId=result.messageId;
    }
  } catch {
    // Timeout/crash can occur after provider acceptance; never automatically replay.
    return finish('unknown','provider_outcome_unknown');
  }
  return providerId ? finish('accepted','provider_accepted',providerId) : finish('unknown','provider_acceptance_unconfirmed');
}

export async function dispatchMerchantNotifications(db: SupabaseClient, limit=20) {
  if (!isMerchantNotificationsEnabled()) return {enabled:false,processed:0};
  let processed=0;
  const deadline=Date.now()+45_000;
  for (let i=0;i<Math.min(Math.max(limit,0),20);i++) {
    if (Date.now()>=deadline) break;
    const claim=await db.rpc('claim_merchant_notification');
    if (claim.error) throw new Error('Merchant notification queue unavailable');
    if (!claim.data) break;
    await deliverMerchantNotification(db,claim.data as MerchantNotificationDelivery);
    processed++;
  }
  return {enabled:true,processed};
}
