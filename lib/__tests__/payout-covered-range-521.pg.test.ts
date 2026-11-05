/**
 * M521 — business_payouts.covered_from / covered_to (#796, Owner decision
 * 2026-11-05 Option A). Real PostgreSQL proof (disposable local database,
 * created and dropped by this file).
 *
 * The fixture is the live final state of public.business_payouts, read on
 * 2026-11-05 (read-only, production cxcmiqotkowhxinjbytg):
 *   - columns as live (no covered_from / covered_to);
 *   - table ACL: service_role ALL; anon and authenticated SELECT, TRUNCATE,
 *     REFERENCES, TRIGGER (+ MAINTAIN on PostgreSQL 17), no INSERT/UPDATE/DELETE (M439);
 *   - RLS on, with "Admins can view business_payouts" (authenticated, is_admin())
 *     and "Business owners can view own payouts" (PUBLIC, owner's businesses);
 *   - chk_payouts_amount_nonneg and the M468 per-currency dedup index;
 *   - service_role BYPASSRLS, as on Supabase.
 * The two live triggers (trg_payout_linkage_guard, guard_accounting_held_payout)
 * are omitted: neither reads covered_from / covered_to.
 * M521 is applied from disk as one whole-file statement, as it will be hosted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M521 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m521 = readFileSync('supabase/migrations/521_payout_covered_range.sql', 'utf8');
const database = `m521_${randomUUID().replaceAll('-', '')}`;
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const BIZ_A = randomUUID();
const BIZ_B = randomUUID();

type DbError = { code?: string; message?: string };

suite('M521 business_payouts covered range (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;

  const q = (text: string, params?: unknown[]) => client.query(text, params);

  /** Run fn as `role` (optionally as auth user `sub`) inside a rolled-back transaction. */
  async function as<T>(role: string, sub: string | null, fn: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      if (sub) await q(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
      return await fn();
    } finally {
      await q('ROLLBACK');
    }
  }
  async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
    try { await fn(); } catch (err) { return err as DbError; }
    return {};
  }
  const insertPayout = (cols: string, vals: string, params: unknown[]) =>
    q(`INSERT INTO public.business_payouts (business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, currency${cols})
       VALUES ($1, $2, $3, 100, 5, 1, 94, 'NGN'${vals})`, params);

  /** Build the live fixture in a fresh database. */
  async function buildFixture(db: pg.Client) {
    const major = Number((await db.query(`SHOW server_version_num`)).rows[0].server_version_num) / 10000;
    await db.query(`
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      CREATE TABLE public.businesses (id UUID PRIMARY KEY, owner_id UUID NOT NULL);
      GRANT SELECT ON public.businesses TO anon, authenticated;
      GRANT ALL ON public.businesses TO service_role;

      CREATE TABLE public.business_payouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id),
        payout_account_id UUID,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        gross_amount NUMERIC(12,2) NOT NULL,
        platform_fee NUMERIC(12,2) NOT NULL,
        gateway_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
        net_amount NUMERIC(12,2) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        approved_by UUID,
        approved_at TIMESTAMPTZ,
        rejected_reason TEXT,
        transfer_method VARCHAR(20),
        transfer_reference VARCHAR(100),
        gateway_transfer_code VARCHAR(100),
        paid_at TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        flags JSONB NOT NULL DEFAULT '[]'::jsonb,
        transfer_notes TEXT,
        auto_generated BOOLEAN DEFAULT false,
        claim_token UUID,
        provider_idempotency_key TEXT,
        processing_started_at TIMESTAMPTZ,
        currency VARCHAR(3),
        CONSTRAINT chk_payouts_amount_nonneg CHECK (gross_amount >= 0 AND net_amount >= 0)
      );
      CREATE UNIQUE INDEX idx_business_payouts_dedup_currency
        ON public.business_payouts (business_id, period_start, period_end, COALESCE(currency, '__legacy__'));
      ALTER TABLE public.business_payouts ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.business_payouts FROM PUBLIC, anon, authenticated;
      GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER ON public.business_payouts TO anon, authenticated;
      GRANT ALL ON public.business_payouts TO service_role;
      CREATE POLICY "Admins can view business_payouts" ON public.business_payouts
        FOR SELECT TO authenticated USING (is_admin());
      CREATE POLICY "Business owners can view own payouts" ON public.business_payouts
        FOR SELECT USING (business_id IN (SELECT businesses.id FROM businesses WHERE businesses.owner_id = auth.uid()));
    `);
    if (major >= 17) await db.query(`GRANT MAINTAIN ON public.business_payouts TO anon, authenticated`);
    await db.query(`INSERT INTO public.businesses VALUES ($1, $2), ($3, $4)`, [BIZ_A, OWNER_A, BIZ_B, OWNER_B]);
    // A row written before M521 (like the 11 production rows).
    await db.query(`INSERT INTO public.business_payouts (business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount)
                    VALUES ($1, '2026-07-13', '2026-07-19', 50, 2, 1, 47)`, [BIZ_A]);
  }

  async function freshDatabase(name: string): Promise<pg.Client> {
    await control.query(`CREATE DATABASE ${name}`);
    const target = new URL(url!); target.pathname = `/${name}`;
    const db = new pg.Client({ connectionString: target.toString() }); await db.connect();
    return db;
  }

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$`);
    await control.query(`ALTER ROLE service_role BYPASSRLS`);
    for (const role of ['anon', 'authenticated']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    client = await freshDatabase(database);
    await buildFixture(client);
    await q(m521);
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('adds two nullable timestamptz columns with no default, and existing rows keep NULL', async () => {
    const cols = await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'business_payouts'
                            AND column_name IN ('covered_from', 'covered_to') ORDER BY column_name`);
    expect(cols.rows).toEqual([
      { column_name: 'covered_from', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'covered_to', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ]);
    const legacy = await q(`SELECT covered_from, covered_to FROM public.business_payouts WHERE period_end = '2026-07-19'`);
    expect(legacy.rows).toEqual([{ covered_from: null, covered_to: null }]);
  });

  it('is idempotent: a second whole-file application changes nothing and passes its self-check', async () => {
    await q(m521);
    const checks = await q(`SELECT count(*)::int AS n FROM pg_constraint
                            WHERE conrelid = 'public.business_payouts'::regclass AND conname = 'business_payouts_covered_range_check'`);
    expect(checks.rows[0].n).toBe(1);
  });

  it('service_role can write a half-open range; the check rejects empty, reversed and half-set ranges', async () => {
    await as('service_role', null, async () => {
      await insertPayout(', covered_from, covered_to', ', $4, $5', [BIZ_A, '2026-11-02', '2026-11-08', '2026-11-01T23:00:00Z', '2026-11-08T23:00:00Z']);
      const row = await q(`SELECT covered_from, covered_to FROM public.business_payouts WHERE business_id = $1 AND period_end = '2026-11-08'`, [BIZ_A]);
      expect(row.rows[0].covered_from.toISOString()).toBe('2026-11-01T23:00:00.000Z');
      expect(row.rows[0].covered_to.toISOString()).toBe('2026-11-08T23:00:00.000Z');
    });
    for (const [from, to] of [
      ['2026-11-08T23:00:00Z', '2026-11-08T23:00:00Z'], // empty
      ['2026-11-08T23:00:00Z', '2026-11-01T23:00:00Z'], // reversed
      ['2026-11-01T23:00:00Z', null],                    // only start
      [null, '2026-11-08T23:00:00Z'],                    // only end
    ]) {
      const err = await as('service_role', null, () =>
        errorOf(() => insertPayout(', covered_from, covered_to', ', $4, $5', [BIZ_A, '2026-11-09', '2026-11-15', from, to])));
      expect(err.code).toBe('23514');
      expect(err.message).toContain('business_payouts_covered_range_check');
    }
  });

  it('anon and authenticated cannot write the new columns', async () => {
    for (const role of ['anon', 'authenticated']) {
      const insert = await as(role, OWNER_A, () =>
        errorOf(() => insertPayout(', covered_from, covered_to', ', $4, $5', [BIZ_A, '2026-11-16', '2026-11-22', '2026-11-15T23:00:00Z', '2026-11-22T23:00:00Z'])));
      expect(insert.code).toBe('42501');
      const update = await as(role, OWNER_A, () =>
        errorOf(() => q(`UPDATE public.business_payouts SET covered_to = now() WHERE business_id = $1`, [BIZ_A])));
      expect(update.code).toBe('42501');
    }
    const priv = await q(`SELECT has_column_privilege('authenticated', 'public.business_payouts', 'covered_to', 'UPDATE') AS u,
                                 has_column_privilege('anon', 'public.business_payouts', 'covered_from', 'INSERT') AS i`);
    expect(priv.rows[0]).toEqual({ u: false, i: false });
  });

  it('reads follow the existing RLS: the owner sees their own payouts, another owner sees none', async () => {
    await q(`INSERT INTO public.business_payouts (business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, currency, covered_from, covered_to)
             VALUES ($1, '2026-10-26', '2026-11-01', 100, 5, 1, 94, 'NGN', '2026-10-25T23:00:00Z', '2026-11-01T23:00:00Z')`, [BIZ_A]);
    const own = await as('authenticated', OWNER_A, () =>
      q(`SELECT covered_to FROM public.business_payouts WHERE period_end = '2026-11-01'`));
    expect(own.rows.map(r => r.covered_to.toISOString())).toEqual(['2026-11-01T23:00:00.000Z']);
    const other = await as('authenticated', OWNER_B, () =>
      q(`SELECT covered_to FROM public.business_payouts WHERE period_end = '2026-11-01'`));
    expect(other.rows).toEqual([]);
  });

  it('self-check fails the migration if drift gives authenticated UPDATE on the table', async () => {
    const name = `${database}_drift`;
    const db = await freshDatabase(name);
    try {
      await buildFixture(db);
      await db.query(`GRANT UPDATE ON public.business_payouts TO authenticated`);
      const err = await (async () => { try { await db.query(m521); } catch (e) { return e as DbError; } return {} as DbError; })();
      expect(err.message).toContain('M521: authenticated must not have UPDATE on business_payouts.covered_from');
    } finally {
      await db.end();
      await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });
});
