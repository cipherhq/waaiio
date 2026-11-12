import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const f=vi.hoisted(()=>({admin:vi.fn(),step:vi.fn(),process:vi.fn(),user:vi.fn(),capability:vi.fn(),audit:vi.fn(),allowed:true}));
function db() {return {auth:{getUser:f.user},from:()=>{const chain:any={select:()=>chain,eq:()=>chain,single:async()=>({data:f.allowed?{id:'payment',business_id:'business'}:null,error:null})};return chain;}};}
vi.mock('@supabase/supabase-js',()=>({createClient:()=>db()}));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>db()}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>db()}));
vi.mock('@/lib/admin-auth',()=>({requirePlatformAdmin:f.admin}));
vi.mock('@/lib/admin-step-up',()=>({consumeStepUp:f.step,StepUpError:class extends Error{}}));
vi.mock('@/lib/payments/refund-handler',()=>({processRefund:f.process}));
vi.mock('@/lib/capabilities/api-guard',()=>({requireCapability:f.capability}));
vi.mock('@/lib/admin-audit',()=>({logAdminAudit:f.audit}));
vi.mock('@/lib/logger',()=>({logger:{error:vi.fn(),withContext:()=>({error:vi.fn()})}}));
import {POST as adminPost} from '@/app/api/admin/payments/refund/route';
import {POST as merchantPost} from '@/app/api/payments/refund/route';
const requestId='20000000-0000-4000-8000-000000000001';
const body={paymentId:'payment',businessId:'business',amount:0,reason:'return',stepUpId:'step',requestId,
  taxSelection:{mode:'items',items:[{id:'b',quantity:1},{id:'a',quantity:2}]}};
const req=(value:unknown)=>new NextRequest('https://example.test/api/payments/refund',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(value)});
beforeEach(()=>{vi.clearAllMocks();f.allowed=true;f.admin.mockResolvedValue({id:'admin'});f.step.mockResolvedValue(undefined);
  f.user.mockResolvedValue({data:{user:{id:'owner'}}});f.capability.mockResolvedValue({allowed:true});
  f.process.mockResolvedValue({success:true,zeroValueReturn:true,returnId:'return-1',state:'success'});});
describe('tax refund route authorization and selection binding',()=>{
  it('binds canonical selected items and request identity to admin step-up',async()=>{
    const response=await adminPost(req(body));expect(response.status).toBe(200);
    const canonical={mode:'items',items:[{id:'a',quantity:2},{id:'b',quantity:1}]};
    expect(f.step).toHaveBeenCalledWith({id:'admin'},'step','refund','payment',{businessId:'business',amount:0,reason:'return',taxSelection:canonical,requestId});
    expect(f.process).toHaveBeenCalledWith(expect.objectContaining({taxSelection:canonical,requestId,amount:0}));
  });
  it('does not execute when operation-bound step-up rejects',async()=>{
    f.step.mockRejectedValue(new Error('mismatch'));expect((await adminPost(req(body))).status).toBe(403);expect(f.process).not.toHaveBeenCalled();
  });
  it('keeps legacy step-up fields unchanged when selection is absent',async()=>{
    await adminPost(req({paymentId:'payment',businessId:'business',amount:12,reason:'return',stepUpId:'step'}));
    expect(f.step).toHaveBeenCalledWith({id:'admin'},'step','refund','payment',{businessId:'business',amount:12,reason:'return'});
  });
  it('allows an authenticated merchant zero-value item return',async()=>{
    const response=await merchantPost(req(body));expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({zeroValueReturn:true,returnId:'return-1'});
  });
  it('denies unauthenticated and non-owning merchants before reservation',async()=>{
    f.user.mockResolvedValueOnce({data:{user:null}});expect((await merchantPost(req(body))).status).toBe(401);
    f.allowed=false;expect((await merchantPost(req(body))).status).toBe(403);expect(f.process).not.toHaveBeenCalled();
  });
  it('rejects malformed quantities and an unselected zero refund',async()=>{
    expect((await merchantPost(req({...body,taxSelection:{mode:'items',items:[{id:'a',quantity:0}]}}))).status).toBe(400);
    expect((await adminPost(req({...body,taxSelection:undefined,requestId:undefined}))).status).toBe(400);
    expect(f.process).not.toHaveBeenCalled();
  });
});
