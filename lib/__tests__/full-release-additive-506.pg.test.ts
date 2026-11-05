import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the additive release proof');
const parsed = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Disposable local PostgreSQL required');
const migration = (name: string) => readFileSync(`supabase/migrations/${name}`, 'utf8');
const expand = migration('506_full_release_additive_foundation.sql');
const formsContract = migration('437_native_whatsapp_forms.sql');
const accountsContract = migration('446_payout_accounts_server_only.sql');
const accountRpc = migration('441_payout_account_atomic_swap.sql');
const database = `full_expand_${randomUUID().replaceAll('-', '')}`;
const owner = '00000000-0000-4000-a506-000000000001';
const business = '00000000-0000-4000-a506-000000000002';
const form = '00000000-0000-4000-a506-000000000003';
let control: pg.Client;
let client: pg.Client;

async function asRole(role: string, query: string) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
    return await client.query(query);
  } finally { await client.query('ROLLBACK'); }
}
async function projection() {
  return (await client.query(`SELECT jsonb_build_object(
    'businesses',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM businesses b),
    'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM payout_accounts a),
    'form',(SELECT to_jsonb(f)-ARRAY['meta_flow_id','meta_flow_status','native_flow_json'] FROM forms f WHERE id='${form}')
  ) value`)).rows[0].value;
}
async function grants() {
  return (await client.query(`SELECT c.relname,c.relacl::text,coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'roles',p.polroles,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FILTER (WHERE p.oid IS NOT NULL),'[]'::jsonb) policies
    FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid=c.oid WHERE c.oid IN ('forms'::regclass,'payout_accounts'::regclass) GROUP BY c.oid ORDER BY c.relname`)).rows;
}

describe('M506 additive release dependencies', () => {
  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;`);
  });
  afterAll(async () => { await client?.end(); if (control) { await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await control.end(); } });
  beforeEach(async () => {
    await client.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
      CREATE TABLE businesses(id uuid PRIMARY KEY,owner_id uuid,payout_mode text DEFAULT 'platform_managed');
      CREATE TABLE forms(id uuid PRIMARY KEY,business_id uuid REFERENCES businesses(id),title text,description text,fields jsonb,settings jsonb,is_active boolean,token text,response_count integer,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE form_responses(id uuid PRIMARY KEY,form_id uuid REFERENCES forms(id),data jsonb);
      CREATE TABLE payout_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid REFERENCES businesses(id),gateway text,bank_code text,bank_name text,account_number text,account_name text,subaccount_code text,stripe_account_id text,square_merchant_id text,square_access_token text,platform_percentage numeric DEFAULT 2.5,is_active boolean DEFAULT true,verified_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX idx_payout_accounts_business_active ON payout_accounts(business_id) WHERE is_active=true;
      GRANT ALL ON businesses,forms,form_responses,payout_accounts TO service_role;
      GRANT SELECT ON businesses TO authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON forms,payout_accounts TO authenticated;
      ALTER TABLE payout_accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_form_owner ON forms FOR ALL TO authenticated USING (business_id IN (SELECT id FROM businesses WHERE owner_id=current_setting('request.jwt.claim.sub',true)::uuid));
      CREATE POLICY "Business owners can view own payout accounts" ON payout_accounts FOR SELECT TO authenticated USING (business_id IN (SELECT id FROM businesses WHERE owner_id=current_setting('request.jwt.claim.sub',true)::uuid));
      CREATE POLICY "Business owners can insert own payout accounts" ON payout_accounts FOR INSERT TO authenticated WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id=current_setting('request.jwt.claim.sub',true)::uuid));
      CREATE POLICY "Business owners can update own payout accounts" ON payout_accounts FOR UPDATE TO authenticated USING (business_id IN (SELECT id FROM businesses WHERE owner_id=current_setting('request.jwt.claim.sub',true)::uuid));
      INSERT INTO businesses(id,owner_id) VALUES('${business}','${owner}');
      INSERT INTO forms(id,business_id,title) VALUES('${form}','${business}','Existing form');
      INSERT INTO payout_accounts(business_id,gateway,subaccount_code,stripe_account_id) VALUES('${business}','paystack','fixture-subaccount','fixture-connect');`);
    await client.query(accountRpc);
  });

  it('adds the dependencies without changing existing business values or existing table authority', async () => {
    const before=await projection(); const permissions=await grants(); await client.query(expand);
    expect(await projection()).toEqual(before); expect(await grants()).toEqual(permissions);
    expect((await client.query(`SELECT meta_flow_id,meta_flow_status,native_flow_json FROM forms WHERE id='${form}'`)).rows[0]).toEqual({meta_flow_id:null,meta_flow_status:'draft',native_flow_json:null});
  });
  it('preserves the old form update including business_id during the transition', async () => {
    await client.query(expand);
    expect((await asRole('authenticated',`UPDATE forms SET business_id='${business}',title='Edited' WHERE id='${form}' RETURNING title`)).rows[0].title).toBe('Edited');
  });
  it('preserves old payout metadata reads and owner update during the transition', async () => {
    await client.query(expand);
    expect((await asRole('authenticated',`SELECT subaccount_code,stripe_account_id FROM payout_accounts WHERE business_id='${business}'`)).rows[0]).toEqual({subaccount_code:'fixture-subaccount',stripe_account_id:'fixture-connect'});
    expect((await asRole('authenticated',`UPDATE payout_accounts SET account_name='Changed' WHERE business_id='${business}' RETURNING account_name`)).rows[0].account_name).toBe('Changed');
  });
  it('makes the new native-form read contract available', async () => {
    await client.query(expand);
    expect((await asRole('authenticated',`SELECT meta_flow_id,meta_flow_status,native_flow_json FROM forms WHERE id='${form}'`)).rows).toHaveLength(1);
    expect((await client.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='form_responses' AND column_name IN ('submission_source','flow_token_hash','consent_given')")).rows[0].n).toBe(3);
  });
  it('supports the previous eight named service arguments without overload ambiguity', async () => {
    await client.query(expand);
    const result=await asRole('service_role',`SELECT swap_payout_account(p_business_id=>'${business}',p_gateway=>'paystack',p_bank_code=>'001',p_bank_name=>'Bank',p_account_number=>'123',p_account_name=>'Fixture',p_subaccount_code=>'fixture-new',p_verified_at=>now()) id`);
    expect(result.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('supports the complete eleven-argument service interface atomically', async () => {
    await client.query(expand);
    const result=await asRole('service_role',`WITH changed AS (SELECT swap_payout_account(p_business_id=>'${business}',p_gateway=>'stripe',p_stripe_account_id=>'fixture-new-connect') id) SELECT id FROM changed`);
    expect(result.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE service_role; SELECT swap_payout_account(p_business_id=>'${business}',p_gateway=>'stripe',p_stripe_account_id=>'fixture-new-connect')`);
    expect((await client.query(`SELECT stripe_account_id FROM payout_accounts WHERE business_id='${business}' AND is_active`)).rows).toEqual([{stripe_account_id:'fixture-new-connect'}]);
    await client.query('ROLLBACK');
  });
  it.each(['anon','authenticated'])('denies %s direct execution and OAuth access', async role => {
    await client.query(expand);
    await expect(asRole(role,`SELECT swap_payout_account('${business}','stripe')`)).rejects.toMatchObject({code:'42501'});
    await expect(asRole(role,'SELECT * FROM oauth_connect_states')).rejects.toMatchObject({code:'42501'});
    await expect(asRole(role,`INSERT INTO oauth_connect_states(state_hash,user_id,business_id,provider,expires_at) VALUES('fixture','${owner}','${business}','stripe',now())`)).rejects.toMatchObject({code:'42501'});
  });
  it('removes inherited public defaults only from the new OAuth table', async () => {
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated');
    try {
      const before=await grants(); await client.query(expand); expect(await grants()).toEqual(before);
      await expect(asRole('authenticated','SELECT * FROM oauth_connect_states')).rejects.toMatchObject({code:'42501'});
    } finally { await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated'); }
  });
  it('does not reopen permissions when run on an already-contracted staging schema', async () => {
    await client.query(formsContract); await client.query(accountsContract); const before=await grants(); await client.query(expand); expect(await grants()).toEqual(before);
    await expect(asRole('authenticated',`UPDATE forms SET business_id='${business}' WHERE id='${form}'`)).rejects.toMatchObject({code:'42501'});
    await expect(asRole('authenticated','SELECT subaccount_code FROM payout_accounts')).rejects.toMatchObject({code:'42501'});
  });
  it('supports complete canonical contraction after compatible app cutover', async () => {
    await client.query(expand); await client.query(formsContract); await client.query(accountsContract);
    await expect(asRole('authenticated','SELECT subaccount_code FROM payout_accounts')).rejects.toMatchObject({code:'42501'});
    expect((await asRole('authenticated','SELECT id,gateway,bank_name FROM payout_accounts')).rows).toHaveLength(1);
    expect((await asRole('authenticated',`UPDATE forms SET title='New app' WHERE id='${form}' RETURNING title`)).rows[0].title).toBe('New app');
  });
  it('is idempotent without changing data or final function definition', async () => {
    await client.query(expand); const before=await projection(); const fn=(await client.query("SELECT pg_get_functiondef(oid) body FROM pg_proc WHERE proname='swap_payout_account'")).rows;
    await client.query(expand); expect(await projection()).toEqual(before); expect((await client.query("SELECT pg_get_functiondef(oid) body FROM pg_proc WHERE proname='swap_payout_account'")).rows).toEqual(fn);
  });
  it('rejects an incompatible existing column and rolls back the entire expansion', async () => {
    await client.query('ALTER TABLE forms ADD COLUMN meta_flow_id integer'); const before=await projection();
    await expect(client.query(expand)).rejects.toThrow('M506 form column contract mismatch'); await client.query('ROLLBACK');
    expect(await projection()).toEqual(before); expect((await client.query("SELECT to_regclass('public.oauth_connect_states') value")).rows[0].value).toBeNull();
  });
  it('rejects a same-name nonunique index instead of treating existence as proof', async () => {
    await client.query('ALTER TABLE form_responses ADD COLUMN flow_token_hash varchar(128); CREATE INDEX idx_form_responses_flow_token_hash ON form_responses(flow_token_hash) WHERE flow_token_hash IS NOT NULL');
    await expect(client.query(expand)).rejects.toThrow('M506 form response index mismatch'); await client.query('ROLLBACK');
    expect((await client.query("SELECT to_regclass('public.oauth_connect_states') value")).rows[0].value).toBeNull();
  });
  it('rejects a same-name unique index on the wrong key', async () => {
    await client.query('ALTER TABLE form_responses ADD COLUMN flow_token_hash varchar(128); CREATE UNIQUE INDEX idx_form_responses_flow_token_hash ON form_responses(id) WHERE flow_token_hash IS NOT NULL');
    await expect(client.query(expand)).rejects.toThrow('M506 form response index mismatch'); await client.query('ROLLBACK');
  });
  it.each([
    "ALTER TABLE forms ADD COLUMN meta_flow_status varchar(20) DEFAULT 'published'",
    "ALTER TABLE forms ADD COLUMN meta_flow_id varchar(64) NOT NULL DEFAULT ''",
    "ALTER TABLE forms ADD COLUMN meta_flow_status varchar(20) DEFAULT 'draft'; ALTER TABLE forms ADD CONSTRAINT forms_meta_flow_status_check CHECK (true)",
    "CREATE TABLE oauth_connect_states(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),state_hash text,user_id uuid NOT NULL,business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,provider text NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())",
  ])('rejects incompatible existing defaults, nullability, checks or OAuth shape: %s', async setup => {
    await client.query(setup); const before=await projection();
    await expect(client.query(expand)).rejects.toThrow('M506 existing structure differs from canonical contract'); await client.query('ROLLBACK');
    expect(await projection()).toEqual(before);
  });
});
