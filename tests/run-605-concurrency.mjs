// Disposable PostgreSQL ONLY. Not staging, production, or a shared dev DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
const url=process.env.TEST_DATABASE_URL;
if(!url){console.error('SKIPPED: supply TEST_DATABASE_URL for an isolated disposable database');process.exit(2)}
let db;
try { db=new URL(url); } catch { throw new Error('Invalid TEST_DATABASE_URL'); }
if(db.pathname!=='/waaiio_pr605_race_20261019' || !['localhost','127.0.0.1','::1'].includes(db.hostname) || (db.port && db.port !== '5432')) throw new Error('Refusing unsafe database target: require localhost:5432/waaiio_pr605_race_20261019');
const args=['-X','-q','-t','-A','-v','ON_ERROR_STOP=1',url];
function sql(query){return execFileSync('psql',args,{input:query,encoding:'utf8',timeout:30000}).trim()}
function asyncSql(query){return new Promise((resolve,reject)=>{
 const p=spawn('psql',args,{stdio:['pipe','pipe','pipe']});let o='',e='';
 p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>e+=d);
 p.on('close',code=>code===0?resolve(o.trim()):reject(new Error(e||`psql exit ${code}`)));
 p.stdin.end(query);
})}
const SUB='32100000-0000-0000-0000-000000000001';
const fakeToken='32100000-0000-0000-0000-000000000002';
const base=readFileSync(new URL('../supabase/migrations/452_cancellation_intent_charge_gate.sql',import.meta.url),'utf8');
// Require disposable DB to be empty of production billing objects. No arbitrary DROP CASCADE.
const existing=Number(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('customer_subscriptions','paystack_billing_attempts','processed_webhook_events')"));
assert.equal(existing,0,'Refusing an existing schema: create a fresh disposable database');
sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE customer_subscriptions(id uuid PRIMARY KEY, gateway text, status text, next_charge_at timestamptz, amount numeric, currency text, authorization_code text, customer_email text, cancellation_requested_at timestamptz);
CREATE TABLE paystack_billing_attempts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_subscription_id uuid NOT NULL,cycle_key text NOT NULL,scheduled_at timestamptz NOT NULL,attempt_number int NOT NULL,provider_reference text NOT NULL,intended_amount_minor int NOT NULL,intended_currency text NOT NULL,status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','dispatched','charged','finalized','failed','disputed')),claim_token uuid,lease_expires_at timestamptz,dispatched_at timestamptz);
CREATE UNIQUE INDEX pba_unique_ref ON paystack_billing_attempts(provider_reference);
CREATE TABLE processed_webhook_events(event_id text PRIMARY KEY,gateway text,event_type text,status text,attempts int,first_received_at timestamptz,last_attempted_at timestamptz,last_error text);
INSERT INTO customer_subscriptions(id,gateway,status,next_charge_at,amount,currency) VALUES ('${SUB}','paystack','active',now()-interval '1 day',50,'NGN');`);
// The migration includes IF NOT EXISTS column; schema was seeded above intentionally.
sql(base);
function claim(){return JSON.parse(sql(`SELECT claim_paystack_billing_cycle('${SUB}');`))}
function reset(){sql(`DELETE FROM paystack_billing_attempts;UPDATE customer_subscriptions SET status='active', cancellation_requested_at=NULL,next_charge_at=now()-interval '1 day' WHERE id='${SUB}';`)}
let passed=0; const check=(name,fn)=>{fn();passed++;console.log('PASS',name)};
reset();sql(`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}'`);
check('cancellation before claim denies claim',()=>assert.equal(claim().reason,'cancellation_pending'));
reset();let c=claim();sql(`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}'`);
check('reserved attempt cannot dispatch after cancellation',()=>assert.equal(JSON.parse(sql(`SELECT dispatch_paystack_attempt('${c.attempt_id}','${c.claim_token}')`)).dispatched,false));
reset();c=claim();
// A holds cancellation row lock until commit; B must wait then refuse dispatch.
const cancelA=asyncSql(`BEGIN;UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}';SELECT pg_sleep(1.5);COMMIT;`);
await new Promise(r=>setTimeout(r,250));
const dispatchB=asyncSql(`SELECT dispatch_paystack_attempt('${c.attempt_id}','${c.claim_token}');`);
const [a,b]=await Promise.all([cancelA,dispatchB]);
check('concurrent cancel wins before dispatch',()=>assert.equal(JSON.parse(b).reason,'cancellation_or_inactive'));
reset();c=claim();
// Existing dispatch commits before cancellation: permitted in-flight and MUST reconcile.
const dispatchA=asyncSql(`BEGIN;SELECT dispatch_paystack_attempt('${c.attempt_id}','${c.claim_token}');SELECT pg_sleep(1.5);COMMIT;`);
await new Promise(r=>setTimeout(r,250));
const cancelB=asyncSql(`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}';`);
const [d,e]=await Promise.all([dispatchA,cancelB]);
check('dispatch before cancellation stays dispatched for reconciliation',()=>assert.equal(sql(`SELECT status FROM paystack_billing_attempts WHERE id='${c.attempt_id}'`),'dispatched'));
check('cancel intent persists after authorized dispatch',()=>assert.equal(sql(`SELECT cancellation_requested_at IS NOT NULL FROM customer_subscriptions WHERE id='${SUB}'`),'t'));
reset();
// CAS cancellation in two simultaneous transactions: exactly one may write intent.
const cas=`UPDATE customer_subscriptions SET cancellation_requested_at=now() WHERE id='${SUB}' AND status='active' AND cancellation_requested_at IS NULL RETURNING id;`;
const [x,y]=await Promise.all([asyncSql(cas),asyncSql(cas)]);
check('simultaneous intent CAS has exactly one winner',()=>assert.equal(Number(!!x.trim())+Number(!!y.trim()),1));
console.log(`${passed} PostgreSQL checks passed; FINALIZER and provider boundary not covered.`);
