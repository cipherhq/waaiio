/** Private candidate SQL proof. Requires explicit disposable localhost PostgreSQL. */
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL required; targeted accounting-hold SQL proof must not skip');
const parsed=new URL(url);
if(!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))throw new Error('Disposable localhost only');
const database=`accounting_hold_${randomUUID().replaceAll('-','')}`;
const B=randomUUID(),OTHER=randomUUID(),ACTOR=randomUUID(),HASH='1'.repeat(64);
let control:Client,a:Client,b:Client;
const q=(sql:string,values:unknown[]=[])=>a.query(sql,values);
const candidate='lib/__tests__/fixtures/legacy-accounting-hold-candidate.sql';
async function hold(){await q('INSERT INTO merchant_accounting_holds(business_id,evidence_sha256) VALUES($1,$2) ON CONFLICT DO NOTHING',[B,HASH]);}
async function seed({direct=false,linked=false,amount=100,sibling=false}:{direct?:boolean|null,linked?:boolean,amount?:number,sibling?:boolean}={}){
 const payment=randomUUID(),booking=randomUUID(),fee=randomUUID();
 await q("INSERT INTO bookings VALUES($1,'paid')",[booking]);
 await q("INSERT INTO payments(id,business_id,booking_id,currency,amount,status,gateway,gateway_reference,metadata,created_at) VALUES($1,$2,$3,'USD',100,'success','stripe',$4,'{}','2026-10-02')",[payment,B,booking,payment]);
 if(sibling)await q("INSERT INTO payments(id,business_id,booking_id,currency,amount,status,gateway,gateway_reference,metadata,created_at) VALUES($1,$2,$3,'USD',100,'failed','stripe',$4,'{}','2026-10-02')",[randomUUID(),B,booking,randomUUID()]);
 // Historical shape predates the candidate; bypass only the NEW provenance trigger during fixture seed.
 await q('ALTER TABLE platform_fees DISABLE TRIGGER guard_accounting_fee_provenance');
 try{await q('INSERT INTO platform_fees(id,business_id,payment_id,booking_id,transaction_amount,fee_total,fee_percentage,fee_flat,is_direct_transfer,created_at) VALUES($1,$2,$3,$4,100,10,10,0,$5,now())',[fee,B,linked?payment:null,booking,direct]);}finally{await q('ALTER TABLE platform_fees ENABLE TRIGGER guard_accounting_fee_provenance');}
 return {payment,booking,fee,amount};
}
async function enroll(payment:string){await q('SELECT accounting_private.enroll_legacy_refund_accounting($1,$2,$3,$4)',[payment,B,HASH,ACTOR]);}
async function refund(payment:string,amount=100){const id=randomUUID();await q("INSERT INTO refunds(id,business_id,payment_id,status,amount,reason,initiated_by,gateway,provider_refund_id) VALUES($1,$2,$3,'provider_success_unfinalized',$4,'fixture',$5,'stripe','fixture-provider-refund')",[id,B,payment,amount,ACTOR]);return id;}
const finalize=(id:string)=>q('SELECT finalize_refund_execution($1) result',[id]);
async function snapshot(){const out:any={};for(const table of ['payments','refunds','platform_fees','business_payouts','payout_adjustments','merchant_accounting_holds','legacy_refund_accounting_membership','refund_accounting_exceptions','admin_audit_logs'])out[table]=(await q(`SELECT row_to_json(t) row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;return out;}
async function payout(status='pending'){
 const id=randomUUID();await q("INSERT INTO business_payouts(id,business_id,net_amount,currency,status,transfer_method,claim_token,provider_idempotency_key,processing_started_at,gateway_transfer_code) VALUES($1,$2,90,'USD',$3,'paystack_transfer',$4,'fixture-key',now()-interval '1 day','TRF_fixture')",[id,B,status,randomUUID()]);return id;
}
describe('targeted accounting hold private candidate — real PostgreSQL',()=>{
 beforeAll(async()=>{
  control=new Client({connectionString:url});await control.connect();await control.query(`CREATE DATABASE ${database}`);parsed.pathname=`/${database}`;
  a=new Client({connectionString:parsed.toString(),statement_timeout:10000});b=new Client({connectionString:parsed.toString(),statement_timeout:10000});await Promise.all([a.connect(),b.connect()]);
  for(const role of ['anon','authenticated','service_role'])if(!(await q('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await q(`CREATE ROLE ${role}${role==='service_role'?' BYPASSRLS':''}`);
  if(!(await q("SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role'")).rows[0]?.rolbypassrls)throw new Error('Disposable fixture service_role must have BYPASSRLS, matching Supabase');
  await q(`CREATE TYPE payment_status AS ENUM('success','refunded','failed');CREATE TABLE businesses(id uuid PRIMARY KEY);
CREATE TABLE payments(id uuid PRIMARY KEY,business_id uuid,booking_id uuid,invoice_id uuid,order_id uuid,reservation_id uuid,currency varchar(3),amount numeric,status payment_status,gateway text,gateway_reference text,metadata jsonb,created_at timestamptz,refund_amount numeric,refund_reason text,refunded_at timestamptz,refunded_by uuid);
CREATE TABLE refunds(id uuid PRIMARY KEY,business_id uuid,payment_id uuid,status text,amount numeric,reason text,initiated_by uuid,finalized_at timestamptz,gateway text,provider_refund_id text,provider_connection_id uuid,connect_account_id text);
CREATE TABLE platform_fees(id uuid PRIMARY KEY,business_id uuid,payment_id uuid,booking_id uuid,invoice_id uuid,order_id uuid,transaction_amount numeric,fee_total numeric,fee_percentage numeric,fee_flat numeric,is_direct_transfer boolean,created_at timestamptz,refunded_at timestamptz,invoiced_at timestamptz);
CREATE TABLE business_payouts(id uuid PRIMARY KEY,business_id uuid,net_amount numeric,currency varchar(3),status varchar(20),transfer_method text,period_start date,period_end date,claim_token uuid,provider_idempotency_key text,processing_started_at timestamptz,gateway_transfer_code text,paid_at timestamptz,flags jsonb DEFAULT '[]',updated_at timestamptz,rejected_reason text);
CREATE TABLE payout_adjustments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid,payout_id uuid,applied_to_payout_id uuid,amount numeric,reason text,payment_id uuid,currency varchar(3));
CREATE TABLE platform_fee_invoices(id uuid PRIMARY KEY,business_id uuid);
CREATE TABLE bookings(id uuid PRIMARY KEY,deposit_status text);CREATE TABLE reservations(id uuid PRIMARY KEY,deposit_status text);
CREATE TABLE admin_audit_logs(actor_id uuid NOT NULL,action text,entity_type text,entity_id uuid,details jsonb);
GRANT SELECT,INSERT,UPDATE,DELETE ON payments,refunds,platform_fees,business_payouts,payout_adjustments TO service_role;`);
  await q(readFileSync(candidate,'utf8'));
  await q(readFileSync('lib/__tests__/fixtures/payout-reject-prerequisites.sql','utf8'));
  await q(readFileSync('supabase/migrations/498_manual_settlement_rejection_guard.sql','utf8'));
 },30000);
 beforeEach(async()=>{await q('TRUNCATE refund_accounting_exceptions,legacy_refund_accounting_membership,merchant_accounting_holds,refunds,platform_fees,payments,business_payouts,payout_adjustments,bookings,reservations,admin_audit_logs,platform_fee_invoices,businesses');await q('INSERT INTO businesses VALUES($1),($2)',[B,OTHER]);});
 afterAll(async()=>{await Promise.all([a?.end(),b?.end()]);if(control){await control.query(`DROP DATABASE IF EXISTS ${database}`);await control.end();}});
 it('independent business hold blocks settlement without enrolling any refund and preserves strict linked refunds',async()=>{
  const f=await seed({linked:true});
  await q('SELECT accounting_private.enroll_merchant_accounting_hold($1,$2,$3)',[B,'2'.repeat(64),ACTOR]);
  expect((await q('SELECT * FROM legacy_refund_accounting_membership')).rowCount).toBe(0);
  await expect(payout()).rejects.toThrow('held');
  await finalize(await refund(f.payment));
  expect((await q('SELECT * FROM refund_accounting_exceptions')).rowCount).toBe(0);
  expect((await q('SELECT active FROM merchant_accounting_holds')).rows[0].active).toBe(true);
 });
 it('distinct reviewed refund packet can enroll under an existing business-domain hold without replacing its evidence',async()=>{
  const f=await seed();await q('SELECT accounting_private.enroll_merchant_accounting_hold($1,$2,$3)',[B,'2'.repeat(64),ACTOR]);await enroll(f.payment);
  expect((await q('SELECT evidence_sha256 FROM merchant_accounting_holds')).rows[0].evidence_sha256).toBe('2'.repeat(64));
  expect((await q('SELECT evidence_sha256 FROM legacy_refund_accounting_membership')).rows[0].evidence_sha256).toBe(HASH);
 });
 it('service-role hold reads work while held authority denies and ordinary roles cannot read or mutate evidence',async()=>{
  await hold();await q('SET ROLE service_role');
  try{
   expect((await q('SELECT active FROM merchant_accounting_holds WHERE business_id=$1',[B])).rows[0].active).toBe(true);
   await expect(q('SELECT assert_merchant_settlement_available($1)',[B])).rejects.toThrow('held');
   await q('SELECT assert_merchant_settlement_available($1)',[OTHER]);
   await expect(q('UPDATE merchant_accounting_holds SET active=false')).rejects.toThrow('permission');
  }finally{await q('RESET ROLE');}
  for(const role of ['anon','authenticated']){await q(`SET ROLE ${role}`);try{await expect(q('SELECT * FROM merchant_accounting_holds')).rejects.toThrow('permission');await expect(q('SELECT assert_merchant_settlement_available($1)',[OTHER])).rejects.toThrow('permission');}finally{await q('RESET ROLE');}}
 });
 it.each([100,25])('enrolled legacy %s refund commits exactly one exception and leaves ambiguous fee/allocation untouched',async(amount)=>{
  const f=await seed({sibling:true});await enroll(f.payment);const id=await refund(f.payment,amount);const before=(await q('SELECT row_to_json(t) r FROM platform_fees t')).rows;
  expect((await finalize(id)).rows[0].result).toMatchObject({finalized:true,accounting_status:'deferred'});expect((await q('SELECT row_to_json(t) r FROM platform_fees t')).rows).toEqual(before);
  const ex=(await q('SELECT amount,currency,provider_evidence FROM refund_accounting_exceptions')).rows[0];expect(Number(ex.amount)).toBe(amount);expect(ex.currency).toBe('USD');expect(ex.provider_evidence.provider_refund_id).toBe('fixture-provider-refund');expect((await q('SELECT * FROM payout_adjustments')).rowCount).toBe(0);
  const after=await snapshot();expect((await finalize(id)).rows[0].result.reason).toBe('already_finalized');expect(await snapshot()).toEqual(after);
 });
 it('rolls every local update back if exception journal fails',async()=>{const f=await seed();await enroll(f.payment);const id=await refund(f.payment);await q("ALTER TABLE refund_accounting_exceptions ADD CONSTRAINT fixture_failure CHECK(amount<0) NOT VALID");const before=await snapshot();try{await expect(finalize(id)).rejects.toThrow('fixture_failure');expect(await snapshot()).toEqual(before);}finally{await q('ALTER TABLE refund_accounting_exceptions DROP CONSTRAINT fixture_failure');}});
 it.each([true,null])('rejects direct or unknown custody enrollment %s',async direct=>{const f=await seed({direct});await expect(enroll(f.payment)).rejects.toThrow('mixed_or_unproven');expect((await q('SELECT * FROM merchant_accounting_holds')).rowCount).toBe(0);});
 it('rejects mixed same-entity direct fees and wrong tenant enrollment',async()=>{const f=await seed();await q('ALTER TABLE platform_fees DISABLE TRIGGER guard_accounting_fee_provenance');await q('INSERT INTO platform_fees(id,business_id,booking_id,is_direct_transfer) VALUES($1,$2,$3,true)',[randomUUID(),B,f.booking]);await q('ALTER TABLE platform_fees ENABLE TRIGGER guard_accounting_fee_provenance');await expect(enroll(f.payment)).rejects.toThrow('mixed_or_unproven');await expect(q('SELECT accounting_private.enroll_legacy_refund_accounting($1,$2,$3,$4)',[f.payment,OTHER,HASH,ACTOR])).rejects.toThrow('identity');});
 it.each(['amount=200',"currency='NGN'",'business_id=$2','booking_id=$2',"gateway_reference='different'","metadata='{\"provider_connection_id\":\"different\"}'"])('pins enrolled payment identity %s',async mutation=>{const f=await seed();await enroll(f.payment);await expect(q(`UPDATE payments SET ${mutation} WHERE id=$1`,mutation.includes('$2')?[f.payment,OTHER]:[f.payment])).rejects.toThrow('immutable');});
 it('ordinary callers cannot enroll, erase holds/journal or invoke private modern bypass',async()=>{
  const f=await seed();await enroll(f.payment);await q('SET ROLE service_role');try{await expect(q('DELETE FROM merchant_accounting_holds')).rejects.toThrow('permission');await expect(enroll(f.payment)).rejects.toThrow('permission');await expect(q('SELECT accounting_private.finalize_refund_accounting_modern($1)',[randomUUID()])).rejects.toThrow('permission');}finally{await q('RESET ROLE');}
 });
 it('refund after simulated separately audited release re-holds without changing membership route',async()=>{const f=await seed();await enroll(f.payment);await q('UPDATE merchant_accounting_holds SET active=false WHERE business_id=$1',[B]);const id=await refund(f.payment,25);expect((await finalize(id)).rows[0].result.accounting_status).toBe('deferred');expect((await q('SELECT active,epoch FROM merchant_accounting_holds')).rows[0]).toEqual({active:true,epoch:'2'});});
 it('new non-enrolled linked same-entity payment reverses only its fee and retains hold',async()=>{
  const legacy=await seed();await enroll(legacy.payment);const payment=randomUUID(),fee=randomUUID();await q("INSERT INTO payments(id,business_id,booking_id,currency,amount,status,metadata,created_at) VALUES($1,$2,$3,'USD',100,'success','{}',now())",[payment,B,legacy.booking]);await q('INSERT INTO platform_fees(id,business_id,payment_id,booking_id,transaction_amount,fee_total,fee_percentage,fee_flat,is_direct_transfer,created_at) VALUES($1,$2,$3,$4,100,10,10,0,false,now())',[fee,B,payment,legacy.booking]);
  const before=(await q('SELECT row_to_json(t) r FROM platform_fees t WHERE id=$1',[legacy.fee])).rows;await finalize(await refund(payment));expect((await q('SELECT row_to_json(t) r FROM platform_fees t WHERE id=$1',[legacy.fee])).rows).toEqual(before);expect((await q('SELECT fee_total,refunded_at FROM platform_fees WHERE id=$1',[fee])).rows[0].refunded_at).toBeTruthy();expect((await q('SELECT * FROM refund_accounting_exceptions')).rowCount).toBe(0);expect((await q('SELECT active FROM merchant_accounting_holds')).rows[0].active).toBe(true);
 });
 it('unregistered ambiguous refund has no legacy fallback',async()=>{const f=await seed({sibling:true});await hold();const id=await refund(f.payment);const before=await snapshot();await expect(finalize(id)).rejects.toThrow('provenance_required');expect(await snapshot()).toEqual(before);});
 it('new unsafe fee and linked payment identity mutations cannot commit ambiguity',async()=>{const f=await seed({linked:true});await expect(q('INSERT INTO platform_fees(id,business_id,is_direct_transfer) VALUES($1,$2,false)',[randomUUID(),B])).rejects.toThrow('provenance_required');await expect(q("UPDATE payments SET currency=NULL WHERE id=$1",[f.payment])).rejects.toThrow('identity_immutable');await expect(q('UPDATE platform_fees SET payment_id=NULL WHERE id=$1',[f.fee])).rejects.toThrow('requires_reconciliation');});
 it('held business cannot generate, approve, claim or escape to an unheld business',async()=>{const id=await payout();await hold();await expect(payout()).rejects.toThrow('held');await expect(q("UPDATE business_payouts SET status='approved' WHERE id=$1",[id])).rejects.toThrow('held');await expect(q("UPDATE business_payouts SET status='processing' WHERE id=$1",[id])).rejects.toThrow('held');await expect(q('UPDATE business_payouts SET business_id=$2 WHERE id=$1',[id,OTHER])).rejects.toThrow('mismatch');});
 it('held pending rejection preserves durable hold',async()=>{const id=await payout();await hold();await q("SELECT * FROM reject_payout_and_release_adjustments($1,'fixture')",[id]);expect((await q('SELECT active FROM merchant_accounting_holds')).rows[0].active).toBe(true);});
 it('prior provider authority can record submit/paid/reversal truth but not change frozen authority',async()=>{const id=await payout('processing');await q('UPDATE business_payouts SET gateway_transfer_code=NULL WHERE id=$1',[id]);await hold();await q("UPDATE business_payouts SET gateway_transfer_code='TRF_fixture' WHERE id=$1",[id]);await expect(q('UPDATE business_payouts SET claim_token=$2 WHERE id=$1',[id,randomUUID()])).rejects.toThrow('mismatch');await expect(q("UPDATE business_payouts SET gateway_transfer_code='spoof' WHERE id=$1",[id])).rejects.toThrow('reference_mismatch');await q("UPDATE business_payouts SET status='paid',paid_at=now() WHERE id=$1",[id]);await q("UPDATE business_payouts SET status='review_required' WHERE id=$1",[id]);expect((await q('SELECT status FROM business_payouts WHERE id=$1',[id])).rows[0].status).toBe('review_required');});
 it('two independent refund finalizers create exactly one journal and amount application',async()=>{const f=await seed();await enroll(f.payment);const id=await refund(f.payment,25);const results=await Promise.all([finalize(id),b.query('SELECT finalize_refund_execution($1) result',[id])]);expect(results.every(r=>r.rows[0].result.finalized)).toBe(true);expect((await q('SELECT * FROM refund_accounting_exceptions')).rowCount).toBe(1);expect(Number((await q('SELECT refund_amount FROM payments WHERE id=$1',[f.payment])).rows[0].refund_amount)).toBe(25);});
 it('valid Stripe/Paystack direct fee inserts and billing linkage retain existing behavior',async()=>{
  for(const gateway of ['stripe','paystack']){
   const f=await seed({linked:true,direct:true});await q('UPDATE payments SET gateway=$2 WHERE id=$1',[f.payment,gateway]);
   await q('INSERT INTO platform_fees(id,business_id,payment_id,booking_id,is_direct_transfer) VALUES($1,$2,$3,$4,true)',[randomUUID(),B,f.payment,f.booking]);
   const invoice=randomUUID();await q('INSERT INTO platform_fee_invoices VALUES($1,$2)',[invoice,B]);await q('UPDATE platform_fees SET invoice_id=$2,invoiced_at=now() WHERE id=$1',[f.fee,invoice]);
   expect((await q('SELECT invoice_id,is_direct_transfer FROM platform_fees WHERE id=$1',[f.fee])).rows[0]).toEqual({invoice_id:invoice,is_direct_transfer:true});
  }
 });
 it('wrong-business billing invoice cannot change direct fee linkage',async()=>{const f=await seed({linked:true,direct:true});const invoice=randomUUID();await q('INSERT INTO platform_fee_invoices VALUES($1,$2)',[invoice,OTHER]);await expect(q('UPDATE platform_fees SET invoice_id=$2,invoiced_at=now() WHERE id=$1',[f.fee,invoice])).rejects.toThrow('requires_reconciliation');});
 it.each(['duplicate','wrong-business','direct-mixed','unknown-currency'])('strict-linked held exception refuses failed proof %s atomically',async kind=>{
  const f=await seed();await enroll(f.payment);const payment=randomUUID();await q("INSERT INTO payments(id,business_id,booking_id,currency,amount,status,metadata,created_at) VALUES($1,$2,$3,$4,100,'success','{}',now())",[payment,B,f.booking,kind==='unknown-currency'?null:'USD']);
  await q('ALTER TABLE platform_fees DISABLE TRIGGER guard_accounting_fee_provenance');
  try{for(let i=0;i<(kind==='duplicate'?2:1);i++)await q('INSERT INTO platform_fees(id,business_id,payment_id,booking_id,transaction_amount,fee_total,is_direct_transfer,created_at) VALUES($1,$2,$3,$4,100,10,$5,now())',[randomUUID(),kind==='wrong-business'?OTHER:B,payment,f.booking,kind==='direct-mixed']);}finally{await q('ALTER TABLE platform_fees ENABLE TRIGGER guard_accounting_fee_provenance');}
  const id=await refund(payment),before=await snapshot();await expect(finalize(id)).rejects.toThrow(/proof_required|provenance_required|currency_unclassified/);expect(await snapshot()).toEqual(before);
 });
 it('unheld classified linked refund preserves modern completion and direct-custody exclusion',async()=>{const f=await seed({linked:true,direct:true});await finalize(await refund(f.payment));expect((await q('SELECT * FROM refund_accounting_exceptions')).rowCount).toBe(0);expect((await q('SELECT * FROM payout_adjustments')).rowCount).toBe(0);expect((await q('SELECT * FROM merchant_accounting_holds')).rowCount).toBe(0);});
 it('a held business retains clean direct-split refund completion on a separate entity',async()=>{
  const f=await seed({linked:true,direct:true});await hold();await finalize(await refund(f.payment));
  expect((await q('SELECT * FROM refund_accounting_exceptions')).rowCount).toBe(0);
  expect((await q('SELECT * FROM payout_adjustments')).rowCount).toBe(0);
  expect((await q('SELECT active FROM merchant_accounting_holds')).rows[0].active).toBe(true);
 });
 it('deferred refund with observed unknown currency records uncertainty without inference',async()=>{const f=await seed();await q('UPDATE payments SET currency=NULL WHERE id=$1',[f.payment]);await enroll(f.payment);await finalize(await refund(f.payment));expect((await q('SELECT currency FROM refund_accounting_exceptions')).rows[0].currency).toBeNull();});
 it('held provider completion without a recorded reference or with fresh authority is refused',async()=>{const id=await payout('processing');await q('UPDATE business_payouts SET gateway_transfer_code=NULL WHERE id=$1',[id]);await hold();await expect(q("UPDATE business_payouts SET status='paid' WHERE id=$1",[id])).rejects.toThrow('reference_required');await expect(q("UPDATE business_payouts SET processing_started_at=now() WHERE id=$1",[id])).rejects.toThrow('mismatch');});
 it('row/advisory inversion aborts one transaction and leaves no partial accounting state',async()=>{
  const f=await seed({linked:true}),before=await snapshot();
  await q('BEGIN');await b.query('BEGIN');
  try{
   await q("SELECT pg_advisory_xact_lock(hashtext('payout_settle:' || $1::text))",[B]);
   await b.query('SELECT id FROM platform_fees WHERE id=$1 FOR UPDATE',[f.fee]);
   const waiting=b.query('UPDATE platform_fees SET fee_total=8 WHERE id=$1',[f.fee]).then(()=>null,e=>e);
   const competing=q('UPDATE platform_fees SET fee_total=7 WHERE id=$1',[f.fee]).then(()=>null,e=>e);
   const first=await Promise.race([waiting.then(error=>({side:'b',error})),competing.then(error=>({side:'a',error}))]);
   expect(first.error?.code).toBe('40P01');
   if(first.side==='a')await q('ROLLBACK');else await b.query('ROLLBACK');
   await Promise.all([waiting,competing]);
  }finally{await q('ROLLBACK');await b.query('ROLLBACK');}
  expect(await snapshot()).toEqual(before);
 },15000);
 it('reviewed historical failed sibling remains enrolled after a legitimate later success',async()=>{
  const f=await seed({sibling:true});const sibling=(await q('SELECT id FROM payments WHERE booking_id=$1 AND id<>$2',[f.booking,f.payment])).rows[0].id;
  await enroll(f.payment);await enroll(sibling);
  await q("UPDATE payments SET status='success' WHERE id=$1",[sibling]);
  expect((await finalize(await refund(sibling))).rows[0].result.accounting_status).toBe('deferred');
 });
 it('concurrent simulated audited release cannot clear a later enrolled refund hold',async()=>{
  const f=await seed();await enroll(f.payment);const id=await refund(f.payment,25);
  await q('BEGIN');await q("SELECT pg_advisory_xact_lock(hashtext('payout_settle:' || $1::text))",[B]);
  await q('UPDATE merchant_accounting_holds SET active=false WHERE business_id=$1',[B]);
  const outcome=b.query('SELECT finalize_refund_execution($1) result',[id]);
  await q('COMMIT');await outcome;
  expect((await q('SELECT active,epoch FROM merchant_accounting_holds')).rows[0]).toEqual({active:true,epoch:'2'});
  expect((await q('SELECT * FROM refund_accounting_exceptions')).rowCount).toBe(1);
 });
 it('payment currency mutation cannot commit behind a concurrent new linked fee',async()=>{
  const payment=randomUUID(),fee=randomUUID();await q("INSERT INTO payments(id,business_id,currency,amount,status,metadata) VALUES($1,$2,'USD',100,'success','{}')",[payment,B]);
  const pid=(await q('SELECT pg_backend_pid() pid')).rows[0].pid;
  await q('BEGIN');await q('SELECT id FROM payments WHERE id=$1 FOR UPDATE',[payment]);
  await b.query('BEGIN');await b.query('INSERT INTO platform_fees(id,business_id,payment_id,is_direct_transfer) VALUES($1,$2,$3,false)',[fee,B,payment]);
  const outcome=q("UPDATE payments SET currency='NGN' WHERE id=$1",[payment]).then(()=>null,e=>e);
  let blocked=false;for(let i=0;i<100;i++){if((await control.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
  await b.query('COMMIT');const error=await outcome;await q('ROLLBACK');expect(blocked).toBe(true);
  expect(error?.message).toContain('identity_immutable');
  expect((await q('SELECT currency FROM payments WHERE id=$1',[payment])).rows[0].currency).toBe('USD');
  expect((await q('SELECT payment_id FROM platform_fees WHERE id=$1',[fee])).rows[0].payment_id).toBe(payment);
 });
 it('paid provider truth cannot reopen processing or alter amount, method or idempotency authority',async()=>{
  const id=await payout('processing');await hold();await q("UPDATE business_payouts SET status='paid' WHERE id=$1",[id]);
  await expect(q("UPDATE business_payouts SET status='processing' WHERE id=$1",[id])).rejects.toThrow('held');
  for(const mutation of ["net_amount=91","transfer_method='manual_bank'","provider_idempotency_key='different'"]){await expect(q(`UPDATE business_payouts SET ${mutation} WHERE id=$1`,[id])).rejects.toThrow('mismatch');}
 });
 it('adjustments link only to same-business same-currency payouts and can be released by rejection',async()=>{
  const target=await payout(),foreign=randomUUID(),otherCurrency=randomUUID(),adjustment=randomUUID();
  await q("INSERT INTO business_payouts(id,business_id,currency,status,net_amount) VALUES($1,$2,'USD','pending',90),($3,$4,'NGN','pending',90)",[foreign,OTHER,otherCurrency,B]);
  await q("INSERT INTO payout_adjustments(id,business_id,amount,currency) VALUES($1,$2,-10,'USD')",[adjustment,B]);
  for(const invalid of [foreign,otherCurrency,randomUUID()])await expect(q('UPDATE payout_adjustments SET applied_to_payout_id=$2 WHERE id=$1',[adjustment,invalid])).rejects.toThrow('target_mismatch');
  await q('UPDATE payout_adjustments SET applied_to_payout_id=$2 WHERE id=$1',[adjustment,target]);
  await q("SELECT * FROM reject_payout_and_release_adjustments($1,'fixture')",[target]);
  expect((await q('SELECT applied_to_payout_id FROM payout_adjustments WHERE id=$1',[adjustment])).rows[0].applied_to_payout_id).toBeNull();
 });
 it('earlier-started refund transaction re-holds after a later committed claim without rejecting its real completion',async()=>{
  const f=await seed();await enroll(f.payment);await q('UPDATE merchant_accounting_holds SET active=false WHERE business_id=$1',[B]);
  const id=await payout(),refundId=await refund(f.payment,25);
  await q('BEGIN');await q('SELECT pg_sleep(0.02)');
  await b.query('BEGIN');await b.query("UPDATE business_payouts SET status='processing',processing_started_at=now() WHERE id=$1",[id]);await b.query('COMMIT');
  try{await finalize(refundId);await q('COMMIT');}catch(error){await q('ROLLBACK');throw error;}
  const times=(await q('SELECT h.activated_at>=p.processing_started_at AS correct_order FROM merchant_accounting_holds h JOIN business_payouts p USING(business_id) WHERE p.id=$1',[id])).rows[0];expect(times.correct_order).toBe(true);
  await q("UPDATE business_payouts SET status='paid',paid_at=now() WHERE id=$1",[id]);
  await expect(payout()).rejects.toThrow('held');
 });
 it('hold entry serializes against a concurrent new outgoing claim',async()=>{const id=await payout();await q('BEGIN');await q("SELECT pg_advisory_xact_lock(hashtext('payout_settle:' || $1::text))",[B]);await hold();const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;const result=b.query("UPDATE business_payouts SET status='processing' WHERE id=$1",[id]).then(()=>null,e=>e);let blocked=false;for(let i=0;i<100;i++){if((await control.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}await q('COMMIT');expect(blocked).toBe(true);expect((await result)?.message).toContain('held');expect((await q('SELECT status FROM business_payouts WHERE id=$1',[id])).rows[0].status).toBe('pending');});

});
