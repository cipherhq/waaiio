import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),guard:vi.fn(),provider:vi.fn(),markSending:vi.fn()}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>({rpc:m.rpc})}));
vi.mock('@/lib/channels/send-guard',async original=>({...await original<typeof import('@/lib/channels/send-guard')>(),assertMessagingAllowed:m.guard}));
vi.mock('@/lib/channels/attempt-recording',async original=>({...await original<typeof import('@/lib/channels/attempt-recording')>(),createAttempt:vi.fn(async()=> 'attempt'),updateAttemptContext:vi.fn(),markSending:m.markSending,markAccepted:vi.fn(),markFailed:vi.fn(),markAmbiguous:vi.fn()}));
import {MetaCloudSender} from '@/lib/channels/message-sender';
import type {MetaCloudService} from '@/lib/channels/meta-cloud';
import {PreEmissionRecoveryError} from '@/lib/channels/pre-emission-error';
import {MessagingSuspendedError} from '@/lib/channels/send-guard';
const message={to:'14155552671',templateName:'name_waaiio_merchant_alert_v1',templateParams:[],noRetry:true,reportSafePreEmissionFailure:true};
function sender(){const s=new MetaCloudSender({sendTemplate:m.provider} as unknown as MetaCloudService,{} as never);s.bindBusiness('business');return s;}
beforeEach(()=>{vi.resetAllMocks();m.guard.mockResolvedValue(undefined);m.rpc.mockResolvedValue({data:{enforcement_required:false}});m.provider.mockResolvedValue({messageId:'wamid'});});
describe('strict financial pre-emission boundary',()=>{
 it.each(['40001','40P01'])('recovers returned transaction rollback %s before provider invocation',async code=>{
  const cause={code,message:'transaction aborted'};m.rpc.mockResolvedValue({error:cause});
  await expect(sender().sendTemplate(message)).rejects.toMatchObject({name:'PreEmissionRecoveryError',cause});
  expect(m.provider).not.toHaveBeenCalled();expect(m.markSending).not.toHaveBeenCalled();expect(m.rpc).toHaveBeenCalledTimes(1);
 });
 it.each(['PGRST000','57014','unknown'])('does not infer rollback from %s',async code=>{
  m.rpc.mockResolvedValue({error:{code,message:'unavailable'}});
  await expect(sender().sendTemplate(message)).rejects.not.toBeInstanceOf(PreEmissionRecoveryError);expect(m.provider).not.toHaveBeenCalled();
 });
 it('preserves transport uncertainty',async()=>{m.rpc.mockRejectedValue(new Error('timeout'));await expect(sender().sendTemplate(message)).rejects.not.toBeInstanceOf(PreEmissionRecoveryError);expect(m.provider).not.toHaveBeenCalled();});
 it('does not recover explicit financial denial',async()=>{m.rpc.mockResolvedValue({data:{authorized:false,reason:'balance'}});await expect(sender().sendTemplate(message)).rejects.not.toBeInstanceOf(PreEmissionRecoveryError);});
 it('does not reclassify a second guard error after authorization',async()=>{m.guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new MessagingSuspendedError('business','db_error'));await expect(sender().sendTemplate(message)).rejects.not.toBeInstanceOf(PreEmissionRecoveryError);expect(m.provider).not.toHaveBeenCalled();});
 it('does not reclassify durable-marker failure',async()=>{m.markSending.mockRejectedValue(new Error('db unavailable'));await expect(sender().sendTemplate(message)).rejects.not.toBeInstanceOf(PreEmissionRecoveryError);expect(m.provider).not.toHaveBeenCalled();});
 it('does not change unrelated callers',async()=>{m.rpc.mockResolvedValue({error:{code:'40001',message:'rollback'}});await expect(sender().sendTemplate({...message,reportSafePreEmissionFailure:undefined})).rejects.not.toBeInstanceOf(PreEmissionRecoveryError);});
});
