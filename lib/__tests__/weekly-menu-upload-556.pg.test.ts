/**
 * M556 — "Upload this week's menu" (Owner decisions 2026-11-23).
 * Real PostgreSQL proof (disposable local database, created and dropped by this file).
 *
 * The fixture is the part of public.products / public.businesses M556 uses,
 * with Supabase-like roles. M555 and M556 are applied from disk, each as one
 * whole-file statement, as they will be hosted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M556 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m555 = readFileSync('supabase/migrations/555_product_day_availability.sql', 'utf8');
const m556 = readFileSync('supabase/migrations/556_weekly_menu_upload.sql', 'utf8');
const database = `m556_${randomUUID().replaceAll('-', '')}`;
const BIZ = randomUUID();
const OTHER = randomUUID();
const THIS_MONDAY = '2026-11-23';
const LAST_MONDAY = '2026-11-16';

type DbError = { code?: string; message?: string };

suite('M556 weekly menu upload (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  let targetUrl: string;
  const q = (text: string, params?: unknown[]) => client.query(text, params);
  async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
    try { await fn(); } catch (err) { return err as DbError; }
    return {};
  }
  const asService = async <T>(fn: () => Promise<T>): Promise<T> => {
    await q('SET ROLE service_role');
    try { return await fn(); } finally { await q('RESET ROLE'); }
  };
  const save = (biz: string, week: string, items: unknown) =>
    asService(async () => (await q(`SELECT public.save_weekly_menu($1, $2::date, $3::jsonb) AS r`, [biz, week, JSON.stringify(items)])).rows[0].r);
  const consume = (biz: string, day: string, limit: number) =>
    asService(async () => (await q(`SELECT public.consume_menu_photo_read($1, $2::date, $3) AS n`, [biz, day, limit])).rows[0].n);
  const product = async (name: string) =>
    (await q(`SELECT id, price::float AS price, is_active, available_days, available_from::text AS available_from,
                     available_until::text AS available_until, weekly_menu_week::text AS weekly_menu_week, deleted_at
              FROM public.products WHERE business_id = $1 AND name = $2 ORDER BY deleted_at NULLS FIRST`, [BIZ, name])).rows;
  const insertProduct = async (name: string, extra: Record<string, unknown> = {}) => {
    const cols = ['business_id', 'name', 'price', ...Object.keys(extra)];
    const vals = [BIZ, name, 1000, ...Object.values(extra)];
    return (await q(`INSERT INTO public.products (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals)).rows[0].id as string;
  };

  let riceBowl: string;
  let lastSalmon: string;
  let lastBass: string;

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    targetUrl = target.toString();
    client = new pg.Client({ connectionString: targetUrl }); await client.connect();
    await q(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      -- Supabase-like default privileges, so the migration's REVOKEs are what keep the new objects closed.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      CREATE TABLE public.businesses (id UUID PRIMARY KEY);
      CREATE TABLE public.products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        price NUMERIC NOT NULL,
        category VARCHAR(100),
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        deleted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
    `);
    await q(`INSERT INTO public.businesses (id) VALUES ($1), ($2)`, [BIZ, OTHER]);
    await q(m555);
    riceBowl = await insertProduct('Rice bowl');
    lastSalmon = await insertProduct('Salmon', { available_days: '{2}', available_from: LAST_MONDAY, available_until: '2026-11-22' });
    await q(m556);
    // Last week's weekly-menu dishes (column exists from here on).
    await q(`UPDATE public.products SET weekly_menu_week = $1 WHERE id = $2`, [LAST_MONDAY, lastSalmon]);
    lastBass = await insertProduct('Bass fish', { weekly_menu_week: LAST_MONDAY, available_days: '{3}', available_from: LAST_MONDAY, available_until: '2026-11-22' });
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('existing items stay ordinary (weekly_menu_week NULL); the column only accepts a Monday', async () => {
    expect((await product('Rice bowl'))[0].weekly_menu_week).toBeNull();
    const err = await errorOf(() => q(`UPDATE public.products SET weekly_menu_week = '2026-11-24' WHERE id = $1`, [riceBowl]));
    expect(err.code).toBe('23514');
  });

  it('menu_photo_reads: RLS on, no policy, closed to anon/authenticated, open to service_role', async () => {
    const t = (await q(`SELECT relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS policies
                        FROM pg_class c WHERE oid = 'public.menu_photo_reads'::regclass`)).rows[0];
    expect(t).toEqual({ rls: true, policies: 0 });
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect((await q(`SELECT has_table_privilege($1, 'public.menu_photo_reads', $2) AS ok`, [role, priv])).rows[0].ok).toBe(false);
      }
    }
    expect((await q(`SELECT has_table_privilege('service_role', 'public.menu_photo_reads', 'INSERT') AS ok`)).rows[0].ok).toBe(true);
  });

  it('both functions: SECURITY INVOKER, empty search_path, EXECUTE for service_role only', async () => {
    const rows = (await q(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('consume_menu_photo_read', 'save_weekly_menu') ORDER BY p.proname`)).rows;
    expect(rows).toEqual([
      { proname: 'consume_menu_photo_read', prosecdef: false, proconfig: ['search_path=""'], anon: false, auth: false, service: true, public_exec: false },
      { proname: 'save_weekly_menu', prosecdef: false, proconfig: ['search_path=""'], anon: false, auth: false, service: true, public_exec: false },
    ]);
    await q('SET ROLE authenticated');
    const denied = await errorOf(() => q(`SELECT public.consume_menu_photo_read($1, '2026-11-23', 5)`, [BIZ]));
    await q('RESET ROLE');
    expect(denied.code).toBe('42501');
  });

  it('daily reads: counts up to the limit, then NULL; a new day and another business start fresh', async () => {
    expect(await consume(BIZ, '2026-11-23', 2)).toBe(1);
    expect(await consume(BIZ, '2026-11-23', 2)).toBe(2);
    expect(await consume(BIZ, '2026-11-23', 2)).toBeNull();
    expect((await q(`SELECT read_count FROM public.menu_photo_reads WHERE business_id = $1 AND read_date = '2026-11-23'`, [BIZ])).rows[0].read_count).toBe(2);
    expect(await consume(BIZ, '2026-11-24', 2)).toBe(1);
    expect(await consume(OTHER, '2026-11-23', 1)).toBe(1);
    expect(await consume(OTHER, '2026-11-23', 1)).toBeNull();
    expect(await consume(OTHER, '2026-11-30', 0)).toBeNull();
    expect((await q(`SELECT count(*)::int AS n FROM public.menu_photo_reads WHERE business_id = $1 AND read_date = '2026-11-30'`, [OTHER])).rows[0].n).toBe(0);
  });

  it('daily reads: 12 reads at once with a limit of 5 → exactly 5 counted', async () => {
    const pool = new pg.Pool({ connectionString: targetUrl, max: 12 });
    try {
      const results = await Promise.all(Array.from({ length: 12 }, async () => {
        const c = await pool.connect();
        try {
          await c.query('SET ROLE service_role');
          return (await c.query(`SELECT public.consume_menu_photo_read($1, '2026-12-01', 5) AS n`, [BIZ])).rows[0].n;
        } finally { c.release(); }
      }));
      expect(results.filter(n => n !== null).sort()).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await pool.end();
    }
  });

  it('save: adds new dishes, brings back a weekly dish by name, skips ordinary items, hides last week (not deleted)', async () => {
    const result = await save(BIZ, THIS_MONDAY, [
      { name: 'Salmon', price: 5000, days: [2] },
      { name: 'Rice platter', price: 4000, days: [1], category: 'Mains' },
      { name: 'rice bowl ', price: 1, days: [] },
      { name: 'Jollof', price: 2500, days: [] },
      { name: 'Wings', price: 3000, days: [1, 2, 3, 4, 5, 6, 7] },
    ]);
    expect(result).toEqual({ created: 3, updated: 1, hidden: 1, skipped: ['rice bowl'] });

    const [salmon] = await product('Salmon');
    expect(salmon).toMatchObject({ id: lastSalmon, price: 5000, is_active: true, available_days: [2], available_from: THIS_MONDAY, available_until: '2026-11-29', weekly_menu_week: THIS_MONDAY });
    const [platter] = await product('Rice platter');
    expect(platter).toMatchObject({ available_days: [1], available_from: THIS_MONDAY, available_until: '2026-11-29', weekly_menu_week: THIS_MONDAY, is_active: true });
    expect((await product('Jollof'))[0].available_days).toBeNull();
    expect((await product('Wings'))[0].available_days).toBeNull();

    const [bowl] = await product('Rice bowl');
    expect(bowl).toMatchObject({ id: riceBowl, price: 1000, is_active: true, available_days: null, available_from: null, weekly_menu_week: null });
    const [bass] = await product('Bass fish');
    expect(bass).toMatchObject({ id: lastBass, is_active: false, weekly_menu_week: LAST_MONDAY, deleted_at: null });
  });

  it('save again the same week: replaces only that week\'s dishes (hidden), reuses the same rows', async () => {
    const jollofId = (await product('Jollof'))[0].id;
    const result = await save(BIZ, THIS_MONDAY, [{ name: 'Jollof', price: 2600, days: [5] }]);
    expect(result).toEqual({ created: 0, updated: 1, hidden: 3, skipped: [] });
    expect((await product('Jollof'))[0]).toMatchObject({ id: jollofId, price: 2600, available_days: [5], is_active: true });
    for (const name of ['Salmon', 'Rice platter', 'Wings']) expect((await product(name))[0].is_active).toBe(false);
    expect((await product('Rice bowl'))[0].is_active).toBe(true);
  });

  it('a deleted weekly dish is never brought back; a new row is added instead', async () => {
    await q(`UPDATE public.products SET deleted_at = now() WHERE id = $1`, [lastBass]);
    const result = await save(BIZ, THIS_MONDAY, [{ name: 'Bass fish', price: 7000, days: [3] }, { name: 'Jollof', price: 2600, days: [5] }]);
    expect(result).toMatchObject({ created: 1, updated: 1 });
    const rows = await product('Bass fish');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ is_active: true, deleted_at: null, weekly_menu_week: THIS_MONDAY });
    expect(rows[0].id).not.toBe(lastBass);
  });

  it('refuses bad input and changes nothing (one transaction)', async () => {
    const before = (await q(`SELECT count(*)::int AS n, sum(is_active::int)::int AS active FROM public.products WHERE business_id = $1`, [BIZ])).rows[0];
    expect((await errorOf(() => save(BIZ, '2026-11-24', [{ name: 'Okra', price: 1 }]))).code).toBe('22023');
    expect((await errorOf(() => save(BIZ, THIS_MONDAY, [{ name: 'Okra', price: 1 }, { name: 'OKRA', price: 1 }]))).code).toBe('22023');
    expect((await errorOf(() => save(BIZ, THIS_MONDAY, [{ name: 'Okra', price: 1 }, { name: 'Egusi', price: null }]))).code).toBe('22023');
    expect((await errorOf(() => save(BIZ, THIS_MONDAY, [{ name: 'Okra', price: 1, days: [8] }]))).code).toBe('23514');
    expect((await errorOf(() => save(BIZ, THIS_MONDAY, []))).code).toBe('22023');
    expect((await errorOf(() => save(randomUUID(), THIS_MONDAY, [{ name: 'Okra', price: 1 }]))).code).toBe('P0002');
    const after = (await q(`SELECT count(*)::int AS n, sum(is_active::int)::int AS active FROM public.products WHERE business_id = $1`, [BIZ])).rows[0];
    expect(after).toEqual(before);
    expect(await product('Okra')).toHaveLength(0);
  });

  it('applies a second time without error or change (idempotent)', async () => {
    const count = async () => (await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'products_weekly_menu_week_monday'`)).rows[0].n;
    await q(m556);
    expect(await count()).toBe(1);
    expect((await q(`SELECT has_function_privilege('authenticated', 'public.save_weekly_menu(uuid, date, jsonb)', 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
  });

  it('an ordinary item that is switched off or limited to some days is skipped and left exactly as it is', async () => {
    const egusi = await insertProduct('Egusi', { is_active: false, available_days: '{5}' });
    const result = await save(BIZ, THIS_MONDAY, [{ name: 'Egusi', price: 9, days: [3] }, { name: 'Jollof', price: 2600, days: [5] }]);
    expect(result.skipped).toEqual(['Egusi']);
    expect((await product('Egusi'))[0]).toMatchObject({ id: egusi, price: 1000, is_active: false, available_days: [5], weekly_menu_week: null });
  });

  it('only touches the given business', async () => {
    await q(`INSERT INTO public.products (business_id, name, price, weekly_menu_week) VALUES ($1, 'Other dish', 10, $2)`, [OTHER, LAST_MONDAY]);
    await save(BIZ, THIS_MONDAY, [{ name: 'Jollof', price: 2600, days: [5] }]);
    expect((await q(`SELECT is_active FROM public.products WHERE business_id = $1`, [OTHER])).rows[0].is_active).toBe(true);
  });
});
