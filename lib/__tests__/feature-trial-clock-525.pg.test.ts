/**
 * M525 — feature-trial clock from sign-up; the trial never waives the fee.
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * Fixture: a minimal public.businesses / public.platform_settings, plus the REAL
 * recurring-charge fee functions copied from their migrations on disk
 * (token M335, Stripe M339, Paystack M503, process_recurring_charge M305).
 * PL/pgSQL bodies are not executed, only created, so their table references
 * do not need to exist. A synthetic function with the same waiver shape is
 * executed to prove the fee is charged after the rewrite.
 * M525 is applied from disk as one whole-file statement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M525 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m525 = readFileSync('supabase/migrations/525_feature_trial_clock_and_no_trial_fee_waiver.sql', 'utf8');
const database = `m525_${randomUUID().replaceAll('-', '')}`;

/** Extract one CREATE OR REPLACE FUNCTION statement (through its closing `$$;`) from a migration file. */
function extractFunction(file: string, name: string): string {
  const text = readFileSync(`supabase/migrations/${file}`, 'utf8');
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const end = text.indexOf('\n$$;', start);
  if (end < 0) throw new Error(`${name} has no closing $$ in ${file}`);
  return text.slice(start, end + 4);
}

const REAL_FUNCTIONS: Array<{ file: string; name: string; sig: string }> = [
  { file: '335_recurring_spend_finalization.sql', name: 'finalize_token_recurring_charge', sig: 'finalize_token_recurring_charge(text,uuid,numeric,text,text,text)' },
  { file: '339_stripe_recurring_finalization.sql', name: 'finalize_stripe_recurring_charge', sig: 'finalize_stripe_recurring_charge(uuid,text,text,integer,text,text)' },
  { file: '503_recurring_cancellation_compatibility.sql', name: 'finalize_paystack_recurring_charge', sig: 'finalize_paystack_recurring_charge(uuid,integer,text,text,text)' },
  { file: '305_annual_subscriptions_loyalty.sql', name: 'process_recurring_charge', sig: 'process_recurring_charge(text,text,text,text,text,bigint,text,text,text,text)' },
];

// Same waiver shape as the real finalizers; returns the fee it would record.
const SYNTHETIC_FEE_FN = `
CREATE OR REPLACE FUNCTION public.synthetic_recurring_fee(p_business_id uuid, p_amount numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_business RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_is_in_trial BOOLEAN;
  v_tier TEXT;
  v_fee_pct NUMERIC(5,2);
  v_fee_total NUMERIC(12,2);
BEGIN
  SELECT subscription_tier, trial_ends_at INTO v_business FROM businesses WHERE id = p_business_id;
  v_is_in_trial := v_business.trial_ends_at > v_now;
  v_tier := COALESCE(v_business.subscription_tier, 'free');
  IF v_is_in_trial THEN v_fee_total := 0;
  ELSE
    SELECT (value -> v_tier ->> 'feePercentage')::numeric INTO v_fee_pct
      FROM platform_settings WHERE key = 'pricing_tiers';
    v_fee_total := ROUND(p_amount * v_fee_pct / 100, 2);
  END IF;
  RETURN v_fee_total;
END;
$$;`;

suite('M525 feature trial clock and no trial fee waiver (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);

  async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      return await fn();
    } finally {
      await q('ROLLBACK');
    }
  }
  async function errorOf(fn: () => Promise<unknown>): Promise<{ message?: string }> {
    try { await fn(); } catch (err) { return err as { message?: string }; }
    return {};
  }
  async function attrs(sig: string) {
    const { rows } = await q(
      `SELECT prosecdef, proconfig, proacl::text AS acl, prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`,
      [`public.${sig}`],
    );
    return rows[0] as { prosecdef: boolean; proconfig: string[] | null; acl: string | null; prosrc: string };
  }

  const BIZ_TRIAL = randomUUID();
  const before: Record<string, Awaited<ReturnType<typeof attrs>>> = {};

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query(`CREATE DATABASE ${database}`);
    const u = new URL(url!); u.pathname = `/${database}`;
    client = new pg.Client({ connectionString: u.toString() }); await client.connect();

    await q(`
      CREATE TABLE public.platform_settings (key text PRIMARY KEY, value jsonb NOT NULL);
      CREATE TABLE public.businesses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text,
        subscription_tier text NOT NULL DEFAULT 'free',
        trial_ends_at timestamptz,
        status text DEFAULT 'active'
      );
      GRANT SELECT, INSERT, UPDATE ON public.businesses TO authenticated, service_role;
      GRANT SELECT ON public.platform_settings TO authenticated, service_role;
      INSERT INTO public.platform_settings VALUES
        ('trial_days', '14'),
        ('pricing_tiers', '{"free":{"feePercentage":3,"feeFlat":0},"growth":{"feePercentage":1.5,"feeFlat":0},"business":{"feePercentage":1,"feeFlat":0}}');
    `);

    for (const f of REAL_FUNCTIONS) {
      await q(extractFunction(f.file, f.name));
      await q(`REVOKE ALL ON FUNCTION public.${f.sig} FROM PUBLIC`);
      await q(`GRANT EXECUTE ON FUNCTION public.${f.sig} TO service_role`);
      before[f.sig] = await attrs(f.sig);
    }
    await q(SYNTHETIC_FEE_FN);

    // A business whose credit clock is in the future (the old waiver condition).
    await q(`INSERT INTO public.businesses (id, name, trial_ends_at) VALUES ($1, 'Trial credit biz', now() + interval '10 days')`, [BIZ_TRIAL]);
    expect(Number((await q(`SELECT public.synthetic_recurring_fee($1, 1000) AS fee`, [BIZ_TRIAL])).rows[0].fee)).toBe(0);

    await q(m525);
  }, 60000);

  afterAll(async () => {
    await client?.end();
    if (control) {
      await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await control.end();
    }
  });

  it('every real recurring fee function now assigns v_is_in_trial := false exactly once', async () => {
    for (const f of REAL_FUNCTIONS) {
      const after = await attrs(f.sig);
      expect(before[f.sig].prosrc, f.sig).toMatch(/v_is_in_trial\s*:=\s*(COALESCE\()?v_business\.trial_ends_at > v_now/);
      const assignments = after.prosrc.match(/v_is_in_trial\s*:=\s*[^;]*;/g) || [];
      expect(assignments, f.sig).toEqual(['v_is_in_trial := false;']);
      expect(after.prosrc, f.sig).toContain('/* M525: the trial never waives the Waaiio fee');
    }
  });

  it('only the assignment changed; SECURITY DEFINER, search_path and ACL are preserved', async () => {
    for (const f of REAL_FUNCTIONS) {
      const after = await attrs(f.sig);
      expect(after.prosecdef, f.sig).toBe(before[f.sig].prosecdef);
      expect(after.proconfig, f.sig).toEqual(before[f.sig].proconfig);
      expect(after.acl, f.sig).toBe(before[f.sig].acl);
      const strip = (s: string) => s.replace(/v_is_in_trial\s*:=\s*[^;]*;( \/\* M525:[^*]*\*\/)?/, '<ASSIGN>');
      expect(strip(after.prosrc), f.sig).toBe(strip(before[f.sig].prosrc));
    }
  });

  it('a business with a future trial clock is now charged its plan fee on a recurring charge', async () => {
    expect(Number((await q(`SELECT public.synthetic_recurring_fee($1, 1000) AS fee`, [BIZ_TRIAL])).rows[0].fee)).toBe(30);
    await q(`UPDATE public.businesses SET subscription_tier = 'growth' WHERE id = $1`, [BIZ_TRIAL]);
    expect(Number((await q(`SELECT public.synthetic_recurring_fee($1, 1000) AS fee`, [BIZ_TRIAL])).rows[0].fee)).toBe(15);
    await q(`UPDATE public.businesses SET subscription_tier = 'business' WHERE id = $1`, [BIZ_TRIAL]);
    expect(Number((await q(`SELECT public.synthetic_recurring_fee($1, 1000) AS fee`, [BIZ_TRIAL])).rows[0].fee)).toBe(10);
  });

  it('a new business gets feature_trial_ends_at = sign-up + trial_days; supplied values are ignored', async () => {
    const { rows } = await as('service_role', () => q(`
      INSERT INTO public.businesses (name, feature_trial_ends_at)
      VALUES ('New biz', now() + interval '400 days')
      RETURNING EXTRACT(EPOCH FROM (feature_trial_ends_at - now())) / 86400 AS days, trial_ends_at`));
    expect(Number(rows[0].days)).toBeCloseTo(14, 5);
    // The messaging-credit clock is untouched by sign-up.
    expect(rows[0].trial_ends_at).toBeNull();
  });

  it('trial length follows platform_settings.trial_days', async () => {
    await q(`UPDATE public.platform_settings SET value = '30' WHERE key = 'trial_days'`);
    const { rows } = await q(`INSERT INTO public.businesses (name) VALUES ('Thirty') RETURNING EXTRACT(EPOCH FROM (feature_trial_ends_at - now())) / 86400 AS days`);
    expect(Number(rows[0].days)).toBeCloseTo(30, 5);
    await q(`UPDATE public.platform_settings SET value = '14' WHERE key = 'trial_days'`);
  });

  it('missing or invalid trial_days gives no trial and does not block sign-up', async () => {
    for (const bad of [null, '"14"', '0', '-3', '1.5', '{}']) {
      await q('BEGIN');
      try {
        if (bad === null) await q(`DELETE FROM public.platform_settings WHERE key = 'trial_days'`);
        else await q(`UPDATE public.platform_settings SET value = $1::jsonb WHERE key = 'trial_days'`, [bad]);
        const { rows } = await q(`INSERT INTO public.businesses (name) VALUES ('Bad config') RETURNING feature_trial_ends_at`);
        expect(rows[0].feature_trial_ends_at, String(bad)).toBeNull();
      } finally {
        await q('ROLLBACK');
      }
    }
  });

  it('only the server can change the feature trial clock', async () => {
    const { rows } = await q(`INSERT INTO public.businesses (name) VALUES ('Guarded') RETURNING id`);
    const id = rows[0].id;
    const err = await errorOf(() => as('authenticated', () =>
      q(`UPDATE public.businesses SET feature_trial_ends_at = now() + interval '365 days' WHERE id = $1`, [id])));
    expect(err.message).toContain('feature_trial_ends_at can only be modified by the server');

    // Other columns stay editable for authenticated (this guard only covers the clock).
    await as('authenticated', async () => {
      const r = await q(`UPDATE public.businesses SET name = 'Renamed' WHERE id = $1`, [id]);
      expect(r.rowCount).toBe(1);
    });

    await as('service_role', async () => {
      const r = await q(`UPDATE public.businesses SET feature_trial_ends_at = now() + interval '20 days' WHERE id = $1`, [id]);
      expect(r.rowCount).toBe(1);
    });
  });

  it('upgrading from Starter ends a running trial at that moment (Owner 2026-11-09)', async () => {
    const { rows } = await q(`INSERT INTO public.businesses (name) VALUES ('Upgrader') RETURNING id`);
    const id = rows[0].id;
    await q(`UPDATE public.businesses SET subscription_tier = 'growth' WHERE id = $1`, [id]);
    const after = (await q(`SELECT EXTRACT(EPOCH FROM (now() - feature_trial_ends_at)) AS ago FROM public.businesses WHERE id = $1`, [id])).rows[0];
    expect(Math.abs(Number(after.ago))).toBeLessThan(5);
    // A later downgrade does not bring the remaining trial days back.
    await q(`UPDATE public.businesses SET subscription_tier = 'free' WHERE id = $1`, [id]);
    const back = (await q(`SELECT feature_trial_ends_at > now() + interval '1 second' AS active FROM public.businesses WHERE id = $1`, [id])).rows[0];
    expect(back.active).toBe(false);
  });

  it('other updates and other tier moves leave the trial clock alone', async () => {
    const { rows } = await q(`INSERT INTO public.businesses (name) VALUES ('Untouched') RETURNING id, feature_trial_ends_at`);
    const { id, feature_trial_ends_at: start } = rows[0];
    await q(`UPDATE public.businesses SET name = 'Renamed' WHERE id = $1`, [id]);
    await q(`UPDATE public.businesses SET subscription_tier = 'free' WHERE id = $1`, [id]);
    expect((await q(`SELECT feature_trial_ends_at FROM public.businesses WHERE id = $1`, [id])).rows[0].feature_trial_ends_at).toEqual(start);
    // Growth → Business (already paid) and an expired clock are not touched.
    const paid = (await q(`INSERT INTO public.businesses (name, subscription_tier) VALUES ('Paid', 'growth') RETURNING id, feature_trial_ends_at`)).rows[0];
    await q(`UPDATE public.businesses SET subscription_tier = 'business' WHERE id = $1`, [paid.id]);
    expect((await q(`SELECT feature_trial_ends_at FROM public.businesses WHERE id = $1`, [paid.id])).rows[0].feature_trial_ends_at).toEqual(paid.feature_trial_ends_at);
    const expired = (await q(`INSERT INTO public.businesses (name) VALUES ('Expired') RETURNING id`)).rows[0];
    await q(`UPDATE public.businesses SET feature_trial_ends_at = now() - interval '2 days' WHERE id = $1`, [expired.id]);
    const before = (await q(`SELECT feature_trial_ends_at FROM public.businesses WHERE id = $1`, [expired.id])).rows[0].feature_trial_ends_at;
    await q(`UPDATE public.businesses SET subscription_tier = 'growth' WHERE id = $1`, [expired.id]);
    expect((await q(`SELECT feature_trial_ends_at FROM public.businesses WHERE id = $1`, [expired.id])).rows[0].feature_trial_ends_at).toEqual(before);
  });

  it('the trigger functions are not callable by anon or authenticated', async () => {
    const { rows } = await q(`SELECT
      has_function_privilege('anon', 'public.set_feature_trial_clock()', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'public.set_feature_trial_clock()', 'EXECUTE') AS auth,
      has_function_privilege('anon', 'public.guard_feature_trial_clock()', 'EXECUTE') AS guard_anon,
      has_function_privilege('authenticated', 'public.guard_feature_trial_clock()', 'EXECUTE') AS guard_auth,
      has_function_privilege('anon', 'public.end_feature_trial_on_upgrade()', 'EXECUTE') AS end_anon,
      has_function_privilege('authenticated', 'public.end_feature_trial_on_upgrade()', 'EXECUTE') AS end_auth`);
    expect(rows[0]).toEqual({ anon: false, auth: false, guard_anon: false, guard_auth: false, end_anon: false, end_auth: false });
  });

  it('re-applying M525 is idempotent', async () => {
    await q(m525);
    for (const f of REAL_FUNCTIONS) {
      const assignments = (await attrs(f.sig)).prosrc.match(/v_is_in_trial\s*:=\s*[^;]*;/g) || [];
      expect(assignments, f.sig).toEqual(['v_is_in_trial := false;']);
    }
  });

  it('fails closed when a recurring finalizer waives on trial_ends_at in another shape', async () => {
    await q('BEGIN');
    try {
      // A finalizer name with a waiver that is not a v_is_in_trial assignment.
      await q(`CREATE FUNCTION public.finalize_token_recurring_charge(p_x int) RETURNS numeric LANGUAGE plpgsql AS $$
        DECLARE v_fee numeric := 10; BEGIN
          IF (SELECT trial_ends_at FROM public.businesses LIMIT 1) > now() THEN v_fee := 0; END IF;
          RETURN v_fee; END; $$`);
      const err = await errorOf(() => q(m525));
      expect(err.message).toContain('without the M525 neutral assignment');
    } finally {
      await q('ROLLBACK');
    }
  });

  it('fails closed when a function has more than one trial assignment', async () => {
    await q('BEGIN');
    try {
      await q(`CREATE FUNCTION public.ambiguous_waiver() RETURNS boolean LANGUAGE plpgsql AS $$
        DECLARE v_is_in_trial boolean; BEGIN v_is_in_trial := true; v_is_in_trial := now() > now(); RETURN v_is_in_trial; END; $$`);
      const err = await errorOf(() => q(m525));
      expect(err.message).toContain('expected exactly 1');
    } finally {
      await q('ROLLBACK');
    }
  });
});
