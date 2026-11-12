/** Full migration-replayed PostgreSQL17 lifecycle. No schema stubs or disabled triggers.
 * Provider boundary is synthetic verified-success evidence; no provider/network dispatch.
 * Real SQL authorities and the production recordPlatformFee implementation are exercised.
 * This is not HTTP authentication, provider settlement, or webhook-signature certification.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
vi.mock('@sentry/nextjs',()=>({captureException:vi.fn(),captureMessage:vi.fn()}));
const url=process.env.TAX_LIFECYCLE_TEST_DATABASE_URL;
if(!url && process.env.REQUIRE_TAX_PG_TESTS==='true') throw Error('TAX_LIFECYCLE_TEST_DATABASE_URL required');
if(url){const u=new URL(url);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/waaiio_tax_lifecycle_test')throw Error('Dedicated local full-schema lifecycle database required');}
let db:Client;
async function one(sql:string,args:unknown[]=[]){return(await db.query(sql,args)).rows[0];}
async function value(sql:string,args:unknown[]=[]){return(await one(sql,args)).result;}
async function denied(sql:string,args:unknown[]=[],pattern?:RegExp){
 await db.query('SAVEPOINT expected_deny');let error:unknown;
 try{await db.query(sql,args);}catch(e){error=e;}finally{await db.query('ROLLBACK TO SAVEPOINT expected_deny; RELEASE SAVEPOINT expected_deny');}
 expect(error).toBeTruthy();if(pattern)expect(String(error)).toMatch(pattern);
}
/** SQL transport adapter only: production fee calculation is not mocked. */
function feeClient():SupabaseClient {
 const ident=(text:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(text))throw Error('Unexpected identifier');return '"'+text+'"';};
 return {from:(table:string)=>{
  let cols='*',insert:Record<string,unknown>|undefined;const filters:Array<[string,unknown]>=[];
  const execute=async()=>{try{
   if(insert){const entries=Object.entries(insert);await db.query(`INSERT INTO public.${ident(table)} (${entries.map(([k])=>ident(k)).join(',')}) VALUES (${entries.map((_,i)=>'$'+(i+1)).join(',')})`,entries.map(([,v])=>v));return{data:null,error:null};}
   const rows=(await db.query(`SELECT ${cols==='*'?'*':cols.split(',').map(c=>ident(c.trim())).join(',')} FROM public.${ident(table)} WHERE ${filters.map(([k],i)=>ident(k)+'=$'+(i+1)).join(' AND ')||'true'}`,filters.map(([,v])=>v))).rows;
   return{data:rows[0]??null,error:null};
  }catch(error){return{data:null,error};}};
  const chain:any={select:(value:string)=>{cols=value;return chain;},eq:(key:string,value:unknown)=>{filters.push([key,value]);return chain;},single:execute,maybeSingle:execute,insert:(row:Record<string,unknown>)=>{insert=row;return chain;},then:(resolve:unknown,reject:unknown)=>execute().then(resolve as never,reject as never)};return chain;
 }} as unknown as SupabaseClient;
}
describe.skipIf(!url)('full-schema taxed purchase lifecycle',()=>{
 beforeAll(async()=>{db=new Client({connectionString:url});await db.connect();
  expect(Number((await one('SHOW server_version_num')).server_version_num)).toBeGreaterThanOrEqual(170000);
  expect(Number((await one("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).count)).toBeGreaterThan(100);
  expect((await one("SELECT to_regprocedure('public.save_invoice_tax_980(uuid,uuid,jsonb)') IS NOT NULL complete")).complete).toBe(true);
  // Owner-approved local fixture only: the catalog oracle omits historical
  // Supabase implicit API grants. Restore only the existing-table privileges
  // this lifecycle transport uses. No new tax-ledger grants, RLS changes,
  // trigger disabling, or application-migration ACL changes.
  // https://supabase.com/docs/guides/api/securing-your-api
  await db.query('GRANT SELECT ON public.products,public.platform_config_versions,public.payout_adjustments TO service_role; GRANT SELECT,UPDATE ON public.payments TO service_role');
 });
 afterAll(async()=>{await db?.end();});
 it('denies browser roles all money-authority entrypoints',async()=>{
  await db.query('BEGIN');
  try{
   for(const role of ['anon','authenticated']){
    await db.query('SET LOCAL ROLE '+role);
    await denied("SELECT reserve_merchant_tax_payment_980('{}'::jsonb)",[],/permission denied/);
    await denied('SELECT bind_merchant_tax_fee_980($1)',[randomUUID()],/permission denied/);
    await denied('SELECT finalize_refund_execution($1)',[randomUUID()],/permission denied/);
    await denied("SELECT confirm_manual_settlement($1,'fixture',true,$2)",[randomUUID(),randomUUID()],/permission denied/);
    await db.query('RESET ROLE');
   }
  }finally{await db.query('ROLLBACK; RESET ROLE');}
 });
 it.each([
  {name:'platform partial before settlement',routing:'platform',mode:'partial',settled:false,waived:false},
  {name:'BYO partial refund excludes held custody',routing:'byo',mode:'partial',settled:false,waived:false},
  {name:'platform full before settlement',routing:'platform',mode:'full',settled:false,waived:false},
  {name:'platform partial after settlement',routing:'platform',mode:'partial',settled:true,waived:false},
  {name:'platform full after settlement',routing:'platform',mode:'full',settled:true,waived:false},
  {name:'platform partial then full before settlement',routing:'platform',mode:'sequential',settled:false,waived:false},
  {name:'platform partial then full after settlement',routing:'platform',mode:'sequential',settled:true,waived:false},
  {name:'waived fee partial refund',routing:'platform',mode:'partial',settled:false,waived:true},
  {name:'waived fee full refund',routing:'platform',mode:'full',settled:false,waived:true},
  {name:'concurrent payout creation consumes balance once',routing:'platform',mode:'partial',settled:false,waived:false,concurrent:true},
 ] as const)('$name',async scenario=>{
  const {routing,mode,settled,waived}=scenario;
  const concurrent='concurrent' in scenario && scenario.concurrent;
  await db.query('BEGIN');
  try{
   const owner=randomUUID(),business=randomUUID(),product=randomUUID(),session=randomUUID(),config=randomUUID();
   await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)",[owner,owner+'@example.test']);
   await db.query("INSERT INTO businesses(id,owner_id,name,slug,address,city,phone,country_code,status,category,payout_mode) VALUES($1,$2,'Tax lifecycle',($1::uuid)::text,'Test address','Test city','15550000001','NG','active','salon','platform_managed')",[business,owner]);
   await db.query("INSERT INTO products(id,business_id,name,price,is_active,track_inventory,stock_quantity) VALUES($1,$2,'Two items',100,true,true,10)",[product,business]);
   await db.query("INSERT INTO bot_sessions(id,business_id,user_id,whatsapp_number) VALUES($1,$2,$3,'15550000001')",[session,business,owner]);
   await db.query("INSERT INTO merchant_tax_settings(business_id,enabled,label,rate_bps) VALUES($1,true,'Tax',750)",[business]);
   await db.query("INSERT INTO platform_config_versions(id,config_snapshot,effective_from) VALUES($1,$2,clock_timestamp())",[config,{pricing_tiers:{free:{feePercentage:10,feeFlat:0}},category_fee_rates:{ordering:{feePercentage:10}}}]);
   await db.query('SET LOCAL ROLE service_role');
   const items=[{product_id:product,quantity:2,unit_price:100}];
   const quote=await value('SELECT create_order_atomic(p_bot_session_id:=$1,p_business_id:=$2,p_user_id:=$3,p_items:=$4,p_validate_products:=true,p_preview:=true) result',[session,business,owner,JSON.stringify(items)]);
   expect(quote.tax_snapshot).toMatchObject({netAmount:20000,taxAmount:1500,grossAmount:21500,percentageFeeBase:20000});
   expect(Number((await one('SELECT stock_quantity FROM products WHERE id=$1',[product])).stock_quantity)).toBe(10);
   const order=await value('SELECT create_order_atomic(p_bot_session_id:=$1,p_business_id:=$2,p_user_id:=$3,p_items:=$4,p_validate_products:=true,p_expected_total:=215,p_total_amount:=215,p_expected_tax_snapshot:=$5) result',[session,business,owner,JSON.stringify(items),JSON.stringify(quote.tax_snapshot)]);
   expect(order.created).toBe(true);expect(Number((await one('SELECT stock_quantity FROM products WHERE id=$1',[product])).stock_quantity)).toBe(8);
   const basis={payment_routing:routing,tier:'free',is_in_trial:false,custom_fee_percentage:null,custom_fee_flat:null};
   const intent={business_id:business,user_id:owner,order_id:order.order_id,amount:215,currency:'NGN',gateway:'paystack',gateway_reference:'tax-lifecycle-'+randomUUID(),fee_policy_version:1,config_version_id:config,transaction_category:'ordering',fee_basis:basis,metadata:{payment_origin:routing}};
   await denied('SELECT reserve_merchant_tax_payment_980($1)',[JSON.stringify({...intent,business_id:randomUUID()})],/tax_source_business_mismatch/);
   const reserved=await value('SELECT reserve_merchant_tax_payment_980($1) result',[JSON.stringify(intent)]);const payment=reserved.payment;
   expect(payment.tax_allocation).toMatchObject({netAmount:20000,taxAmount:1500,grossAmount:21500});
   const fee=await value('SELECT bind_merchant_tax_fee_980($1) result',[payment.id]);expect(fee).toMatchObject({feeTotal:20,percentageMinor:2000,netAmount:20000,grossAmount:21500});
   expect((await value('SELECT reserve_merchant_tax_payment_980($1) result',[JSON.stringify(intent)])).payment.id).toBe(payment.id);
   // Explicit synthetic provider boundary. This is the verified event state the
   // application writes, not a real charge or a claim about provider verification.
   await db.query("UPDATE payments SET provider_init_state='dispatched',status='success',gateway_fee_contract_version=1 WHERE id=$1",[payment.id]);
   const claimed=await value("SELECT claim_payment_finalization_with_verified_fee($1,'paystack',$2,215,'NGN',true,3) result",[payment.id,intent.gateway_reference]);
   expect(claimed.claimed).toBe(true);
   const {recordPlatformFee}=await import('@/lib/payments/process-success');
   await recordPlatformFee(feeClient(),{paymentId:payment.id,orderId:order.order_id,businessId:business,paymentAmount:215,gatewayFee:3,paymentRouting:routing,feePolicyVersion:1,configVersionId:config,transactionCategory:'ordering',feeBasis:basis});
   const row=await one('SELECT transaction_amount,fee_total,gateway_fee,is_direct_transfer,waived FROM platform_fees WHERE payment_id=$1',[payment.id]);
   expect(row).toMatchObject({transaction_amount:'215.00',fee_total:'20.00',gateway_fee:'3.00',is_direct_transfer:routing==='byo',waived:false});
   const completed=await value('SELECT complete_payment_finalization($1,$2) result',[payment.id,claimed.claim_token]);expect(completed.completed).toBe(true);
   if(waived){
    // Explicit approved-fee-waiver fixture, not a test of automatic trial policy.
    // Preserve the original pinned fee to prove custody ignores waived amounts.
    await db.query('RESET ROLE');
    await db.query('UPDATE platform_fees SET waived=true WHERE payment_id=$1',[payment.id]);
    await db.query('SET LOCAL ROLE service_role');
   }
   if(settled){
    await db.query('RESET ROLE');
    const prior=randomUUID();
    await db.query("INSERT INTO business_payouts(id,business_id,period_start,period_end,gross_amount,platform_fee,gateway_fee,net_amount,currency,status,transfer_method) VALUES($1,$2,current_date-1,current_date-1,215,$3,3,$4,'NGN','approved','manual_bank')",[prior,business,waived?0:20,waived?212:192]);
    await db.query('SET LOCAL ROLE service_role');
    await db.query("SELECT confirm_manual_settlement($1,'fixture-prior-transfer',true,$2)",[prior,owner]);
   }
   let staleProjection:Record<string,unknown>|undefined;
   for(let index=0;index<(mode==='sequential'?2:1);index++){
    const full=mode==='full',amount=full?215:107.5,quantity=full?2:1;
    const refund=await value("SELECT reserve_merchant_tax_refund_980($1,$2,$3,$4,$5,'Lifecycle fixture',$6,'business') result",[payment.id,business,amount,JSON.stringify({mode:'items',items:[{id:quote.tax_snapshot.lines[0].id,quantity}]}),randomUUID(),owner]);
    expect(refund.allocation).toMatchObject({netAmount:full?20000:10000,taxAmount:full?1500:750,grossAmount:full?21500:10750});
    await db.query("UPDATE refunds SET status='provider_success_unfinalized' WHERE id=$1",[refund.refund_id]);
    const finalized=await value('SELECT finalize_refund_execution($1) result',[refund.refund_id]);expect(finalized.finalized).toBe(true);
    expect((await value('SELECT finalize_refund_execution($1) result',[refund.refund_id])).finalized).toBe(true);
    const intermediate=await one('SELECT fee_total FROM platform_fees WHERE payment_id=$1',[payment.id]);
    expect(intermediate.fee_total).toBe(full||index===1?'0.00':'10.00');
    if(mode==='sequential' && index===0) staleProjection=await value("SELECT tax_refund_payout_projection_980($1,'NGN') result",[business]);
   }
   const after=await one('SELECT transaction_amount,fee_total,gateway_fee FROM platform_fees WHERE payment_id=$1',[payment.id]);
   const projection=await value("SELECT tax_refund_payout_projection_980($1,'NGN') result",[business]);
   let expectedAvailable=routing==='byo'||settled||mode!=='partial'?0:waived?104.5:94.5;
   if(routing==='byo'){
    expect(projection).toEqual({affected:false});
    expect(Number((await one('SELECT count(*) FROM payout_adjustments WHERE business_id=$1 AND tax_refund_id IS NOT NULL',[business])).count)).toBe(0);
   }else{
    expect(Number(projection.netAvailable)).toBe(expectedAvailable);
    const raw=Number(projection.gross)-Number(projection.platformFee)-Number(projection.gatewayFee)+Number(projection.adjustments)-Number(projection.commitments);
    expect(raw).toBe((mode==='partial'?(waived?104.5:94.5):-3)-(settled?(waived?212:192):0));
   }
   if(settled && mode==='partial'){
    // A second real exempt order contributes exactly100 after zero custom fee
    // and a verified zero gateway cost; the earlier97.5 debt must survive.
    const nextProduct=randomUUID(),nextSession=randomUUID();
    await db.query('RESET ROLE');
    await db.query("INSERT INTO products(id,business_id,name,price,is_active,tax_treatment) VALUES($1,$2,'New exempt earnings',100,true,'exempt')",[nextProduct,business]);
    await db.query("INSERT INTO bot_sessions(id,business_id,user_id,whatsapp_number) VALUES($1,$2,$3,'15550000002')",[nextSession,business,owner]);
    await db.query('SET LOCAL ROLE service_role');
    const nextItems=JSON.stringify([{product_id:nextProduct,quantity:1,unit_price:100}]);
    const nextQuote=await value('SELECT create_order_atomic(p_bot_session_id:=$1,p_business_id:=$2,p_user_id:=$3,p_items:=$4,p_validate_products:=true,p_preview:=true) result',[nextSession,business,owner,nextItems]);
    const nextOrder=await value('SELECT create_order_atomic(p_bot_session_id:=$1,p_business_id:=$2,p_user_id:=$3,p_items:=$4,p_validate_products:=true,p_expected_total:=100,p_total_amount:=100,p_expected_tax_snapshot:=$5) result',[nextSession,business,owner,nextItems,JSON.stringify(nextQuote.tax_snapshot)]);
    const nextBasis={...basis,custom_fee_percentage:0,custom_fee_flat:0};
    const nextIntent={...intent,order_id:nextOrder.order_id,amount:100,gateway_reference:'tax-next-'+randomUUID(),fee_basis:nextBasis};
    const nextPayment=(await value('SELECT reserve_merchant_tax_payment_980($1) result',[JSON.stringify(nextIntent)])).payment;
    expect((await value('SELECT bind_merchant_tax_fee_980($1) result',[nextPayment.id])).feeTotal).toBe(0);
    await db.query("UPDATE payments SET provider_init_state='dispatched',status='success',gateway_fee_contract_version=1 WHERE id=$1",[nextPayment.id]);
    const nextClaim=await value("SELECT claim_payment_finalization_with_verified_fee($1,'paystack',$2,100,'NGN',true,0) result",[nextPayment.id,nextIntent.gateway_reference]);
    expect(nextClaim.claimed).toBe(true);
    await recordPlatformFee(feeClient(),{paymentId:nextPayment.id,orderId:nextOrder.order_id,businessId:business,paymentAmount:100,gatewayFee:0,paymentRouting:routing,feePolicyVersion:1,configVersionId:config,transactionCategory:'ordering',feeBasis:nextBasis});
    expect((await value('SELECT complete_payment_finalization($1,$2) result',[nextPayment.id,nextClaim.claim_token])).completed).toBe(true);
    const recovered=await value("SELECT tax_refund_payout_projection_980($1,'NGN') result",[business]);
    expect(Number(recovered.netAvailable)).toBe(2.5);
    expectedAvailable=2.5;
   }
   if(staleProjection){
    const date=(await one('SELECT current_date::text AS date_text')).date_text;
    const stale={business_id:business,period_start:date,period_end:date,covered_from:date+'T00:00:00Z',covered_to:date+'T23:59:59Z',currency:'NGN',status:'approved',flags:[],gross_amount:staleProjection.gross,platform_fee:staleProjection.platformFee,gateway_fee:staleProjection.gatewayFee,net_amount:staleProjection.netAvailable};
    await denied('SELECT create_tax_refund_payout_980($1)',[JSON.stringify(stale)],/tax_payout_no_available_balance/);
   }
   let payout=randomUUID();const available=expectedAvailable;
   if(available>0){
    const current=await value("SELECT tax_refund_payout_projection_980($1,'NGN') result",[business]);
    const date=(await one("SELECT current_date::text AS date_text")).date_text;
    const request={business_id:business,period_start:date,period_end:date,covered_from:date+'T00:00:00Z',covered_to:date+'T23:59:59Z',currency:'NGN',status:'approved',flags:[],gross_amount:current.gross,platform_fee:current.platformFee,gateway_fee:current.gatewayFee,net_amount:available};
    await denied('SELECT create_tax_refund_payout_980($1)',[JSON.stringify({...request,net_amount:available+1})],/tax_payout_projection_changed/);
    if(concurrent){
     // Commit only synthetic rows in the dedicated disposable database so two
     // real connections can race. No production credentials can reach this suite.
     await db.query('COMMIT');
     const peers=[new Client({connectionString:url}),new Client({connectionString:url})];
     try{
      await Promise.all(peers.map(async peer=>{await peer.connect();await peer.query('SET ROLE service_role');}));
      const attempts=await Promise.allSettled(peers.map(peer=>peer.query('SELECT create_tax_refund_payout_980($1) result',[JSON.stringify(request)])));
      const successes=attempts.filter(result=>result.status==='fulfilled');
      const failures=attempts.filter(result=>result.status==='rejected');
      expect(successes).toHaveLength(1);expect(failures).toHaveLength(1);
      if(successes[0].status!=='fulfilled'||failures[0].status!=='rejected')throw Error('Unexpected race result');
      expect(String(failures[0].reason)).toMatch(/tax_payout_no_available_balance|tax_payout_period_exists/);
      payout=successes[0].value.rows[0].result.id;
     }finally{await Promise.all(peers.map(peer=>peer.end()));}
     await db.query('BEGIN; SET LOCAL ROLE service_role');
    }else payout=(await value('SELECT create_tax_refund_payout_980($1) result',[JSON.stringify(request)])).id;
    expect(Number((await value("SELECT tax_refund_payout_projection_980($1,'NGN') result",[business])).netAvailable)).toBe(0);
    await db.query('RESET ROLE');
    await db.query("UPDATE business_payouts SET transfer_method='manual_bank' WHERE id=$1",[payout]);
   }else{
    await db.query('RESET ROLE');
    // A pre-existing approved request must not consume unavailable/refunded funds.
    await db.query("INSERT INTO business_payouts(id,business_id,period_start,period_end,gross_amount,platform_fee,gateway_fee,net_amount,currency,status,transfer_method) VALUES($1,$2,current_date,current_date,$3,$4,$5,1,'NGN','approved','manual_bank')",[payout,business,Number(after.transaction_amount),Number(after.fee_total),Number(after.gateway_fee)]);
   }
   await db.query('SET LOCAL ROLE service_role');
   expect((await one('SELECT status FROM business_payouts WHERE id=$1',[payout])).status).toBe('approved');
   await denied("SELECT confirm_manual_settlement($1,'fixture-transfer',false,$2)",[payout,owner],/attestation_required/);
   if(available===0)await denied("SELECT confirm_manual_settlement($1,'fixture-transfer',true,$2)",[payout,owner],/insufficient_balance/);
   else{
    await db.query("SELECT confirm_manual_settlement($1,'fixture-transfer',true,$2)",[payout,owner]);
    expect((await one('SELECT status FROM business_payouts WHERE id=$1',[payout])).status).toBe('paid');
    await denied("SELECT confirm_manual_settlement($1,'fixture-transfer',true,$2)",[payout,owner],/ineligible_status/);
    expect(Number((await one("SELECT count(*) FROM admin_audit_logs WHERE entity_id=$1 AND action='confirm_payout_settlement'",[payout])).count)).toBe(1);
   }
  }finally{await db.query('ROLLBACK; RESET ROLE');}
 },30000);
});
