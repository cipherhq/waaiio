/**
 * Execute the COMPLETE proposed M452 SQL in a new, isolated local PG database.
 * Does NOT connect to Supabase, production or Paystack/Flutterwave. No Docker.
 * Requires empty database waaiio_pr605_full_r2_20261019 on localhost:5432.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const url = process.env.TEST_DATABASE_URL;
assert.ok(url, 'TEST_DATABASE_URL required');
const parsed = new URL(url);
assert.ok(parsed.pathname.startsWith('/waaiio_pr605_'), 'Refusing unexpected database: must start with waaiio_pr605_');
assert.ok(['localhost','127.0.0.1','::1'].includes(parsed.hostname), 'Refusing nonlocal host');
assert.ok(!parsed.port || parsed.port === '5432', 'Refusing unexpected port');
const expectedDb = parsed.pathname.slice(1);
const args = ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', url];
const sql = (q) => execFileSync('psql',args,{input:q,encoding:'utf8',timeout:30000,maxBuffer:1024*1024}).trim();
assert.equal(sql('SELECT current_database()'), expectedDb);
assert.equal(sql("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"), '0', 'Must use EMPTY disposable DB');
// M337-compatible, minimal disposable fixture with no merchant information.
const ddl = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE customer_subscriptions(
 id uuid PRIMARY KEY, business_id uuid, user_id uuid,service_id uuid,
 gateway text, status text, next_charge_at timestamptz, amount numeric, currency text,
 authorization_code text, customer_email text,
 customer_name text,customer_phone text,frequency text,charge_count int,total_charged numeric,
 last_charged_at timestamptz, failure_count int,card_last_four text,card_brand text);
CREATE TABLE paystack_billing_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_subscription_id uuid NOT NULL,
 cycle_key text NOT NULL,scheduled_at timestamptz NOT NULL,attempt_number int NOT NULL,
 provider_reference text NOT NULL UNIQUE,intended_amount_minor int NOT NULL,intended_currency text NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','dispatched','charged','finalized','failed','disputed')),
 claim_token uuid, lease_expires_at timestamptz, verify_attempts int NOT NULL DEFAULT 0,
 dispatched_at timestamptz,provider_transaction_id text,provider_invoice_code text,
 canonical_payment_id uuid,canonical_booking_id uuid,canonical_booking_ref text,
 finalized_at timestamptz,charged_at timestamptz,failure_reason text,created_at timestamptz DEFAULT NOW());
CREATE TABLE processed_webhook_events(event_id text PRIMARY KEY,gateway text,event_type text,status text,
 attempts int,first_received_at timestamptz,last_attempted_at timestamptz,last_error text);
CREATE TABLE bookings(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,reference_code text DEFAULT 'B-TEST',
 business_id uuid,user_id uuid,service_id uuid,date date,time text,party_size int,
 flow_type text,channel text,payment_source text,deposit_amount numeric,deposit_status text,status text,
 total_amount numeric,quantity int,guest_name text,guest_phone text,confirmed_at timestamptz,notes text);
CREATE TABLE payments(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,business_id uuid,user_id uuid,booking_id uuid,
 amount numeric,currency text,gateway text,gateway_reference text,status text,gateway_status text,payment_method text,
 card_last_four text,card_brand text,paid_at timestamptz,metadata jsonb);
CREATE TABLE subscription_charges(subscription_id uuid,business_id uuid,user_id uuid,amount numeric,
 currency text,status text,gateway text,gateway_reference text,payment_id uuid,booking_id uuid,charged_at timestamptz);
CREATE TABLE businesses(id uuid PRIMARY KEY,subscription_tier text,trial_ends_at timestamptz,payout_mode text);
CREATE TABLE platform_settings(key text,value text);
CREATE TABLE platform_fees(business_id uuid,booking_id uuid,transaction_amount numeric,
 fee_percentage numeric,fee_flat numeric,fee_total numeric,tier text);
CREATE FUNCTION apply_payment_spend_once(p uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"applied":true}'::jsonb $$;
`;
sql(ddl);
const migration=readFileSync(new URL('../supabase/migrations/452_cancellation_intent_charge_gate.sql',import.meta.url),'utf8');
sql(migration);
const SUB='51200000-0000-0000-0000-000000000001';
const FLW='51200000-0000-0000-0000-000000000002';
const ins=`INSERT INTO customer_subscriptions(id,gateway,status,next_charge_at,amount,currency,authorization_code,customer_email,customer_phone,customer_name,frequency,charge_count,total_charged,failure_count)
VALUES ('${SUB}','paystack','active',now()-interval '1 day',50,'NGN','auth','test@example.invalid','+1000','Test','monthly',0,0,0),
('${FLW}','flutterwave','active',now()-interval '1 day',50,'NGN','auth','test@example.invalid','+1000','Test','monthly',0,0,0);`;
sql(ins);
let count=0;
function check(label,fn){fn();console.log('PASS',label);count++}
const value=q=>JSON.parse(sql(q));
check('all four RPCs are SECURITY DEFINER with safe search_path',()=>{
 const n=Number(sql("SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('claim_paystack_billing_cycle','dispatch_paystack_attempt','finalize_paystack_recurring_charge','claim_recurring_billing_cycle') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public, extensions']::text[]"));assert.equal(n,4);
});
check('RPC permissions deny anon and authenticated',()=>{
 for(const sig of ['claim_paystack_billing_cycle(uuid)','dispatch_paystack_attempt(uuid,uuid)','finalize_paystack_recurring_charge(uuid,integer,text,text,text)','claim_recurring_billing_cycle(uuid)']) {
  const ref='public.'+sig;
  assert.equal(sql(`SELECT has_function_privilege('anon','${ref}','EXECUTE')`),'f');
  assert.equal(sql(`SELECT has_function_privilege('authenticated','${ref}','EXECUTE')`),'f');
  assert.equal(sql(`SELECT has_function_privilege('service_role','${ref}','EXECUTE')`),'t');
 }
});
sql(`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}'`);
check('cancelled Paystack claim denied without new attempt',()=>{
 const r=value(`SELECT claim_paystack_billing_cycle('${SUB}')`);assert.equal(r.claimed,false);assert.equal(sql('SELECT COUNT(*) FROM paystack_billing_attempts'),'0');
});
sql(`UPDATE customer_subscriptions SET cancellation_requested_at=null WHERE id='${SUB}'`);
const c=value(`SELECT claim_paystack_billing_cycle('${SUB}')`);
check('M337 claim retains required fields and reference',()=>{
 assert.equal(c.claimed,true);assert.ok(c.attempt_id&&c.provider_reference&&c.claim_token);
 assert.equal(sql(`SELECT scheduled_at IS NOT NULL AND provider_reference IS NOT NULL FROM paystack_billing_attempts WHERE id='${c.attempt_id}'`),'t');
});
sql(`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}'`);
check('intent recorded after claim blocks dispatch',()=>{
 const d=value(`SELECT dispatch_paystack_attempt('${c.attempt_id}','${c.claim_token}')`);assert.equal(d.dispatched,false);
 assert.equal(sql(`SELECT status FROM paystack_billing_attempts WHERE id='${c.attempt_id}'`),'reserved');
});
sql(`UPDATE customer_subscriptions SET cancellation_requested_at=null WHERE id='${SUB}'`);
const d=value(`SELECT dispatch_paystack_attempt('${c.attempt_id}','${c.claim_token}')`);
check('existing valid attempt dispatches once',()=>assert.equal(d.dispatched,true));
sql(`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}'`);
const fin=value(`SELECT finalize_paystack_recurring_charge('${c.attempt_id}',5000,'NGN','tx-full','inv-full')`);
check('previously dispatched payment finalizes after cancellation',()=>{
 assert.equal(fin.success,true);assert.equal(sql('SELECT COUNT(*) FROM payments'),'1');
 assert.equal(sql(`SELECT cancellation_requested_at IS NOT NULL FROM customer_subscriptions WHERE id='${SUB}'`),'t');
});
check('duplicate finalizer invocation creates no extra payment',()=>{
 const replay=value(`SELECT finalize_paystack_recurring_charge('${c.attempt_id}',5000,'NGN','tx-full','inv-full')`);
 assert.equal(replay.already_finalized,true);assert.equal(sql('SELECT COUNT(*) FROM payments'),'1');
});
sql(`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${FLW}'`);
check('cancelled Flutterwave claim denied',()=>{
 const claim=value(`SELECT claim_recurring_billing_cycle('${FLW}')`);assert.equal(claim.claimed,false);
 assert.equal(sql('SELECT COUNT(*) FROM processed_webhook_events'),'0');
});
check('reconciliation selector is service role only',()=>{
  const sig='public.list_cancelled_flutterwave_claims(integer)';
  assert.equal(sql(`SELECT has_function_privilege('anon','${sig}','EXECUTE')`),'f');
  assert.equal(sql(`SELECT has_function_privilege('authenticated','${sig}','EXECUTE')`),'f');
  assert.equal(sql(`SELECT has_function_privilege('service_role','${sig}','EXECUTE')`),'t');
});
const listCancelledFlw = () => value("SELECT COALESCE(json_agg(t),'[]'::json) FROM list_cancelled_flutterwave_claims(6) t");
check('no cancelled in-flight events produces an empty work queue',()=>assert.deepEqual(listCancelledFlw(),[]));
const stableRef=`flw-${FLW}-2026-10-18`;
const attemptRef=stableRef+'-a1';
sql(`INSERT INTO processed_webhook_events(event_id,gateway,event_type,status,attempts,first_received_at,last_attempted_at,last_error)
VALUES ('${stableRef}','flutterwave','token_renewal','claimed',1,now()-interval '1 day',now()-interval '20 minutes','${attemptRef}')`);
check('cancelled in-flight Flutterwave claim remains discoverable',()=>{
  const candidates=listCancelledFlw();
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].stable_ref,stableRef);
  assert.equal(candidates[0].attempt_ref,attemptRef);
  assert.equal(candidates[0].claim_status,'claimed');
  assert.equal(candidates[0].subscription_id,FLW);
});
sql(`UPDATE processed_webhook_events SET status='provider_success' WHERE event_id='${stableRef}'`);
check('existing provider success remains discoverable for finalization',()=>{
  const candidates=listCancelledFlw();
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].claim_status,'provider_success');
});
sql(`UPDATE customer_subscriptions SET cancellation_requested_at=NULL, status='active' WHERE id='${FLW}'`);
check('selector excludes active subscriptions without cancellation intent',()=>assert.deepEqual(listCancelledFlw(),[]));
sql(`UPDATE customer_subscriptions SET status='cancelled' WHERE id='${FLW}'`);
check('selector also handles cancelled subscription without intent',()=>assert.equal(listCancelledFlw().length,1));
sql(`INSERT INTO processed_webhook_events(event_id,gateway,event_type,status,last_error) VALUES
  ('flw-invalid-uuid-2026-10-18','flutterwave','token_renewal','claimed','invalid-a1'),
  ('ignore-${FLW}-2026-10-18','flutterwave','token_renewal','claimed','invalid-a2')`);
check('malformed and unrelated identities do not enter queue',()=>assert.equal(listCancelledFlw().length,1));
console.log(`${count} COMPLETE M452 migration checks passed on disposable PostgreSQL; no external provider calls.`);
