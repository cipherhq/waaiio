import {beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({charge:vi.fn(),reconcile:vi.fn(),events:[] as string[],writes:[] as Record<string,any>[],fail:false,ambiguous:false}));
vi.mock('@/lib/payments/saved-card-compat',()=>({canonicalSavedCardPhone:(p:string)=>p,isCompatibleForSavedCard:async()=>({compatible:true})}));
vi.mock('@/lib/payments/resolve-stripe-routing',()=>({resolvePaymentRoutingAuthority:async()=>({classification:'platform_connect',paymentOrigin:'connect',stripeAccountId:'acct_tax',platformFeeAmount:99}),isStripeCompatibleForSavedCard:()=>true}));
vi.mock('@/lib/payments/stripe-saved-card',async()=>({...await vi.importActual('@/lib/payments/stripe-saved-card'),chargeStripeSavedCard:h.charge}));
vi.mock('@/lib/payments/reconcile',()=>({reconcilePayment:h.reconcile}));
import {savedPaymentAdapter} from '@/lib/payments/saved-payment-adapter';
const fee={version:1,feePolicyVersion:0,configVersionId:null,tier:'free',currency:'USD',feePercentage:3,feeFlat:0,feeTotal:3,netAmount:10000,grossAmount:12000,flatMinor:0,percentageMinor:300,totalMinor:300};
function client(){
 const chain=(table:string,write?:Record<string,any>):any=>new Proxy({}, {get(_t,key){
  if(key==='update')return (value:Record<string,any>)=>{h.writes.push(value);h.events.push(String(value.provider_init_state||'metadata'));return chain(table,value);};
  if(key==='insert')return ()=>{throw new Error('Tax payment must be reserved');};
  if(key==='then')return (resolve:(v:unknown)=>unknown)=>resolve({data:write?[{id:'payment-tax'}]:[],error:null});
  if(key==='single'||key==='maybeSingle')return async()=>({data:table==='saved_payment_methods'?{id:'method-tax',gateway:'stripe',stripe_customer_id:'cus_tax',stripe_payment_method_id:'pm_tax'}:null,error:null});
  return ()=>chain(table,write);
 }});
 return {from:(table:string)=>chain(table),rpc:vi.fn(async(name:string)=>{
  h.events.push(name);
  if(name==='reserve_merchant_tax_payment_980')return h.fail?{data:null,error:{message:'held'}}:{data:{taxable:true,payment:{id:'payment-tax'}},error:null};
  if(name==='bind_merchant_tax_fee_980')return {data:fee,error:null};
  if(name==='confirm_merchant_tax_payment_failure_980')return {data:true,error:null};
  throw new Error('Unexpected RPC');
 })} as any;
}
const opts={methodId:'method-tax',customerPhone:'+15550000000',amount:120,currency:'USD',email:'test@example.invalid',reference:'intent',businessId:'business',orderId:'order'};
beforeEach(()=>{h.events=[];h.writes=[];h.fail=false;h.charge.mockReset();h.reconcile.mockResolvedValue({});h.charge.mockImplementation(async()=>{h.events.push('provider');return {status:'succeeded',paymentIntentId:'pi_tax'};});});
describe('Stripe saved-card tax authority',()=>{
 it('binds net fee, persists exact replay parameters, and dispatches once with gross amount',async()=>{
  expect(await savedPaymentAdapter.chargeSavedMethod(client(),opts)).toMatchObject({status:'charged',paymentId:'payment-tax'});
  expect(h.events.slice(0,5)).toEqual(['reserve_merchant_tax_payment_980','bind_merchant_tax_fee_980','metadata','dispatched','provider']);
  expect(h.charge).toHaveBeenCalledWith(expect.objectContaining({amountCents:12000,applicationFeeAmount:300,idempotencyKey:'sc_charge_payment-tax',stripeAccountId:'acct_tax'}));
  expect(h.writes[0].metadata.pi_params.application_fee_amount).toBe('300');
 });
 it('does not dispatch if the allocation cannot be reserved',async()=>{h.fail=true;expect(await savedPaymentAdapter.chargeSavedMethod(client(),opts)).toMatchObject({status:'declined'});expect(h.charge).not.toHaveBeenCalled();});
 it('retains the hold for ambiguous provider outcomes',async()=>{
  h.charge.mockResolvedValue({status:'indeterminate'});const db=client();
  expect(await savedPaymentAdapter.chargeSavedMethod(db,opts)).toMatchObject({status:'indeterminate'});
  expect(db.rpc.mock.calls.some((call:any[])=>call[0]==='confirm_merchant_tax_payment_failure_980')).toBe(false);
 });
 it('releases only an explicit provider decline atomically',async()=>{
  h.charge.mockResolvedValue({status:'declined',errorMessage:'declined'});const db=client();
  expect(await savedPaymentAdapter.chargeSavedMethod(db,opts)).toMatchObject({status:'declined'});
  expect(db.rpc).toHaveBeenCalledWith('confirm_merchant_tax_payment_failure_980',expect.objectContaining({p_payment_id:'payment-tax',p_gateway:'stripe',p_status:'failed'}));
 });
});
