/**
 * Release V3 catalog scope (#929) — real PostgreSQL proof (disposable database).
 *
 * catalog-v3.sql now:
 *  - reads the schema public_view_private (M523);
 *  - records a relation's reloptions (e.g. security_invoker) when set;
 *  - hashes a BEGIN ATOMIC function body (empty prosrc) from
 *    pg_get_function_sqlbody.
 * Objects with neither keep their earlier digest format.
 *
 * Proves, on the real M523 file over the M293 views:
 *  - the new objects and options are observed;
 *  - every relevant change to them changes exactly the expected digest, so
 *    the gate's lock + deltas comparison fails on it;
 *  - the lock translation recorded in lock.json (two M293 views per
 *    environment) re-hashes to the committed lock-map digests.
 * Runs in CI's "Catalog oracle (PostgreSQL 17)" job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { CATALOG_QUERY, catalogMap, compareCatalogs } from '../release-v3/catalog-oracle.mjs';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the catalog scope proof');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const database = `v3scope_${randomUUID().replaceAll('-', '')}`;
const m523 = readFileSync('supabase/migrations/523_public_views_security_invoker.sql', 'utf8');
const lock = JSON.parse(readFileSync('scripts/release-v3/lock.json', 'utf8'));
const lockMaps = {
  production: JSON.parse(readFileSync('scripts/release-v3/lock-catalog-production.json', 'utf8')),
  staging: JSON.parse(readFileSync('scripts/release-v3/lock-catalog-staging.json', 'utf8')),
};
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const BIZ = 'table:public.businesses_public';
const CH = 'table:public.whatsapp_channels_public';
const FN_B = 'function:public_view_private.businesses_public_rows()';
const FN_C = 'function:public_view_private.whatsapp_channels_public_rows()';
const SCHEMA = 'schema:public_view_private';

let admin: pg.Client, db: pg.Client;
type Row = { identity: string; digest: string; value: Record<string, unknown> };

async function readCatalog(): Promise<Row[]> {
  return (await db.query(CATALOG_QUERY)).rows as Row[];
}
/** Identities whose digest differs after `change` (run in a rolled-back transaction). */
async function driftAfter(change: string): Promise<string[]> {
  const before = catalogMap(await readCatalog());
  await db.query('BEGIN');
  try {
    await db.query(change);
    return compareCatalogs(before, catalogMap(await readCatalog()));
  } finally {
    await db.query('ROLLBACK');
  }
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$`);
  await admin.query(`CREATE DATABASE ${database}`);
  const u = new URL(url); u.pathname = `/${database}`;
  db = new pg.Client({ connectionString: u.toString() }); await db.connect();
  // The M293 state M523 builds on (columns the views read, plus one secret column).
  await db.query(`
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE TYPE public.restaurant_status AS ENUM ('pending', 'active', 'suspended');
    CREATE TYPE public.business_category AS ENUM ('other');
    CREATE TYPE public.flow_type AS ENUM ('scheduling');
    CREATE TABLE public.businesses (id uuid PRIMARY KEY, name varchar(200), slug varchar(200), description text, address text,
      city varchar(50), state varchar(100), country_code varchar(2), phone varchar(20), email varchar(255), logo_url text,
      cover_photo_url text, category public.business_category, flow_type public.flow_type, operating_hours jsonb,
      rating_avg numeric(2,1), rating_count integer, total_bookings integer, instagram_handle varchar(100), timezone varchar(50),
      recurring_enabled boolean, bot_code varchar(30), status public.restaurant_status, created_at timestamptz, updated_at timestamptz,
      payment_channels jsonb);
    CREATE TABLE public.whatsapp_channels (id uuid PRIMARY KEY, country_code varchar(2), phone_number varchar(20),
      display_name varchar(128), channel_type varchar(10), is_active boolean, meta_access_token text);
    ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.whatsapp_channels ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.businesses, public.whatsapp_channels FROM PUBLIC, anon;
    CREATE VIEW public.businesses_public WITH (security_barrier = true) AS
      SELECT id, name, slug, description, address, city, state, country_code, phone, email, logo_url, cover_photo_url, category,
        flow_type, operating_hours, rating_avg, rating_count, total_bookings, instagram_handle, timezone, recurring_enabled,
        bot_code, status, created_at, updated_at FROM public.businesses WHERE status = 'active';
    CREATE VIEW public.whatsapp_channels_public WITH (security_barrier = true) AS
      SELECT id, country_code, phone_number, display_name, channel_type, is_active FROM public.whatsapp_channels
      WHERE channel_type = 'shared' AND is_active = true;
    REVOKE ALL ON public.businesses_public, public.whatsapp_channels_public FROM PUBLIC;
    GRANT SELECT ON public.businesses_public, public.whatsapp_channels_public TO anon, authenticated, service_role;
    CREATE TABLE public.plain_table (id int PRIMARY KEY);
    CREATE FUNCTION public.plain_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
  `);
});
afterAll(async () => {
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});

describe('catalog-v3.sql scope for M523 (#929)', () => {
  it('before M523 the views carry only security_barrier and the schema is not read', async () => {
    const rows = await readCatalog();
    const byId = new Map(rows.map(r => [r.identity, r]));
    expect(byId.get(BIZ)?.value.options).toEqual(['security_barrier=true']);
    expect(byId.get(CH)?.value.options).toEqual(['security_barrier=true']);
    expect(byId.has(SCHEMA)).toBe(false);
  });

  it('after M523 it reads the schema, both functions and the views\' security_invoker option', async () => {
    await db.query(m523);
    const rows = await readCatalog();
    const byId = new Map(rows.map(r => [r.identity, r]));
    for (const id of [BIZ, CH]) expect(byId.get(id)?.value.options).toEqual(['security_barrier=true', 'security_invoker=true']);
    expect(byId.get(SCHEMA)?.value.acl).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantee: 'anon', privilege: 'USAGE' }),
      expect.objectContaining({ grantee: 'authenticated', privilege: 'USAGE' }),
      expect.objectContaining({ grantee: 'service_role', privilege: 'USAGE' }),
    ]));
    for (const id of [FN_B, FN_C]) {
      const value = byId.get(id)?.value as Record<string, unknown>;
      expect(value).toMatchObject({ definer: true, volatility: 's', config: ['search_path=""'] });
      // BEGIN ATOMIC: prosrc is empty, so the body hash must come from the parsed body, not sha256('').
      expect(value.body_sha256).not.toBe(sha(''));
      const grantees = (value.acl as { grantee: string; privilege: string }[]).filter(a => a.privilege === 'EXECUTE').map(a => a.grantee);
      expect(grantees).not.toContain('PUBLIC');
      expect(grantees).toEqual(expect.arrayContaining(['anon', 'authenticated', 'service_role', 'pg_read_all_data']));
    }
  });

  it('objects without options or a BEGIN ATOMIC body keep the earlier value format', async () => {
    const byId = new Map((await readCatalog()).map(r => [r.identity, r]));
    expect(Object.keys(byId.get('table:public.plain_table')!.value).sort()).toEqual(['acl', 'force_rls', 'kind', 'owner', 'rls', 'view']);
    const fn = byId.get('function:public.plain_fn()')!.value;
    expect(fn.body_sha256).toBe(sha(' SELECT 1 '));
  });

  it.each([
    ['security_invoker reset on a view', 'ALTER VIEW public.businesses_public RESET (security_invoker)', [BIZ]],
    ['security_barrier turned off', 'ALTER VIEW public.whatsapp_channels_public SET (security_barrier = false)', [CH]],
    ['function opened to PUBLIC', `GRANT EXECUTE ON FUNCTION public_view_private.businesses_public_rows() TO PUBLIC`, [FN_B]],
    ['function EXECUTE revoked', `REVOKE EXECUTE ON FUNCTION public_view_private.whatsapp_channels_public_rows() FROM pg_read_all_data`, [FN_C]],
    ['function search_path changed', `ALTER FUNCTION public_view_private.businesses_public_rows() SET search_path = public`, [FN_B]],
    ['BEGIN ATOMIC body changed', `CREATE OR REPLACE FUNCTION public_view_private.whatsapp_channels_public_rows()
      RETURNS TABLE (id uuid, country_code varchar, phone_number varchar, display_name varchar, channel_type varchar, is_active boolean)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' BEGIN ATOMIC
        SELECT c.id, c.country_code, c.phone_number, c.display_name, c.channel_type, c.is_active
        FROM public.whatsapp_channels c WHERE c.is_active = true; END`, [FN_C]],
    ['schema CREATE granted to anon', 'GRANT CREATE ON SCHEMA public_view_private TO anon', [SCHEMA]],
    ['new function added to the schema', `CREATE FUNCTION public_view_private.extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
      ['function:public_view_private.extra()']],
  ])('the gate sees drift: %s', async (_name, change, expected) => {
    expect(await driftAfter(change)).toEqual(expected);
  });

  it('the lock translation (lock.json observed.catalog_query_rebase_929) re-hashes to the committed lock maps', async () => {
    const rebase = lock.observed.catalog_query_rebase_929;
    // Live definitions of the M293 views in the lock state (pg_get_viewdef(oid, true), read-only).
    const defs: Record<string, string> = {
      [BIZ]: ' SELECT id,\n    name,\n    slug,\n    description,\n    address,\n    city,\n    state,\n    country_code,\n    phone,\n    email,\n    logo_url,\n    cover_photo_url,\n    category,\n    flow_type,\n    operating_hours,\n    rating_avg,\n    rating_count,\n    total_bookings,\n    instagram_handle,\n    timezone,\n    recurring_enabled,\n    bot_code,\n    status,\n    created_at,\n    updated_at\n   FROM businesses\n  WHERE status = \'active\'::restaurant_status;',
      [CH]: ' SELECT id,\n    country_code,\n    phone_number,\n    display_name,\n    channel_type,\n    is_active\n   FROM whatsapp_channels\n  WHERE channel_type::text = \'shared\'::text AND is_active = true;',
    };
    // Production views carried the PostgreSQL 17 MAINTAIN bit for the API roles; staging did not.
    const owner = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'].map(p => ['postgres', p]);
    const api = (privs: string[]) => ['anon', 'authenticated', 'service_role'].flatMap(g => privs.map(p => [g, p]));
    const acls: Record<string, string[][]> = { production: [...api(['MAINTAIN', 'SELECT']), ...owner], staging: [...api(['SELECT']), ...owner] };
    for (const env of ['production', 'staging'] as const) {
      for (const id of [BIZ, CH]) {
        const acl = acls[env].sort((a, b) => (a[0] + '\u0000' + a[1] < b[0] + '\u0000' + b[1] ? -1 : 1))
          .map(([grantee, privilege]) => ({ grantee, grantor: 'postgres', privilege, grantable: false }));
        const r = await db.query(`SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex') AS old_digest,
            encode(sha256(convert_to((v || '{"options":["security_barrier=true"]}'::jsonb)::text,'UTF8')),'hex') AS new_digest
          FROM (SELECT jsonb_build_object('kind','v','owner','postgres','rls',false,'force_rls',false,
            'view',encode(sha256(convert_to($1::text,'UTF8')),'hex'),'acl',$2::jsonb) AS v) s`, [defs[id], JSON.stringify(acl)]);
        expect(r.rows[0].old_digest, `${env} ${id} old`).toBe(rebase.environments[env].changed[id].previous_digest);
        expect(r.rows[0].new_digest, `${env} ${id} new`).toBe(rebase.environments[env].changed[id].new_digest);
        expect(lockMaps[env].objects[id]).toBe(r.rows[0].new_digest);
      }
    }
  });
});
