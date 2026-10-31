/**
 * Real reconcile -> authority -> processSuccessfulPayment -> recordPlatformFee.
 * Storage and provider HTTP are synthetic; no live sends or hosted mutations.
 * SQL concurrency/provenance is independently proven in the M485 PG suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reconcilePayment } from '../reconcile';
import { authorizeAndFinalize, resumeSuccessfulPaymentFinalization, type VerifiedPaymentResult } from '../authority';
import { processSuccessfulPayment } from '../process-success';
import { processPaystackChargeSuccess } from '../webhook-handler';
import { normalizePaystackGatewayFee } from '../provider-adapters';

const boundary = vi.hoisted(() => ({
  confirm: vi.fn(), terminalize: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/logger', () => ({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn(),withContext:()=>({error:vi.fn(),warn:vi.fn()})}}));
vi.mock('../send-confirmation', () => ({sendProactiveConfirmation:boundary.confirm}));
vi.mock('../session-terminalization', () => ({terminalizeOriginatingSession:boundary.terminalize}));
vi.mock('@/lib/posthog/server', () => ({getServerPostHog:()=>null}));
vi.mock('@/lib/fraud/detect', () => ({checkPaymentFraud:vi.fn()}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({evaluateRules:vi.fn()}));
vi.mock('@/lib/waitlist/auto-notify', () => ({markWaitlistConverted:vi.fn()}));

type Row = Record<string, any>; // Synthetic PostgREST rows spanning multiple tables.
function fixture() {
  const payment: Row = {id:'payment-762',amount:5000,currency:'NGN',gateway:'paystack',gateway_reference:'REF-762',
    status:'pending',business_id:'biz-762',booking_id:'booking-762',invoice_id:null,campaign_id:null,
    reservation_id:null,order_id:null,metadata:{payment_origin:'platform'},gateway_fee:0,
    payment_authority_version:1,fee_policy_version:1,config_version_id:'config-762',transaction_category:'appointment',
    fee_basis:{payment_routing:'platform',tier:'free',is_in_trial:false,custom_fee_percentage:null,custom_fee_flat:null},
    finalization_completed_at:null,finalization_processing_at:null,finalization_claim_token:null,
    gateway_fee_contract_version:1,verified_gateway_fee:null,gateway_fee_claim_snapshot:null,gateway_fee_claim_sealed_at:null};
  const tables: Record<string,Row[]> = {
    payments:[payment],bookings:[{id:'booking-762',business_id:'biz-762',status:'pending',deposit_status:'pending',
      payment_id:null,flow_type:'appointment',guest_phone:null}],
    businesses:[{id:'biz-762',payout_mode:'platform_managed',subscription_tier:'free',reseller_id:null}],
    platform_config_versions:[{id:'config-762',config_snapshot:{pricing_tiers:{free:{feePercentage:2,feeFlat:0}},category_fee_rates:{appointment:{feePercentage:3}}}}],
    platform_fees:[],orders:[{id:'order-762',business_id:'biz-762',referral_id:null}],
  };
  const state = {feeError:false,claimFailure:false,lostResponse:false,rereadFailure:false,lookupFailure:false,
    markPaidFailure:false,markPaidZero:false,spendFailure:false,token:0,feeAttempts:0,
    beforeClaim:null as null|(()=>Promise<void>),calls:[] as {name:string,args:Row}[],writes:[] as {table:string,values:Row}[]};
  function from(table:string) {
    const filters:((row:Row)=>boolean)[]=[];
    let operation='select'; let values:Row={}; let one=false; let selection='';
    const run=async()=>{
      if(table==='payments'&&state.lookupFailure) return {data:null,error:{message:'lookup unavailable'}};
      if(table==='payments'&&state.rereadFailure&&selection.includes('gateway_fee_claim_sealed_at')) return {data:null,error:{message:'reread unavailable'}};
      const rows=(tables[table]||[]).filter(row=>filters.every(filter=>filter(row)));
      if(operation==='update') {
        state.writes.push({table,values:{...values}});
        if(table==='payments'&&values.status==='success'&&(state.markPaidFailure||state.markPaidZero))
          return {data:[],error:state.markPaidFailure?{message:'paid update failure'}:null};
        rows.forEach(row=>Object.assign(row,values));
      }
      if(operation==='insert') {
        if(table==='platform_fees') {
          state.feeAttempts++;
          if(state.feeError) return {data:null,error:{message:'fee storage unavailable'}};
          if(!Number.isInteger(values.gateway_fee)||values.gateway_fee<0||values.gateway_fee>2147483647)
            return {data:null,error:{message:'invalid integer fee'}};
          if(tables.platform_fees.some(row=>row.payment_id===values.payment_id))
            return {data:null,error:{message:'duplicate unique payment',code:'23505'}};
        }
        (tables[table] ||= []).push({...values});
        return {data:null,error:null};
      }
      return {data:one?(rows[0]?structuredClone(rows[0]):null):structuredClone(rows),error:null};
    };
    const chain:any = {
      select:(fields='')=>{selection=fields;return chain;},
      eq:(key:string,value:unknown)=>{filters.push(row=>row[key]===value);return chain;},
      is:(key:string,value:unknown)=>{filters.push(row=>row[key]===value||value===null&&row[key]===undefined);return chain;},
      in:(key:string,values:unknown[])=>{filters.push(row=>values.includes(row[key]));return chain;},
      update:(data:Row)=>{operation='update';values=data;return chain;},
      insert:(data:Row)=>{operation='insert';values=data;return chain;},
      single:()=>{one=true;return run();},maybeSingle:()=>{one=true;return run();},
      then:(resolve:(value:unknown)=>unknown,reject:(reason:unknown)=>unknown)=>run().then(resolve,reject),
    };
    return chain;
  }
  async function rpc(name:string,args:Row) {
    state.calls.push({name,args});
    const result=(data:Row)=>({data,error:null});
    if(name.startsWith('claim_payment_finalization')) {
      if(state.beforeClaim) {const barrier=state.beforeClaim;state.beforeClaim=null;await barrier();}
      if(state.claimFailure) return {data:null,error:{message:'claim rolled back'}};
      const observed=name==='claim_payment_finalization_with_verified_fee';
      if(observed) {
        if(args.p_provider!==payment.gateway||args.p_reference!==payment.gateway_reference||args.p_amount!==payment.amount||args.p_currency!==payment.currency)
          return result({claimed:false,reason:'payment_tuple_mismatch'});
        if(payment.gateway_fee_contract_version===null&&args.p_fee_supplied&&args.p_gateway_fee!==payment.gateway_fee)
          return result({claimed:false,reason:'legacy_fee_reconciliation_required'});
        if(payment.gateway_fee_claim_sealed_at&&args.p_fee_supplied&&payment.gateway_fee_contract_version!==null) {
          if(payment.verified_gateway_fee===null) return result({claimed:false,reason:'fee_snapshot_sealed'});
          if(payment.verified_gateway_fee!==args.p_gateway_fee) return result({claimed:false,reason:'fee_conflict'});
        }
      }
      if(payment.finalization_completed_at) return result({claimed:false,already_completed:true,reason:'already_finalized'});
      if(payment.finalization_processing_at&&Date.parse(payment.finalization_processing_at)>Date.now()-300000)
        return result({claimed:false,reason:'processing_in_progress'});
      if(!payment.gateway_fee_claim_sealed_at) {
        if(observed&&args.p_fee_supplied&&payment.gateway_fee_contract_version!==null) {
          payment.gateway_fee=args.p_gateway_fee;payment.verified_gateway_fee=args.p_gateway_fee;
        }
        payment.gateway_fee_claim_snapshot=payment.gateway_fee;payment.gateway_fee_claim_sealed_at=new Date().toISOString();
      }
      payment.finalization_claim_token='claim-'+(++state.token);payment.finalization_processing_at=new Date().toISOString();
      if(state.lostResponse) throw new Error('commit response lost');
      return result({claimed:true,claim_token:payment.finalization_claim_token,payment_id:payment.id,amount:payment.amount,
        booking_id:payment.booking_id,invoice_id:null,campaign_id:null,reservation_id:null,order_id:payment.order_id,gateway_fee:payment.gateway_fee});
    }
    if(name==='release_payment_finalization') {
      if(payment.finalization_claim_token!==args.p_claim_token) return result({released:false,reason:'token_mismatch'});
      payment.finalization_claim_token=null;payment.finalization_processing_at=null;return result({released:true});
    }
    if(name==='complete_payment_finalization') {
      if(payment.finalization_claim_token!==args.p_claim_token) return result({completed:false,reason:'token_mismatch'});
      payment.finalization_completed_at=new Date().toISOString();payment.finalization_claim_token=null;payment.finalization_processing_at=null;
      return result({completed:true});
    }
    if(name==='apply_payment_spend_once') return result({applied:!state.spendFailure,reason:state.spendFailure?'injected_failure':undefined});
    if(name==='apply_customer_spend_once') return result({applied:true});
    if(name==='apply_order_stock_once') return result({applied:true});
    if(name==='finalize_promo_reservation') return result({reason:'no_reservation'});
    throw new Error('Unimplemented fixture RPC: '+name);
  }
  return {sb:{from,rpc} as unknown as SupabaseClient,payment,tables,state};
}
const verified=(fee:unknown=750):VerifiedPaymentResult=>({provider:'paystack',waaiioReference:'REF-762',
  amount:5000,currency:'NGN',verifiedAt:'2026-10-30T00:00:00Z',verifiedGatewayFee:normalizePaystackGatewayFee(fee)});
const through=(f:ReturnType<typeof fixture>,v=verified())=>reconcilePayment(f.sb,f.payment.id,'ive_paid',{status:'verified',result:v});
const webhook=(f:ReturnType<typeof fixture>,fees:unknown=750)=>processPaystackChargeSuccess(
  {id:1,amount:500000,currency:'NGN',fees},'REF-762',f.sb,{paymentId:f.payment.id,businessId:'biz-762'});

describe('verified fee actual reconciliation and insertion',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();vi.stubGlobal('fetch',boundary.fetch);process.env.PAYSTACK_SECRET_KEY='test_fee_key';
    boundary.confirm.mockResolvedValue({status:'completed'});boundary.terminalize.mockResolvedValue({status:'no_origin'});
  });
  it('provider HTTP verification reaches actual platform-fee insertion then webhook replay',async()=>{
    const f=fixture();
    boundary.fetch.mockResolvedValue({ok:true,json:async()=>({data:{status:'success',amount:500000,currency:'NGN',fees:750}})});
    const result=await reconcilePayment(f.sb,f.payment.id,'ive_paid');
    expect(result.lifecycle?.status).toBe('completed');
    expect(f.payment.gateway_fee).toBe(8);
    expect(f.tables.platform_fees).toHaveLength(1);
    expect(f.tables.platform_fees[0]).toMatchObject({payment_id:f.payment.id,gateway_fee:8,fee_total:150,is_direct_transfer:false});
    expect(await webhook(f)).toBe('already_finalized');
    expect(f.state.feeAttempts).toBe(1);
  });
  it('webhook first uses the same normalization, without standalone fee update',async()=>{
    const f=fixture();expect(await webhook(f)).toBe('finalized');
    expect(f.tables.platform_fees[0].gateway_fee).toBe(8);
    expect(f.state.writes.filter(w=>w.table==='payments').every(w=>!('gateway_fee' in w.values))).toBe(true);
    expect((await through(f)).lifecycle?.stages.businessFinalized).toBe(true);
    expect(f.state.feeAttempts).toBe(1);
  });
  it.each([0,49,50,750])('propagates supplied %s through actual integer insert',async raw=>{
    const f=fixture();await through(f,verified(raw));
    const value=Math.round(raw/100);
    expect(f.payment.verified_gateway_fee).toBe(value);
    expect(f.tables.platform_fees[0].gateway_fee).toBe(value);
  });
  it('keeps absent observation distinct from supplied zero',async()=>{
    const f=fixture();f.state.spendFailure=true;
    const v=verified();v.verifiedGatewayFee={version:1,supplied:false};
    await through(f,v);
    expect(f.payment.verified_gateway_fee).toBeNull();expect(f.tables.platform_fees[0].gateway_fee).toBe(0);
    expect((await through(f,verified(0))).lifecycle?.reason).toBe('fee_snapshot_sealed');
  });
  it.each([null,undefined,{}, {version:2,supplied:true,value:8},{version:1,supplied:'yes',value:8},
    {version:1,supplied:true},{version:1,supplied:false,value:0},{version:1,supplied:true,value:-1},
    {version:1,supplied:true,value:1.5},{version:1,supplied:true,value:2147483648}])('present malformed envelope never falls back: %j',async envelope=>{
    const f=fixture();const v={...verified(),verifiedGatewayFee:envelope} as unknown as VerifiedPaymentResult;
    const result=await authorizeAndFinalize(f.sb,v,processSuccessfulPayment,boundary.confirm);
    expect(result.reason).toContain('invalid_gateway_fee');
    expect(f.payment.status).toBe('pending');expect(f.state.calls).toHaveLength(0);expect(f.state.writes).toHaveLength(0);
  });
  it('rejects non-Paystack observation before mutation',async()=>{
    const f=fixture();const result=await through(f,{...verified(),provider:'stripe'});
    expect(result.lifecycle?.reason).toContain('invalid_gateway_fee');expect(f.state.calls).toHaveLength(0);
    expect(f.payment.status).toBe('pending');
  });
  it.each(['stripe','paypal','flutterwave'] as const)('preserves unversioned %s scalar path',async provider=>{
    const f=fixture();f.payment.gateway=provider;f.payment.gateway_fee=7;
    const v=verified();delete v.verifiedGatewayFee;v.provider=provider;v.gatewayFee=7.25;
    expect((await through(f,v)).lifecycle?.status).toBe('completed');
    expect(f.state.calls[0].name).toBe('claim_payment_finalization');
    expect(f.tables.platform_fees[0].gateway_fee).toBe(7);
  });
  it.each(['provider','reference','amount','currency'] as const)('rejects %s mismatch before financial effects',async field=>{
    const f=fixture();const v=verified();
    if(field==='provider'){delete v.verifiedGatewayFee;v.provider='stripe';}
    if(field==='reference')v.waaiioReference='foreign';
    if(field==='amount')v.amount=4999;
    if(field==='currency')v.currency='USD';
    expect((await through(f,v)).lifecycle?.status).toBe('rejected');
    expect(f.tables.platform_fees).toHaveLength(0);expect(boundary.confirm).not.toHaveBeenCalled();
  });
  it.each(['lookupFailure','markPaidFailure','markPaidZero','claimFailure'] as const)('does not run effects after %s',async failure=>{
    const f=fixture();f.state[failure]=true;await through(f);
    expect(f.tables.platform_fees).toHaveLength(0);expect(boundary.confirm).not.toHaveBeenCalled();
  });
  it('allows a supplied retry after paid state but a rolled-back claim',async()=>{
    const f=fixture();f.state.claimFailure=true;const v=verified();v.verifiedGatewayFee={version:1,supplied:false};
    await through(f,v);expect(f.payment.status).toBe('success');expect(f.payment.gateway_fee_claim_sealed_at).toBeNull();
    f.state.claimFailure=false;expect((await through(f)).lifecycle?.status).toBe('completed');
    expect(f.tables.platform_fees[0].gateway_fee).toBe(8);
  });
  it('serializes supplied worker before the absent worker reaches claim',async()=>{
    const f=fixture();const absent=verified();absent.verifiedGatewayFee={version:1,supplied:false};
    f.state.beforeClaim=async()=>{expect((await through(f)).lifecycle?.status).toBe('completed');};
    await through(f,absent);expect(f.tables.platform_fees).toHaveLength(1);expect(f.tables.platform_fees[0].gateway_fee).toBe(8);
  });
  it('fee insertion failure prevents completion and confirmation; identical retry recovers',async()=>{
    const f=fixture();f.state.feeError=true;
    expect((await through(f)).lifecycle?.reason).toBe('critical_effects_failed');
    expect(f.payment.finalization_completed_at).toBeNull();expect(boundary.confirm).not.toHaveBeenCalled();
    expect(f.payment.gateway_fee_claim_snapshot).toBe(8);
    f.state.feeError=false;expect((await through(f)).lifecycle?.status).toBe('completed');
    expect(f.tables.platform_fees).toHaveLength(1);
  });
  it('partial work plus release cannot change fee and duplicate insertion is idempotent',async()=>{
    const f=fixture();f.state.spendFailure=true;await through(f);
    expect(f.tables.platform_fees).toHaveLength(1);expect(f.payment.finalization_completed_at).toBeNull();
    expect((await through(f,verified(900))).lifecycle?.reason).toBe('fee_conflict');
    f.state.spendFailure=false;expect((await through(f)).lifecycle?.status).toBe('completed');
    expect(f.tables.platform_fees).toHaveLength(1);expect(f.tables.platform_fees[0].gateway_fee).toBe(8);
  });
  it.each([false,true])('lost response reread (failure=%s) never borrows token or executes effects',async rereadFailure=>{
    const f=fixture();f.state.lostResponse=true;f.state.rereadFailure=rereadFailure;
    const result=await through(f);
    expect(result.lifecycle?.status).toBe(rereadFailure?'retryable_failed':'processing');
    expect(f.payment.gateway_fee_claim_snapshot).toBe(8);expect(f.tables.platform_fees).toHaveLength(0);
    expect(boundary.confirm).not.toHaveBeenCalled();
    expect(f.state.calls.filter(c=>c.name==='complete_payment_finalization')).toHaveLength(0);
  });
  it('expires an unacknowledged claim and recovers through a fresh token',async()=>{
    const f=fixture();f.state.lostResponse=true;await through(f);const old=f.payment.finalization_claim_token;
    f.state.lostResponse=false;f.payment.finalization_processing_at=new Date(Date.now()-301000).toISOString();
    expect((await through(f)).lifecycle?.status).toBe('completed');
    expect(f.state.calls.find(c=>c.name==='complete_payment_finalization')?.args.p_claim_token).not.toBe(old);
  });
  it('unclassified unchanged recovery never creates observation provenance',async()=>{
    const f=fixture();f.payment.gateway_fee_contract_version=null;f.payment.gateway_fee=8;
    expect((await through(f,verified(900))).lifecycle?.reason).toBe('legacy_fee_reconciliation_required');
    expect((await through(f)).lifecycle?.status).toBe('completed');expect(f.payment.verified_gateway_fee).toBeNull();
    expect(f.tables.platform_fees[0].gateway_fee).toBe(8);
  });
  it.each([
    ['custom-zero',{custom_fee_percentage:0},0,false],
    ['null-fallback',{custom_fee_percentage:null},150,false],
    ['trial',{is_in_trial:true},0,false],
    ['byo',{payment_routing:'byo'},0,true],
    ['connect',{payment_routing:'connect'},150,true],
  ] as const)('preserves actual pinned policy: %s',async(_name,basis,total,direct)=>{
    const f=fixture();Object.assign(f.payment.fee_basis,basis);
    expect((await through(f)).lifecycle?.status).toBe('completed');
    expect(f.tables.platform_fees[0]).toMatchObject({fee_total:total,gateway_fee:8,is_direct_transfer:direct});
  });
  it('preserves direct_split exemption without a platform-fee insert',async()=>{
    const f=fixture();f.tables.businesses[0].payout_mode='direct_split';
    expect((await through(f)).lifecycle?.status).toBe('completed');expect(f.tables.platform_fees).toHaveLength(0);
  });
  it('preserves direct-transfer resume, zero fee and legacy claim dispatch',async()=>{
    const f=fixture();Object.assign(f.payment,{status:'success',gateway:'direct',booking_id:null,order_id:'order-762',
      metadata:{_direct_transfer:true,pending_transfer_id:'transfer-762'}});
    const result=await resumeSuccessfulPaymentFinalization(f.sb,f.payment.id,processSuccessfulPayment,boundary.confirm);
    expect(result.status).toBe('completed');
    expect(f.state.calls[0].name).toBe('claim_payment_finalization');
    expect(f.tables.platform_fees[0]).toMatchObject({gateway_fee:0,fee_total:0,is_direct_transfer:true});
  });
});
