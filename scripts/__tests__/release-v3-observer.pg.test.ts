/**
 * Release V3 read-only observer — real PostgreSQL proof (disposable database).
 * Applies scripts/release-v3/release-observer-role.sql, then connects AS
 * release_observer and proves:
 *  - the gate's observation runs and parses (forced read-only, unprivileged);
 *  - the JS catalog aggregate equals the reviewer SQL recipe (string_agg);
 *  - the login cannot write, even after turning read-only off, and can read
 *    only the migration ledger, not app tables.
 * Runs in CI's "Catalog oracle (PostgreSQL 17)" job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUARD_BODY_SHA256 } from '../release-v3/db-observe.mjs';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { OBSERVATION_SQL, parseObservation } from '../release-v3/db-observe.mjs';
import { catalogAggregate, CATALOG_QUERY } from '../release-v3/catalog-oracle.mjs';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the release_observer proof');
const parsed = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Disposable local PostgreSQL required');
const major = Number(process.env.RELEASE_V3_TEST_PG_MAJOR || 17);
const database = `v3obs_${randomUUID().replaceAll('-', '')}`;
const password = `test-only-${randomUUID()}`;
let admin: pg.Client, db: pg.Client, observer: pg.Client;

function asObserver(sql: string): string {
  return execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGUSER: 'release_observer', PGPASSWORD: password, PGDATABASE: database } });
}
async function denied(sql: string) {
  try { await observer.query(sql); return null; } catch (e) { return (e as Error).message; } finally { await observer.query('ROLLBACK').catch(() => {}); }
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  // Roles are cluster-wide: clear a leftover from an earlier local run.
  const exists = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname='release_observer'`);
  if (exists.rowCount) { await admin.query('DROP OWNED BY release_observer'); await admin.query('DROP ROLE release_observer'); }
  const u = new URL(url); u.pathname = `/${database}`;
  db = new pg.Client({ connectionString: u.toString() }); await db.connect();
  await db.query(`CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text, created_by text, idempotency_key text, rollback text[]);
    INSERT INTO supabase_migrations.schema_migrations VALUES ('20261103223154', ARRAY['select 1'], '508_business_control_columns_guard', NULL, NULL, NULL), ('1', NULL, 'legacy', NULL, NULL, NULL);
    CREATE TABLE public.secrets(id int PRIMARY KEY, v text); INSERT INTO public.secrets VALUES (1, 'x');
    CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`);
  await db.query(readFileSync('scripts/release-v3/release-observer-role.sql', 'utf8'));
  await db.query(`ALTER ROLE release_observer PASSWORD '${password}'`);
  observer = new pg.Client({ host: parsed.hostname, port: Number(parsed.port || 5432), user: 'release_observer', password, database }); await observer.connect();
});
afterAll(async () => {
  await observer?.end(); await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query('DROP OWNED BY release_observer').catch(() => {}); await admin.query('DROP ROLE IF EXISTS release_observer').catch(() => {});
  await admin.end();
});

describe('release_observer role (release-observer-role.sql)', () => {
  it('runs the gate observation as a forced read-only, unprivileged session', () => {
    const observation = parseObservation(asObserver(OBSERVATION_SQL), { major });
    expect(observation.ledger.map((r: { name: string }) => r.name)).toEqual(['legacy', '508_business_control_columns_guard']);
    // sha256('select 1'): the stored single statement's exact bytes.
    expect(observation.ledger[1]).toMatchObject({ statement_count: 1, statement_sha256: '822ae07d4783158bc1912bb623e5107cc9002d519e1143a9c200ed6ee18b6d0f' });
    expect(observation.ledger[0]).toMatchObject({ statement_count: null, statement_sha256: null });
    expect(observation.catalog.has('table:public.secrets')).toBe(true);
    expect(observation.catalog.has('function:public.f()')).toBe(true);
  });
  it('the JS aggregate equals the SQL recipe reviewers run through the connector', async () => {
    const observation = parseObservation(asObserver(OBSERVATION_SQL), { major });
    const body = CATALOG_QUERY.split('\n').filter(l => !l.startsWith('--')).join('\n').trim().replace(/;$/, '');
    const sql = await db.query(`SELECT count(*)::int AS n, encode(sha256(convert_to(string_agg(identity||E'\\t'||digest||E'\\n','' ORDER BY identity COLLATE "C"),'UTF8')),'hex') AS agg FROM (${body}) q`);
    expect(observation.catalog.size).toBe(sql.rows[0].n);
    expect(catalogAggregate(observation.catalog)).toBe(sql.rows[0].agg);
  });
  it('cannot write, even after turning read-only off', async () => {
    expect(await denied(`INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('x')`)).toMatch(/read-only transaction/);
    expect(await denied(`BEGIN READ WRITE; INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('x')`)).toMatch(/permission denied/);
    expect(await denied(`BEGIN READ WRITE; CREATE TABLE public.x(i int)`)).toMatch(/permission denied/);
    expect(await denied(`BEGIN READ WRITE; UPDATE public.secrets SET v='y'`)).toMatch(/permission denied/);
  });
  it('reads the ledger but not app tables', async () => {
    expect((await observer.query('SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations')).rows[0].n).toBe(2);
    expect(await denied('SELECT * FROM public.secrets')).toMatch(/permission denied/);
  });
  it('has the forced settings and no elevated attributes', async () => {
    const r = await observer.query(`SELECT current_setting('default_transaction_read_only') ro, current_setting('statement_timeout') st, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, rolconnlimit FROM pg_roles WHERE rolname=current_user`);
    expect(r.rows[0]).toEqual({ ro: 'on', st: '1min', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false, rolconnlimit: 3 });
  });
  it('refuses to run twice (an existing role must be reviewed, not overwritten)', async () => {
    await expect(db.query(readFileSync('scripts/release-v3/release-observer-role.sql', 'utf8'))).rejects.toThrow('already exists');
  });
});

// Replica-only login guard (release-observer-replica-guard.sql). Login event
// triggers exist from PostgreSQL 17; CI runs 17, so this always runs there.
// A disposable server is never a replica, so the guard must REFUSE the login.
describe.runIf(major >= 17)('replica-only login guard (release-observer-replica-guard.sql)', () => {
  const guardDb = `${database}_guard`;
  let guarded: pg.Client;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${guardDb}`);
    const u = new URL(url!); u.pathname = `/${guardDb}`;
    guarded = new pg.Client({ connectionString: u.toString() }); await guarded.connect();
    await guarded.query(readFileSync('scripts/release-v3/release-observer-replica-guard.sql', 'utf8'));
  });
  afterAll(async () => { await guarded?.end(); await admin.query(`DROP DATABASE IF EXISTS ${guardDb} WITH (FORCE)`); });

  it('refuses release_observer on a server that is not a replica', async () => {
    const c = new pg.Client({ host: parsed.hostname, port: Number(parsed.port || 5432), user: 'release_observer', password, database: guardDb });
    await expect(c.connect()).rejects.toThrow('release_observer may only connect to a read replica');
    await c.end().catch(() => {});
  });
  it('leaves every other login alone', async () => {
    const u = new URL(url!); u.pathname = `/${guardDb}`;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    expect((await c.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    await c.end();
  });
  it('the installed guard is enabled, on login, with exactly the body the gate pins', async () => {
    const r = await guarded.query(`SELECT t.evtenabled AS enabled, t.evtevent AS event, encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') AS body
      FROM pg_event_trigger t JOIN pg_proc p ON p.oid = t.evtfoid JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE t.evtname = 'release_observer_replica_only' AND n.nspname = 'release_ops'`);
    expect(r.rows).toEqual([{ enabled: 'O', event: 'login', body: GUARD_BODY_SHA256 }]);
  });
  it('the guard function is not executable by PUBLIC and the schema is closed', async () => {
    const r = await guarded.query(`SELECT has_function_privilege('release_observer', 'release_ops.release_observer_replica_only()', 'EXECUTE') AS fn,
      has_schema_privilege('release_observer', 'release_ops', 'USAGE') AS sch`);
    expect(r.rows[0]).toEqual({ fn: false, sch: false });
  });
});
