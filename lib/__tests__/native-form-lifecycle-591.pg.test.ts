/** Real PostgreSQL authority/locking/RLS tests using a minimal current-schema fixture.
 * Not HTTP, hosted migration, or provider certification. */
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID, createHash } from 'crypto';
import { readFileSync } from 'fs';

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === 'true') throw Error('Disposable PostgreSQL required for #591');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('Local disposable database only');
const suite = url ? describe : describe.skip;
const database = `native591_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client, db: pg.Client, connection: string;
const owner = randomUUID(), otherOwner = randomUUID(), biz = randomUUID(), otherBiz = randomUUID(), channel = randomUUID(), event = randomUUID(), form = randomUUID(), pub = randomUUID();
const phone = '447700900000', number = '123456789', asset = '789789789';
const config = { title: 'Signup', description: null, fields: [{ id: 'name', type: 'text', label: 'Name' }], settings: { registration_event_id: event, email_marketing_opt_in: true } };
const revision = 'a'.repeat(64), nonce = createHash('sha256').update('native591').digest('hex');
const timestamp = '2026-11-11T12:00:00.000Z';
async function save(client = db, overrides: { business?: string; nonce?: string; email?: boolean } = {}) {
  return (await client.query(`select public.save_native_form_response_591($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) result`,
    [pub, overrides.business || biz, channel, number, asset, revision, phone, overrides.nonce || nonce,
      { name: 'Ada' }, 'Ada', 'ADA@example.test', true, overrides.email ?? true, 'wamid.native591', timestamp])).rows[0].result;
}
async function claim(registrationId: string, client = db) {
  return (await client.query('select public.claim_native_registration_591($1,$2,$3,$4,$5) result', [registrationId, biz, phone, channel, JSON.stringify(['ticketing'])])).rows[0].result;
}
async function roleQuery(role: string, query: string, params: unknown[] = []) {
  await db.query('BEGIN');
  try { await db.query(`SET LOCAL ROLE ${role}`); return await db.query(query, params); }
  finally { await db.query('ROLLBACK'); }
}

suite('#591 native lifecycle database authority', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url }); await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`; connection = target.toString();
    db = new pg.Client({ connectionString: connection }); await db.connect();
    await db.query(`
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      CREATE TABLE businesses(id uuid PRIMARY KEY, owner_id uuid, name text, category text, status text DEFAULT 'active', wa_method text DEFAULT 'shared', assigned_channel_id uuid);
      CREATE TABLE whatsapp_channels(id uuid PRIMARY KEY, phone_number_id text, waba_id text, business_id uuid, channel_type text, is_active boolean DEFAULT true, connection_status text DEFAULT 'active');
      CREATE TABLE events(id uuid PRIMARY KEY, business_id uuid, status text, date date);
      CREATE TABLE bookings(id uuid PRIMARY KEY, business_id uuid, event_id uuid, bot_session_id uuid, guest_phone text);
      CREATE TABLE bot_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), whatsapp_number text NOT NULL, business_id uuid REFERENCES businesses(id), user_id uuid,
        current_step text, session_data jsonb DEFAULT '{}', conversation_log jsonb DEFAULT '[]', is_active boolean DEFAULT true, expires_at timestamptz DEFAULT now()+interval '24 hours', version bigint DEFAULT 0, updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX idx_bot_sessions_phone_business ON bot_sessions(whatsapp_number,business_id) WHERE business_id IS NOT NULL;
      CREATE TABLE whatsapp_inbound_receipts(channel_id uuid, message_id text, sender_phone text, provider_timestamp timestamptz, PRIMARY KEY(channel_id,message_id));
      CREATE TABLE customer_consents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid, phone text NOT NULL, channel text, purpose text, status text, source text, evidence_reference text, policy_version text, granted_at timestamptz, expires_at timestamptz, revoked_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE messaging_opt_outs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid, phone text NOT NULL, channel text, opt_out_type text, resubscribed_at timestamptz);
      CREATE UNIQUE INDEX idx_opt_out_unique ON messaging_opt_outs(phone, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), channel) WHERE resubscribed_at IS NULL;
      GRANT USAGE ON SCHEMA public,auth TO service_role,authenticated,anon;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT SELECT ON businesses TO authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    `);
    await db.query(readFileSync('supabase/migrations/119_forms.sql', 'utf8'));
    await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON forms TO authenticated; GRANT SELECT,DELETE ON form_responses TO authenticated');
    await db.query(readFileSync('supabase/migrations/437_native_whatsapp_forms.sql', 'utf8'));
    await db.query(readFileSync('supabase/migrations/493_shared_conversation_binding.sql', 'utf8'));
    // M490 grants only evidence insertion/read; the new claim column must not widen it.
    await db.query('REVOKE ALL ON whatsapp_inbound_receipts FROM service_role; GRANT SELECT,INSERT ON whatsapp_inbound_receipts TO service_role; ALTER TABLE whatsapp_inbound_receipts ENABLE ROW LEVEL SECURITY');
    await db.query(readFileSync('supabase/migrations/535_native_form_lifecycle.sql', 'utf8'));
  });
  afterAll(async () => {
    await db?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); }
  });
  beforeEach(async () => {
    await db.query('RESET ROLE; TRUNCATE businesses,whatsapp_channels,events,bookings,bot_sessions,forms,form_responses,native_form_publications,native_form_registrations,customer_consents,whatsapp_inbound_receipts CASCADE');
    await db.query("INSERT INTO businesses(id,owner_id,name,category,assigned_channel_id) VALUES($1,$2,'Church','church',$3),($4,$5,'Other','other',$3)", [biz, owner, channel, otherBiz, otherOwner]);
    await db.query("INSERT INTO whatsapp_channels(id,phone_number_id,waba_id,channel_type) VALUES($1,$2,'987654321','shared')", [channel, number]);
    await db.query("INSERT INTO events VALUES($1,$2,'published',CURRENT_DATE+10)", [event,biz]);
    await db.query('INSERT INTO forms(id,business_id,title,description,fields,settings) VALUES($1,$2,$3,$4,$5,$6)', [form,biz,config.title,null,JSON.stringify(config.fields),config.settings]);
    await db.query("INSERT INTO native_form_publications(id,form_id,business_id,channel_id,phone_number_id,waba_id,revision,config,flow_json,meta_flow_id,status,published_at) VALUES($1,$2,$3,$4,$5,'987654321',$6,$7,'{}',$8,'published',now())", [pub,form,biz,channel,number,revision,config,asset]);
    await db.query('INSERT INTO whatsapp_inbound_receipts VALUES($1,$2,$3,$4)', [channel,'wamid.native591',phone,timestamp]);
  });
  it('atomically saves answers, one count, one registration and one exact-address unverified email grant', async () => {
    const result = await save(); expect(result.response_id).toBeTruthy(); expect(result.registration_id).toBeTruthy();
    expect((await db.query('select response_count from forms where id=$1',[form])).rows[0].response_count).toBe(1);
    const consent = (await db.query('select * from customer_consents')).rows[0];
    expect(consent).toMatchObject({ phone, channel:'email',purpose:'marketing',status:'granted',email_address:'ada@example.test',policy_version:'native-email-marketing-v1-unverified' });
    expect((await db.query('select metadata from form_responses')).rows[0].metadata.email_verified).toBe(false);
    expect(await save()).toMatchObject({ response_id:result.response_id,duplicate:true,registration_id:result.registration_id });
    expect((await db.query('select count(*)::int n from customer_consents')).rows[0].n).toBe(1);
  });
  it('serializes simultaneous nonce submissions and increments once', async () => {
    const second = new pg.Client({connectionString:connection}); await second.connect();
    try {
      const rows = await Promise.all([save(),save(second)]);
      expect(new Set(rows.map(x=>x.response_id)).size).toBe(1); expect(rows.filter(x=>x.duplicate)).toHaveLength(1);
      expect((await db.query('select response_count from forms')).rows[0].response_count).toBe(1);
    } finally { await second.end(); }
  });
  it('rejects tenant replay and edited config without any new response', async () => {
    await save(); expect((await save(db,{business:otherBiz})).error).toBe('replay_scope_mismatch');
    await db.query("update forms set title='Changed' where id=$1",[form]);
    expect((await save(db,{nonce:'b'.repeat(64)})).error).toBe('form_changed');
    expect((await db.query('select count(*)::int n from form_responses')).rows[0].n).toBe(1);
  });
  it('requires durable provider receipt and does not infer unchecked email consent', async () => {
    await db.query('delete from whatsapp_inbound_receipts'); expect((await save()).error).toBe('receipt_unavailable');
    await db.query('INSERT INTO whatsapp_inbound_receipts VALUES($1,$2,$3,$4)', [channel,'wamid.native591',phone,timestamp]);
    await save(db,{email:false}); expect((await db.query('select count(*)::int n from customer_consents')).rows[0].n).toBe(0);
  });
  it('denies client RPC execution and isolates owner publication reads', async () => {
    await expect(roleQuery('authenticated','select public.claim_native_registration_591($1,$2,$3,$4,$5)',[randomUUID(),biz,phone,channel,'["ticketing"]'])).rejects.toMatchObject({code:'42501'});
    await expect(roleQuery('anon','select public.complete_native_form_publication_591($1)',[pub])).rejects.toMatchObject({code:'42501'});
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[otherOwner]);
    expect((await roleQuery('authenticated','select id from native_form_publications')).rowCount).toBe(0);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
    expect((await roleQuery('authenticated','select id from native_form_publications')).rowCount).toBe(1);
    expect((await roleQuery('service_role','select id from native_form_publications')).rowCount).toBe(1);
  });
  it('starts one bound ticketing session and never restarts a duplicate continuation', async () => {
    const result=await save(); const first=await claim(result.registration_id);
    expect(first.session.current_step).toBe('select_event'); expect(first.session.session_data._inbound_channel_id).toBe(channel);
    expect((await claim(result.registration_id)).error).toBe('already_started');
    expect((await db.query('select session_id from bot_conversation_bindings')).rows[0].session_id).toBe(first.session.id);
  });
  it('preserves an active checkout on the shared number', async () => {
    const id=randomUUID();
    await db.query("insert into bot_sessions(id,whatsapp_number,business_id,current_step,session_data) values($1,$2,$3,'await_ticket_payment',$4)",[id,phone,otherBiz,{_inbound_channel_id:channel}]);
    await db.query('insert into bot_conversation_bindings(whatsapp_number,channel_id,business_id,session_id) values($1,$2,$3,$4)',[phone,channel,otherBiz,id]);
    const r=await save(); expect((await claim(r.registration_id)).error).toBe('active_checkout');
    expect((await db.query('select session_id from bot_conversation_bindings')).rows[0].session_id).toBe(id);
    expect((await db.query('select session_id from native_form_registrations')).rows[0].session_id).toBeNull();
  });
  it('rotates an idle session identity so ticket creation cannot reuse an older booking', async () => {
    const id=randomUUID();
    await db.query("insert into bot_sessions(id,whatsapp_number,business_id,current_step,session_data) values($1,$2,$3,'select_capability',$4)",[id,phone,biz,{_inbound_channel_id:channel,_detected_language:'en'}]);
    const r=await save(); const started=await claim(r.registration_id);
    expect(started.session.id).not.toBe(id); expect(started.session.session_data._detected_language).toBe('en');
  });
  it('persists separate address unsubscribes despite an existing same-phone email suppression', async () => {
    await db.query("insert into messaging_opt_outs(phone,business_id,channel) values($1,$2,'email')",[phone,biz]);
    await roleQuery('service_role',"select 1");
    await db.query("insert into native_form_email_unsubscribes(business_id,email_address) values($1,'a@example.test'),($1,'b@example.test')",[biz]);
    await db.query("insert into native_form_email_unsubscribes(business_id,email_address) values($1,'b@example.test') on conflict do nothing",[biz]);
    expect((await db.query('select count(*)::int n from native_form_email_unsubscribes')).rows[0].n).toBe(2);
    await expect(roleQuery('authenticated','select * from native_form_email_unsubscribes')).rejects.toMatchObject({code:'42501'});
  });
  it('allows only the receipt send claim column under the real service-role grant boundary', async () => {
    await roleQuery('service_role', 'update whatsapp_inbound_receipts set native_form_send_claimed_at=now() where channel_id=$1', [channel]);
    await expect(roleQuery('service_role', 'update whatsapp_inbound_receipts set provider_timestamp=now() where channel_id=$1', [channel])).rejects.toMatchObject({code:'42501'});
    await expect(roleQuery('authenticated', 'update whatsapp_inbound_receipts set native_form_send_claimed_at=now()')).rejects.toMatchObject({code:'42501'});
  });
  it('attaches only the existing same-business/event/phone/session booking', async () => {
    const r=await save(); const started=await claim(r.registration_id); const booking=randomUUID();
    await db.query('insert into bookings values($1,$2,$3,$4,$5)',[booking,biz,event,started.session.id,'+'+phone]);
    expect((await db.query('select attach_native_registration_591($1,$2,$3) ok',[r.registration_id,booking,started.session.id])).rows[0].ok).toBe(true);
    expect((await db.query('select attach_native_registration_591($1,$2,$3) ok',[r.registration_id,booking,randomUUID()])).rows[0].ok).toBe(false);
  });
});
