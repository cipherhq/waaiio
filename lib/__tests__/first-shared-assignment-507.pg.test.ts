/**
 * M507 — first shared-number assignment without M430, plus get_bot_context
 * ambiguity detection. Real PostgreSQL proof (disposable local database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the M507 first shared assignment proof');
const parsed = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Disposable local PostgreSQL required');

const migration = readFileSync('supabase/migrations/507_first_shared_channel_assignment.sql', 'utf8');
const database = `m507_${randomUUID().replaceAll('-', '')}`;

const NG_BIZ = '00000000-0000-4000-a507-000000000001';
const GH_BIZ = '00000000-0000-4000-a507-000000000002';
const US_BIZ = '00000000-0000-4000-a507-000000000003';
const OTHER_BIZ = '00000000-0000-4000-a507-000000000004';
const NG_CH = '00000000-0000-4000-b507-000000000001';
const US_CH = '00000000-0000-4000-b507-000000000002';
const GH_CH = '00000000-0000-4000-b507-000000000003';

let control: pg.Client;
let client: pg.Client;
let target: URL;

async function assign(id: string | null, c: pg.Client = client) {
  return (await c.query('SELECT public.assign_first_shared_channel($1::uuid) AS r', [id])).rows[0].r;
}
async function assigned(id: string) {
  return (await client.query('SELECT assigned_channel_id FROM businesses WHERE id=$1', [id])).rows[0]?.assigned_channel_id ?? null;
}
async function snapshot() {
  return (await client.query(`SELECT jsonb_build_object(
    'b', (SELECT jsonb_agg(to_jsonb(b) - 'updated_at' ORDER BY id) FROM businesses b),
    'w', (SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM whatsapp_channels w)) v`)).rows[0].v;
}
async function addBusiness(id: string, country: string, extra: Record<string, unknown> = {}) {
  const cols = { id, owner_id: randomUUID(), name: `Biz ${id.slice(-4)}`, country_code: country, wa_method: 'shared', ...extra };
  const keys = Object.keys(cols);
  await client.query(
    `INSERT INTO businesses(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(cols),
  );
}
async function addChannel(id: string, country: string, extra: Record<string, unknown> = {}) {
  const cols = { id, country_code: country, channel_type: 'shared', is_active: true, connection_status: 'active', ...extra };
  const keys = Object.keys(cols);
  await client.query(
    `INSERT INTO whatsapp_channels(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(cols),
  );
}

describe('M507 first shared-number assignment (real PostgreSQL)', () => {
  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    target = new URL(url); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;`);
  });
  afterAll(async () => {
    await client?.end();
    if (control) { await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await control.end(); }
  });
  beforeEach(async () => {
    // Minimal final-state shape of the columns the migration reads/writes (production 2026-11-03).
    await client.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      CREATE TABLE whatsapp_channels(
        id uuid PRIMARY KEY, country_code varchar NOT NULL DEFAULT 'NG',
        channel_type varchar NOT NULL DEFAULT 'shared' CHECK (channel_type IN ('shared','dedicated')),
        business_id uuid, is_active boolean NOT NULL DEFAULT true,
        connection_status varchar DEFAULT 'active' CHECK (connection_status IN ('pending','verifying','active','suspended','disconnected','provisioning')));
      CREATE TABLE businesses(
        id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text, slug text, category text, flow_type text,
        subscription_tier text DEFAULT 'free', trial_ends_at timestamptz, metadata jsonb, operating_hours jsonb,
        country_code varchar NOT NULL DEFAULT 'NG', payment_gateway text, status text NOT NULL DEFAULT 'pending',
        is_whitelabel boolean DEFAULT false, bot_code text,
        wa_method varchar DEFAULT 'shared' CHECK (wa_method IN ('shared','transfer','coexist','own_phone')),
        assigned_channel_id uuid REFERENCES whatsapp_channels(id) ON DELETE SET NULL,
        whatsapp_channel_id uuid REFERENCES whatsapp_channels(id) ON DELETE SET NULL,
        updated_at timestamptz DEFAULT now());
      CREATE TABLE bot_sessions(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), whatsapp_number text NOT NULL, business_id uuid,
        current_step text, session_data jsonb DEFAULT '{}', is_active boolean DEFAULT true,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), version integer DEFAULT 1,
        user_id uuid, expires_at timestamptz DEFAULT now() + interval '1 day');
      CREATE TABLE business_capabilities(business_id uuid, capability text, is_enabled boolean, sort_order integer);
      CREATE TABLE capability_overrides(business_id uuid, capability text);`);
    await client.query(migration);
    await addChannel(NG_CH, 'NG');
    await addChannel(US_CH, 'US');
  });

  it('assigns the business its own country’s active shared number', async () => {
    await addBusiness(NG_BIZ, 'NG');
    const r = await assign(NG_BIZ);
    expect(r).toMatchObject({ allocated: true, idempotent: false, channel_id: NG_CH, channel_country: 'NG', fallback_used: false });
    expect(await assigned(NG_BIZ)).toBe(NG_CH);
  });

  it('is idempotent: a repeat call returns the same number and changes nothing', async () => {
    await addBusiness(NG_BIZ, 'NG');
    await assign(NG_BIZ);
    const before = await snapshot();
    expect(await assign(NG_BIZ)).toEqual({ allocated: true, idempotent: true, channel_id: NG_CH });
    expect(await snapshot()).toEqual(before);
  });

  it('never replaces an existing assignment (even a wrong-country one)', async () => {
    await addBusiness(NG_BIZ, 'NG', { assigned_channel_id: US_CH });
    const before = await snapshot();
    expect(await assign(NG_BIZ)).toEqual({ allocated: true, idempotent: true, channel_id: US_CH });
    expect(await snapshot()).toEqual(before);
  });

  it('Ghana uses a Ghana number when one exists, otherwise the approved Nigeria fallback', async () => {
    await addBusiness(GH_BIZ, 'GH');
    expect(await assign(GH_BIZ)).toMatchObject({ allocated: true, channel_id: NG_CH, channel_country: 'NG', fallback_used: true });
    await addChannel(GH_CH, 'GH');
    await addBusiness(OTHER_BIZ, 'GH');
    expect(await assign(OTHER_BIZ)).toMatchObject({ allocated: true, channel_id: GH_CH, fallback_used: false });
  });

  it('does not fall back across other countries (e.g. Canada never gets the US number)', async () => {
    await addBusiness(US_BIZ, 'CA');
    const before = await snapshot();
    expect(await assign(US_BIZ)).toEqual({ allocated: false, reason: 'no_shared_channel_for_country' });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['inactive', { is_active: false }],
    ['not connection-active', { connection_status: 'suspended' }],
    ['owned by a business', { business_id: OTHER_BIZ }],
    ['dedicated', { channel_type: 'dedicated' }],
  ])('skips a %s channel', async (_label, extra) => {
    await client.query('DELETE FROM whatsapp_channels WHERE id=$1', [NG_CH]);
    await addChannel(NG_CH, 'NG', extra as Record<string, unknown>);
    await addBusiness(NG_BIZ, 'NG');
    expect(await assign(NG_BIZ)).toEqual({ allocated: false, reason: 'no_shared_channel_for_country' });
    expect(await assigned(NG_BIZ)).toBeNull();
  });

  it('refuses businesses that already have other channel authority, without mutation', async () => {
    // NG_BIZ: points at its own dedicated channel.
    const DED = randomUUID();
    await addChannel(DED, 'NG', { channel_type: 'dedicated', business_id: NG_BIZ });
    await addBusiness(NG_BIZ, 'NG', { whatsapp_channel_id: DED });
    // US_BIZ: non-shared WhatsApp method.
    await addBusiness(US_BIZ, 'US', { wa_method: 'transfer' });
    // GH_BIZ: no pointer, but an inactive (historical) dedicated channel belongs to it.
    await addBusiness(GH_BIZ, 'NG');
    await addChannel(randomUUID(), 'NG', { channel_type: 'dedicated', business_id: GH_BIZ, is_active: false });
    const before = await snapshot();
    expect(await assign(NG_BIZ)).toEqual({ allocated: false, reason: 'has_channel' });
    expect(await assign(US_BIZ)).toEqual({ allocated: false, reason: 'not_shared_method' });
    expect(await assign(GH_BIZ)).toEqual({ allocated: false, reason: 'has_dedicated_channel' });
    expect(await snapshot()).toEqual(before);
  });

  it('handles unknown and null business ids without mutation', async () => {
    const before = await snapshot();
    expect(await assign(randomUUID())).toEqual({ allocated: false, reason: 'business_not_found' });
    expect(await assign(null)).toEqual({ allocated: false, reason: 'missing_business' });
    expect(await snapshot()).toEqual(before);
  });

  it('changes only the target business', async () => {
    await addBusiness(NG_BIZ, 'NG');
    await addBusiness(OTHER_BIZ, 'NG');
    await addBusiness(US_BIZ, 'US', { assigned_channel_id: US_CH });
    await assign(NG_BIZ);
    expect(await assigned(OTHER_BIZ)).toBeNull();
    expect(await assigned(US_BIZ)).toBe(US_CH);
  });

  it('has no capacity limit (Owner decision): 75 businesses share one number', async () => {
    const ids = Array.from({ length: 75 }, () => randomUUID());
    for (const id of ids) await addBusiness(id, 'NG');
    for (const id of ids) expect((await assign(id)).channel_id).toBe(NG_CH);
    const { rows } = await client.query('SELECT count(*)::int n FROM businesses WHERE assigned_channel_id=$1', [NG_CH]);
    expect(rows[0].n).toBe(75);
  });

  it('serializes concurrent calls for the same business: one assignment, both see the same number', async () => {
    await addBusiness(NG_BIZ, 'NG');
    const a = new pg.Client({ connectionString: target.toString(), statement_timeout: 5000 });
    const b = new pg.Client({ connectionString: target.toString(), statement_timeout: 5000 });
    await Promise.all([a.connect(), b.connect()]);
    try {
      await a.query('BEGIN');
      const first = await assign(NG_BIZ, a);
      const second = assign(NG_BIZ, b); // blocks on the business row lock
      await new Promise(r => setTimeout(r, 200));
      await a.query('COMMIT');
      const r2 = await second;
      expect(first).toMatchObject({ allocated: true, idempotent: false, channel_id: NG_CH });
      expect(r2).toEqual({ allocated: true, idempotent: true, channel_id: NG_CH });
    } finally { await a.end(); await b.end(); }
  });

  it('is executable only by service_role and is SECURITY DEFINER with a pinned search_path', async () => {
    const { rows } = await client.query(`SELECT p.prosecdef, p.proconfig::text cfg,
      has_function_privilege('anon', p.oid, 'EXECUTE') anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') authed,
      has_function_privilege('service_role', p.oid, 'EXECUTE') svc
      FROM pg_proc p WHERE p.oid='public.assign_first_shared_channel(uuid)'::regprocedure`);
    expect(rows[0]).toEqual({ prosecdef: true, cfg: '{"search_path=public, pg_temp"}', anon: false, authed: false, svc: true });
    const ctx = (await client.query(`SELECT has_function_privilege('authenticated','public.get_bot_context(text,uuid)','EXECUTE') a,
      has_function_privilege('anon','public.get_bot_context(text,uuid)','EXECUTE') n,
      has_function_privilege('service_role','public.get_bot_context(text,uuid)','EXECUTE') s`)).rows[0];
    expect(ctx).toEqual({ a: false, n: false, s: true });
  });

  describe('get_bot_context ambiguity (#266 R3)', () => {
    const PHONE = '2348000000001';
    const ctx = async (biz: string | null) =>
      (await client.query('SELECT public.get_bot_context($1, $2::uuid) AS r', [PHONE, biz])).rows[0].r;

    beforeEach(async () => {
      await addBusiness(NG_BIZ, 'NG', { name: 'Alpha', bot_code: 'ALPHA' });
      await addBusiness(OTHER_BIZ, 'NG', { name: 'Beta', bot_code: 'BETA' });
    });

    it('unresolved lookup with sessions at two businesses returns ambiguous with both businesses', async () => {
      await client.query('INSERT INTO bot_sessions(whatsapp_number, business_id) VALUES ($1,$2),($1,$3)', [PHONE, NG_BIZ, OTHER_BIZ]);
      const r = await ctx(null);
      expect(r.has_session).toBe(true);
      expect(r.ambiguous).toBe(true);
      expect(r.session).toBeUndefined();
      expect((r.businesses as { bot_code: string }[]).map(b => b.bot_code).sort()).toEqual(['ALPHA', 'BETA']);
    });

    it('unresolved lookup with one business resumes that session (not ambiguous)', async () => {
      await client.query('INSERT INTO bot_sessions(whatsapp_number, business_id) VALUES ($1,$2)', [PHONE, NG_BIZ]);
      const r = await ctx(null);
      expect(r).toMatchObject({ has_session: true, ambiguous: false, session: { business_id: NG_BIZ }, business: { id: NG_BIZ } });
    });

    it('business-scoped lookup is unchanged and never ambiguous', async () => {
      await client.query('INSERT INTO bot_sessions(whatsapp_number, business_id) VALUES ($1,$2),($1,$3)', [PHONE, NG_BIZ, OTHER_BIZ]);
      const r = await ctx(OTHER_BIZ);
      expect(r).toMatchObject({ has_session: true, ambiguous: false, session: { business_id: OTHER_BIZ } });
    });

    it('expired or inactive sessions do not count toward ambiguity', async () => {
      await client.query(`INSERT INTO bot_sessions(whatsapp_number, business_id, is_active, expires_at)
        VALUES ($1,$2,true,now()+interval '1 day'),($1,$3,false,now()+interval '1 day'),($1,$3,true,now()-interval '1 minute')`,
      [PHONE, NG_BIZ, OTHER_BIZ]);
      const r = await ctx(null);
      expect(r).toMatchObject({ has_session: true, ambiguous: false, session: { business_id: NG_BIZ } });
    });

    it('no session returns has_session false', async () => {
      expect(await ctx(null)).toEqual({ has_session: false, ambiguous: false });
    });
  });
});
