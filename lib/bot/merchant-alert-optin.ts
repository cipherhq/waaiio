import { createServiceClient } from '@/lib/supabase/service';
import { hashInvitation, missingSchema, normalizeAddress } from '@/lib/merchant-notifications/enrollment';
import { isMerchantNotificationsEnabled } from '@/lib/merchant-notifications/types';

/** Called only by the signature-verified Meta transport, never BotService recursion. */
export async function handleMerchantAlertOptIn(input: {
  db: ReturnType<typeof createServiceClient>;
  provenance: 'verified_meta_webhook';
  from: string; text: string; messageType: string;
  channel: {id:string; channel_type:string; is_active:boolean; provider:string};
  sendReply: (text:string) => Promise<unknown>;
}): Promise<boolean> {
  const {db,channel} = input;
  if (input.provenance !== 'verified_meta_webhook' || input.messageType !== 'text' || channel.channel_type !== 'shared' || !channel.is_active || channel.provider !== 'meta_cloud') return false;
  let address: string;
  try { address = normalizeAddress('whatsapp',`+${input.from.replace(/^\+/,'')}`); } catch { return false; }
  const text = input.text.trim();
  if (/^(STOP|UNSUBSCRIBE|OPT OUT|OPT-OUT)$/i.test(text)) {
    // Always preserve the existing customer STOP path, including during rollout-off.
    const result = await db.rpc('revoke_merchant_notification_whatsapp',{p_address:address,p_channel_id:channel.id})
      .then(value => value, () => ({error:{code:'unavailable'},data:null}));
    if (result.error && !missingSchema(result.error)) {
      // Do not hide a failed merchant opt-out behind a successful customer response.
      await input.sendReply('Merchant notification opt-out could not be saved. Please ask the business owner to remove this recipient in notification settings.').catch(() => undefined);
    }
    return false;
  }
  const match = /^WAAIIO ALERTS ([A-Za-z0-9_-]{43})(?:\n[^\r\n]{1,300})?$/i.exec(text);
  if (!match) return false;
  if (!isMerchantNotificationsEnabled()) return true;
  const {data,error} = await db.rpc('consume_merchant_notification_invitation',{p_token_hash:hashInvitation(match[1]),p_channel:'whatsapp',p_address:address,p_channel_id:channel.id});
  await input.sendReply(!error && data?.verified
    ? 'Merchant notifications are now enabled for this number. Reply STOP at any time to stop these alerts.'
    : 'This invitation is invalid, expired, or intended for another number. Ask the business owner for a new invitation.');
  return true;
}
