"""Disposable local PostgreSQL review. Run: python3 scripts/tests/transaction-followups-db.py
Requires PostgreSQL binaries on PATH. No external database or credentials are used.
"""
import tempfile, subprocess, pathlib, json, shutil
base=pathlib.Path(tempfile.mkdtemp(prefix='waaiio-followup-review-'))
data=base/'data'
def run(args,input=None):
 r=subprocess.run(args,input=input,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr+'\n'+r.stdout)
 return r.stdout
started=False
try:
 run(['initdb','-D',str(data),'-A','trust','--no-locale'])
 run(['pg_ctl','-D',str(data),'-l',str(base/'server.log'),'-o',f"-k {base} -p 55483 -h ''",'-w','start']); started=True
 psql=['psql','-h',str(base),'-p','55483','-d','postgres','-X','-v','ON_ERROR_STOP=1','-At']
 run(psql,input='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE businesses(id uuid primary key); CREATE TABLE whatsapp_channels(id uuid primary key); CREATE TABLE payments(id uuid primary key); CREATE TABLE bot_sessions(id uuid primary key, business_id uuid, whatsapp_number text, is_active boolean, current_step text, session_data jsonb, version integer, updated_at timestamptz); CREATE TABLE payment_saved_card_offers(id uuid primary key, payment_id uuid, business_id uuid, customer_phone text, state text, consent_source text, activation_prompt_sent_at timestamptz, claim_token uuid, claim_expires_at timestamptz, credential_committed_at timestamptz, confirmation_send_started_at timestamptz, confirmation_claim_token uuid, confirmation_claim_expires_at timestamptz, resolved_at timestamptz);')
 migration=(pathlib.Path(__file__).resolve().parents[2] / 'supabase/migrations/20261111134639_transaction_followups.sql').read_text()
 run(psql,input=migration)
 for role,statement in [('anon','SELECT * FROM transaction_followups'),('authenticated',"INSERT INTO transaction_followups DEFAULT VALUES")]:
  denied=subprocess.run(psql,input=f'SET ROLE {role}; {statement};',text=True,capture_output=True)
  assert denied.returncode != 0 and 'permission denied for table transaction_followups' in denied.stderr,denied.stderr
 checks=run(psql,input="SELECT relrowsecurity FROM pg_class WHERE oid='public.transaction_followups'::regclass; SELECT has_table_privilege('anon','public.transaction_followups','SELECT'),has_table_privilege('authenticated','public.transaction_followups','INSERT'),has_table_privilege('service_role','public.transaction_followups','SELECT,INSERT,UPDATE'); INSERT INTO businesses VALUES ('00000000-0000-4000-8000-000000000001'); INSERT INTO whatsapp_channels VALUES ('00000000-0000-4000-8000-000000000002'); INSERT INTO transaction_followups(completion_key,business_id,phone,channel_id,kind,state) SELECT 'test-'||g,'00000000-0000-4000-8000-000000000001','+2348000000000','00000000-0000-4000-8000-000000000002','ticketing','ready' FROM generate_series(1,2) g;")
 a=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 a.stdin.write("BEGIN; UPDATE transaction_followups SET state='optin_sending' WHERE completion_key='test-1'; SELECT pg_sleep(2); COMMIT;");a.stdin.close()
 import time; time.sleep(.3)
 b=subprocess.run(psql,input="UPDATE transaction_followups SET state='optin_sending' WHERE completion_key='test-2';",text=True,capture_output=True)
 a.wait(); aerr=a.stderr.read()
 assert a.returncode==0,aerr
 assert b.returncode!=0 and 'transaction_followups_conversation_prompt' in b.stderr,b.stderr
 result=run(psql,input="SELECT state,count(*) FROM transaction_followups GROUP BY state ORDER BY state; UPDATE transaction_followups SET state='done' WHERE completion_key='test-1'; UPDATE transaction_followups SET state='optin_sending' WHERE completion_key='test-2'; SELECT count(*) FROM transaction_followups WHERE state='optin_sending';")
 assert 't\nf|f|t' in checks,checks
 run(psql,input="UPDATE transaction_followups SET state='done'; UPDATE transaction_followups SET state='card_active' WHERE completion_key='test-1';")
 for state in ['card_active','optin_sending']:
  blocked=subprocess.run(psql,input=f"UPDATE transaction_followups SET state='{state}' WHERE completion_key='test-2';",text=True,capture_output=True)
  assert blocked.returncode != 0 and 'transaction_followups_conversation_prompt' in blocked.stderr,blocked.stderr
 run(psql,input="UPDATE transaction_followups SET state='card_resolved' WHERE completion_key='test-1';")
 blocked=subprocess.run(psql,input="UPDATE transaction_followups SET state='card_active' WHERE completion_key='test-2';",text=True,capture_output=True)
 assert blocked.returncode != 0 and 'transaction_followups_conversation_prompt' in blocked.stderr,blocked.stderr
 run(psql,input="UPDATE transaction_followups SET state='done' WHERE completion_key='test-1'; UPDATE transaction_followups SET state='card_active' WHERE completion_key='test-2';")
 cancellation_sql = r"""
INSERT INTO bot_sessions VALUES ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','2348000000000',true,'save_card_pin','{"_save_card_payment_id":"00000000-0000-4000-8000-000000000020","_save_card_auth":"secret-fixture"}',3,now());
INSERT INTO payment_saved_card_offers(id,payment_id,business_id,customer_phone,state) VALUES ('00000000-0000-4000-8000-000000000030','00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000001','+2348000000000','accepted');
CREATE FUNCTION pg_temp.attempt_cancel(v integer DEFAULT 3, phone text DEFAULT '+2348000000000', business uuid DEFAULT '00000000-0000-4000-8000-000000000001', payment uuid DEFAULT '00000000-0000-4000-8000-000000000020') RETURNS jsonb LANGUAGE sql AS $$ SELECT public.cancel_transaction_card_setup('00000000-0000-4000-8000-000000000010',v,payment,phone,business,'{"_save_card_auth":"fixture","keep":true}'); $$;
DO $$ BEGIN
 IF pg_temp.attempt_cancel(2)->>'reason' <> 'version_conflict' THEN RAISE EXCEPTION 'version deny failed'; END IF;
 IF pg_temp.attempt_cancel(3,'+2348000000001')->>'reason' <> 'session_mismatch' THEN RAISE EXCEPTION 'phone deny failed'; END IF;
 IF pg_temp.attempt_cancel(3,'+2348000000000','00000000-0000-4000-8000-000000000099')->>'reason' <> 'session_mismatch' THEN RAISE EXCEPTION 'business deny failed'; END IF;
 IF pg_temp.attempt_cancel(3,'+2348000000000','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000099')->>'reason' <> 'payment_mismatch' THEN RAISE EXCEPTION 'payment deny failed'; END IF;
 UPDATE payment_saved_card_offers SET consent_source='provider_checkout',claim_token=gen_random_uuid(),claim_expires_at=now()+interval '2 minutes';
 IF pg_temp.attempt_cancel()->>'reason' <> 'activation_processing' THEN RAISE EXCEPTION 'active activation deny failed'; END IF;
 UPDATE payment_saved_card_offers SET claim_token=NULL,claim_expires_at=NULL;
 UPDATE payment_saved_card_offers SET state='committed',credential_committed_at=now();
 IF pg_temp.attempt_cancel()->>'reason' <> 'credential_already_committed' THEN RAISE EXCEPTION 'committed deny failed'; END IF;
 IF (SELECT version FROM bot_sessions) <> 3 OR (SELECT current_step FROM bot_sessions) <> 'save_card_pin' THEN RAISE EXCEPTION 'denial mutated session'; END IF;
 UPDATE payment_saved_card_offers SET state='accepted',credential_committed_at=NULL,confirmation_claim_token=gen_random_uuid(),confirmation_claim_expires_at=now()+interval '2 minutes';
 IF pg_temp.attempt_cancel()->>'reason' <> 'credential_already_committed' THEN RAISE EXCEPTION 'active confirmation deny failed'; END IF;
 UPDATE payment_saved_card_offers SET confirmation_claim_token=NULL,confirmation_claim_expires_at=NULL;
 IF pg_temp.attempt_cancel()->>'success' <> 'true' THEN RAISE EXCEPTION 'cancel allow failed'; END IF;
 IF (SELECT version FROM bot_sessions) <> 4 OR (SELECT current_step FROM bot_sessions) <> 'select_capability' OR (SELECT state FROM payment_saved_card_offers) <> 'declined' OR (SELECT session_data ? '_save_card_auth' FROM bot_sessions) THEN RAISE EXCEPTION 'cancel final state wrong'; END IF;
 DELETE FROM payment_saved_card_offers;
 UPDATE bot_sessions SET current_step='replace_card_pin', session_data='{"_replace_payment_id":"00000000-0000-4000-8000-000000000020"}';
 IF pg_temp.attempt_cancel(4)->>'success' <> 'true' THEN RAISE EXCEPTION 'legacy no offer allow failed'; END IF;
 IF has_function_privilege('anon','public.cancel_transaction_card_setup(uuid,integer,uuid,text,uuid,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.cancel_transaction_card_setup(uuid,integer,uuid,text,uuid,jsonb)','EXECUTE') OR NOT has_function_privilege('service_role','public.cancel_transaction_card_setup(uuid,integer,uuid,text,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'RPC grants wrong'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.cancel_transaction_card_setup(uuid,integer,uuid,text,uuid,jsonb)'::regprocedure AND prosecdef AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION 'RPC definer/path wrong'; END IF;
END $$;
"""
 run(psql,input=cancellation_sql)
 print(json.dumps({'checks_passed':24,'checks_failed':0,'checks_skipped':0,'migration_applied':True,'rls_enabled':True,'anon_select_denied':True,'authenticated_insert_denied':True,'service_role_select_insert_update_allowed':True,'concurrent_prompt_second_claim_rejected':True,'completed_prompt_releases_conversation':True,'card_conversation_checks_passed':4,'cancellation_checks_passed':13,'checks':checks,'state_results':result},indent=2))
finally:
 if started: subprocess.run(['pg_ctl','-D',str(data),'-m','immediate','-w','stop'],capture_output=True)
 shutil.rmtree(base)
