import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { loadReminderPreview, signPreview, verifyPreview } from '@/lib/parties/reminder-preview';
import { deliverReminder } from '@/lib/parties/reminder-delivery';
export const dynamic='force-dynamic';
type Context={params:Promise<{partyId:string}>};
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export async function POST(request:NextRequest,context:Context) {
 const auth=await authenticateRequest(request); if(auth instanceof NextResponse)return auth;
 const {partyId}=await context.params;
 if(!/^[0-9a-f-]{36}$/i.test(partyId))return reply({error:'Invalid party.'},400);
 try {
  const raw=await request.text(); if(raw.length>16384)return reply({error:'Request too large.'},413);
  const body=JSON.parse(raw);
  if(body.op==='preview' && ['chase','followup'].includes(body.purpose)) {
   const {preview}=await loadReminderPreview(auth.service,partyId,body.purpose,auth.user.id);
   return reply({preview,token:body.purpose==='chase'?signPreview(preview,auth.user.id):null});
  }
  if(body.op!=='confirm'||typeof body.token!=='string')return reply({error:'Review a preview first.'},400);
  const ticket=verifyPreview(body.token,partyId,auth.user.id);
  const {preview}=await loadReminderPreview(auth.service,partyId,'chase',auth.user.id);
  // Replays may follow legacy flag/status changes; the recorded identity still cannot change.
  const prior=await auth.service.from('party_reminder_runs').select('fingerprint,actor_id,party_id').eq('id',ticket.occurrence).maybeSingle();
  if(prior.error)throw new Error('Reminder history unavailable.');
  if(prior.data) {
   if(prior.data.fingerprint!==ticket.fingerprint||prior.data.actor_id!==auth.user.id||prior.data.party_id!==partyId)throw new Error('Reminder identity conflict.');
   return reply(await deliverReminder(auth.service,{...preview,fingerprint:ticket.fingerprint},ticket.occurrence,auth.user.id));
  }
  if(preview.fingerprint!==ticket.fingerprint)return reply({error:'Reminder content or recipients changed. Review a fresh preview.'},409);
  return reply(await deliverReminder(auth.service,preview,ticket.occurrence,auth.user.id));
 } catch(e) {return reply({error:e instanceof Error?e.message:'Reminder unavailable.'},409);}
}
