import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({sendEmail:vi.fn(),resolve:vi.fn(),sendTemplate:vi.fn(),getTemplates:vi.fn()}));
vi.mock('@/lib/email/client',()=>({sendEmail:mocks.sendEmail}));
vi.mock('@/lib/channels/channel-resolver',()=>({ChannelResolver:class {resolveByChannelIdForBusiness=mocks.resolve;}}));
import { deliverMerchantNotification, dispatchMerchantNotifications, merchantNotificationEmail } from '@/lib/merchant-notifications/delivery';
import { MERCHANT_NOTIFICATION_TEMPLATE, MERCHANT_NOTIFICATION_TEMPLATE_LANGUAGE, type MerchantNotificationDelivery } from '@/lib/merchant-notifications/types';
function fixture(channel:'email'|'whatsapp'='email') {
 const d:MerchantNotificationDelivery={id:'d',business_id:'b',recipient_id:'r',channel,address:channel==='email'?'a@example.com':'+2348012345678',whatsapp_channel_id:'c',event:'sale',source_table:'orders',source_id:'o',claim_token:'claim',payload:{title:'Order received',reference:'ORDER-1',detail:'Review payment status'}};
 const query:any={select:vi.fn(()=>query),eq:vi.fn(()=>query),single:vi.fn(async()=>({data:{name:'Shop'},error:null}))};
 const db:any={from:vi.fn(()=>query),rpc:vi.fn(async(name:string)=>({data:name==='claim_merchant_notification'?d:true,error:null}))};
 return {db,d};
}
describe('merchant notification guarded dispatch',()=>{
 beforeEach(()=>{
  vi.clearAllMocks();process.env.MERCHANT_NOTIFICATIONS_ENABLED='true';process.env.RESEND_API_KEY='test-only';
  mocks.sendEmail.mockResolvedValue({success:true,id:'email-id'});mocks.sendTemplate.mockResolvedValue({success:true,messageId:'wamid.1'});
  mocks.getTemplates.mockResolvedValue({data:[{name:'name_waaiio_merchant_alert_v1',status:'APPROVED',category:'UTILITY',language:'en'}]});
  mocks.resolve.mockResolvedValue({sender:{sendTemplate:mocks.sendTemplate},cloud:{getTemplates:mocks.getTemplates}});
 });
 it('flag off neither claims nor sends',async()=>{process.env.MERCHANT_NOTIFICATIONS_ENABLED='false';const {db}=fixture();expect(await dispatchMerchantNotifications(db)).toEqual({enabled:false,processed:0});expect(db.rpc).not.toHaveBeenCalled();});
 it('email acceptance requires real provider ID and writes dispatch fence first',async()=>{
  const {db,d}=fixture();expect(await deliverMerchantNotification(db,d)).toBe('accepted');
  expect(db.rpc.mock.calls[0][0]).toBe('fence_merchant_notification');expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({to:d.address,noRetry:true}));
  expect(db.rpc).toHaveBeenLastCalledWith('finish_merchant_notification',expect.objectContaining({p_state:'accepted',p_provider_id:'email-id'}));
 });
 it('dev email is unknown, never accepted',async()=>{mocks.sendEmail.mockResolvedValue({success:true,dev:true});const {db,d}=fixture();expect(await deliverMerchantNotification(db,d)).toBe('unknown');});
 it('WA uses consent-bound authorized channel and approved utility template, noRetry',async()=>{
  expect(MERCHANT_NOTIFICATION_TEMPLATE).toBe('name_waaiio_merchant_alert_v1');
  expect(MERCHANT_NOTIFICATION_TEMPLATE_LANGUAGE).toBe('en');
  const {db,d}=fixture('whatsapp');expect(await deliverMerchantNotification(db,d)).toBe('accepted');expect(mocks.resolve).toHaveBeenCalledWith('c','b');
  expect(mocks.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({templateName:'name_waaiio_merchant_alert_v1',languageCode:'en',noRetry:true,messageCategory:'utility',templateParams:['Shop','Order received','ORDER-1','Review payment status']}));
 });
 it.each([
  ['wrong name', {name:'waaiio_merchant_alert_v1'}],
  ['wrong language', {language:'en_US'}],
  ['pending approval', {status:'PENDING'}],
  ['wrong category', {category:'MARKETING'}],
 ])('%s is rejected before the dispatch fence',async(_reason,override)=>{
  mocks.getTemplates.mockResolvedValue({data:[{name:'name_waaiio_merchant_alert_v1',status:'APPROVED',category:'UTILITY',language:'en',...override}]});
  const {db,d}=fixture('whatsapp');expect(await deliverMerchantNotification(db,d)).toBe('pending');expect(mocks.sendTemplate).not.toHaveBeenCalled();expect(db.rpc.mock.calls.some((c:any[])=>c[0]==='fence_merchant_notification')).toBe(false);
  expect(db.rpc).toHaveBeenCalledWith('finish_merchant_notification',expect.objectContaining({p_state:'pending',p_reason:'template_unavailable'}));
 });
 it('unavailable WA does not prevent independent email',async()=>{
  mocks.resolve.mockResolvedValue(null);const wa=fixture('whatsapp'), email=fixture();expect(await deliverMerchantNotification(wa.db,wa.d)).toBe('pending');expect(await deliverMerchantNotification(email.db,email.d)).toBe('accepted');
 });
 it('pre-dispatch suppression never reaches provider',async()=>{const {db,d}=fixture();db.rpc.mockResolvedValue({data:false,error:null});expect(await deliverMerchantNotification(db,d)).toBe('suppressed');expect(mocks.sendEmail).not.toHaveBeenCalled();});
 it('provider timeout is unknown without application retry',async()=>{mocks.sendTemplate.mockRejectedValue(new Error('timeout'));const {db,d}=fixture('whatsapp');expect(await deliverMerchantNotification(db,d)).toBe('unknown');expect(mocks.sendTemplate).toHaveBeenCalledTimes(1);expect(db.rpc).toHaveBeenLastCalledWith('finish_merchant_notification',expect.objectContaining({p_state:'unknown'}));});
 it('provider success without message ID is unknown',async()=>{mocks.sendTemplate.mockResolvedValue({success:true});const {db,d}=fixture('whatsapp');expect(await deliverMerchantNotification(db,d)).toBe('unknown');});
 it('failed fence persistence cannot send',async()=>{const {db,d}=fixture();db.rpc.mockResolvedValue({data:null,error:{message:'db unavailable'}});await expect(deliverMerchantNotification(db,d)).rejects.toThrow('dispatch fence');expect(mocks.sendEmail).not.toHaveBeenCalled();});
 it('email escapes source-controlled HTML',()=>{expect(merchantNotificationEmail('<img>',{title:'<script>',reference:'&',detail:'"test"'}).html).toContain('&lt;script&gt;');expect(merchantNotificationEmail('<img>',{title:'x',reference:'&',detail:'y'}).html).not.toContain('<img>');});
});
