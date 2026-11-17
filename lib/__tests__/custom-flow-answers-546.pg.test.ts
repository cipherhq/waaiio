// M546 (#1085, Phase 3 of #1013): Custom Flow answers on real PostgreSQL —
// exact final ACLs, owner + active-team read, owner-only delete, no client
// writes, value/file CHECKs, composite FKs and the private uploads bucket.
//
// This test FAILS, never skips, when the database is missing. It runs in CI
// in the security-acl-tests job ("Run .pg.test.ts files in parallel with
// isolated databases"), which gives it its own disposable database.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error('Disposable PostgreSQL required for M546 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('Local disposable database only');
const database = `customflow546_${randomUUID().replaceAll('-', '')}`;
const migration = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');

const owner = randomUUID(), otherOwner = randomUUID(), teammate = randomUUID(), invited = randomUUID(), suspended = randomUUID();
const biz = randomUUID(), otherBiz = randomUUID(), flow = randomUUID(), otherFlow = randomUUID(), session = randomUUID();
const response = randomUUID();

let admin: pg.Client, db: pg.Client;

async function roleQuery(role: string, sub: string | null, sql: string, params: unknown[] = []) {
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    if (sub) await db.query(`SET LOCAL request.jwt.claim.sub = '${sub}'`);
    return await db.query(sql, params);
  } finally { await db.query('ROLLBACK'); }
}

const insertAnswer = (fields: Record<string, unknown>) => {
  const row = { business_id: biz, flow_id: flow, flow_version: 1, response_id: randomUUID(), customer_number: '2348012345678',
    node_id: `q_${randomUUID().slice(0, 8)}`, question: 'Are you coming?', answer_type: 'yes_no', value_text: 'Yes', ...fields };
  const keys = Object.keys(row);
  return db.query(`INSERT INTO custom_flow_answers(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(row));
};

describe('M546 custom flow answers (real PostgreSQL)', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url }); await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const target = new URL(url); target.pathname = `/${database}`;
    db = new pg.Client({ connectionString: target.toString() }); await db.connect();
    await db.query(`
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
      CREATE TYPE business_category AS ENUM ('other');
      CREATE TABLE businesses(id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL DEFAULT 'B',
        status text DEFAULT 'active', flow_type text DEFAULT 'scheduling');
      GRANT SELECT ON businesses TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON businesses TO service_role;
      -- business_members as left by M099 + M433: clients read their own row.
      CREATE TABLE business_members(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        user_id uuid, email text NOT NULL, role text NOT NULL DEFAULT 'staff', status text NOT NULL DEFAULT 'invited');
      ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON business_members TO authenticated;
      CREATE POLICY business_members_select ON business_members FOR SELECT TO authenticated
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()) OR user_id = auth.uid());
      -- Supabase Storage shape (the real buckets table has the limit columns).
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets(id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
        file_size_limit bigint, allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text);
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO service_role, authenticated;
    `);
    await db.query(migration('008_capabilities.sql'));
    // Production's drift: new tables and functions default to every right for every API role.
    await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`);
    await db.query(migration('541_custom_flow_base.sql'));
    await db.query(migration('546_custom_flow_answers.sql'));
  });
  afterAll(async () => {
    await db?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); }
  });
  beforeEach(async () => {
    await db.query('TRUNCATE custom_flow_answers, custom_flow_sessions, custom_flows, business_members, businesses CASCADE');
    await db.query('INSERT INTO businesses(id, owner_id) VALUES($1,$2),($3,$4)', [biz, owner, otherBiz, otherOwner]);
    await db.query(`INSERT INTO business_members(business_id, user_id, email, role, status) VALUES
      ($1,$2,'team@x.test','staff','active'),($1,$3,'invited@x.test','admin','invited'),($1,$4,'gone@x.test','admin','suspended')`,
    [biz, teammate, invited, suspended]);
    await db.query(`INSERT INTO custom_flows(id, business_id, name) VALUES($1,$2,'Retreat'),($3,$4,'Other')`, [flow, biz, otherFlow, otherBiz]);
    await db.query(`INSERT INTO custom_flow_sessions(id, business_id, whatsapp_number, flow_id, flow_version, current_node_id)
      VALUES($1,$2,'2348012345678',$3,1,'q1')`, [session, biz, flow]);
    await insertAnswer({ response_id: response, session_id: session, node_id: 'q1' });
    await insertAnswer({ business_id: otherBiz, flow_id: otherFlow, node_id: 'q1' });
  });

  it('final ACLs are exact despite production-like default privileges', async () => {
    const acl = (await db.query(`SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) p
      FROM information_schema.role_table_grants WHERE table_name='custom_flow_answers' AND grantee IN ('anon','authenticated','service_role','PUBLIC') GROUP BY grantee ORDER BY grantee`)).rows;
    expect(acl).toEqual([
      { grantee: 'authenticated', p: 'DELETE,SELECT' },
      { grantee: 'service_role', p: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
    expect((await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='public.custom_flow_answers'::regclass`)).rows[0].relrowsecurity).toBe(true);
    await expect(roleQuery('anon', null, 'SELECT * FROM custom_flow_answers')).rejects.toMatchObject({ code: '42501' });
  });

  it('the owner and an active team member read their answers; invited, suspended and other owners do not', async () => {
    const ids = async (sub: string) => (await roleQuery('authenticated', sub, 'SELECT node_id, business_id FROM custom_flow_answers')).rows;
    expect(await ids(owner)).toEqual([{ node_id: 'q1', business_id: biz }]);
    expect(await ids(teammate)).toEqual([{ node_id: 'q1', business_id: biz }]);
    expect(await ids(invited)).toEqual([]);
    expect(await ids(suspended)).toEqual([]);
    expect((await ids(otherOwner)).map(r => r.business_id)).toEqual([otherBiz]);
  });

  it('only the owner can delete; team members and other owners delete nothing', async () => {
    expect((await roleQuery('authenticated', teammate, 'DELETE FROM custom_flow_answers RETURNING id')).rowCount).toBe(0);
    expect((await roleQuery('authenticated', otherOwner, 'DELETE FROM custom_flow_answers WHERE business_id=$1 RETURNING id', [biz])).rowCount).toBe(0);
    expect((await roleQuery('authenticated', owner, 'DELETE FROM custom_flow_answers WHERE business_id=$1 RETURNING id', [biz])).rowCount).toBe(1);
  });

  it('clients can never insert or update answers', async () => {
    await expect(roleQuery('authenticated', owner, `INSERT INTO custom_flow_answers(business_id, flow_id, flow_version, response_id, customer_number, node_id, question, answer_type, value_text)
      VALUES($1,$2,1,$3,'234','q9','Q','text','x')`, [biz, flow, randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(roleQuery('authenticated', owner, `UPDATE custom_flow_answers SET value_text='No'`)).rejects.toMatchObject({ code: '42501' });
    // service_role (the engine) can write.
    const written = await roleQuery('service_role', null, `UPDATE custom_flow_answers SET value_text='No' WHERE business_id=$1 RETURNING id`, [biz]);
    expect(written.rowCount).toBe(1);
  });

  it('value columns must match the answer type', async () => {
    await expect(insertAnswer({ answer_type: 'date', value_text: 'Saturday' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertAnswer({ answer_type: 'text', value_text: '   ' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertAnswer({ answer_type: 'file', value_text: null })).rejects.toMatchObject({ code: '23514' });
    await expect(insertAnswer({ answer_type: 'maybe' })).rejects.toMatchObject({ code: '23514' });
    await insertAnswer({ answer_type: 'date', value_text: null, value_date: '2026-11-21' });
    await insertAnswer({ answer_type: 'choice', value_text: 'Vegetarian' });
  });

  it('files: own-folder path, photo/PDF types only, 10 MB maximum', async () => {
    const file = { answer_type: 'file', value_text: null, file_mime: 'image/jpeg', file_size: 1024, file_path: `${biz}/${randomUUID()}.jpg` };
    await insertAnswer(file);
    await insertAnswer({ ...file, file_mime: 'application/pdf', file_size: 10485760, file_path: `${biz}/a.pdf` });
    await expect(insertAnswer({ ...file, file_path: `${otherBiz}/x.jpg` })).rejects.toMatchObject({ code: '23514' });
    await expect(insertAnswer({ ...file, file_path: `${biz}/../${otherBiz}/x.jpg` })).rejects.toMatchObject({ code: '23514' });
    await expect(insertAnswer({ ...file, file_mime: 'application/zip' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertAnswer({ ...file, file_mime: 'image/gif' })).rejects.toMatchObject({ code: '23514' });
    await expect(insertAnswer({ ...file, file_size: 10485761 })).rejects.toMatchObject({ code: '23514' });
  });

  it('composite FKs stop an answer attaching to another business’s flow or session', async () => {
    await expect(insertAnswer({ business_id: otherBiz, flow_id: flow })).rejects.toMatchObject({ code: '23503' });
    await expect(insertAnswer({ business_id: otherBiz, flow_id: otherFlow, session_id: session })).rejects.toMatchObject({ code: '23503' });
  });

  it('re-answering in one run is a single row; a deleted session keeps the answer', async () => {
    await expect(insertAnswer({ response_id: response, node_id: 'q1' })).rejects.toMatchObject({ code: '23505' });
    await db.query('DELETE FROM custom_flow_sessions WHERE id=$1', [session]);
    const rows = (await db.query('SELECT session_id, business_id FROM custom_flow_answers WHERE response_id=$1', [response])).rows;
    expect(rows).toEqual([{ session_id: null, business_id: biz }]);
  });

  it('the uploads bucket is private with limits, and only service_role has a policy on it', async () => {
    const bucket = (await db.query(`SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id='custom-flow-uploads'`)).rows[0];
    expect(bucket).toEqual({ public: false, file_size_limit: '10485760', allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] });
    const policies = (await db.query(`SELECT roles::text[] r FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND qual LIKE '%custom-flow-uploads%'`)).rows;
    expect(policies).toEqual([{ r: ['service_role'] }]);
    await db.query(`INSERT INTO storage.objects(bucket_id, name) VALUES('custom-flow-uploads', $1)`, [`${biz}/a.jpg`]);
    expect((await roleQuery('authenticated', owner, `SELECT name FROM storage.objects WHERE bucket_id='custom-flow-uploads'`)).rows).toEqual([]);
  });
});
