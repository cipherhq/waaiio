/** Disposable PostgreSQL only. CI discovers *.pg.test.ts and enforces zero skipped tests. */
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
const url=process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS==='true') throw new Error('TEST_DATABASE_URL required');
const suite=url?describe:describe.skip;
const B='10000000-0000-0000-0000-000000000001', OTHER='10000000-0000-0000-0000-000000000002';
const OWNER='20000000-0000-0000-0000-000000000001', CHANNEL='30000000-0000-0000-0000-000000000001';
let db: Client;
const sql=(s:string,v:unknown[]=[])=>db.query(s,v);
async function recipient(channel='email', address='owner@example.com', business=B) {
 return (await sql(`SELECT create_merchant_notification_recipient($1,'Manager',$2,$3,ARRAY['sale','payment','appointment','booking']) result`,[business,channel,address])).rows[0].result.recipient.id as string;
}
async function verify(id:string) {await sql(`UPDATE merchant_notification_recipients SET verified_at=now(),consent_version='merchant-alerts-v1',whatsapp_channel_id=CASE WHEN channel='whatsapp' THEN $2::uuid END WHERE id=$1`,[id,CHANNEL]);}
async function order(status='confirmed') {return (await sql(`INSERT INTO orders(business_id,status,reference_code) VALUES($1,$2,'ORDER-1') RETURNING id`,[B,status])).rows[0].id;}
async function claim() {return (await sql('SELECT claim_merchant_notification() d')).rows[0].d;}
async function fence(d:{id:string;claim_token:string}) {return (await sql('SELECT fence_merchant_notification($1,$2) ok',[d.id,d.claim_token])).rows[0].ok;}
suite('M499 merchant notification transaction and tenant boundaries',()=>{
 beforeAll(async()=>{
  db=new Client({connectionString:url});await db.connect();
  // The designated job gives this file its own database cloned from the ACL fixture.
  await sql(`DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
  DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$;
  GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''test.uid'',true),'''')::uuid';
  CREATE TABLE businesses(id uuid PRIMARY KEY,owner_id uuid,name text DEFAULT 'Shop',subscription_tier text DEFAULT 'free',whatsapp_channel_id uuid);
  CREATE TABLE whatsapp_channels(id uuid PRIMARY KEY,is_active boolean DEFAULT true,channel_type text DEFAULT 'shared',business_id uuid);
  CREATE TABLE whatsapp_config(business_id uuid PRIMARY KEY REFERENCES businesses(id),notify_monthly_count integer DEFAULT 0,notify_month_reset date);
  CREATE TABLE services(id uuid PRIMARY KEY,business_id uuid,is_class boolean DEFAULT false);
  CREATE TABLE orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid,status text,reference_code text);
  CREATE TABLE bookings(LIKE orders INCLUDING ALL,service_id uuid,flow_type text DEFAULT 'scheduling');
  CREATE TABLE reservations(LIKE orders INCLUDING ALL);
  CREATE TABLE invoices(LIKE orders INCLUDING ALL);
  CREATE TABLE campaigns(LIKE orders INCLUDING ALL);
  CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text,finalization_completed_at timestamptz,booking_id uuid,order_id uuid,reservation_id uuid,invoice_id uuid,campaign_id uuid,gateway_reference text);
  GRANT SELECT ON businesses TO authenticated;
  INSERT INTO businesses(id,owner_id) VALUES('${B}','${OWNER}'),('${OTHER}','20000000-0000-0000-0000-000000000002');
  INSERT INTO whatsapp_channels(id) VALUES('${CHANNEL}');`);
  await sql(readFileSync('supabase/migrations/499_merchant_notifications.sql','utf8'));
  await sql(readFileSync('supabase/migrations/502_merchant_notification_invitation_lifetime.sql','utf8'));
 },30000);
 beforeEach(async()=>{await sql('RESET ROLE; TRUNCATE merchant_notification_recipients,orders,bookings,reservations,payments,whatsapp_config CASCADE');});
 afterAll(async()=>{await db?.end();});
 it('M502 preserves existing expiry timestamps and cannot revive expired invitations',async()=>{
  const original=readFileSync('supabase/migrations/499_merchant_notifications.sql','utf8')
   .match(/CREATE FUNCTION public\.issue_merchant_notification_invitation[\s\S]*?END \$\$;/)?.[0];
  expect(original).toBeTruthy();
  await sql(original!.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
  const expired=await recipient(), active=await recipient('email','active@example.com');
  await sql('SELECT issue_merchant_notification_invitation($1,$2,$3)',[expired,B,'1'.repeat(64)]);
  await sql('SELECT issue_merchant_notification_invitation($1,$2,$3)',[active,B,'2'.repeat(64)]);
  expect((await sql('SELECT bool_and(expires_at-created_at=interval \'30 minutes\') ok FROM merchant_notification_invitations')).rows[0].ok).toBe(true);
  await sql("UPDATE merchant_notification_invitations SET expires_at=now()-interval '1 second' WHERE recipient_id=$1",[expired]);
  const before=(await sql('SELECT id,expires_at,consumed_at FROM merchant_notification_invitations ORDER BY id')).rows;
  await sql(readFileSync('supabase/migrations/502_merchant_notification_invitation_lifetime.sql','utf8'));
  expect((await sql('SELECT id,expires_at,consumed_at FROM merchant_notification_invitations ORDER BY id')).rows).toEqual(before);
  expect((await sql("SELECT consume_merchant_notification_invitation($1,'email') r",['1'.repeat(64)])).rows[0].r.verified).toBe(false);
  expect((await sql("SELECT consume_merchant_notification_invitation($1,'email') r",['2'.repeat(64)])).rows[0].r.verified).toBe(true);
 });
 it.each(['email','whatsapp'])('new %s invitations last exactly48hours and reject at expiry',async(channel)=>{
  const address=channel==='email'?'owner@example.com':'+2348012345678';const id=await recipient(channel,address);const hash='3'.repeat(64);
  const result=(await sql('SELECT issue_merchant_notification_invitation($1,$2,$3,$4) r',[id,B,hash,CHANNEL])).rows[0].r;
  expect(result.issued).toBe(true);
  expect((await sql("SELECT expires_at-created_at=interval '48 hours' AS correct FROM merchant_notification_invitations WHERE recipient_id=$1",[id])).rows[0].correct).toBe(true);
  expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now()+47*60*60*1000);
  await sql('BEGIN');
  try {
   await sql('UPDATE merchant_notification_invitations SET expires_at=now() WHERE recipient_id=$1',[id]);
   expect((await sql('SELECT consume_merchant_notification_invitation($1,$2,$3,$4) r',[hash,channel,address,CHANNEL])).rows[0].r.verified).toBe(false);
  } finally {await sql('ROLLBACK');}
  // Still valid beyond the former30-minute window (47hours elapsed, onehour remaining).
  await sql("UPDATE merchant_notification_invitations SET created_at=now()-interval '47 hours',expires_at=now()+interval '1 hour' WHERE recipient_id=$1",[id]);
  expect((await sql('SELECT consume_merchant_notification_invitation($1,$2,$3,$4) r',[hash,channel,address,CHANNEL])).rows[0].r).toMatchObject({verified:true,replay:false});
  const verified=(await sql('SELECT verified_at FROM merchant_notification_recipients WHERE id=$1',[id])).rows[0].verified_at;
  expect((await sql('SELECT consume_merchant_notification_invitation($1,$2,$3,$4) r',[hash,channel,address,CHANNEL])).rows[0].r).toMatchObject({verified:true,replay:true});
  expect((await sql('SELECT verified_at FROM merchant_notification_recipients WHERE id=$1',[id])).rows[0].verified_at).toEqual(verified);
 });
 it.each(['email','whatsapp'])('replacement %s invitation retains throttle and invalidates earlier token',async(channel)=>{
  const address=channel==='email'?'owner@example.com':'+2348012345678';const id=await recipient(channel,address);
  const issue=(hash:string)=>sql('SELECT issue_merchant_notification_invitation($1,$2,$3,$4) r',[id,B,hash,CHANNEL]);
  expect((await issue('4'.repeat(64))).rows[0].r.issued).toBe(true);
  expect((await issue('5'.repeat(64))).rows[0].r).toEqual({issued:false,reason:'rate_limited'});
  await sql("UPDATE merchant_notification_invitations SET created_at=now()-interval '61 seconds' WHERE recipient_id=$1",[id]);
  expect((await issue('5'.repeat(64))).rows[0].r.issued).toBe(true);
  expect((await sql('SELECT consume_merchant_notification_invitation($1,$2,$3,$4) r',['4'.repeat(64),channel,address,CHANNEL])).rows[0].r.verified).toBe(false);
  expect((await sql('SELECT consume_merchant_notification_invitation($1,$2,$3,$4) r',['5'.repeat(64),channel,address,CHANNEL])).rows[0].r).toMatchObject({verified:true,replay:false});
 });
 it.each([
  ['search_path', 'ALTER FUNCTION public.issue_merchant_notification_invitation(uuid,uuid,text,uuid) RESET search_path', 'security/search_path'],
  ['PUBLIC execute', 'GRANT EXECUTE ON FUNCTION public.issue_merchant_notification_invitation(uuid,uuid,text,uuid) TO PUBLIC', 'public execution'],
  ['service execute', 'REVOKE EXECUTE ON FUNCTION public.issue_merchant_notification_invitation(uuid,uuid,text,uuid) FROM service_role', 'service execution'],
 ])('M502 verifier rejects and rolls back changed %s',async(_name,tamper,reason)=>{
  const verifier=readFileSync('supabase/migrations/502_merchant_notification_invitation_lifetime.sql','utf8')
   .match(/DO \$verify_invitation_lifetime\$[\s\S]*?END \$verify_invitation_lifetime\$;/)?.[0];
  expect(verifier).toBeTruthy();await sql('BEGIN');
  try {await sql(tamper);await expect(sql(verifier!)).rejects.toThrow(`M502 verification FAILED: ${reason}`);await expect(sql('SELECT 1')).rejects.toMatchObject({code:'25P02'});}
  finally {await sql('ROLLBACK');}
  await expect(sql(verifier!)).resolves.toBeDefined();
 });
 it.each([
  ['missing search path', 'ALTER FUNCTION public.claim_merchant_notification() RESET search_path', 'security/search_path'],
  ['wrong search path', 'ALTER FUNCTION public.claim_merchant_notification() SET search_path=public', 'security/search_path'],
  ['security invoker', 'ALTER FUNCTION public.claim_merchant_notification() SECURITY INVOKER', 'security/search_path'],
  ['PUBLIC execution', 'GRANT EXECUTE ON FUNCTION public.capture_merchant_notification() TO PUBLIC', 'public execution'],
  ['anon execution', 'GRANT EXECUTE ON FUNCTION public.claim_merchant_notification() TO anon', 'public execution'],
  ['authenticated execution', 'GRANT EXECUTE ON FUNCTION public.claim_merchant_notification() TO authenticated', 'public execution'],
  ['missing service execution', 'REVOKE EXECUTE ON FUNCTION public.claim_merchant_notification() FROM service_role', 'service execution'],
  ['missing function', 'DROP FUNCTION public.claim_merchant_notification()', 'missing function'],
  ['disabled RLS', 'ALTER TABLE public.merchant_notification_invitations DISABLE ROW LEVEL SECURITY', 'RLS'],
 ])('migration verifier aborts and rolls back %s',async(_name,tamper,reason)=>{
  const migration=readFileSync('supabase/migrations/499_merchant_notifications.sql','utf8');
  const verifier=migration.match(/DO \$verify_merchant_notifications\$[\s\S]*?END \$verify_merchant_notifications\$;/)?.[0];
  expect(verifier).toBeTruthy();
  // Execute the actual migration block, not a duplicated test-only catalog check.
  await sql('BEGIN');
  try {
   await sql(tamper);
   await expect(sql(verifier!)).rejects.toThrow(`M499 verification FAILED: ${reason}`);
   await expect(sql('SELECT 1')).rejects.toMatchObject({code:'25P02'});
  } finally {await sql('ROLLBACK');}
  // Successful re-verification proves rollback restored the original security state.
  await expect(sql(verifier!)).resolves.toBeDefined();
 });
 it('service-only writes and RPCs, owner-scoped reads',async()=>{
  await recipient();await recipient('email','other@example.com',OTHER);
  const grants=await sql(`SELECT has_function_privilege('anon','create_merchant_notification_recipient(uuid,text,text,text,text[])','EXECUTE') a,has_function_privilege('authenticated','fence_merchant_notification(uuid,uuid)','EXECUTE') b,has_function_privilege('service_role','fence_merchant_notification(uuid,uuid)','EXECUTE') c`);
  expect(grants.rows[0]).toEqual({a:false,b:false,c:true});
  await sql(`SET test.uid='${OWNER}'; SET ROLE authenticated`);
  expect((await sql('SELECT count(*)::int n FROM merchant_notification_recipients')).rows[0].n).toBe(1);
  await expect(sql("UPDATE merchant_notification_recipients SET enabled=false")).rejects.toThrow(/permission denied/);
 });
 it('caps destinations at 20, deduplicates and keeps tenants separate',async()=>{
  for(let i=0;i<20;i++) await recipient('email',`a${i}@example.com`);
  expect((await sql(`SELECT create_merchant_notification_recipient($1,'Extra','email','extra@example.com',ARRAY['sale']) r`,[B])).rows[0].r).toMatchObject({created:false,reason:'recipient_limit'});
  expect(await recipient('email','a0@example.com',OTHER)).toBeTruthy();
 });
 it('binds opt-in to real sender and channel; replay cannot reactivate STOP',async()=>{
  const id=await recipient('whatsapp','+2348012345678');const hash='a'.repeat(64);
  expect((await sql('SELECT issue_merchant_notification_invitation($1,$2,$3,$4) r',[id,B,hash,CHANNEL])).rows[0].r.issued).toBe(true);
  const consume=(address:string)=>sql('SELECT consume_merchant_notification_invitation($1,\'whatsapp\',$2,$3) r',[hash,address,CHANNEL]);
  expect((await consume('+2348099999999')).rows[0].r.verified).toBe(false);
  expect((await consume('+2348012345678')).rows[0].r.verified).toBe(true);
  expect((await consume('+2348012345678')).rows[0].r.replay).toBe(true);
  await sql('SELECT revoke_merchant_notification_whatsapp($1,$2)',['+2348012345678',CHANNEL]);
  await sql('UPDATE merchant_notification_recipients SET enabled=true WHERE id=$1',[id]);
  expect((await consume('+2348012345678')).rows[0].r.verified).toBe(false);
 });
 it('email verification expires, invalidates prior token, and respects address changes',async()=>{
  const id=await recipient();const h='b'.repeat(64);
  await sql('SELECT issue_merchant_notification_invitation($1,$2,$3)',[id,B,h]);
  await sql('UPDATE merchant_notification_invitations SET expires_at=now()-interval \'1 second\'');
  expect((await sql("SELECT consume_merchant_notification_invitation($1,'email') r",[h])).rows[0].r.verified).toBe(false);
  await sql("UPDATE merchant_notification_invitations SET expires_at=now()+interval '1 hour'");
  await sql("UPDATE merchant_notification_recipients SET address='changed@example.com' WHERE id=$1",[id]);
  expect((await sql("SELECT consume_merchant_notification_invitation($1,'email') r",[h])).rows[0].r.verified).toBe(false);
 });
 it('future-only transaction capture, rollback and duplicate transitions',async()=>{
  const id=await recipient();await order();await verify(id);
  expect(await claim()).toBeNull();
  await sql('BEGIN');await order();await sql('ROLLBACK');expect(await claim()).toBeNull();
  const source=await order('draft');expect(await claim()).toBeNull();
  await sql("UPDATE orders SET status='confirmed' WHERE id=$1",[source]);
  await sql("UPDATE orders SET status='processing' WHERE id=$1",[source]);
  await sql("UPDATE orders SET status='confirmed' WHERE id=$1",[source]);
  expect((await sql('SELECT count(*)::int n FROM merchant_notification_deliveries')).rows[0].n).toBe(1);
 });
 it('captures approval request without claiming confirmation or payment',async()=>{
  await verify(await recipient());const id=await order('paid_pending_approval');
  const d=await claim();expect(d.payload.title).toBe('Order received');expect(d.payload.detail).toContain('approval required');
  await sql("UPDATE orders SET status='confirmed' WHERE id=$1",[id]);expect(await claim()).toBeNull();
 });
 it('distinguishes appointments, classes and reservations',async()=>{
  await verify(await recipient());const service=(await sql(`INSERT INTO services(id,business_id,is_class) VALUES(gen_random_uuid(),$1,true) RETURNING id`,[B])).rows[0].id;
  await sql("INSERT INTO bookings(business_id,status,service_id) VALUES($1,'confirmed',$2),($1,'confirmed',NULL)",[B,service]);
  await sql("INSERT INTO reservations(business_id,status) VALUES($1,'confirmed')",[B]);
  expect((await sql('SELECT event FROM merchant_notification_deliveries ORDER BY event')).rows.map(r=>r.event)).toEqual(['appointment','booking','booking']);
 });
 it('only finalized successful canonical payments; mismatched tenants do not fan out',async()=>{
  await verify(await recipient());const source=await order('draft');
  const p=(await sql("INSERT INTO payments(status,order_id) VALUES('success',$1) RETURNING id",[source])).rows[0].id;
  expect(await claim()).toBeNull();await sql('UPDATE payments SET finalization_completed_at=now() WHERE id=$1',[p]);
  expect((await claim()).event).toBe('payment');
  const other=(await sql("INSERT INTO bookings(business_id,status) VALUES($1,'pending') RETURNING id",[OTHER])).rows[0].id;
  await sql("INSERT INTO payments(status,order_id,booking_id,finalization_completed_at) VALUES('success',$1,$2,now())",[source,other]);
  expect(await claim()).toBeNull();
 });
 it('claims atomically, fences current consent, and refuses stale claim tokens',async()=>{
  const id=await recipient();await verify(id);await order();const d=await claim();
  expect(await claim()).toBeNull();expect(await fence({...d,claim_token:OWNER})).toBe(false);
  await sql('UPDATE merchant_notification_recipients SET enabled=false WHERE id=$1',[id]);expect(await fence(d)).toBe(false);
  expect((await sql('SELECT state FROM merchant_notification_deliveries')).rows[0].state).toBe('suppressed');
 });
 it('cancelled source suppresses before send',async()=>{
  await verify(await recipient());const source=await order();const d=await claim();await sql("UPDATE orders SET status='cancelled' WHERE id=$1",[source]);expect(await fence(d)).toBe(false);
 });
 it('reclaims expired pre-send leases, never dispatched/unknown, and requires provider ID',async()=>{
  await verify(await recipient());await order();const old=await claim();await sql("UPDATE merchant_notification_deliveries SET lease_until=now()-interval '1 minute'");const d=await claim();expect(d.claim_token).not.toBe(old.claim_token);expect(await fence(old)).toBe(false);expect(await fence(d)).toBe(true);
  expect((await sql("SELECT finish_merchant_notification($1,$2,'accepted') ok",[d.id,d.claim_token])).rows[0].ok).toBe(false);
  expect(await claim()).toBeNull();await sql("SELECT finish_merchant_notification($1,$2,'unknown',NULL,'timeout')",[d.id,d.claim_token]);expect(await claim()).toBeNull();
 });
 it('atomic shared monthly allowance counts multiple destinations and preserves email',async()=>{
  await verify(await recipient('whatsapp','+2348012345678'));await verify(await recipient('whatsapp','+2348012345679'));await verify(await recipient());
  await sql("INSERT INTO whatsapp_config VALUES($1,49,date_trunc('month',now())::date)",[B]);await order();
  let sent=0;for(let i=0;i<3;i++){const d=await claim();if(await fence(d))sent++;}
  expect(sent).toBe(2);expect((await sql('SELECT notify_monthly_count n FROM whatsapp_config')).rows[0].n).toBe(50);
 });
 it('STOP before initial verification invalidates outstanding phone invitation',async()=>{
  const id=await recipient('whatsapp','+2348012345678');const hash='c'.repeat(64);
  await sql('SELECT issue_merchant_notification_invitation($1,$2,$3,$4)',[id,B,hash,CHANNEL]);
  expect((await sql('SELECT revoke_merchant_notification_whatsapp($1,$2) n',['+2348012345678',CHANNEL])).rows[0].n).toBe(1);
  expect((await sql("SELECT consume_merchant_notification_invitation($1,'whatsapp',$2,$3) r",[hash,'+2348012345678',CHANNEL])).rows[0].r.verified).toBe(false);
 });
 it('captures finalized campaign payments from canonical campaign tenant',async()=>{
  await verify(await recipient());const campaign=(await sql('INSERT INTO campaigns(business_id) VALUES($1) RETURNING id',[B])).rows[0].id;
  await sql("INSERT INTO payments(status,finalization_completed_at,campaign_id) VALUES('success',now(),$1)",[campaign]);
  expect((await claim()).event).toBe('payment');
 });
 it('reverified recipient cannot receive a prior consent generation event',async()=>{
  const id=await recipient();await verify(id);await order();const d=await claim();
  await sql("UPDATE merchant_notification_recipients SET verified_at=verified_at+interval '1 second' WHERE id=$1",[id]);expect(await fence(d)).toBe(false);
 });
 it('expired final pre-dispatch lease becomes visible failure',async()=>{
  await verify(await recipient());await order();await claim();await sql("UPDATE merchant_notification_deliveries SET attempts=5,lease_until=now()-interval '1 minute'");
  expect(await claim()).toBeNull();expect((await sql('SELECT state,reason FROM merchant_notification_deliveries')).rows[0]).toEqual({state:'failed',reason:'preflight_attempts_exhausted'});
 });
 it('parallel allowance claims consume only one remaining slot',async()=>{
  await sql("INSERT INTO whatsapp_config VALUES($1,49,date_trunc('month',now())::date)",[B]);
  const other=new Client({connectionString:url});await other.connect();
  try {const results=await Promise.all([sql('SELECT reserve_merchant_notification_allowance($1) ok',[B]),other.query('SELECT reserve_merchant_notification_allowance($1) ok',[B])]);expect(results.map(r=>r.rows[0].ok).sort()).toEqual([false,true]);} finally {await other.end();}
 });

 it('two simultaneous claimers cannot claim the same delivery',async()=>{
  await verify(await recipient());await order();const other=new Client({connectionString:url});await other.connect();
  try {const results=await Promise.all([sql('SELECT claim_merchant_notification() d'),other.query('SELECT claim_merchant_notification() d')]);expect(results.filter(r=>r.rows[0].d).length).toBe(1);} finally {await other.end();}
 });
 it('service role executes permitted API while anonymous cannot read recipients',async()=>{
  await sql('SET ROLE service_role');expect(await recipient()).toBeTruthy();await sql('RESET ROLE; SET ROLE anon');
  await expect(sql('SELECT * FROM merchant_notification_recipients')).rejects.toThrow(/permission denied/);
 });
 it('changed source tenant suppresses the old tenant intent',async()=>{
  await verify(await recipient());const source=await order();const d=await claim();await sql('UPDATE orders SET business_id=$1 WHERE id=$2',[OTHER,source]);expect(await fence(d)).toBe(false);
 });

 it('STOP survives remove/re-add and only fresh opt-in clears the address lineage',async()=>{
  const phone='+2348012345678';const old=await recipient('whatsapp',phone);const oldHash='d'.repeat(64);
  await sql('SELECT issue_merchant_notification_invitation($1,$2,$3,$4)',[old,B,oldHash,CHANNEL]);
  await sql("SELECT consume_merchant_notification_invitation($1,'whatsapp',$2,$3)",[oldHash,phone,CHANNEL]);
  await sql('SELECT revoke_merchant_notification_whatsapp($1,$2)',[phone,CHANNEL]);
  await sql('UPDATE merchant_notification_recipients SET revoked_at=now() WHERE id=$1',[old]);
  const fresh=await recipient('whatsapp',phone);const newHash='e'.repeat(64);
  expect((await sql('SELECT count(*)::int n FROM merchant_notification_recipients WHERE stopped_at IS NOT NULL')).rows[0].n).toBe(1);
  await sql('SELECT issue_merchant_notification_invitation($1,$2,$3,$4)',[fresh,B,newHash,CHANNEL]);
  expect((await sql("SELECT consume_merchant_notification_invitation($1,'whatsapp',$2,$3) r",[oldHash,phone,CHANNEL])).rows[0].r.verified).toBe(false);
  expect((await sql('SELECT count(*)::int n FROM merchant_notification_recipients WHERE stopped_at IS NOT NULL')).rows[0].n).toBe(1);
  expect((await sql("SELECT consume_merchant_notification_invitation($1,'whatsapp',$2,$3) r",[newHash,phone,CHANNEL])).rows[0].r.verified).toBe(true);
  expect((await sql('SELECT count(*)::int n FROM merchant_notification_recipients WHERE stopped_at IS NOT NULL')).rows[0].n).toBe(0);
 });

});
