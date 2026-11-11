import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
const state=vi.hoisted(()=>({events:[] as string[],gate:false,failReservation:false,failCas:false,provider:vi.fn(),errors:[] as unknown[]}));
vi.mock('@/lib/payments/factory',()=>({getPaymentGateway:vi.fn(),getPaymentGatewayByName:()=>({name:'stripe',initializePayment:state.provider})}));
vi.mock('@/lib/payments/gateway-resolver',()=>({resolveBusinessGateway:async()=>({gateway:'stripe',currency:'USD'}),resolveCountryGateway:async()=>({gateway:'stripe',currency:'USD'})}));
vi.mock('@/lib/payments/resolve-stripe-routing',()=>({resolvePaymentRoutingAuthority:async()=>({isByo:false,stripeAccountId:'acct_merchant',platformFeeAmount:99})}));
vi.mock('@/lib/observability',()=>({observe:async(_name:unknown,_meta:unknown,fn:()=>unknown)=>fn()}));
vi.mock('@/lib/logger',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:(...args:unknown[])=>state.errors.push(args),withContext:()=>({error:(...args:unknown[])=>state.errors.push(args)})}}));
vi.mock('@/lib/trial-status',()=>({resolveTrialStatus:async()=>false}));
vi.mock('@/lib/url',()=>({canonicalPublicOrigin:()=> 'https://example.test'}));
vi.mock('@/lib/getPlatformFees',()=>({getPlatformFees:vi.fn()}));
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { parseTaxRefundSelection, parseTaxRefundRequestId } from '../refund-selection';

function client() {
  const chain=(table:string,write?:Record<string,unknown>):any=>new Proxy({}, {get(_target,key){
    if(key==='update') return (payload:Record<string,unknown>)=> {state.events.push(String(payload.provider_init_state || 'update'));return chain(table,payload);};
    if(key==='insert') return ()=>{throw new Error('Tax payment must use SQL reservation');};
    if(key==='then') return (resolve:(v:unknown)=>unknown)=>resolve({data:write?(state.failCas?[]:[{id:'payment-tax'}]):[],error:null});
    if(key==='maybeSingle') return async()=>({data:null,error:null});
    if(key==='single') return async()=>({data:table==='platform_config_versions'
      ? {id:'config-tax',config_snapshot:{fee_policy_enabled:state.gate,pricing_tiers:{free:{feePercentage:3,feeFlat:0}}}}
      : {subscription_tier:'free',custom_fee_percentage:null,custom_fee_flat:null},error:null});
    return ()=>chain(table,write);
  }});
  return {from:(table:string)=>chain(table),rpc:vi.fn(async(name:string)=>{
    state.events.push(name);
    if(name==='reserve_merchant_tax_payment_980') return state.failReservation ? {data:null,error:{message:'unresolved'}}
      : {data:{taxable:true,payment:{id:'payment-tax'}},error:null};
    return {data:{version:1,feePolicyVersion:state.gate?1:0,configVersionId:state.gate?'config-tax':null,
      tier:'free',currency:'USD',feePercentage:3,feeFlat:0,feeTotal:3,netAmount:10000,grossAmount:12000,
      flatMinor:0,percentageMinor:300,totalMinor:300},error:null};
  })} as unknown as SupabaseClient;
}
const opts={userId:null,amount:120,referenceCode:'intent-tax',businessName:'Merchant',phone:'+15550000000',
  orderId:'order-tax',businessId:'business-tax',transactionCategory:'ordering'};
beforeEach(()=>{
  state.events=[];state.errors=[];state.gate=false;state.failReservation=false;state.failCas=false;state.provider.mockReset();
  state.provider.mockImplementation(async()=>{state.events.push('provider');return {url:'https://checkout.test',reference:'session-tax'};});
});
describe('tax checkout provider dispatch (real initializer, mocked boundaries)',()=>{
  for(const gate of [false,true]) it(`reserves and pins net fee before dispatch with v${gate?1:0}`,async()=>{
    state.gate=gate;
    expect(await initializePayment(client(),opts),JSON.stringify(state.errors)).toEqual({url:'https://checkout.test',reference:'session-tax'});
    expect(state.events).toEqual(['reserve_merchant_tax_payment_980','bind_merchant_tax_fee_980','dispatched','provider','provider_confirmed']);
    expect(state.provider).toHaveBeenCalledWith(expect.objectContaining({amount:120,platformFeeAmount:3,existingPaymentId:'payment-tax',stripeAccountId:'acct_merchant'}));
  });
  it('does not contact the provider when reservation fails',async()=>{
    state.failReservation=true;expect(await initializePayment(client(),opts)).toBeNull();expect(state.provider).not.toHaveBeenCalled();
  });
  it('does not contact the provider when another dispatch owns the row',async()=>{
    state.failCas=true;expect(await initializePayment(client(),opts)).toBeNull();expect(state.provider).not.toHaveBeenCalled();
  });
});
describe('canonical refund selection',()=>{
  it('sorts and strips unrelated fields for the same step-up and SQL payload',()=>{
    expect(parseTaxRefundSelection({mode:'items',items:[{id:'b',quantity:2,ignored:true},{id:'a',quantity:1}]}))
      .toEqual({mode:'items',items:[{id:'a',quantity:1},{id:'b',quantity:2}]});
  });
  it('requires durable request IDs and positive integer quantities',()=>{
    expect(()=>parseTaxRefundRequestId(undefined,{mode:'items',items:[{id:'a',quantity:1}]})).toThrow();
    for(const quantity of [0,-1,1.5,NaN,Infinity]) expect(()=>parseTaxRefundSelection({mode:'items',items:[{id:'a',quantity}]})).toThrow();
  });
});
