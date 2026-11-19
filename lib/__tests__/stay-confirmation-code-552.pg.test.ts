/**
 * M552 — reservations.confirmation_code, the secret code behind /stays/[code]
 * (follow-up to #1121; Owner decision 2026-11-18).
 * Real PostgreSQL proof (disposable local database, created and dropped by this file).
 *
 * The fixture is the part of public.reservations M552 touches: id, business_id,
 * the short reference_code, check_in/check_out, status, RLS on, an owner policy
 * and the table grant authenticated has today (M415: SELECT, UPDATE).
 * M552 is applied from disk as one whole-file statement, as it will be hosted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M552 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m552 = readFileSync('supabase/migrations/552_stay_confirmation_code.sql', 'utf8');
const database = `m552_${randomUUID().replaceAll('-', '')}`;
const BIZ = randomUUID();
const HEX32 = /^[0-9a-f]{32}$/;

type DbError = { code?: string; message?: string };

suite('M552 secret stay confirmation code (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);
  async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
    try { await fn(); } catch (err) { return err as DbError; }
    return {};
  }
  const insertStay = (ref: string) => q(
    `INSERT INTO public.reservations (business_id, reference_code, check_in, check_out)
     VALUES ($1, $2, '2026-12-01', '2026-12-03') RETURNING id, confirmation_code`, [BIZ, ref]);

  const snapshot = async () => (await q(`
      SELECT c.relacl::text AS acl, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS policies,
             (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) AS triggers,
             (SELECT json_agg(conname::text ORDER BY conname) FROM pg_constraint WHERE conrelid = c.oid) AS constraints
      FROM pg_class c WHERE c.oid = 'public.reservations'::regclass`)).rows[0];

  let before: Record<string, unknown>;
  let existingIds: string[];

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
    await q(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
      CREATE TABLE public.reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        reference_code VARCHAR(12) UNIQUE,
        check_in DATE NOT NULL,
        check_out DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "fixture owner" ON public.reservations FOR ALL USING (true);
      GRANT SELECT, UPDATE ON public.reservations TO authenticated;
    `);
    // Existing stays before M552.
    existingIds = [];
    for (let i = 0; i < 50; i++) {
      const r = await q(`INSERT INTO public.reservations (business_id, reference_code, check_in, check_out)
                         VALUES ($1, $2, '2026-11-01', '2026-11-02') RETURNING id`, [BIZ, `WA-RS-${String(i).padStart(4, '0')}`]);
      existingIds.push(r.rows[0].id);
    }
    before = await snapshot();
    await q(m552);
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('gives every existing stay its own 32-hex code', async () => {
    const rows = (await q(`SELECT confirmation_code FROM public.reservations WHERE id = ANY($1::uuid[])`, [existingIds])).rows;
    expect(rows).toHaveLength(50);
    for (const r of rows) expect(r.confirmation_code).toMatch(HEX32);
    expect(new Set(rows.map(r => r.confirmation_code)).size).toBe(50);
  });

  it('new stays get a code from the default, unrelated to the reference code', async () => {
    const a = (await insertStay('WA-RS-9001')).rows[0];
    const b = (await insertStay('WA-RS-9002')).rows[0];
    expect(a.confirmation_code).toMatch(HEX32);
    expect(b.confirmation_code).toMatch(HEX32);
    expect(a.confirmation_code).not.toBe(b.confirmation_code);
    expect(a.confirmation_code).not.toContain('9001');
  });

  it('column is text NOT NULL with the random default', async () => {
    const col = (await q(`
      SELECT a.attnotnull, format_type(a.atttypid, a.atttypmod) AS type, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.reservations'::regclass AND a.attname = 'confirmation_code'`)).rows[0];
    expect(col).toEqual({ attnotnull: true, type: 'text', def: "replace((gen_random_uuid())::text, '-'::text, ''::text)" });
  });

  it('refuses a short, guessable, upper-case or null code', async () => {
    const id = existingIds[0];
    for (const code of ['1234', 'WA-RS-0001', 'ABCDEF0123456789ABCDEF0123456789', `${'a'.repeat(32)}0`]) {
      expect((await errorOf(() => q(`UPDATE public.reservations SET confirmation_code = $1 WHERE id = $2`, [code, id]))).code).toBe('23514');
    }
    expect((await errorOf(() => q(`UPDATE public.reservations SET confirmation_code = NULL WHERE id = $1`, [id]))).code).toBe('23502');
  });

  it('refuses a duplicate code', async () => {
    const [a, b] = existingIds;
    const code = (await q(`SELECT confirmation_code FROM public.reservations WHERE id = $1`, [a])).rows[0].confirmation_code;
    expect((await errorOf(() => q(`UPDATE public.reservations SET confirmation_code = $1 WHERE id = $2`, [code, b]))).code).toBe('23505');
  });

  it('changes no grant, RLS, policy or trigger; adds only the two constraints', async () => {
    const after = await snapshot();
    expect(after.acl).toBe(before.acl);
    expect(after.rls).toBe(true);
    expect(after.policies).toBe(before.policies);
    expect(after.triggers).toBe(before.triggers);
    expect(after.constraints).toEqual(
      [...(before.constraints as string[]), 'reservations_confirmation_code_format', 'reservations_confirmation_code_key'].sort(),
    );
    const colAcl = (await q(`SELECT attacl FROM pg_attribute WHERE attrelid = 'public.reservations'::regclass AND attname = 'confirmation_code'`)).rows[0];
    expect(colAcl.attacl).toBeNull();
  });

  it('is idempotent: a re-run keeps every code and adds nothing', async () => {
    const codes = (await q(`SELECT id, confirmation_code FROM public.reservations ORDER BY id`)).rows;
    const shape = await snapshot();
    await q(m552);
    expect((await q(`SELECT id, confirmation_code FROM public.reservations ORDER BY id`)).rows).toEqual(codes);
    expect(await snapshot()).toEqual(shape);
  });
});
