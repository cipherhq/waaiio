import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const m=vi.hoisted(()=>({permission:vi.fn(),resolve:vi.fn(),templates:vi.fn(),email:vi.fn()}));
vi.mock('@/lib/channels/channel-resolver',()=>({ChannelResolver:class{resolveByBusinessId=m.resolve;}}));
vi.mock('@/lib/merchants/recipient-permission',()=>({hasRecipientPermission:m.permission}));
vi.mock('@/lib/channels/send-or-email',()=>({findCustomerEmail:m.email}));
import {loadReminderPreview,signPreview,verifyPreview,scheduledOccurrence} from '@/lib/parties/reminder-preview';
const baseInvite={guest_name:'Guest',guest_phone:'2348012345678',invite_token:'token',reminder_sent:false,table_id:'table',seat_number:2};
function dbFixture(options:{legacy?:boolean;window?:boolean;table?:string}={}) {
 const trace:Record<string,unknown>[]=[];
 const db={from:(table:string)=>{
  const filters:Record<string,unknown>={table};trace.push(filters);
  const data=()=>table==='parties'?{id:'party',business_id:'business',name:'Celebration',date:'2027-01-01',time:'18:00',venue:'Hall',followup_message:'See you soon',followup_days_before:1,businesses:{owner_id:'owner',name:'Host',country_code:'NG'}}:table==='event_invites'?['pending','maybe','accepted','declined'].map((status,i)=>({...baseInvite,id:String(i),status,reminder_sent:!!options.legacy})):table==='party_tables'?[{id:'table',name:options.table || 'A'}]:table==='chat_messages'?(options.window===false?null:{created_at:new Date().toISOString()}):table==='customer_consents'?{status:'granted',expires_at:null}:null;
  const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q;},in:()=>q,or:()=>q,is:()=>q,gte:()=>q,order:()=>q,limit:()=>q,single:async()=>({data:data(),error:null}),maybeSingle:async()=>({data:data(),error:null}),then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:data(),error:null,count:0}).then(resolve)};return q;
 }};return {db:db as never,trace};
}
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','test-preview-key');vi.stubEnv('RESEND_API_KEY','test-email-key');vi.stubEnv('BULKSMS_NG_API_TOKEN','test-sms-key');
 m.permission.mockResolvedValue(true);m.email.mockResolvedValue('guest@example.test');
 m.templates.mockResolvedValue({data:[{name:'waaiio_event_invite',language:'en_US',category:'MARKETING',status:'APPROVED',components:[{type:'BODY',text:'Invitation {{1}} RSVP {{2}}'},{type:'FOOTER',text:'Host footer'}]}]});
 m.resolve.mockResolvedValue({channel:{id:'channel',waba_id:'actual-waba'},cloud:{getTemplates:m.templates},sender:{}});
});
afterEach(()=>vi.unstubAllEnvs());
describe('Party reminder preview and consent contracts',()=>{
 it('separates manual and scheduled audiences and preserves legacy suppression',async()=>{
  const {db}=dbFixture();const chase=await loadReminderPreview(db,'party','chase','owner');const followup=await loadReminderPreview(db,'party','followup','owner');
  expect(chase.preview.recipients.filter(x=>x.eligible).map(x=>x.status)).toEqual(['pending','maybe']);
  expect(followup.preview.recipients.filter(x=>x.eligible).map(x=>x.status)).toEqual(['maybe','accepted']);
  const legacy=await loadReminderPreview(dbFixture({legacy:true}).db,'party','followup','owner');expect(legacy.preview.recipients.every(x=>!x.eligible)).toBe(true);
 });
 it('uses actual approved template text, current own table, and separate marketing permission',async()=>{
  m.permission.mockImplementation(async (_db,_biz,_phone,purpose)=>purpose!=='marketing');
  const {preview}=await loadReminderPreview(dbFixture().db,'party','chase','owner');const variants=preview.recipients[0].variants;
  expect(variants[0].available).toBe(true);expect(variants[0].text).toContain('Table: A · Seat: 2');expect(variants[1].available).toBe(false);expect(variants[1].text).toContain('Invitation Host invites you');expect(m.templates).toHaveBeenCalled();
 });
 it('withholds unapproved template and text without actual inbound window',async()=>{
  m.templates.mockResolvedValue({data:[{name:'waaiio_event_invite',language:'en_US',category:'MARKETING',status:'PENDING',components:[{type:'BODY',text:'{{1}} {{2}}'}]}]});
  const {preview}=await loadReminderPreview(dbFixture({window:false}).db,'party','chase','owner');expect(preview.recipients[0].variants.every(v=>!v.available)).toBe(true);
 });
 it('withholds SMS when its 160-character variant loses assigned table content',async()=>{
  const {preview}=await loadReminderPreview(dbFixture({table:'Long table name '.repeat(20)}).db,'party','followup','owner');const sms=preview.recipients.find(r=>r.eligible)!.variants.find(v=>v.channel==='sms')!;
  expect(sms.text.length).toBe(160);expect(sms.available).toBe(false);
 });
 it('denies a different organizer and scopes every invite/table read',async()=>{
  const h=dbFixture();await expect(loadReminderPreview(h.db,'party','chase','other')).rejects.toThrow('Party unavailable');
  await loadReminderPreview(h.db,'party','chase','owner');expect(h.trace.filter(x=>['event_invites','party_tables'].includes(String(x.table))).every(x=>x.party_id==='party'&&x.business_id==='business')).toBe(true);
 });
 it('binds confirmation to actor, party, purpose, expiry and unchanged signed identity',async()=>{
  const {preview}=await loadReminderPreview(dbFixture().db,'party','chase','owner');const token=signPreview(preview,'owner');
  expect(verifyPreview(token,'party','owner').fingerprint).toBe(preview.fingerprint);expect(()=>verifyPreview(token,'party','other')).toThrow();expect(()=>verifyPreview(token+'x','party','owner')).toThrow();
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+16*60_000);expect(()=>verifyPreview(token,'party','owner')).toThrow();vi.restoreAllMocks();
  expect(scheduledOccurrence('party','2027-01-01','guest')).toBe(scheduledOccurrence('party','2027-01-01','guest'));expect(scheduledOccurrence('party','2027-01-02','guest')).not.toBe(scheduledOccurrence('party','2027-01-01','guest'));
 });
});
