import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver, type ResolvedChannel } from '@/lib/channels/channel-resolver';
import { hasRecipientPermission } from '@/lib/merchants/recipient-permission';
import { findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { formatDisplayDate, formatDisplayTime } from '@/lib/bot/format-date';
import { isSmsEligible } from '@/lib/sms/bulksms-ng';
import type { CountryCode } from '@/lib/constants';
export type ReminderPurpose = 'chase' | 'followup';
export type ReminderChannel = 'whatsapp_text' | 'whatsapp_template' | 'email' | 'sms';
export type Variant = { channel: ReminderChannel; available: boolean; reason: string; text: string; category: 'service' | 'marketing'; address?: string; subject?: string; html?: string; templateParams?: string[] };
export type ReminderRecipient = { id: string; name: string; phone: string; status: string; eligible: boolean; exclusion: string; variants: Variant[] };
export type ReminderPreview = { transport?: { channelId: string; provider: string; wabaId: string | null; phoneNumberId: string | null } | null; partyId: string; businessId: string; purpose: ReminderPurpose; scheduledDate: string; fingerprint: string; recipients: ReminderRecipient[]; notice: string };
export const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const key = () => { const value = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!value) throw new Error('Preview signing is unavailable.'); return value; };
type Ticket = { partyId: string; actorId: string; purpose: ReminderPurpose; fingerprint: string; occurrence: string; expires: number };
export function signPreview(preview: ReminderPreview, actorId: string): string {
 const ticket:Ticket={partyId:preview.partyId,actorId,purpose:preview.purpose,fingerprint:preview.fingerprint,occurrence:randomUUID(),expires:Date.now()+15*60_000};
 const payload=Buffer.from(JSON.stringify(ticket)).toString('base64url');
 return payload+'.'+createHmac('sha256',key()).update(payload).digest('base64url');
}
export function verifyPreview(token: string, partyId: string, actorId: string): Ticket {
 const [payload,signature,extra]=token.split('.');
 if (!payload || !signature || extra) throw new Error('Review a fresh reminder preview.');
 const expected=createHmac('sha256',key()).update(payload).digest(); const actual=Buffer.from(signature,'base64url');
 if (actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw new Error('Invalid reminder preview.');
 const ticket=JSON.parse(Buffer.from(payload,'base64url').toString()) as Ticket;
 if (ticket.partyId!==partyId || ticket.actorId!==actorId || ticket.purpose!=='chase' || ticket.expires<Date.now()) throw new Error('Review a fresh reminder preview.');
 return ticket;
}
export function scheduledOccurrence(partyId:string,date:string,inviteId:string) {
 const h=fingerprint({partyId,date,inviteId,purpose:'followup'});
 return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** Compatibility: preserve the existing cron's date calculation; no timezone policy change. */
export function followupDate(date:string,days:number) {
 const d=new Date(date+'T00:00'); d.setDate(d.getDate()-days); return d.toISOString().slice(0,10);
}
async function smsPermission(db:SupabaseClient,businessId:string,phone:string) {
 const digits=phone.replace(/\D/g,''); if (!/^[1-9]\d{6,14}$/.test(digits)) return false;
 const variants=[digits,'+'+digits];
 const blocked=await db.from('messaging_opt_outs').select('id',{count:'exact',head:true}).in('phone',variants).or(`business_id.eq.${businessId},business_id.is.null`).eq('channel','sms').is('resubscribed_at',null);
 if (blocked.error || blocked.count!==0) return false;
 const consent=await db.from('customer_consents').select('status,expires_at').eq('business_id',businessId).in('phone',variants).eq('channel','sms').eq('purpose','utility').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1).maybeSingle();
 return !consent.error && consent.data?.status==='granted' && (!consent.data.expires_at || Date.parse(consent.data.expires_at)>Date.now());
}
async function hasWindow(db:SupabaseClient,channelId:string|undefined,phone:string) {
 if (!channelId) return false;
 const digits=phone.replace(/\D/g,'');
 const now=Date.now();
 // Service-window evidence belongs to the actual sender/transport, never a session update.
 const {data,error}=await db.from('whatsapp_inbound_receipts').select('provider_timestamp').eq('channel_id',channelId).eq('sender_phone',digits).gte('provider_timestamp',new Date(now-24*60*60_000).toISOString()).lte('provider_timestamp',new Date(now).toISOString()).order('provider_timestamp',{ascending:false}).limit(1).maybeSingle();
 return !error && !!data;
}
async function approvedTemplate(resolved:ResolvedChannel|null) {
 if (!resolved?.cloud || !resolved.channel.waba_id) return null;
 try {
  let after:string|undefined;
  // Bounded lookup: unavailable if approval cannot be established on this WABA.
  for(let page=0;page<10;page++) {
   const result=await resolved.cloud.getTemplates({limit:100,after});
   const t=result.data.find(t=>t.name==='waaiio_event_invite' && t.language==='en_US');
   if(t) {
    const body=t.components.find(c=>c.type==='BODY');
    if(t.status!=='APPROVED' || t.category!=='MARKETING' || !body?.text || t.components.some(c=>!['BODY','FOOTER'].includes(c.type))) return null;
    const slots=[...body.text.matchAll(/\{\{(\d+)\}\}/g)].map(m=>m[1]);
    if(slots.length!==2 || slots[0]!=='1' || slots[1]!=='2') return null;
    return {body:body.text,footer:t.components.find(c=>c.type==='FOOTER')?.text || ''};
   }
   if(!result.paging?.next || !result.paging.cursors.after) break; after=result.paging.cursors.after;
  }
 } catch { /* Unknown approval is unavailable, never inferred from source declarations. */ }
 return null;
}
export async function loadReminderPreview(db:SupabaseClient,partyId:string,purpose:ReminderPurpose,actorId?:string,inviteId?:string):Promise<{preview:ReminderPreview;resolved:ResolvedChannel|null}> {
 const {data:party,error}=await db.from('parties').select('id,business_id,name,date,time,venue,followup_message,followup_days_before,businesses!inner(owner_id,name,country_code)').eq('id',partyId).single();
 if(error || !party) throw new Error('Party unavailable.');
 const business=(Array.isArray(party.businesses)?party.businesses[0]:party.businesses) as unknown as {owner_id:string;name:string;country_code:CountryCode};
 if(actorId && actorId!==business.owner_id) throw new Error('Party unavailable.');
 let inviteQuery=db.from('event_invites').select('id,guest_name,guest_phone,status,invite_token,reminder_sent,table_id,seat_number').eq('party_id',partyId).eq('business_id',party.business_id).order('id');
 if(inviteId) inviteQuery=inviteQuery.eq('id',inviteId);
 const invites=await inviteQuery;
 if(invites.error) throw new Error('Reminder recipients unavailable.');
 const tableId=invites.data?.[0]?.table_id;
 const tables=inviteId ? (tableId ? await db.from('party_tables').select('id,name').eq('party_id',partyId).eq('business_id',party.business_id).eq('id',tableId) : {data:[],error:null}) : await db.from('party_tables').select('id,name').eq('party_id',partyId).eq('business_id',party.business_id);
 if(invites.error || tables.error) throw new Error('Reminder recipients unavailable.');
 let resolved:ResolvedChannel|null=null;
 try { resolved=await new ChannelResolver(db).resolveByBusinessId(party.business_id); } catch { /* Explicit unavailable variants. */ }
 const template=purpose==='chase'?await approvedTemplate(resolved):null;
 const recipients:ReminderRecipient[]=[];
 const dateLabel=formatDisplayDate(party.date,'long','en',business.country_code || 'NG');
 const timeLabel=party.time?` at ${formatDisplayTime(party.time,'en',business.country_code || 'NG')}`:'';
 for(const invite of invites.data || []) {
  const eligible=(purpose==='chase'?['pending','maybe']:['accepted','maybe']).includes(invite.status) && (purpose==='chase'||!invite.reminder_sent) && (purpose==='chase'||!!party.followup_message);
  const recipient:ReminderRecipient={id:invite.id,name:invite.guest_name || 'Guest',phone:invite.guest_phone || '',status:invite.status,eligible,exclusion:eligible?'':purpose==='followup'&&invite.reminder_sent?'Previously marked reminded (legacy suppression)':'Outside this reminder audience',variants:[]};
  recipients.push(recipient); if(!eligible) continue;
  const table=(tables.data || []).find(t=>t.id===invite.table_id);
  const seating=table?`Table: ${table.name}${invite.seat_number?` · Seat: ${invite.seat_number}`:''}`:'';
  const link=`${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/rsvp/${invite.invite_token}`;
  const greeting=invite.guest_name?`Hi ${invite.guest_name}! `:'';
  const lead=purpose==='chase'?(invite.status==='maybe'?`You said *maybe* to *${party.name}*. Have you decided?`:`You haven't responded to the invite for *${party.name}* yet.`):party.followup_message;
  const text=['⏰ *Reminder*',`${greeting}${lead}`,purpose==='followup'?`📅 ${party.name}`:'',`📅 ${dateLabel}${purpose==='followup'?timeLabel:''}`,party.venue?`📍 ${party.venue}`:'',seating,...(purpose==='chase'?['RSVP here 👇',link,'Reply: *yes*, *no*, or *maybe*']:[])].filter(Boolean).join('\n');
  const [utility,marketing,window]=await Promise.all([hasRecipientPermission(db,party.business_id,recipient.phone,'utility'),purpose==='chase'?hasRecipientPermission(db,party.business_id,recipient.phone,'marketing'):false,hasWindow(db,resolved?.channel.id,recipient.phone)]);
  const textAllowed=!!resolved && utility && window;
  recipient.variants.push({channel:'whatsapp_text',available:textAllowed,reason:textAllowed?'Within the customer service window':!utility?'Utility consent unavailable':!window?'No verified open customer service window':'WhatsApp unavailable',text,category:'service'});
  if(purpose==='chase') {
   const params=[`${business.name} invites you to ${party.name}${dateLabel?` on ${dateLabel}`:''}${party.venue?` at ${party.venue}`:''}${seating?` — ${seating}`:''}`,link];
   const available=!!template && marketing && params[0].length<=1024;
   recipient.variants.push({channel:'whatsapp_template',available,reason:available?'Marketing template fallback':!marketing?'Marketing consent unavailable':'Approved compatible template unavailable',text:template?template.body.replace('{{1}}',params[0]).replace('{{2}}',params[1])+(template.footer?'\n'+template.footer:''):'Template approval unavailable',templateParams:params,category:'marketing'});
  } else {
   const address=await findCustomerEmail(db,recipient.phone.replace(/\D/g,''),party.business_id);
   const permitted=await hasRecipientPermission(db,party.business_id,recipient.phone,'utility','email');
   const email=businessNotificationEmail({businessName:party.name,title:'Event Reminder',message:party.followup_message,details:{Date:dateLabel,...(party.venue?{Venue:party.venue}:{}),...(seating?{Seating:seating}:{})}});
   const emailAllowed=!!resolved && !!process.env.RESEND_API_KEY && !!address && permitted;
   recipient.variants.push({channel:'email',available:emailAllowed,reason:emailAllowed?'Scheduled dual delivery':'Email address, configured channel or utility consent unavailable',text:email.html,address:address||undefined,subject:email.subject,html:email.html,category:'service'});
   const sms=text.replace(/\*/g,'').replace(/_/g,'').slice(0,160);
   const smsAllowed=!!resolved && !!process.env.BULKSMS_NG_API_TOKEN && isSmsEligible(recipient.phone) && await smsPermission(db,party.business_id,recipient.phone) && (!seating||sms.includes(seating));
   recipient.variants.push({channel:'sms',available:smsAllowed,reason:smsAllowed?'Fallback after definitive WhatsApp/email failure':'SMS channel/consent unavailable or table content exceeds 160 characters',text:sms,category:'service'});
  }
 }
 const transport=resolved?{channelId:resolved.channel.id,provider:resolved.channel.provider,wabaId:resolved.channel.waba_id,phoneNumberId:resolved.channel.phone_number_id}:null;
 const base={transport,partyId,businessId:party.business_id,purpose,scheduledDate:followupDate(party.date,party.followup_days_before??1),recipients,notice:'Provider acceptance is not delivery. Prior manual reminders still suppress scheduled follow-up through the existing reminder flag.'};
 return {preview:{...base,fingerprint:fingerprint({base,channel:resolved?.channel.id || null})},resolved};
}
