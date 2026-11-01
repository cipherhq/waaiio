import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({getUser:vi.fn(),rpc:vi.fn(),from:vi.fn(),send:vi.fn()}));
vi.mock('@supabase/ssr',()=>({createServerClient:()=>({auth:{getUser:mocks.getUser}})}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>({from:mocks.from,rpc:mocks.rpc})}));
vi.mock('@/lib/email/client',()=>({sendEmail:mocks.send}));
vi.mock('@/lib/rate-limit',()=>({checkRateLimitAsync:async()=>({allowed:true})}));
import { POST, PATCH, DELETE } from '@/app/api/settings/merchant-notifications/route';
import { POST as enroll } from '@/app/api/settings/merchant-notifications/enrollment/route';
import { POST as confirm } from '@/app/api/merchant-notifications/confirm/route';
import { handleMerchantAlertOptIn } from '@/lib/bot/merchant-alert-optin';
import { hashInvitation, normalizeAddress, validateEvents, issueInvitation } from '@/lib/merchant-notifications/enrollment';
const biz='11111111-1111-4111-8111-111111111111', id='22222222-2222-4222-8222-222222222222';
function request(body:unknown, method='POST', origin='https://www.waaiio.com') { return new NextRequest('https://www.waaiio.com/api/settings/merchant-notifications',{method,headers:{'content-type':'application/json',origin},body:JSON.stringify(body)}); }
let own=true; const filters:unknown[]=[];
beforeEach(()=>{
 vi.clearAllMocks();process.env.MERCHANT_NOTIFICATIONS_ENABLED='true';own=true;filters.length=0;
 mocks.getUser.mockResolvedValue({data:{user:{id:'owner'}}});
 mocks.rpc.mockResolvedValue({data:{created:true,recipient:{id},verified:true},error:null});
 mocks.from.mockImplementation((table:string)=>{ const q={select:()=>q,eq:(key:string,value:unknown)=>{filters.push([table,key,value]);return q;},is:()=>q,update:()=>q,maybeSingle:async()=>({data:table==='businesses'?(own?{id:biz}:null):{id},error:null})};return q; });
});
describe('owner notification HTTP boundaries',()=>{
 it('rejects anonymous creation before RPC',async()=>{mocks.getUser.mockResolvedValue({data:{user:null}});expect((await POST(request({business_id:biz}))).status).toBe(401);expect(mocks.rpc).not.toHaveBeenCalled();});
 it('rejects a different tenant owner',async()=>{own=false;expect((await POST(request({business_id:biz}))).status).toBe(403);expect(mocks.rpc).not.toHaveBeenCalled();});
 it('authorizes the exact mutation tenant when conflicting aliases are supplied',async()=>{own=false;expect((await POST(request({business_id:biz,businessId:id,label:'Sales',channel:'email',address:'team@example.com',events:['sale']}))).status).toBe(403);expect(filters).toContainEqual(['businesses','id',biz]);expect(mocks.rpc).not.toHaveBeenCalled();});
 it.each([['PATCH',PATCH],['DELETE',DELETE],['POST',enroll]] as const)('rejects conflicting tenant aliases for %s without recipient access',async(method,handler)=>{own=false;expect((await handler(request({business_id:biz,businessId:id,id,enabled:false},method))).status).toBe(403);expect(filters).toContainEqual(['businesses','id',biz]);expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.from).not.toHaveBeenCalledWith('merchant_notification_recipients');});
 it('creates normalized recipient only after owner check',async()=>{expect((await POST(request({business_id:biz,label:'Sales',channel:'email',address:'TEAM@EXAMPLE.COM',events:['sale']}))).status).toBe(201);expect(filters).toContainEqual(['businesses','owner_id','owner']);expect(mocks.rpc).toHaveBeenCalledWith('create_merchant_notification_recipient',expect.objectContaining({p_business_id:biz,p_address:'team@example.com'}));});
 it('rejects cross-origin writes',async()=>{expect((await POST(request({business_id:biz},'POST','https://evil.example'))).status).toBe(403);expect(mocks.from).not.toHaveBeenCalled();});
 it('scopes recipient edits and removal by tenant',async()=>{expect((await PATCH(request({business_id:biz,id,enabled:false},'PATCH'))).status).toBe(200);expect(filters).toContainEqual(['merchant_notification_recipients','business_id',biz]);expect((await DELETE(request({business_id:biz,id},'DELETE'))).status).toBe(200);});
 it('disallows destination edits',async()=>{expect((await PATCH(request({business_id:biz,id,address:'other@example.com'},'PATCH'))).status).toBe(400);});
 it('requires intentional email acceptance',async()=>{expect((await confirm(request({token:'a'.repeat(43)}))).status).toBe(400);expect(mocks.rpc).not.toHaveBeenCalled();expect((await confirm(request({token:'a'.repeat(43),accept:true}))).status).toBe(200);expect(mocks.rpc).toHaveBeenCalledWith('consume_merchant_notification_invitation',{p_token_hash:hashInvitation('a'.repeat(43)),p_channel:'email',p_address:null,p_channel_id:null});});
 it('keeps removal available while rollout disabled',async()=>{process.env.MERCHANT_NOTIFICATIONS_ENABLED='false';expect((await POST(request({business_id:biz}))).status).toBe(503);expect((await DELETE(request({business_id:biz,id},'DELETE'))).status).toBe(200);});
});
describe('signed transport merchant consent',()=>{
 const channel={id,channel_type:'shared',provider:'meta_cloud',is_active:true};
 const invoke=(overrides:Record<string,unknown>={})=>handleMerchantAlertOptIn({db:{rpc:mocks.rpc} as never,provenance:'verified_meta_webhook',from:'14155552671',text:`WAAIIO ALERTS ${'a'.repeat(43)}`,messageType:'text',channel,sendReply:mocks.send,...overrides});
 it('binds verification to actual sender and exact channel',async()=>{expect(await invoke()).toBe(true);expect(mocks.rpc).toHaveBeenCalledWith('consume_merchant_notification_invitation',{p_token_hash:hashInvitation('a'.repeat(43)),p_channel:'whatsapp',p_address:'+14155552671',p_channel_id:id});});
 it('does not activate audio/interactive or dedicated channels',async()=>{expect(await invoke({messageType:'audio'})).toBe(false);expect(await invoke({channel:{...channel,channel_type:'dedicated'}})).toBe(false);expect(mocks.rpc).not.toHaveBeenCalled();});
 it('does not report wrong sender token as verified',async()=>{mocks.rpc.mockResolvedValue({data:{verified:false}});await invoke({from:'442079460018'});expect(mocks.send).toHaveBeenCalledWith(expect.stringContaining('another number'));});
 it('STOP suppresses alerts but continues existing customer handler',async()=>{process.env.MERCHANT_NOTIFICATIONS_ENABLED='false';expect(await invoke({text:'STOP'})).toBe(false);expect(mocks.rpc).toHaveBeenCalledWith('revoke_merchant_notification_whatsapp',{p_address:'+14155552671',p_channel_id:id});});
 it('rejects internal provenance',async()=>{expect(await invoke({provenance:'internal_replay'})).toBe(false);expect(mocks.rpc).not.toHaveBeenCalled();});
 it('START cannot re-enable merchant consent',async()=>{expect(await invoke({text:'START'})).toBe(false);expect(mocks.rpc).not.toHaveBeenCalled();});
});
it('validates destination and event allowlists',()=>{expect(()=>normalizeAddress('whatsapp','4155552671')).toThrow();expect(()=>validateEvents(['admin'])).toThrow();});

describe('invitation issuance',()=>{
 function database(channel='email') {
  return {rpc:mocks.rpc,from:(table:string)=>{const q={select:()=>q,eq:()=>q,is:()=>q,maybeSingle:async()=>({data:table==='businesses'?{name:'Acme <team>',country_code:'US'}:table==='whatsapp_channels'?{id,phone_number:'+14155552671',phone_number_id:'meta-id'}:{id,enabled:true,channel,address:'team@example.com'},error:null})};return q;}} as never;
 }
 beforeEach(()=>{process.env.RESEND_API_KEY='test-placeholder';mocks.rpc.mockResolvedValue({data:{issued:true,expires_at:'future'},error:null});mocks.send.mockResolvedValue({success:true,id:'mail-id'});});
 it('stores only a token hash and sends business-scoped explicit email invitation',async()=>{await expect(issueInvitation(database(),biz,id)).resolves.toEqual({sent:true,expires_at:'future'});const html=mocks.send.mock.calls[0][0].html;expect(html).toContain('Acme &lt;team&gt;');const token=html.match(/#token=([A-Za-z0-9_-]{43})/)[1];expect(mocks.rpc).toHaveBeenCalledWith('issue_merchant_notification_invitation',expect.objectContaining({p_token_hash:hashInvitation(token)}));expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(token);});
 it('does not report development email as sent',async()=>{mocks.send.mockResolvedValue({success:true,dev:true});await expect(issueInvitation(database(),biz,id)).rejects.toThrow('not accepted');});
 it('pins a shared channel and names business in opt-in message',async()=>{const result=await issueInvitation(database('whatsapp'),biz,id);expect('url' in result && decodeURIComponent(result.url)).toContain('I agree to receive');expect(mocks.rpc).toHaveBeenCalledWith('issue_merchant_notification_invitation',expect.objectContaining({p_channel_id:id}));expect(mocks.send).not.toHaveBeenCalled();});
 it('does not send on rejected or throttled issuance',async()=>{mocks.rpc.mockResolvedValue({data:{issued:false,reason:'throttled'}});await expect(issueInvitation(database(),biz,id)).rejects.toThrow('wait');expect(mocks.send).not.toHaveBeenCalled();});
});
