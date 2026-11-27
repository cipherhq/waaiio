/**
 * M558 — growth_pricing and keyword_campaign_responses are written only by the
 * service role. Real PostgreSQL proof (disposable local databases, created and
 * dropped here).
 *
 * Fixture: the canonical has_admin_role() from M439 (from disk), with
 * auth.jwt()/auth.uid() read from request.jwt.claims as in Supabase;
 * growth_pricing with its M241 table and write policies (from disk) and its
 * M439 admin SELECT policy (from disk); keyword_campaign_responses with its
 * M203 table and policies. Table ACLs differ by environment, so M558 is
 * applied from disk (twice, idempotency) over two starting states:
 *   "history": the grants and policies in migration history plus the staging
 *     grants reconciliation (authenticated SELECT/INSERT/UPDATE), with
 *     service_insert_responses open to every role as written in M203;
 *   "broad": every privilege for every API role, as Supabase default
 *     privileges give a new table, with service_insert_responses already
 *     TO service_role.
 * Both must end in the same write lock, with SELECT grants and SELECT
 * policies exactly as they were before.
 *
 * This test FAILS, never skips, when the database is missing. It runs in CI in
 * the security-acl-tests job ("Run .pg.test.ts files in parallel with isolated
 * databases").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Disposable PostgreSQL required for M558 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');

const migration = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');
const M558 = migration('558_growth_pricing_service_role_writes.sql');
const ALL = 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER';
const STATES = ['history', 'broad'] as const;
type State = typeof STATES[number];
const TABLES = ['growth_pricing', 'keyword_campaign_responses'] as const;

const USERS = {
  admin: '00000000-0000-0000-0000-0000000558a1',
  support: '00000000-0000-0000-0000-0000000558a2',
  owner: '00000000-0000-0000-0000-0000000558a3',
  other: '00000000-0000-0000-0000-0000000558a4',
};
const BIZ = '00000000-0000-0000-0000-0000000558b1';
const OTHER_BIZ = '00000000-0000-0000-0000-0000000558b2';
const CAMPAIGN = '00000000-0000-0000-0000-0000000558c1';
const PRICE = '00000000-0000-0000-0000-0000000558d1';
const RESPONSE = '00000000-0000-0000-0000-0000000558e1';

type Caller = { role: 'anon' | 'authenticated'; sub?: string; aal?: string };
type DbError = { code?: string; message?: string };

function slice(text: string, from: string, to: string, label: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + 1);
  if (start < 0 || end <= start) throw new Error(`Canonical ${label} section markers changed`);
  return text.slice(start, end);
}

function fixture(state: State): string {
  const m439 = migration('439_admin_mfa_enforcement.sql');
  const m241 = migration('241_growth_engine.sql');
  const hasAdminRole = slice(m439, 'CREATE OR REPLACE FUNCTION public.has_admin_role(required_roles text[])',
    '-- §4. Rewrite is_support()', 'M439 has_admin_role');
  const pricingTable = slice(m241, 'CREATE TABLE public.growth_pricing (', '-- ====', 'M241 growth_pricing table');
  const pricingWritePolicies = slice(m241, 'CREATE POLICY "growth_pricing_service_insert"', '-- ====', 'M241 growth_pricing policies');
  const pricingSelect = slice(m439, 'DROP POLICY IF EXISTS "growth_pricing_admin_select"', '-- SEC-005', 'M439 growth_pricing select');

  const responseInsertPolicy = state === 'history'
    ? `CREATE POLICY "service_insert_responses" ON public.keyword_campaign_responses FOR INSERT WITH CHECK (true);`
    : `CREATE POLICY "service_insert_responses" ON public.keyword_campaign_responses FOR INSERT TO service_role WITH CHECK (true);`;
  const tableGrants = state === 'broad'
    ? `GRANT ${ALL} ON public.growth_pricing, public.keyword_campaign_responses TO PUBLIC, anon, authenticated, service_role;`
    : `GRANT SELECT, INSERT, UPDATE ON public.growth_pricing TO authenticated;
       GRANT SELECT, INSERT ON public.keyword_campaign_responses TO authenticated;
       GRANT SELECT, INSERT, UPDATE, DELETE ON public.growth_pricing, public.keyword_campaign_responses TO service_role;`;

  return `
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, raw_app_meta_data jsonb NOT NULL DEFAULT '{}');
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt() ->> 'sub')::uuid $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ${hasAdminRole}

    CREATE TABLE public.businesses (id uuid PRIMARY KEY, owner_id uuid NOT NULL);
    GRANT SELECT ON public.businesses TO authenticated, service_role;
    ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "owner reads business" ON public.businesses FOR SELECT USING (owner_id = auth.uid());
    CREATE POLICY "service reads business" ON public.businesses FOR SELECT TO service_role USING (true);

    ${pricingTable}
    ALTER TABLE public.growth_pricing ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "growth_pricing_admin_select" ON public.growth_pricing FOR SELECT USING (false);
    ${pricingWritePolicies}
    ${pricingSelect}

    CREATE TABLE public.keyword_campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE);
    CREATE TABLE public.keyword_campaign_responses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES public.keyword_campaigns(id) ON DELETE CASCADE,
      business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      customer_name TEXT,
      responded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (campaign_id, phone));
    ALTER TABLE public.keyword_campaign_responses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "owners_read_responses" ON public.keyword_campaign_responses FOR SELECT
      USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
    ${responseInsertPolicy}

    ${tableGrants}

    INSERT INTO auth.users (id, raw_app_meta_data) VALUES
      ('${USERS.admin}', '{"role":"admin"}'), ('${USERS.support}', '{"role":"support"}'),
      ('${USERS.owner}', '{}'), ('${USERS.other}', '{}');
    INSERT INTO public.businesses VALUES ('${BIZ}', '${USERS.owner}'), ('${OTHER_BIZ}', '${USERS.other}');
    INSERT INTO public.keyword_campaigns (id, business_id) VALUES ('${CAMPAIGN}', '${BIZ}');
    INSERT INTO public.growth_pricing (id, country_code, channel, currency, credit_cost, effective_date)
      VALUES ('${PRICE}', 'NG', 'whatsapp', 'NGN', 5, DATE '2026-01-01');
    INSERT INTO public.keyword_campaign_responses (id, campaign_id, business_id, phone)
      VALUES ('${RESPONSE}', '${CAMPAIGN}', '${BIZ}', '+2340000000001');`;
}

const SELECT_ACL = `
  SELECT c.relname || ':' || (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) AS g
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid IN ('public.growth_pricing'::regclass, 'public.keyword_campaign_responses'::regclass)
    AND a.privilege_type = 'SELECT'
  ORDER BY 1`;
const SELECT_POLICIES = `
  SELECT tablename || '|' || policyname || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') AS p
  FROM pg_policies WHERE tablename IN ('growth_pricing', 'keyword_campaign_responses') AND cmd = 'SELECT'
  ORDER BY 1`;

describe('M558 service-role-only writes (real PostgreSQL)', () => {
  let control: pg.Client;
  const clients = {} as Record<State, pg.Client>;
  const databases = {} as Record<State, string>;
  const selectBefore = {} as Record<State, { acl: string[]; policies: string[] }>;

  /** Run fn as an API role (with JWT claims) inside a rolled-back transaction. */
  async function as<T>(state: State, caller: Caller, fn: (q: pg.Client['query']) => Promise<T>): Promise<T> {
    const c = clients[state];
    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL ROLE ${caller.role}`);
      if (caller.sub) {
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: caller.sub, aal: caller.aal ?? 'aal2' })]);
      }
      return await fn(c.query.bind(c) as pg.Client['query']);
    } finally {
      await c.query('ROLLBACK');
    }
  }
  /** Run fn as service_role inside a rolled-back transaction. */
  async function asService<T>(state: State, fn: (q: pg.Client['query']) => Promise<T>): Promise<T> {
    const c = clients[state];
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE service_role');
      return await fn(c.query.bind(c) as pg.Client['query']);
    } finally {
      await c.query('ROLLBACK');
    }
  }
  async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
    try { await fn(); } catch (err) { return err as DbError; }
    return {};
  }
  const user = (name: keyof typeof USERS): Caller => ({ role: 'authenticated', sub: USERS[name] });
  const API_CALLERS: Array<[string, Caller]> = [
    ['anon', { role: 'anon' }], ['admin', user('admin')], ['support', user('support')],
    ['owner', user('owner')], ['other', user('other')],
  ];

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url });
    await control.connect();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query('ALTER ROLE service_role BYPASSRLS');
    for (const state of STATES) {
      databases[state] = `m558_${state}_${randomUUID().replaceAll('-', '')}`;
      await control.query(`CREATE DATABASE ${databases[state]}`);
      const target = new URL(url!); target.pathname = `/${databases[state]}`;
      clients[state] = new pg.Client({ connectionString: target.toString(), statement_timeout: 5000 });
      await clients[state].connect();
      await clients[state].query(fixture(state));
      selectBefore[state] = {
        acl: (await clients[state].query(SELECT_ACL)).rows.map(r => r.g),
        policies: (await clients[state].query(SELECT_POLICIES)).rows.map(r => r.p),
      };
      await clients[state].query(M558);
      await clients[state].query(M558);
    }
  }, 60_000);

  afterAll(async () => {
    for (const state of STATES) {
      await clients[state]?.end();
      if (databases[state]) await control?.query(`DROP DATABASE IF EXISTS ${databases[state]} WITH (FORCE)`);
    }
    await control?.end();
  }, 60_000);

  for (const state of STATES) {
    describe(`starting from ${state} grants`, () => {
      const q = (text: string, params?: unknown[]) => clients[state].query(text, params);

      it('anon and every signed-in user (admin included) cannot insert, update or delete growth_pricing', async () => {
        const writes = [
          `INSERT INTO public.growth_pricing (country_code, channel, currency, effective_date) VALUES ('GB', 'sms', 'GBP', DATE '2026-02-01')`,
          `UPDATE public.growth_pricing SET credit_cost = 0 WHERE id = '${PRICE}'`,
          `DELETE FROM public.growth_pricing WHERE id = '${PRICE}'`,
          `TRUNCATE public.growth_pricing`,
        ];
        for (const [label, caller] of API_CALLERS) {
          for (const sql of writes) {
            expect((await errorOf(() => as(state, caller, run => run(sql)))).code, `${label}: ${sql}`).toBe('42501');
          }
        }
        expect((await q(`SELECT credit_cost FROM public.growth_pricing`)).rows).toEqual([{ credit_cost: 5 }]);
      });

      it('anon and every signed-in user cannot insert, update or delete keyword_campaign_responses', async () => {
        const writes = [
          `INSERT INTO public.keyword_campaign_responses (campaign_id, business_id, phone) VALUES ('${CAMPAIGN}', '${BIZ}', '+2340000000002')`,
          `INSERT INTO public.keyword_campaign_responses (campaign_id, business_id, phone) VALUES ('${CAMPAIGN}', '${BIZ}', '+2340000000003') ON CONFLICT (campaign_id, phone) DO NOTHING`,
          `UPDATE public.keyword_campaign_responses SET customer_name = 'x' WHERE id = '${RESPONSE}'`,
          `DELETE FROM public.keyword_campaign_responses WHERE id = '${RESPONSE}'`,
          `TRUNCATE public.keyword_campaign_responses`,
        ];
        for (const [label, caller] of API_CALLERS) {
          for (const sql of writes) {
            expect((await errorOf(() => as(state, caller, run => run(sql)))).code, `${label}: ${sql}`).toBe('42501');
          }
        }
        expect((await q(`SELECT count(*)::int AS n FROM public.keyword_campaign_responses`)).rows[0].n).toBe(1);
      });

      it('service_role can insert and update growth_pricing', async () => {
        await asService(state, async run => {
          expect((await run(`INSERT INTO public.growth_pricing (country_code, channel, currency, credit_cost, effective_date)
            VALUES ('GB', 'sms', 'GBP', 7, DATE '2026-02-01')`)).rowCount).toBe(1);
          expect((await run(`UPDATE public.growth_pricing SET credit_cost = 6 WHERE id = '${PRICE}'`)).rowCount).toBe(1);
          expect((await run(`SELECT country_code, credit_cost FROM public.growth_pricing ORDER BY country_code`)).rows)
            .toEqual([{ country_code: 'GB', credit_cost: 7 }, { country_code: 'NG', credit_cost: 6 }]);
        });
      });

      it('service_role can record a keyword response (bot upsert, duplicate ignored) and update it', async () => {
        await asService(state, async run => {
          const upsert = `INSERT INTO public.keyword_campaign_responses (campaign_id, business_id, phone, responded_at)
            VALUES ('${CAMPAIGN}', '${BIZ}', $1, now()) ON CONFLICT (campaign_id, phone) DO NOTHING`;
          expect((await run(upsert, ['+2340000000009'])).rowCount).toBe(1);
          expect((await run(upsert, ['+2340000000009'])).rowCount).toBe(0);
          expect((await run(`UPDATE public.keyword_campaign_responses SET customer_name = 'Ada' WHERE id = '${RESPONSE}'`)).rowCount).toBe(1);
          expect((await run(`SELECT count(*)::int AS n FROM public.keyword_campaign_responses`)).rows[0].n).toBe(2);
        });
      });

      it('admin roles (aal2) still read growth_pricing; aal1 and non-admins read nothing', async () => {
        for (const name of ['admin', 'support'] as const) {
          const { rows } = await as(state, user(name), run => run(`SELECT id FROM public.growth_pricing`));
          expect(rows, name).toEqual([{ id: PRICE }]);
        }
        expect((await as(state, { role: 'authenticated', sub: USERS.admin, aal: 'aal1' },
          run => run(`SELECT id FROM public.growth_pricing`))).rowCount).toBe(0);
        expect((await as(state, user('owner'), run => run(`SELECT id FROM public.growth_pricing`))).rowCount).toBe(0);
      });

      it('business owners still read only their own campaign responses', async () => {
        expect((await as(state, user('owner'), run => run(`SELECT id FROM public.keyword_campaign_responses`))).rows)
          .toEqual([{ id: RESPONSE }]);
        expect((await as(state, user('other'), run => run(`SELECT id FROM public.keyword_campaign_responses`))).rowCount).toBe(0);
      });

      it('SELECT grants and SELECT policies are exactly as before the migration', async () => {
        expect((await q(SELECT_ACL)).rows.map(r => r.g)).toEqual(selectBefore[state].acl);
        expect((await q(SELECT_POLICIES)).rows.map(r => r.p)).toEqual(selectBefore[state].policies);
        expect(selectBefore[state].policies).toContain('growth_pricing|growth_pricing_admin_select|authenticated|has_admin_role(ARRAY[\'admin\'::text, \'support\'::text, \'finance\'::text, \'operations\'::text])');
      });

      it('no API role holds a write privilege, and every write policy is TO service_role', async () => {
        for (const table of TABLES) {
          for (const role of ['anon', 'authenticated']) {
            for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
              const { rows } = await q(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, `public.${table}`, priv]);
              expect(rows[0].ok, `${role} ${priv} ${table}`).toBe(false);
            }
          }
          const { rows } = await q(`SELECT
            has_table_privilege('service_role', $1, 'INSERT') AND has_table_privilege('service_role', $1, 'UPDATE') AS ok`, [`public.${table}`]);
          expect(rows[0].ok, `service_role ${table}`).toBe(true);
        }
        const { rows } = await q(`SELECT tablename || '|' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') AS p
          FROM pg_policies WHERE tablename IN ('growth_pricing', 'keyword_campaign_responses') AND cmd <> 'SELECT' ORDER BY 1`);
        expect(rows.map(r => r.p)).toEqual([
          'growth_pricing|growth_pricing_service_insert|INSERT|service_role',
          'growth_pricing|growth_pricing_service_update|UPDATE|service_role',
          'keyword_campaign_responses|service_insert_responses|INSERT|service_role',
        ]);
      });

      it('the self-check raises if a write grant or an open write policy comes back', async () => {
        const selfCheck = M558.slice(M558.indexOf('DO $$'));
        await q('BEGIN');
        try {
          await q('GRANT INSERT ON public.growth_pricing TO anon');
          expect((await errorOf(() => q(selfCheck))).message).toContain('anon can still write public.growth_pricing');
        } finally { await q('ROLLBACK'); }
        await q('BEGIN');
        try {
          await q('GRANT UPDATE ON public.keyword_campaign_responses TO PUBLIC');
          expect((await errorOf(() => q(selfCheck))).message).toContain('can still write public.keyword_campaign_responses');
        } finally { await q('ROLLBACK'); }
        await q('BEGIN');
        try {
          await q(`CREATE POLICY "open_update" ON public.keyword_campaign_responses FOR UPDATE USING (true)`);
          expect((await errorOf(() => q(selfCheck))).message).toContain('keyword_campaign_responses.open_update');
        } finally { await q('ROLLBACK'); }
        await q('BEGIN');
        try {
          await q('REVOKE INSERT ON public.growth_pricing FROM service_role');
          expect((await errorOf(() => q(selfCheck))).message).toContain('service_role lost write access to public.growth_pricing');
        } finally { await q('ROLLBACK'); }
        expect((await errorOf(() => q(selfCheck))).code).toBeUndefined();
      });
    });
  }
});
