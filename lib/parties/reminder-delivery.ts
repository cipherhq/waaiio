import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/client';
import { sendSms } from '@/lib/sms/bulksms-ng';
import { fingerprint, scheduledOccurrence, loadReminderPreview, type ReminderPreview, type ReminderRecipient, type Variant, type ReminderChannel } from './reminder-preview';
import type { ResolvedChannel } from '@/lib/channels/channel-resolver';
type Outcome='accepted'|'rejected'|'unknown'|'unavailable'|'dispatched'|'unattempted';
type Result={inviteId:string;channel:ReminderChannel;state:Outcome;reason?:string};
const definitive=(state:Outcome)=>state==='rejected'||state==='unavailable';
/** Claims are durable before provider submission. No dispatched or ambiguous attempt is reclaimed. */
export async function deliverReminder(db:SupabaseClient,preview:ReminderPreview,occurrence:string,actorId:string|null) {
 const prior=await db.from('party_reminder_runs').select('party_id,business_id,actor_id,purpose,fingerprint,state,results').eq('id',occurrence).maybeSingle();
 if(prior.error) throw new Error('Reminder history unavailable.');
 if(prior.data) {
  if(prior.data.party_id!==preview.partyId || prior.data.business_id!==preview.businessId || prior.data.actor_id!==actorId || prior.data.purpose!==preview.purpose || (preview.purpose==='chase' && prior.data.fingerprint!==preview.fingerprint)) throw new Error('Reminder identity conflict.');
  if(preview.purpose==='followup' && (preview.recipients.length!==1 || (prior.data.results as Result[]).some(r=>r.inviteId!==preview.recipients[0].id))) throw new Error('Reminder recipient identity conflict.');
  const attempts=await db.from('party_reminder_attempts').select('invite_id,channel,state').eq('run_id',occurrence);
  if(attempts.error) throw new Error('Reminder outcomes unavailable.');
  const recorded:Result[]=(attempts.data || []).map(x=>({inviteId:x.invite_id,channel:x.channel,state:x.state}));
  const results:Result[]=prior.data.state==='finished'?prior.data.results:(prior.data.results as Result[]).map(r=>recorded.find(a=>a.inviteId===r.inviteId&&a.channel===r.channel)||r);
  return {replay:true,state:prior.data.state,results,accepted:results.filter(x=>x.state==='accepted').length};
 }
 const unattempted:Result[]=preview.recipients.filter(r=>r.eligible).flatMap(r=>r.variants.map(v=>({inviteId:r.id,channel:v.channel,state:'unattempted' as const,reason:'Submission has not started; an interrupted run is not resumed automatically'})));
 const claimed=await db.from('party_reminder_runs').insert({id:occurrence,party_id:preview.partyId,business_id:preview.businessId,actor_id:actorId,purpose:preview.purpose,fingerprint:preview.fingerprint,results:unattempted});
 if(claimed.error) {
  if(claimed.error.code==='23505') return {replay:true,state:'dispatched',results:unattempted,accepted:0};
  throw new Error('Unable to record reminder dispatch. No sends started.');
 }
 const results:Result[]=[];
 for(const recipient of preview.recipients.filter(r=>r.eligible)) {
  // Re-read current tenant, status, content, consent, channel, and seating before each recipient.
  let fresh:Awaited<ReturnType<typeof loadReminderPreview>>;
  try {fresh=await loadReminderPreview(db,preview.partyId,preview.purpose,actorId || undefined,recipient.id);}
  catch {results.push({inviteId:recipient.id,channel:'whatsapp_text',state:'unavailable',reason:'Revalidation unavailable'});continue;}
  const current=fresh.preview.recipients.find(r=>r.id===recipient.id);
  if(!current || fingerprint(current)!==fingerprint(recipient) || fresh.preview.scheduledDate!==preview.scheduledDate || fingerprint(fresh.preview.transport ?? null)!==fingerprint(preview.transport ?? null)) {
   results.push({inviteId:recipient.id,channel:'whatsapp_text',state:'unavailable',reason:'Recipient or reminder changed after preview'});continue;
  }
  const outcomes:Partial<Record<ReminderChannel,Outcome>>={};
  for(const variant of recipient.variants) {
   if(variant.channel==='whatsapp_template' && !definitive(outcomes.whatsapp_text || 'unknown')) continue;
   if(variant.channel==='sms' && (!definitive(outcomes.whatsapp_text || 'unknown') || !definitive(outcomes.email || 'unknown'))) continue;
   const result=await dispatchVariant(db,occurrence,recipient,variant,fresh.resolved);
   outcomes[variant.channel]=result.state; results.push(result);
  }
  if(outcomes.whatsapp_text==='accepted'||outcomes.whatsapp_template==='accepted'||preview.purpose==='followup'&&outcomes.email==='accepted') {
   // Legacy compatibility deliberately preserved: SMS-only acceptance does not set the flag.
   await db.from('event_invites').update({reminder_sent:true}).eq('id',recipient.id).eq('party_id',preview.partyId).eq('business_id',preview.businessId);
  }
 }
 const finished=await db.from('party_reminder_runs').update({state:'finished',results}).eq('id',occurrence).eq('fingerprint',preview.fingerprint).select('id').single();
 return {replay:false,state:finished.error||!finished.data?'dispatched':'finished',results,accepted:results.filter(r=>r.state==='accepted').length};
}
async function dispatchVariant(db:SupabaseClient,runId:string,recipient:ReminderRecipient,variant:Variant,resolved:ResolvedChannel|null):Promise<Result> {
 const base={inviteId:recipient.id,channel:variant.channel};
 if(!variant.available) return {...base,state:'unavailable',reason:variant.reason};
 const claim=await db.from('party_reminder_attempts').insert({run_id:runId,invite_id:recipient.id,channel:variant.channel,content:{phone:recipient.phone,...variant},state:'dispatched'});
 if(claim.error) return {...base,state:'unknown',reason:'Dispatch could not be confirmed; no new submission attempted'};
 let state:Outcome='unknown'; let providerId:string|null=null;
 try {
  if(variant.channel==='whatsapp_text' && resolved) {
   const result=await resolved.sender.sendText({to:recipient.phone,text:variant.text,messageCategory:'service',noRetry:true});
   if(result.success===true && result.messageId) {state='accepted';providerId=result.messageId;}
  } else if(variant.channel==='whatsapp_template' && resolved?.sender.sendTemplate) {
   const result=await resolved.sender.sendTemplate({to:recipient.phone,templateName:'waaiio_event_invite',templateParams:variant.templateParams!,messageCategory:'marketing',noRetry:true});
   if(result.success===true && result.messageId) {state='accepted';providerId=result.messageId;}
  } else if(variant.channel==='email') {
   const result=await sendEmail({to:variant.address!,subject:variant.subject!,html:variant.html!,noRetry:true});
   if(result.success && !('dev' in result && result.dev) && 'id' in result && result.id) {state='accepted';providerId=result.id;}
  } else if(variant.channel==='sms') {
   const result=await sendSms({to:recipient.phone,message:variant.text});
   if(result.sent) state='accepted';
  }
 } catch(error) {
  // These named guards fail before emission; all other exceptions remain indeterminate.
  if(error instanceof Error && ['MessagingSuspendedError','GateBlockError'].includes(error.name)) state='rejected';
 }
 const saved=await db.from('party_reminder_attempts').update({state,provider_id:providerId,updated_at:new Date().toISOString()}).eq('run_id',runId).eq('invite_id',recipient.id).eq('channel',variant.channel).eq('state','dispatched').select('run_id').single();
 return {...base,state:saved.error||!saved.data?'unknown':state};
}

/** Scheduled identity is per guest, so a later eligible guest is not suppressed by an earlier run. */
export async function deliverScheduledReminders(db:SupabaseClient,preview:ReminderPreview) {
 if(preview.purpose!=='followup') throw new Error('Invalid scheduled reminder purpose.');
 let whatsappAccepted=0,emailAccepted=0;
 for(const recipient of preview.recipients.filter(r=>r.eligible)) {
  const single={...preview,recipients:[recipient],fingerprint:fingerprint({partyId:preview.partyId,businessId:preview.businessId,date:preview.scheduledDate,transport:preview.transport??null,recipient})};
  const result=await deliverReminder(db,single,scheduledOccurrence(preview.partyId,preview.scheduledDate,recipient.id),null);
  if(!result.replay) {
   whatsappAccepted+=result.results.filter(r=>r.state==='accepted'&&['whatsapp_text','whatsapp_template'].includes(r.channel)).length;
   emailAccepted+=result.results.filter(r=>r.state==='accepted'&&r.channel==='email').length;
  }
 }
 return {whatsappAccepted,emailAccepted};
}
