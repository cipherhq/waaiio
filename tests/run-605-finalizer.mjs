// Real M337 Paystack finalizer smoke + concurrency; isolated disposable PostgreSQL ONLY.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
const url=process.env.TEST_DATABASE_URL;
if(!url) throw Error('TEST_DATABASE_URL required');
const parsed=new URL(url);
if(!parsed.pathname.startsWith('/waaiio_pr605_')||!['localhost','127.0.0.1','::1'].includes(parsed.hostname)|| (parsed.port && parsed.port!=='5432')) throw Error('Refusing unsafe DB target: require localhost:5432/waaiio_pr605_*');
const args=['-X','-q','-t','-A','-v','ON_ERROR_STOP=1',url];
const sql=q=>execFileSync('psql',args,{input:q,encoding:'utf8',timeout:30000}).trim();
const asyncSql=q=>new Promise((resolve,reject)=>{const p=spawn('psql',args);let o='',e='';p.stdout.on('data',x=>o+=x);p.stderr.on('data',x=>e+=x);p.on('close',c=>c===0?resolve(o.trim()):reject(Error(e||'psql exit '+c)));p.stdin.end(q)});
const SUB='31200000-0000-0000-0000-000000000001';
const ATT='31200000-0000-0000-0000-000000000002';
const dbTables=Number(sql("select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"));
assert.equal(dbTables,0,'Test database must be completely EMPTY. Do not reuse existing DB.');
const ddl=`
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE customer_subscriptions(
 id uuid PRIMARY KEY, business_id uuid,user_id uuid,service_id uuid,
 gateway text,status text,next_charge_at timestamptz,amount numeric,currency text,
 authorization_code text, customer_email text,cancellation_requested_at timestamptz,
 customer_name text,customer_phone text,frequency text,charge_count int,total_charged numeric,
 last_charged_at timestamptz,failure_count int,card_last_four text,card_brand text);
CREATE TABLE paystack_billing_attempts(
 id uuid PRIMARY KEY,customer_subscription_id uuid NOT NULL,cycle_key text NOT NULL,
 scheduled_at timestamptz NOT NULL,attempt_number int NOT NULL,provider_reference text NOT NULL,
 intended_amount_minor int NOT NULL,intended_currency text NOT NULL,
 status text NOT NULL CHECK(status IN('reserved','dispatched','charged','finalized','failed','disputed')),
 claim_token uuid,lease_expires_at timestamptz,dispatched_at timestamptz,
 provider_transaction_id text,provider_invoice_code text,canonical_payment_id uuid,
 canonical_booking_id uuid,canonical_booking_ref text,finalized_at timestamptz);
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
const all=readFileSync(new URL('../supabase/migrations/452_cancellation_intent_charge_gate.sql',import.meta.url),'utf8');
const from=all.lastIndexOf('CREATE OR REPLACE FUNCTION finalize_paystack_recurring_charge(');
assert(from>0);
const to=all.indexOf('-- Least-privilege finalizer permissions',from);
sql(all.slice(from,to>from?to:undefined));
function seed(){sql(`TRUNCATE subscription_charges, payments, bookings, platform_fees, paystack_billing_attempts, customer_subscriptions, businesses;
INSERT INTO customer_subscriptions(id,gateway,status,next_charge_at,amount,currency,customer_name,customer_phone,frequency,charge_count,total_charged,failure_count)
 VALUES('${SUB}','paystack','active',now(),50,'NGN','Test','+100000','monthly',0,0,0);
INSERT INTO paystack_billing_attempts(id,customer_subscription_id,cycle_key,scheduled_at,attempt_number,provider_reference,intended_amount_minor,intended_currency,status)
 VALUES('${ATT}','${SUB}','test-cycle',now(),1,'ps-finalizer-test-ref',5000,'NGN','dispatched');`)}
function finalize(){return JSON.parse(sql(`SELECT public.finalize_paystack_recurring_charge('${ATT}',5000,'NGN','tx-test','inv-test');`))}
let passed=0;function check(n,fn){fn();passed++;console.log('PASS',n)}
seed();sql(`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}'`);
let r=finalize();
check('previously dispatched charge finalizes after cancellation',()=>assert.equal(r.success,true));
check('recorded exactly one payment, booking and subscription charge',()=>assert.equal(sql('select (select count(*) from payments),(select count(*) from bookings),(select count(*) from subscription_charges)'),'1|1|1'.replaceAll('|','|')));
check('finalization retains cancellation intent',()=>assert.equal(sql(`SELECT cancellation_requested_at IS NOT NULL FROM customer_subscriptions WHERE id='${SUB}'`),'t'));
check('idempotent repeat does not create duplicate charges',()=>{assert.equal(finalize().already_finalized,true);assert.equal(sql('select count(*) from payments'),'1')});
seed();
const [a,b]=await Promise.allSettled([asyncSql(`SET lock_timeout='5s'; SELECT public.finalize_paystack_recurring_charge('${ATT}',5000,'NGN','tx-test','inv-test');`),asyncSql(`SET lock_timeout='5s'; UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}';`)]);
check('finalize vs cancellation: no timeout/deadlock',()=>{assert.equal(a.status,'fulfilled',JSON.stringify(a));assert.equal(b.status,'fulfilled',JSON.stringify(b))});
check('finalize vs cancellation: exactly one payment, intent retained',()=>{assert.equal(sql('select count(*) from payments'),'1');assert.equal(sql(`select cancellation_requested_at is not null from customer_subscriptions where id='${SUB}'`),'t')});
seed();
const [f1,f2]=await Promise.allSettled([asyncSql(`SET lock_timeout='5s'; SELECT public.finalize_paystack_recurring_charge('${ATT}',5000,'NGN','tx-test','inv-test');`),asyncSql(`SET lock_timeout='5s'; SELECT public.finalize_paystack_recurring_charge('${ATT}',5000,'NGN','tx-test','inv-test');`)]);
check('simultaneous finalizers both return without deadlock',()=>{assert.equal(f1.status,'fulfilled',JSON.stringify(f1));assert.equal(f2.status,'fulfilled',JSON.stringify(f2))});
check('simultaneous finalizers produce one financial record',()=>{assert.equal(sql('select count(*) from payments'),'1');assert.equal(sql('select count(*) from subscription_charges'),'1')});
console.log(`${passed} real finalizer integration checks passed. Provider network boundary not covered.`);
