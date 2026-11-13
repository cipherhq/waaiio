// M541 (#1013 Phase 1): Custom Flow base tables on real PostgreSQL —
// the capability_type enum value, tenant-scoped RLS, composite FKs,
// the entry-keyword guard, and the 90-day step-log purge.
//
// Per the Owner's direction (2026-11-13): this test FAILS, never skips,
// when the database is missing. It runs in CI in the security-acl-tests
// job ("Run .pg.test.ts files in parallel with isolated databases"),
// which gives it its own disposable database per file.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error('Disposable PostgreSQL required for M541 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('Local disposable database only');
const database = `customflow541_${randomUUID().replaceAll('-', '')}`;
const migration = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');

const owner = randomUUID(), otherOwner = randomUUID(), biz = randomUUID(), otherBiz = randomUUID();
const flow = randomUUID(), otherFlow = randomUUID(), table = randomUUID(), row = randomUUID(), session = randomUUID();

let admin: pg.Client, db: pg.Client;

async function roleQuery(role: string, sub: string | null, sql: string, params: unknown[] = []) {
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    if (sub) await db.query(`SET LOCAL request.jwt.claim.sub = '${sub}'`);
    return await db.query(sql, params);
  } finally { await db.query('ROLLBACK'); }
}

describe('M541 custom flow base tables (real PostgreSQL)', () => {
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
      -- Minimal businesses stub: 008's auto-migration reads b.flow_type and
      -- 541's owner policies read businesses.owner_id.
      CREATE TYPE business_category AS ENUM ('other');
      CREATE TABLE businesses(id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL DEFAULT 'B',
        status text DEFAULT 'active', flow_type text DEFAULT 'scheduling');
      -- 541's owner policies subquery businesses, so the authenticated role
      -- needs SELECT on it (as in production, where it has that grant).
      GRANT SELECT ON businesses TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON businesses TO service_role;
    `);
    await db.query(migration('008_capabilities.sql'));
    // Production's drift: new tables and functions default to every right for every API role.
    await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`);
    await db.query(migration('541_custom_flow_base.sql'));
  });
  afterAll(async () => {
    await db?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); }
  });
  beforeEach(async () => {
    await db.query('TRUNCATE custom_flow_logs, custom_flow_sessions, custom_flow_table_rows, custom_flow_tables, custom_flows, business_capabilities, businesses CASCADE');
    await db.query('INSERT INTO businesses(id, owner_id) VALUES($1,$2),($3,$4)', [biz, owner, otherBiz, otherOwner]);
    await db.query(`INSERT INTO custom_flows(id, business_id, name, status, entry_keyword, published_version, published_definition)
      VALUES($1,$2,'AfroPlus Fest','published','AFROFEST',1,'{}'),($3,$4,'Other Flow','draft',NULL,NULL,NULL)`,
      [flow, biz, otherFlow, otherBiz]);
    await db.query(`INSERT INTO custom_flow_tables(id, business_id, flow_id, name) VALUES($1,$2,$3,'vendors')`, [table, biz, flow]);
    await db.query(`INSERT INTO custom_flow_table_rows(id, table_id, business_id, row_code, data) VALUES($1,$2,$3,'V001','{"name":"Jollof House"}')`, [row, table, biz]);
    await db.query(`INSERT INTO custom_flow_sessions(id, business_id, whatsapp_number, flow_id, flow_version, current_node_id)
      VALUES($1,$2,'2348012345678',$3,1,'main_menu')`, [session, biz, flow]);
  });

  it('the capability_type enum has custom_flow and business_capabilities can store it', async () => {
    const labels = await db.query(`SELECT enumlabel FROM pg_enum WHERE enumtypid = 'capability_type'::regtype AND enumlabel = 'custom_flow'`);
    expect(labels.rows).toHaveLength(1);
    await db.query(`INSERT INTO business_capabilities(business_id, capability, is_enabled) VALUES($1,'custom_flow',true)`, [biz]);
    const stored = await db.query(`SELECT capability FROM business_capabilities WHERE business_id=$1`, [biz]);
    expect(stored.rows.map((r) => r.capability)).toContain('custom_flow');
  });

  it('final ACLs are exact despite production-like default privileges', async () => {
    const acl = async (t: string) => (await db.query(`SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) p
      FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee IN ('anon','authenticated','service_role','PUBLIC') GROUP BY grantee`, [t])).rows;
    expect(await acl('custom_flows')).toEqual([
      { grantee: 'authenticated', p: 'DELETE,INSERT,SELECT,UPDATE' },
      { grantee: 'service_role', p: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
    expect(await acl('custom_flow_tables')).toEqual([
      { grantee: 'authenticated', p: 'DELETE,INSERT,SELECT,UPDATE' },
      { grantee: 'service_role', p: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
    expect(await acl('custom_flow_table_rows')).toEqual([
      { grantee: 'authenticated', p: 'DELETE,INSERT,SELECT,UPDATE' },
      { grantee: 'service_role', p: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
    expect(await acl('custom_flow_sessions')).toEqual([
      { grantee: 'authenticated', p: 'SELECT' },
      { grantee: 'service_role', p: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
    expect(await acl('custom_flow_logs')).toEqual([
      { grantee: 'authenticated', p: 'SELECT' },
      { grantee: 'service_role', p: 'DELETE,INSERT,SELECT' },
    ]);
    const exec = async (role: string) => (await db.query(
      `SELECT has_function_privilege($1,'public.purge_custom_flow_logs(timestamptz)','EXECUTE') v`, [role])).rows[0].v;
    expect([await exec('anon'), await exec('authenticated'), await exec('service_role')]).toEqual([false, false, true]);
    await expect(roleQuery('anon', null, 'SELECT * FROM custom_flows')).rejects.toMatchObject({ code: '42501' });
  });

  it('an owner sees only their own flows; another owner sees none and cannot insert for the first business', async () => {
    const mine = await roleQuery('authenticated', owner, 'SELECT id FROM custom_flows');
    expect(mine.rows.map((r) => r.id)).toEqual([flow]);
    const theirs = await roleQuery('authenticated', otherOwner, 'SELECT id FROM custom_flows');
    expect(theirs.rows.map((r) => r.id)).toEqual([otherFlow]);
    await expect(roleQuery('authenticated', otherOwner,
      `INSERT INTO custom_flows(business_id, name) VALUES($1,'Sneaky')`, [biz]))
      .rejects.toMatchObject({ code: '42501' });
    const sessions = await roleQuery('authenticated', otherOwner, 'SELECT id FROM custom_flow_sessions');
    expect(sessions.rows).toEqual([]);
    const logs = await roleQuery('authenticated', otherOwner, 'SELECT id FROM custom_flow_logs');
    expect(logs.rows).toEqual([]);
  });

  it('composite FKs stop a tenant attaching rows to another tenant’s flow, table, or session', async () => {
    // A table for A's flow but under B's business (a different name, so the
    // (flow_id, name) unique constraint does not fire first).
    await expect(db.query(
      `INSERT INTO custom_flow_tables(business_id, flow_id, name) VALUES($1,$2,'sneaky')`, [otherBiz, flow]))
      .rejects.toMatchObject({ code: '23503' });
    // A row for A's table but under B's business.
    await expect(db.query(
      `INSERT INTO custom_flow_table_rows(table_id, business_id, row_code) VALUES($1,$2,'V009')`, [table, otherBiz]))
      .rejects.toMatchObject({ code: '23503' });
    // A session on A's flow but under B's business.
    await expect(db.query(
      `INSERT INTO custom_flow_sessions(business_id, whatsapp_number, flow_id, flow_version, current_node_id) VALUES($1,'2348099999999',$2,1,'main_menu')`, [otherBiz, flow]))
      .rejects.toMatchObject({ code: '23503' });
    // A log on A's flow but under B's business, and a log on A's session but under B's business.
    await expect(db.query(
      `INSERT INTO custom_flow_logs(business_id, flow_id, direction) VALUES($1,$2,'in')`, [otherBiz, flow]))
      .rejects.toMatchObject({ code: '23503' });
    await expect(db.query(
      `INSERT INTO custom_flow_logs(business_id, flow_id, session_id, direction) VALUES($1,$2,$3,'in')`, [otherBiz, flow, session]))
      .rejects.toMatchObject({ code: '23503' });
    // And the honest versions still work.
    await db.query(`INSERT INTO custom_flow_logs(business_id, flow_id, session_id, direction) VALUES($1,$2,$3,'in')`, [biz, flow, session]);
  });

  it('the entry-keyword guard rejects reserved and multi-word keywords', async () => {
    await expect(db.query(
      `INSERT INTO custom_flows(business_id, name, entry_keyword) VALUES($1,'Bad','STOP')`, [biz]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(db.query(
      `INSERT INTO custom_flows(business_id, name, entry_keyword) VALUES($1,'Bad','AFRO FEST')`, [biz]))
      .rejects.toMatchObject({ code: '23514' });
    // Reviewer B (non-blocking): the bot's own words are reserved too.
    await expect(db.query(
      `INSERT INTO custom_flows(business_id, name, entry_keyword) VALUES($1,'Bad','ORDER')`, [biz]))
      .rejects.toMatchObject({ code: '23514' });
    await db.query(`INSERT INTO custom_flows(business_id, name, entry_keyword) VALUES($1,'Good','AFROFEST2')`, [biz]);
  });

  it('deleting a session with log rows clears only session_id (business_id stays)', async () => {
    await db.query(`INSERT INTO custom_flow_logs(business_id, flow_id, session_id, direction)
      VALUES($1,$2,$3,'in')`, [biz, flow, session]);
    await db.query(`DELETE FROM custom_flow_sessions WHERE id=$1`, [session]);
    const sessions = await db.query(`SELECT id FROM custom_flow_sessions WHERE id=$1`, [session]);
    expect(sessions.rows).toEqual([]);
    const logs = await db.query(`SELECT session_id, business_id FROM custom_flow_logs`);
    expect(logs.rows).toEqual([{ session_id: null, business_id: biz }]);
  });

  it('purge_custom_flow_logs deletes only rows older than the cutoff and returns the count', async () => {
    await db.query(`INSERT INTO custom_flow_logs(business_id, flow_id, session_id, direction, created_at)
      VALUES($1,$2,$3,'in', now() - interval '100 days'),($1,$2,$3,'out', now())`, [biz, flow, session]);
    // The purge runs as service_role (SET LOCAL ROLE), not as superuser:
    // as superuser the DELETE would succeed even without the grant, so the
    // missing-grant failure the re-review found would stay hidden.
    let committed = false;
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE service_role');
      const purged = await db.query(`SELECT public.purge_custom_flow_logs(now() - interval '90 days') n`);
      const remaining = await db.query(`SELECT direction FROM custom_flow_logs ORDER BY created_at`);
      await db.query('COMMIT');
      committed = true;
      expect(purged.rows[0].n).toBe(1);
      expect(remaining.rows.map((r) => r.direction)).toEqual(['out']);
    } finally {
      if (!committed) await db.query('ROLLBACK').catch(() => {});
    }
    // A merchant cannot run the purge: EXECUTE is service_role only.
    await expect(roleQuery('authenticated', owner, `SELECT public.purge_custom_flow_logs(now())`))
      .rejects.toMatchObject({ code: '42501' });
  });
});
