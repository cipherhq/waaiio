import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
const m=vi.hoisted(()=>({db:null as any,resolved:null as any,bot:vi.fn(),send:vi.fn()}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>m.db}));
vi.mock('@/lib/channels/channel-resolver',()=>({ChannelResolver:class {
 resolveByPhoneNumberId=async()=>m.resolved;
 resolveByBusinessId=async()=>m.resolved;
}}));
vi.mock('@/lib/bot/bot.service',()=>({BotService:class {handleMessage=m.bot;}}));
vi.mock('@/lib/bot/bot-intelligence',()=>({BotIntelligenceService:class{}}));
vi.mock('@/lib/bot/standalone.service',()=>({StandaloneService:class{}}));
vi.mock('@/lib/channels/send-or-email',()=>({findCustomerEmail:async()=>null}));
vi.mock('@/lib/email/client',()=>({sendEmail:vi.fn()}));
vi.mock('@/lib/sms/bulksms-ng',()=>({isSmsEligible:()=>false,sendSms:vi.fn()}));
import { POST } from '@/app/api/webhook/meta-cloud/route';
import { loadReminderPreview } from '@/lib/parties/reminder-preview';
import { deliverScheduledReminders } from '@/lib/parties/reminder-delivery';

const phone='15551234567';
function fixture(n=1) {
 const receipts:any[]=[],runs:any[]=[],attempts:any[]=[],trace:any[]=[];
 let denyConsent=false,failReceipt=false,claimed=true;
 const invites=Array.from({length:n},(_,i)=>({id:`guest-${i}`,party_id:'party',business_id:'business',guest_name:'Guest',guest_phone:phone,invite_token:'token',status:'accepted',reminder_sent:false,table_id:'table',seat_number:1}));
 const party={id:'party',business_id:'business',name:'Party',date:'2027-01-01',followup_message:'Join us',businesses:{owner_id:'owner',name:'Host',country_code:'US'}};
 const db={rpc:vi.fn(async()=>({data:{claimed,claim_token:'claim'},error:null})),from:(table:string)=>{
  const filters:any={};const bounds:any={};let op='read',payload:any;trace.push({table,filters});
  const execute=()=>{
   let rows:any[]=table==='parties'?[party]:table==='event_invites'?invites:table==='party_tables'?[{id:'table',party_id:'party',business_id:'business',name:'A'}]:table==='whatsapp_inbound_receipts'?receipts:table==='party_reminder_runs'?runs:table==='party_reminder_attempts'?attempts:[];
   if(table==='customer_consents')rows=denyConsent||filters.business_id!=='business'?[]:[{...filters,status:'granted',expires_at:null}];
   if(op==='insert') {
    if(table==='whatsapp_inbound_receipts'&&failReceipt)return {data:null,error:{code:'NETWORK'}};
    if(table==='whatsapp_inbound_receipts'&&receipts.some(r=>r.channel_id===payload.channel_id&&r.message_id===payload.message_id))return {data:null,error:{code:'23505'}};
    rows.push({state:'dispatched',...payload});return {data:null,error:null};
   }
   rows=rows.filter(r=>Object.entries(filters).every(([k,v])=>r[k]===v));
   if(table==='whatsapp_inbound_receipts')rows=rows.filter(r=>r.provider_timestamp>=bounds.gte&&r.provider_timestamp<=bounds.lte);
   if(op==='update')rows.forEach(r=>Object.assign(r,payload));
   return {data:rows,error:null,count:0};
  };
  const q:any={select:()=>q,eq:(k:string,v:any)=>{filters[k]=v;return q;},in:()=>q,or:()=>q,is:()=>q,order:()=>q,limit:()=>q,gte:(_k:string,v:any)=>{bounds.gte=v;return q;},lte:(_k:string,v:any)=>{bounds.lte=v;return q;},insert:(v:any)=>{op='insert';payload=v;return q;},update:(v:any)=>{op='update';payload=v;return q;},single:async()=>{const r=execute();return {...r,data:r.data?.[0]||null};},maybeSingle:async()=>{const r=execute();return {...r,data:r.data?.[0]||null};},then:(resolve:any)=>Promise.resolve(execute()).then(resolve)};return q;
 }};
 return {db:db as never,receipts,invites,party,trace,deny:()=>denyConsent=true,fail:()=>failReceipt=true,skipClaim:()=>claimed=false};
}
async function incoming(overrides:Record<string,unknown>={},signature=true,field='messages') {
 const message={id:'wamid-test',from:phone,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'yes'},...overrides};
 const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field,value:{metadata:{phone_number_id:'provider-phone'},messages:[message]}}]}]});
 const req=new NextRequest('https://example.test/api/webhook/meta-cloud',{method:'POST',body,headers:{'x-hub-signature-256':signature?'sha256='+createHmac('sha256','test-secret').update(body).digest('hex'):'invalid'}});
 return POST(req);
}
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('META_APP_SECRET','test-secret');vi.stubEnv('RESEND_API_KEY','');vi.stubEnv('BULKSMS_NG_API_TOKEN','');
 m.send.mockResolvedValue({success:true,messageId:'sent'});m.bot.mockResolvedValue(undefined);
 m.resolved={channel:{id:'channel',phone_number:'15550000000',phone_number_id:'provider-phone',provider:'meta_cloud',waba_id:'waba',business_id:null},sender:{sendText:m.send}};
});
afterEach(()=>vi.unstubAllEnvs());
describe('actual webhook evidence and real reminder revalidation',()=>{
 it('opens a window after a normal bot RSVP message without human chat history',async()=>{
  const h=fixture();m.db=h.db;expect((await incoming()).status).toBe(200);expect(m.bot).toHaveBeenCalledTimes(1);
  expect(h.receipts).toHaveLength(1);expect(h.trace.some(x=>x.table==='chat_messages')).toBe(false);
  const {preview}=await loadReminderPreview(h.db,'party','followup','owner');expect(preview.recipients[0].variants[0].available).toBe(true);
  expect(h.receipts[0]).not.toHaveProperty('text');
 });
 it('keeps sender, channel and business consent boundaries independent',async()=>{
  const h=fixture();m.db=h.db;await incoming();
  const available=async()=>(await loadReminderPreview(h.db,'party','followup','owner')).preview.recipients[0].variants[0].available;
  m.resolved.channel.id='other-channel';expect(await available()).toBe(false);m.resolved.channel.id='channel';
  h.invites[0].guest_phone='15559999999';expect(await available()).toBe(false);h.invites[0].guest_phone=phone;
  h.party.business_id='other-business';h.invites[0].business_id='other-business';expect(await available()).toBe(false);
  h.party.business_id='business';h.invites[0].business_id='business';h.deny();expect(await available()).toBe(false);
 });
 it('does not use expired, future, missing timestamps or outbound/system events as windows',async()=>{
  const h=fixture();m.db=h.db;
  await incoming({timestamp:String(Math.floor(Date.now()/1000)-25*3600)});
  expect((await loadReminderPreview(h.db,'party','followup','owner')).preview.recipients[0].variants[0].available).toBe(false);
  for(const timestamp of [undefined,'invalid','0',String(Math.floor(Date.now()/1000)+3600)])await incoming({id:String(timestamp),timestamp});
  await incoming({id:'system',type:'system'});await incoming({id:'self',from:'15550000000'});await incoming({id:'echo'},true,'smb_message_echoes');
  expect(h.receipts).toHaveLength(1);
  h.receipts[0].provider_timestamp=new Date(Date.now()+3600000).toISOString();
  expect((await loadReminderPreview(h.db,'party','followup','owner')).preview.recipients[0].variants[0].available).toBe(false);
 });
 it('rejects unverified webhooks and does not record without a resolved channel',async()=>{
  const h=fixture();m.db=h.db;expect((await incoming({},false)).status).toBe(401);expect(h.receipts).toHaveLength(0);
  m.resolved=null;await incoming();expect(h.receipts).toHaveLength(0);expect(m.bot).not.toHaveBeenCalled();
 });
 it('never extends duplicate evidence and can record original evidence before replay suppression',async()=>{
  const h=fixture();m.db=h.db;await incoming({timestamp:String(Math.floor(Date.now()/1000)-3600)});const original=h.receipts[0].provider_timestamp;
  h.skipClaim();await incoming();expect(h.receipts).toHaveLength(1);expect(h.receipts[0].provider_timestamp).toBe(original);
  await incoming({id:'previously-missed'});expect(h.receipts).toHaveLength(2);expect(m.bot).toHaveBeenCalledTimes(1);
 });
 it('does not stop bot processing when receipt storage is unavailable',async()=>{
  const h=fixture();h.fail();m.db=h.db;expect((await incoming()).status).toBe(200);expect(m.bot).toHaveBeenCalledTimes(1);expect(h.receipts).toHaveLength(0);
 });
 it('revalidates missing or moved guests as unavailable and scopes their table',async()=>{
  const h=fixture(2);const {preview}=await loadReminderPreview(h.db,'party','followup','owner','guest-0');
  expect(preview.recipients).toHaveLength(1);expect(h.trace.find(x=>x.table==='party_tables').filters).toMatchObject({id:'table',party_id:'party',business_id:'business'});
  h.invites[0].business_id='other';expect((await loadReminderPreview(h.db,'party','followup','owner','guest-0')).preview.recipients).toHaveLength(0);
  await expect(loadReminderPreview(h.db,'party','followup','other','guest-1')).rejects.toThrow('Party unavailable');
 });
 it('keeps database work linear with the real loader and scheduled dispatcher',async()=>{
  const count=async(n:number)=>{const h=fixture(n);const {preview}=await loadReminderPreview(h.db,'party','followup');await deliverScheduledReminders(h.db,preview);return h.trace.length;};
  const small=await count(10),large=await count(20);
  expect(large).toBeLessThanOrEqual(small*2+10);expect(large).toBeLessThan(700);
  expect(m.send).not.toHaveBeenCalled();
 });
});
