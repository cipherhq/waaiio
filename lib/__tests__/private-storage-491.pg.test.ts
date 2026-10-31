import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import pg from 'pg';
import {readFileSync} from 'node:fs';
const url=process.env.TEST_DATABASE_URL;
if(process.env.REQUIRE_PG_TESTS==='true'&&!url) throw new Error('Disposable PostgreSQL required');
const suite=url?describe:describe.skip;
const owner='11111111-1111-4111-a111-111111111111', other='22222222-2222-4222-a222-222222222222';
const business='33333333-3333-4333-a333-333333333333';
suite('private storage final-state tenant boundaries',()=>{
 let pool:pg.Pool;
 beforeAll(async()=>{
  const target=url?new URL(url):null;
  const isolatedCi=process.env.GITHUB_ACTIONS==='true'&&process.env.REQUIRE_PG_TESTS==='true'&&target?.username==='test_runner'&&/^\/pg_test_\d+$/.test(target.pathname);
  if(!target||!['localhost','127.0.0.1'].includes(target.hostname)||(target.pathname!=='/storage_security_test'&&!isolatedCi))throw new Error('Local disposable database only');
  pool=new pg.Pool({connectionString:url});
  await pool.query(`DROP SCHEMA IF EXISTS storage CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP TABLE IF EXISTS public.businesses CASCADE; CREATE SCHEMA IF NOT EXISTS storage; CREATE SCHEMA IF NOT EXISTS auth;
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_user::text $$;
  CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
  CREATE TABLE IF NOT EXISTS public.businesses(id uuid PRIMARY KEY,owner_id uuid);
  CREATE TABLE IF NOT EXISTS storage.buckets(id text PRIMARY KEY,name text,public boolean);
  CREATE TABLE IF NOT EXISTS storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text);
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT USAGE ON SCHEMA public,storage,auth TO anon,authenticated,service_role;
  GRANT SELECT ON businesses TO authenticated,service_role;
  GRANT ALL ON storage.objects,storage.buckets TO anon,authenticated,service_role;
  INSERT INTO businesses VALUES('${business}','${owner}') ON CONFLICT DO NOTHING;
  INSERT INTO storage.buckets VALUES('business-documents','business-documents',true),('customer-reports','customer-reports',false),('documents','documents',false) ON CONFLICT DO NOTHING;
  CREATE POLICY "Allow public reads on documents" ON storage.objects FOR SELECT USING(bucket_id='documents');
  CREATE POLICY "Business owners read reports" ON storage.objects FOR SELECT USING(bucket_id='customer-reports' AND auth.role()='authenticated');
  CREATE POLICY "Business owners upload reports" ON storage.objects FOR INSERT WITH CHECK(bucket_id='customer-reports' AND auth.role()='authenticated');
  CREATE POLICY "Allow public reads" ON storage.objects FOR SELECT USING(bucket_id='business-documents');
  CREATE POLICY "Business owners manage own documents" ON storage.objects FOR ALL TO authenticated USING(bucket_id='business-documents' AND (storage.foldername(name))[1] IN(SELECT id::text FROM businesses WHERE owner_id=auth.uid()));`);
  for(const file of ['491_private_document_storage.sql','492_verification_public_upload_guard.sql'])await pool.query(readFileSync(`supabase/migrations/${file}`,'utf8'));
  await pool.query(`INSERT INTO storage.objects(bucket_id,name) VALUES
  ('customer-reports','${business}/report.pdf'),('customer-reports','receipts/${owner}/receipt.pdf'),
  ('customer-reports','receipts/${business}/receipt.pdf'),('customer-reports','invoices/${business}/invoice.pdf'),
  ('documents','tickets/ticket.pdf'),('verification-documents','${business}/id.pdf'),('business-documents','${business}/image.png');`);
 });
 afterAll(async()=>{await pool?.end()});
 async function as(role:string,user:string,fn:(c:pg.PoolClient)=>Promise<void>){const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);await fn(c)}finally{await c.query('ROLLBACK');c.release()}}
 it('keeps public catalog images and private document flags',async()=>{
  expect((await pool.query("SELECT id FROM storage.buckets WHERE public")).rows).toEqual([{id:'business-documents'}]);
 });
 it.each(['anon','authenticated'])('%s cannot read generated or verification documents',async role=>{
  await as(role,owner,async c=>{expect((await c.query("SELECT name FROM storage.objects WHERE bucket_id IN ('documents','verification-documents')")).rows).toHaveLength(0)});
 });
 it('owner can read/create/delete own merchant report, but not generated receipt namespaces',async()=>{
  await as('authenticated',owner,async c=>{
   expect((await c.query("SELECT name FROM storage.objects WHERE bucket_id='customer-reports'")).rows).toEqual([{name:`${business}/report.pdf`}]);
   await c.query("INSERT INTO storage.objects(bucket_id,name) VALUES('customer-reports',$1)",[`${business}/new.pdf`]);
   expect((await c.query("DELETE FROM storage.objects WHERE bucket_id='customer-reports' AND name=$1 RETURNING name",[`${business}/new.pdf`])).rowCount).toBe(1);
  });
 });
 it.each(['anon','authenticated'])('%s other tenant denied read/insert',async role=>{
  await as(role,other,async c=>{expect((await c.query("SELECT * FROM storage.objects WHERE bucket_id='customer-reports'")).rowCount).toBe(0);await expect(c.query("INSERT INTO storage.objects(bucket_id,name) VALUES('customer-reports',$1)",[`${business}/bad.pdf`])).rejects.toMatchObject({code:'42501'})});
 });
 it.each([`receipts/${owner}/new.pdf`,`receipts/${business}/new.pdf`,`invoices/${business}/new.pdf`])('owner denied generated-prefix upload %s',async name=>{
  await as('authenticated',owner,async c=>{await expect(c.query("INSERT INTO storage.objects(bucket_id,name) VALUES('customer-reports',$1)",[name])).rejects.toMatchObject({code:'42501'})});
 });
 it.each([`${business}/verification/old.pdf`,`verification/${business}/old.pdf`])('stale public verification upload denied %s',async name=>{
  await as('authenticated',owner,async c=>{await expect(c.query("INSERT INTO storage.objects(bucket_id,name) VALUES('business-documents',$1)",[name])).rejects.toMatchObject({code:'42501'})});
 });
 it('public catalog uploads preserved',async()=>{
  await as('authenticated',owner,async c=>{await c.query("INSERT INTO storage.objects(bucket_id,name) VALUES('business-documents',$1)",[`${business}/products/image.png`])});
 });
 it.each([`${business}/verification/renamed.pdf`,`verification/${business}/renamed.pdf`])('catalog rename to verification denied %s',async name=>{
  await as('authenticated',owner,async c=>{await expect(c.query("UPDATE storage.objects SET name=$1 WHERE bucket_id='business-documents' AND name=$2",[name,`${business}/image.png`])).rejects.toMatchObject({code:'42501'})});
 });
 it('existing verification overwrite denied while catalog updates remain allowed',async()=>{
  const c=await pool.connect();
  try {
   await c.query('BEGIN');
   await c.query("INSERT INTO storage.objects(bucket_id,name) VALUES('business-documents',$1)",[`${business}/verification/existing.pdf`]);
   await c.query('SET LOCAL ROLE authenticated');
   await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner]);
   expect((await c.query("UPDATE storage.objects SET name=name WHERE bucket_id='business-documents' AND name=$1 RETURNING id",[`${business}/verification/existing.pdf`])).rowCount).toBe(0);
   expect((await c.query("UPDATE storage.objects SET name=$1 WHERE bucket_id='business-documents' AND name=$2 RETURNING id",[`${business}/products/new.png`,`${business}/image.png`])).rowCount).toBe(1);
  } finally {await c.query('ROLLBACK');c.release()}
 });
 it('service retains all generated upload/sign/read/delete paths',async()=>{
  await as('service_role','',async c=>{expect((await c.query('SELECT * FROM storage.objects')).rowCount).toBe(7);await c.query("INSERT INTO storage.objects(bucket_id,name) VALUES('verification-documents',$1)",[`${business}/new.pdf`]);expect((await c.query("DELETE FROM storage.objects WHERE bucket_id='verification-documents' RETURNING id")).rowCount).toBe(2)});
 });
 it('migrations rerun without broadening policies',async()=>{
  for(const file of ['491_private_document_storage.sql','492_verification_public_upload_guard.sql'])await pool.query(readFileSync(`supabase/migrations/${file}`,'utf8'));
  expect((await pool.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='storage' AND policyname='Allow public reads on documents'")).rows[0].n).toBe(0);
 });
});
