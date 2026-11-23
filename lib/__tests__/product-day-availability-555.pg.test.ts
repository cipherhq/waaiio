/**
 * M555 — products.available_days / available_from / available_until
 * (Owner decision 2026-11-23, weekly menus).
 * Real PostgreSQL proof (disposable local database, created and dropped by this file).
 *
 * The fixture is the part of public.products M555 touches: id, business_id,
 * name, is_active, RLS on, an owner policy and a table grant to authenticated.
 * M555 is applied from disk as one whole-file statement, as it will be hosted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M555 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m555 = readFileSync('supabase/migrations/555_product_day_availability.sql', 'utf8');
const database = `m555_${randomUUID().replaceAll('-', '')}`;
const BIZ = randomUUID();

type DbError = { code?: string; message?: string };

suite('M555 product day availability (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);
  async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
    try { await fn(); } catch (err) { return err as DbError; }
    return {};
  }
  const snapshot = async () => (await q(`
      SELECT c.relacl::text AS acl, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS policies,
             (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) AS triggers,
             (SELECT json_agg(conname::text ORDER BY conname) FROM pg_constraint WHERE conrelid = c.oid) AS constraints
      FROM pg_class c WHERE c.oid = 'public.products'::regclass`)).rows[0];

  let before: Record<string, unknown>;
  let existingId: string;

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
    await q(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
      CREATE TABLE public.products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true
      );
      ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "fixture owner" ON public.products FOR ALL USING (true);
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
    `);
    existingId = (await q(`INSERT INTO public.products (business_id, name) VALUES ($1, 'Rice bowl') RETURNING id`, [BIZ])).rows[0].id;
    before = await snapshot();
    await q(m555);
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('existing items keep every day, no dates (NULL in all three columns)', async () => {
    const row = (await q(`SELECT available_days, available_from, available_until FROM public.products WHERE id = $1`, [existingId])).rows[0];
    expect(row).toEqual({ available_days: null, available_from: null, available_until: null });
  });

  it('columns are nullable smallint[] and date with no default', async () => {
    const cols = (await q(`
      SELECT a.attname, a.attnotnull, format_type(a.atttypid, a.atttypmod) AS type, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.products'::regclass AND a.attname IN ('available_days','available_from','available_until')
      ORDER BY a.attname`)).rows;
    expect(cols).toEqual([
      { attname: 'available_days', attnotnull: false, type: 'smallint[]', def: null },
      { attname: 'available_from', attnotnull: false, type: 'date', def: null },
      { attname: 'available_until', attnotnull: false, type: 'date', def: null },
    ]);
  });

  it('accepts weekdays 1..7, an empty list, and from <= until', async () => {
    const ok = await q(`INSERT INTO public.products (business_id, name, available_days, available_from, available_until)
                        VALUES ($1, 'Salmon', '{2}', '2026-11-23', '2026-11-29') RETURNING available_days`, [BIZ]);
    expect(ok.rows[0].available_days).toEqual([2]);
    await q(`UPDATE public.products SET available_days = '{1,2,3,4,5,6,7}' WHERE id = $1`, [existingId]);
    await q(`UPDATE public.products SET available_days = '{}' WHERE id = $1`, [existingId]);
    await q(`UPDATE public.products SET available_from = '2026-11-24', available_until = '2026-11-24' WHERE id = $1`, [existingId]);
  });

  it('refuses a weekday outside 1..7 or a NULL weekday', async () => {
    for (const days of ['{0}', '{8}', '{1,-1}', '{NULL}']) {
      expect((await errorOf(() => q(`UPDATE public.products SET available_days = $1 WHERE id = $2`, [days, existingId]))).code).toBe('23514');
    }
  });

  it('refuses from after until', async () => {
    expect((await errorOf(() => q(`UPDATE public.products SET available_from = '2026-11-30', available_until = '2026-11-23' WHERE id = $1`, [existingId]))).code).toBe('23514');
  });

  it('changes no grant, RLS, policy or trigger; adds only the two constraints', async () => {
    const after = await snapshot();
    expect(after.acl).toBe(before.acl);
    expect(after.rls).toBe(true);
    expect(after.policies).toBe(before.policies);
    expect(after.triggers).toBe(before.triggers);
    expect(after.constraints).toEqual(
      [...(before.constraints as string[]), 'products_available_dates_order', 'products_available_days_valid'].sort(),
    );
    const colAcl = (await q(`SELECT attname, attacl FROM pg_attribute WHERE attrelid = 'public.products'::regclass AND attname LIKE 'available_%'`)).rows;
    for (const c of colAcl) expect(c.attacl).toBeNull();
  });

  it('is idempotent: a re-run changes nothing', async () => {
    const rows = (await q(`SELECT * FROM public.products ORDER BY id`)).rows;
    const shape = await snapshot();
    await q(m555);
    expect((await q(`SELECT * FROM public.products ORDER BY id`)).rows).toEqual(rows);
    expect(await snapshot()).toEqual(shape);
  });
});
