/**
 * M517 — scheduled form sends (public.form_sends, #591).
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * The fixture follows production as read on 2026-11-05 (read-only):
 * - Supabase default privileges grant anon/authenticated/service_role ALL on new
 *   public tables, so the fixture installs the same default ACL and M517 must
 *   revoke it explicitly;
 * - public.forms: unique (id) and (token), RLS owner policies, the M437 column
 *   UPDATE grant; public.businesses with owner_id; auth.uid() from the JWT sub.
 * M517 is applied from disk as one whole-file statement, as it will be hosted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M517 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m517 = readFileSync('supabase/migrations/517_form_sends.sql', 'utf8');
const database = `m517_${randomUUID().replaceAll('-', '')}`;
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const BIZ_A = randomUUID();
const BIZ_B = randomUUID();
const FORM_A = randomUUID();
const FORM_B = randomUUID();

type DbError = { code?: string; message?: string };

suite('M517 form_sends (real PostgreSQL)', () => {
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
  const insertSend = (business: string, form: string, extra = '') =>
    q(`INSERT INTO public.form_sends (business_id, form_id, recipients, scheduled_at${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1, $2, ARRAY['+2348031111111'], now() + interval '1 hour'${extra ? ', ' + extra.split('=').slice(1).join('=') : ''}) RETURNING id`, [business, form]);

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$`);
    await control.query(`ALTER ROLE service_role BYPASSRLS`);
    for (const role of ['anon', 'authenticated']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();

    await q(`
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE TABLE auth.users (id UUID PRIMARY KEY);
      GRANT REFERENCES ON auth.users TO service_role;
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      -- Production default privileges for new public tables.
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

      CREATE TABLE public.businesses (id UUID PRIMARY KEY, owner_id UUID NOT NULL);
      CREATE TABLE public.forms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        title varchar(200) NOT NULL,
        token varchar(20) UNIQUE,
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE INDEX idx_forms_business ON public.forms(business_id);
      ALTER TABLE public.forms ENABLE ROW LEVEL SECURITY;
      CREATE POLICY forms_owner_select ON public.forms FOR SELECT
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      CREATE POLICY forms_service_all ON public.forms FOR ALL TO service_role USING (true) WITH CHECK (true);
      REVOKE UPDATE ON public.forms FROM authenticated;
      GRANT UPDATE (title, is_active, token) ON public.forms TO authenticated;
    `);
    await q(`INSERT INTO auth.users VALUES ($1), ($2)`, [OWNER_A, OWNER_B]);
    await q(`INSERT INTO public.businesses VALUES ($1, $2), ($3, $4)`, [BIZ_A, OWNER_A, BIZ_B, OWNER_B]);
    await q(`INSERT INTO public.forms (id, business_id, title, token) VALUES ($1, $2, 'A', 'tokA'), ($3, $4, 'B', 'tokB')`, [FORM_A, BIZ_A, FORM_B, BIZ_B]);

    await q(m517);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    if (control) {
      await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await control.end();
    }
  });

  it('creates the table with RLS on and exactly one owner SELECT policy', async () => {
    const { rows: [t] } = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.form_sends'::regclass`);
    expect(t.relrowsecurity).toBe(true);
    const { rows } = await q(`SELECT policyname, cmd, roles::text FROM pg_policies WHERE tablename = 'form_sends'`);
    expect(rows).toEqual([{ policyname: 'form_sends_owner_select', cmd: 'SELECT', roles: '{authenticated}' }]);
  });

  it('final ACL: anon nothing, authenticated read only, service_role read/write (default privileges revoked)', async () => {
    const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const check = async (role: string) => Object.fromEntries(await Promise.all(privs.map(async p =>
      [p, (await q(`SELECT has_table_privilege($1, 'public.form_sends', $2) AS ok`, [role, p])).rows[0].ok])));
    expect(await check('anon')).toEqual(Object.fromEntries(privs.map(p => [p, false])));
    expect(await check('authenticated')).toEqual(Object.fromEntries(privs.map(p => [p, p === 'SELECT'])));
    const svc = await check('service_role');
    expect([svc.SELECT, svc.INSERT, svc.UPDATE, svc.DELETE]).toEqual([true, true, true, true]);
  });

  it('service_role can create, claim and complete a send', async () => {
    await as('service_role', null, async () => {
      const { rows: [row] } = await insertSend(BIZ_A, FORM_A, `template_name='feedback_request'`);
      const claimed = await q(`UPDATE public.form_sends SET status = 'sending', started_at = now() WHERE id = $1 AND status = 'scheduled' RETURNING id`, [row.id]);
      expect(claimed.rowCount).toBe(1);
      // A second claim of the same row finds nothing to update.
      const again = await q(`UPDATE public.form_sends SET status = 'sending' WHERE id = $1 AND status = 'scheduled' RETURNING id`, [row.id]);
      expect(again.rowCount).toBe(0);
      await q(`UPDATE public.form_sends SET status = 'sent', sent_count = 1, results = '[{"phone":"+2348031111111","status":"sent"}]' WHERE id = $1`, [row.id]);
    });
  });

  it('an owner reads only their own business’s sends', async () => {
    await q(`INSERT INTO public.form_sends (business_id, form_id, recipients, scheduled_at) VALUES ($1, $2, ARRAY['+1'], now()), ($3, $4, ARRAY['+2'], now())`, [BIZ_A, FORM_A, BIZ_B, FORM_B]);
    const mine = await as('authenticated', OWNER_A, () => q(`SELECT business_id FROM public.form_sends`));
    expect(mine.rows.map(r => r.business_id)).toEqual([BIZ_A]);
    const theirs = await as('authenticated', OWNER_B, () => q(`SELECT business_id FROM public.form_sends`));
    expect(theirs.rows.map(r => r.business_id)).toEqual([BIZ_B]);
    const anonymous = await as('authenticated', null, () => q(`SELECT count(*)::int AS n FROM public.form_sends`));
    expect(anonymous.rows[0].n).toBe(0);
  });

  it('signed-in users and anon cannot write or read past RLS', async () => {
    for (const role of ['authenticated', 'anon']) {
      const sub = role === 'authenticated' ? OWNER_A : null;
      expect((await errorOf(() => as(role, sub, () => insertSend(BIZ_A, FORM_A)))).code).toBe('42501');
      expect((await errorOf(() => as(role, sub, () => q(`UPDATE public.form_sends SET status = 'cancelled'`))))).toMatchObject({ code: '42501' });
      expect((await errorOf(() => as(role, sub, () => q(`DELETE FROM public.form_sends`))))).toMatchObject({ code: '42501' });
    }
    expect((await errorOf(() => as('anon', null, () => q(`SELECT 1 FROM public.form_sends`))))).toMatchObject({ code: '42501' });
  });

  it('refuses a send that pairs a business with another business’s form', async () => {
    const err = await errorOf(() => as('service_role', null, () => insertSend(BIZ_A, FORM_B)));
    expect(err.code).toBe('23503');
  });

  it.each([
    ['an unknown status', `status='done'`],
    ['an empty recipient list', null],
    ['a template name that is not a Meta name', `template_name='Bad Name!'`],
    ['a template name longer than Meta allows', `template_name=repeat('a', 513)`],
    ['negative counts', `sent_count=-1`],
    ['non-array results', `results='{}'::jsonb`],
  ])('rejects %s', async (_label, extra) => {
    const err = await errorOf(() => as('service_role', null, () => extra
      ? insertSend(BIZ_A, FORM_A, extra)
      : q(`INSERT INTO public.form_sends (business_id, form_id, recipients, scheduled_at) VALUES ($1, $2, '{}', now())`, [BIZ_A, FORM_A])));
    expect(err.code).toBe('23514');
  });

  it('caps a send at 500 recipients', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `+23480300${String(i).padStart(5, '0')}`);
    const err = await errorOf(() => as('service_role', null, () =>
      q(`INSERT INTO public.form_sends (business_id, form_id, recipients, scheduled_at) VALUES ($1, $2, $3, now())`, [BIZ_A, FORM_A, many])));
    expect(err.code).toBe('23514');
  });

  it('deleting a form deletes its sends', async () => {
    await q('BEGIN');
    try {
      await insertSend(BIZ_A, FORM_A);
      await q(`DELETE FROM public.forms WHERE id = $1`, [FORM_A]);
      const { rows: [r] } = await q(`SELECT count(*)::int AS n FROM public.form_sends WHERE form_id = $1`, [FORM_A]);
      expect(r.n).toBe(0);
    } finally { await q('ROLLBACK'); }
  });

  it('is idempotent: a re-run converges', async () => {
    await q(m517);
    await q(m517);
    const { rows } = await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'form_sends'`);
    expect(rows[0].n).toBe(1);
  });

  it('the self-check refuses drift that a re-run does not undo (an extra policy)', async () => {
    await q('BEGIN');
    try {
      await q(`CREATE POLICY drift_insert ON public.form_sends FOR INSERT TO authenticated WITH CHECK (true)`);
      const err = await errorOf(() => q(m517));
      expect(err.message).toMatch(/M517/);
    } finally { await q('ROLLBACK'); }
  });
});
