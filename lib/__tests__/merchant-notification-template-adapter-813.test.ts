import {handleMerchantAlertOptIn,sendMerchantAlertControlReply} from '@/lib/bot/merchant-alert-optin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';

vi.mock('@/lib/channels/circuit-breaker', () => ({
  isCircuitOpen: () => false,
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error {},
}));
vi.mock('@/lib/channels/send-guard', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/channels/send-guard')>(),
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
}));

import { assertMessagingAllowed, MessagingSuspendedError } from '@/lib/channels/send-guard';
import { PreEmissionRecoveryError } from '@/lib/channels/pre-emission-error';
import { MetaCloudSender } from '@/lib/channels/message-sender';
import { MetaCloudService } from '@/lib/channels/meta-cloud';

afterEach(() => vi.unstubAllGlobals());

describe('template locale through real sender and cloud adapter', () => {
  it.each([
    ['explicit merchant locale', 'en', 'en'],
    ['existing omitted locale', undefined, 'en_US'],
  ])('%s reaches the actual provider request body', async (_label, languageCode, expected) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      messages: [{id: 'wamid.locale-test'}],
    }), {status: 200, headers: {'Content-Type': 'application/json'}}));
    vi.stubGlobal('fetch', fetchMock);
    const cloud = new MetaCloudService({accessToken: 'test-only', phoneNumberId: 'test-phone', wabaId: 'test-waba'});
    const sender = new MetaCloudSender(cloud, createTestSupabase());
    sender.bindBusiness('test-business');
    const result = await sender.sendTemplate({
      to: '2348012345678', templateName: 'name_waaiio_merchant_alert_v1',
      ...(languageCode === undefined ? {} : {languageCode}),
      templateParams: ['Shop', 'Order received', 'ORDER-1', 'Review payment status'],
      messageCategory: 'utility', noRetry: true,
    });
    expect(result).toEqual({success: true, messageId: 'wamid.locale-test'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toContain('/test-phone/messages');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({
      messaging_product: 'whatsapp', to: '2348012345678', type: 'template',
      template: {
        name: 'name_waaiio_merchant_alert_v1', language: {code: expected},
        components: [{type: 'body', parameters: ['Shop', 'Order received', 'ORDER-1', 'Review payment status']
          .map(text => ({type: 'text', text}))}],
      },
    });
  });
});

describe('actual sender pre-emission classification',()=>{
 it('reports transient initial guard failure only when explicitly requested',async()=>{
  const cloud={sendTemplate:vi.fn()} as unknown as MetaCloudService;
  const sender=new MetaCloudSender(cloud,createTestSupabase());sender.bindBusiness('test-business');
  vi.mocked(assertMessagingAllowed).mockRejectedValueOnce(new MessagingSuspendedError('test-business','db_error'));
  await expect(sender.sendTemplate({to:'14155552671',templateName:'test',templateParams:[],noRetry:true,reportSafePreEmissionFailure:true})).rejects.toBeInstanceOf(PreEmissionRecoveryError);
  expect(cloud.sendTemplate).not.toHaveBeenCalled();
  const original=new MessagingSuspendedError('test-business','db_error');vi.mocked(assertMessagingAllowed).mockRejectedValueOnce(original);
  await expect(sender.sendTemplate({to:'14155552671',templateName:'test',templateParams:[],noRetry:true})).rejects.toBe(original);
 });
 it('does not classify suspension or provider timeout as safe recovery',async()=>{
  const timeout=new Error('timeout');const cloud={sendTemplate:vi.fn().mockRejectedValue(timeout)} as unknown as MetaCloudService;
  const sender=new MetaCloudSender(cloud,createTestSupabase());sender.bindBusiness('test-business');
  const denied=new MessagingSuspendedError('test-business','suspended');vi.mocked(assertMessagingAllowed).mockRejectedValueOnce(denied);
  await expect(sender.sendTemplate({to:'14155552671',templateName:'test',templateParams:[],noRetry:true,reportSafePreEmissionFailure:true})).rejects.toBe(denied);
  await expect(sender.sendTemplate({to:'14155552671',templateName:'test',templateParams:[],noRetry:true,reportSafePreEmissionFailure:true})).rejects.not.toBeInstanceOf(PreEmissionRecoveryError);
 });
 it('uses tenantless platform control replies while business text still fails closed',async()=>{
  const cloud={sendText:vi.fn().mockResolvedValue({messageId:'wamid.control'})} as unknown as MetaCloudService;
  const sender=new MetaCloudSender(cloud,createTestSupabase());
  vi.mocked(assertMessagingAllowed).mockRejectedValueOnce(new MessagingSuspendedError('unknown','missing_business_id'));
  process.env.MERCHANT_NOTIFICATIONS_ENABLED='true';
  await expect(handleMerchantAlertOptIn({db:{rpc:vi.fn().mockResolvedValue({data:{verified:true}})} as never,provenance:'verified_meta_webhook',from:'14155552671',text:`WAAIIO ALERTS ${'a'.repeat(43)}`,messageType:'text',channel:{id:'channel',channel_type:'shared',is_active:true,provider:'meta_cloud'},sendReply:text=>sendMerchantAlertControlReply(sender,'14155552671',text)})).resolves.toBe(true);
  expect(cloud.sendText).toHaveBeenCalledWith(expect.objectContaining({text:expect.stringContaining('Business notifications are now enabled')}));
  expect(assertMessagingAllowed).not.toHaveBeenLastCalledWith('');
  await expect(sender.sendText({to:'14155552671',text:'business scoped'})).rejects.toBeInstanceOf(MessagingSuspendedError);
 });
});
