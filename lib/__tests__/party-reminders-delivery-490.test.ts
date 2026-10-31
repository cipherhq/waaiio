import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({load:vi.fn(),email:vi.fn(),sms:vi.fn()}));
vi.mock('@/lib/parties/reminder-preview',async()=>{const real=await vi.importActual<object>('@/lib/parties/reminder-preview');return {...real,loadReminderPreview:m.load};});
vi.mock('@/lib/email/client',()=>({sendEmail:m.email}));
vi.mock('@/lib/sms/bulksms-ng',()=>({sendSms:m.sms,isSmsEligible:()=>true}));
import { deliverReminder, deliverScheduledReminders } from '@/lib/parties/reminder-delivery';
import type { ReminderPreview, Variant } from '@/lib/parties/reminder-preview';
function harness(purpose:'chase'|'followup'='followup') {
 const variants:Variant[]=(purpose==='chase'?['whatsapp_text','whatsapp_template']:['whatsapp_text','email','sms']).map(channel=>({channel:channel as Variant['channel'],available:true,reason:'',text:'Reminder Table: A',category:channel==='whatsapp_template'?'marketing':'service',address:'guest@example.test',subject:'Reminder',html:'<p>Reminder</p>',templateParams:['Details','link']}));
 const preview:ReminderPreview={partyId:'party',businessId:'business',purpose,scheduledDate:'2027-01-01',fingerprint:'a'.repeat(64),notice:'',recipients:[{id:'invite',name:'Guest',phone:'15551234567',status:'maybe',eligible:true,exclusion:'',variants}]};
 const sender={sendText:vi.fn().mockResolvedValue({success:true,messageId:'wa-id'}),sendTemplate:vi.fn().mockResolvedValue({success:true,messageId:'template-id'})};
 m.load.mockResolvedValue({preview,resolved:{sender}});
 const runs=new Map<string,any>(),attempts=new Map<string,any>(); let loseOutcome=false; let zeroRows=false;
 const db={from:(table:string)=>{
   const filters:Record<string,unknown>={};let op='select',payload:any;
   const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},insert:(v:any)=>{op='insert';payload=v;return q;},update:(v:any)=>{op='update';payload=v;return q;},maybeSingle:async()=>({data:runs.get(String(filters.id))||null,error:null}),single:async()=>{const r:any=await q;return {...r,data:r.data?.[0]||null};},then:(resolve:(x:unknown)=>unknown)=>{
    let result:any={data:null,error:null}; const store=table==='party_reminder_runs'?runs:attempts;
    if(op==='insert') {const key=table==='party_reminder_runs'?payload.id:[payload.run_id,payload.invite_id,payload.channel].join(':'); if(store.has(key))result.error={code:'23505'};else store.set(key,{state:'dispatched',...payload});}
    else if(op==='update') {if(zeroRows&&table==='party_reminder_attempts')result.data=[];else if(loseOutcome&&table==='party_reminder_attempts')result.error={code:'NETWORK'};else for(const value of store.values())if(Object.entries(filters).every(([k,v])=>value[k]===v)){Object.assign(value,payload);result.data=[value];}}
    else result.data=[...store.values()].filter(value=>Object.entries(filters).every(([k,v])=>value[k]===v));
    return Promise.resolve(result).then(resolve);
   }};return q;
 }};
 return {db:db as never,preview,sender,runs,attempts,lose:()=>{loseOutcome=true;},zero:()=>{zeroRows=true;}};
}
beforeEach(()=>{vi.clearAllMocks();m.email.mockResolvedValue({success:true,id:'email-id'});m.sms.mockResolvedValue({sent:true});});
describe('Party durable reminder provider boundaries',()=>{
 it('submits WhatsApp and scheduled dual email once and replays without submissions',async()=>{
  const h=harness();const first=await deliverReminder(h.db,h.preview,'run',null);expect(first.accepted).toBe(2);
  const replay=await deliverReminder(h.db,h.preview,'run',null);expect(replay.replay).toBe(true);
  expect(h.sender.sendText).toHaveBeenCalledTimes(1);expect(m.email).toHaveBeenCalledTimes(1);expect(m.sms).not.toHaveBeenCalled();
  expect(h.sender.sendText).toHaveBeenCalledWith(expect.objectContaining({noRetry:true,messageCategory:'service'}));expect(m.email).toHaveBeenCalledWith(expect.objectContaining({noRetry:true}));
 });
 it('unknown WhatsApp still permits dual email but suppresses SMS and retries',async()=>{
  const h=harness();h.sender.sendText.mockRejectedValue(new Error('timeout'));m.email.mockResolvedValue({success:false});
  const result=await deliverReminder(h.db,h.preview,'run',null);expect(result.accepted).toBe(0);expect(m.email).toHaveBeenCalledTimes(1);expect(m.sms).not.toHaveBeenCalled();
  await deliverReminder(h.db,h.preview,'run',null);expect(h.sender.sendText).toHaveBeenCalledTimes(1);
 });
 it('manual marketing fallback is used only when text is definitively unavailable',async()=>{
  const h=harness('chase');h.preview.recipients[0].variants[0].available=false;
  await deliverReminder(h.db,h.preview,'run','owner');expect(h.sender.sendText).not.toHaveBeenCalled();expect(h.sender.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({messageCategory:'marketing',noRetry:true}));expect(m.email).not.toHaveBeenCalled();
 });
 it('manual timeout does not trigger template fallback',async()=>{
  const h=harness('chase');h.sender.sendText.mockRejectedValue(new Error('timeout'));await deliverReminder(h.db,h.preview,'run','owner');expect(h.sender.sendTemplate).not.toHaveBeenCalled();
 });
 it('persists indeterminate dispatch after failed outcome recording and never resends',async()=>{
  const h=harness();h.lose();const result=await deliverReminder(h.db,h.preview,'run',null);expect(result.accepted).toBe(0);
  await deliverReminder(h.db,h.preview,'run',null);expect(h.sender.sendText).toHaveBeenCalledTimes(1);expect([...h.attempts.values()].every(x=>x.state==='dispatched')).toBe(true);
 });
 it('does not count development email as provider acceptance',async()=>{
  const h=harness();m.email.mockResolvedValue({success:true,dev:true});const result=await deliverReminder(h.db,h.preview,'run',null);expect(result.accepted).toBe(1);
 });
 it('does not submit after recipient consent/content changes during revalidation',async()=>{
  const h=harness();m.load.mockResolvedValue({preview:{...h.preview,recipients:[{...h.preview.recipients[0],eligible:false}]},resolved:{sender:h.sender}});
  const result=await deliverReminder(h.db,h.preview,'run',null);expect(result.accepted).toBe(0);expect(h.sender.sendText).not.toHaveBeenCalled();expect(m.email).not.toHaveBeenCalled();
 });
 it('reports unknown when outcome update matches no ledger row',async()=>{
  const h=harness();h.zero();const result=await deliverReminder(h.db,h.preview,'run',null);expect(result.accepted).toBe(0);expect(result.results.every(r=>r.state==='unknown')).toBe(true);
 });
 it('withholds dispatch when the actual transport changes',async()=>{
  const h=harness();h.preview.transport={channelId:'original',provider:'meta_cloud',wabaId:'waba',phoneNumberId:'phone'};
  m.load.mockResolvedValue({preview:{...h.preview,transport:{...h.preview.transport,channelId:'changed'}},resolved:{sender:h.sender}});
  await deliverReminder(h.db,h.preview,'run',null);expect(h.sender.sendText).not.toHaveBeenCalled();
 });
 it('reports interrupted unattempted recipients without resuming them',async()=>{
  const h=harness();h.runs.set('run',{id:'run',party_id:'party',business_id:'business',actor_id:null,purpose:'followup',fingerprint:h.preview.fingerprint,state:'dispatched',results:[{inviteId:'invite',channel:'email',state:'unattempted',reason:'Not started'}]});
  const result=await deliverReminder(h.db,h.preview,'run',null);expect(result.state).toBe('dispatched');expect(result.results[0].state).toBe('unattempted');expect(m.email).not.toHaveBeenCalled();
 });
 it('two simultaneous confirmations produce one set of provider submissions',async()=>{
  const h=harness();await Promise.all([deliverReminder(h.db,h.preview,'run',null),deliverReminder(h.db,h.preview,'run',null)]);
  expect(h.sender.sendText).toHaveBeenCalledTimes(1);expect(m.email).toHaveBeenCalledTimes(1);
 });

 it('scheduled empty tick does not suppress a guest becoming eligible later',async()=>{
  const h=harness();await deliverScheduledReminders(h.db,{...h.preview,recipients:[]});expect(h.runs.size).toBe(0);
  await deliverScheduledReminders(h.db,h.preview);expect(h.sender.sendText).toHaveBeenCalledTimes(1);
 });
 it('later scheduled guest B sends once after A was already delivered',async()=>{
  const h=harness();await deliverScheduledReminders(h.db,h.preview);
  h.preview.recipients.push({...h.preview.recipients[0],id:'new-guest'});h.preview.fingerprint='changed';
  await deliverScheduledReminders(h.db,h.preview);expect(h.sender.sendText).toHaveBeenCalledTimes(2);expect(m.email).toHaveBeenCalledTimes(2);
 });
 it('concurrent scheduled ticks and subsequent unknown outcomes never resubmit',async()=>{
  const h=harness();h.sender.sendText.mockRejectedValue(new Error('timeout'));
  await Promise.all([deliverScheduledReminders(h.db,h.preview),deliverScheduledReminders(h.db,h.preview)]);
  h.preview.fingerprint='changed';await deliverScheduledReminders(h.db,h.preview);expect(h.sender.sendText).toHaveBeenCalledTimes(1);expect(m.email).toHaveBeenCalledTimes(1);
 });
 it('manual replay still rejects changed signed content',async()=>{
  const h=harness('chase');await deliverReminder(h.db,h.preview,'manual','owner');
  await expect(deliverReminder(h.db,{...h.preview,fingerprint:'changed'},'manual','owner')).rejects.toThrow('identity conflict');
 });

});
