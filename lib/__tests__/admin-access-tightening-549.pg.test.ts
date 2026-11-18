/**
 * M549 — admin panel database access. Real PostgreSQL proof (disposable local
 * databases, created and dropped here).
 *
 * Fixture: the canonical has_admin_role()/is_admin() from M439 (from disk), with
 * auth.jwt()/auth.uid() read from request.jwt.claims as in Supabase;
 * admin_role_permissions with its M439 policies; payout_accounts and
 * business_bank_accounts with their final policies; and
 * get_effective_commercial_config() from M377 (from disk). Table ACLs differ by
 * environment, so M549 is applied from disk (twice, idempotency) over two starting
 * states: "history" (the grants in migration history) and "broad" (every privilege
 * for every API role, as Supabase default privileges give a new table). Both must
 * end in the same exact grants.
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
if (!url) throw new Error('Disposable PostgreSQL required for M549 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');

const migration = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');
const ALL = 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER';
const STATES = ['history', 'broad'] as const;
type State = typeof STATES[number];

const USERS = {
  admin: '00000000-0000-0000-0000-0000000005a1',
  support: '00000000-0000-0000-0000-0000000005a2',
  finance: '00000000-0000-0000-0000-0000000005a3',
  operations: '00000000-0000-0000-0000-0000000005a4',
  owner: '00000000-0000-0000-0000-0000000005a5',
  other: '00000000-0000-0000-0000-0000000005a6',
};
const BIZ = '00000000-0000-0000-0000-0000000005b1';
const PAYOUT = '00000000-0000-0000-0000-0000000005c1';
const BANK = '00000000-0000-0000-0000-0000000005c2';
const PERM = '00000000-0000-0000-0000-0000000005d1';

type Caller = { role: 'anon' | 'authenticated'; sub?: string; aal?: string };
type DbError = { code?: string; message?: string };

const PAYOUT_COLUMNS = ['account_name', 'account_number_last4', 'bank_code', 'bank_name', 'business_id', 'created_at', 'gateway',
  'id', 'is_active', 'platform_percentage', 'square_merchant_id', 'updated_at', 'verified_at'];
const BANK_COLUMNS = ['account_name', 'account_number_last4', 'bank_code', 'bank_name', 'business_id', 'created_at', 'id',
  'is_active', 'is_default', 'updated_at'];

function fixture(state: State): string {
  const m439 = migration('439_admin_mfa_enforcement.sql');
  const start = m439.indexOf('CREATE OR REPLACE FUNCTION public.has_admin_role(required_roles text[])');
  const end = m439.indexOf('-- §4. Rewrite is_support()');
  if (start < 0 || end <= start) throw new Error('Canonical M439 section markers changed');
  const m377 = migration('377_dynamic_market_controls.sql');
  const fStart = m377.indexOf('CREATE OR REPLACE FUNCTION public.get_effective_commercial_config()');
  const fEnd = m377.indexOf('-- B3. Guard');
  if (fStart < 0 || fEnd <= fStart) throw new Error('Canonical M377 section markers changed');

  const tableGrants = state === 'broad'
    ? `GRANT ${ALL} ON public.admin_role_permissions, public.payout_accounts, public.business_bank_accounts TO anon, authenticated, service_role;`
    : `GRANT ${ALL} ON public.admin_role_permissions TO anon, authenticated, service_role;
       GRANT SELECT (id, business_id, gateway, bank_code, bank_name, account_number, account_name, square_merchant_id,
         platform_percentage, is_active, verified_at, created_at, updated_at) ON public.payout_accounts TO authenticated;
       GRANT ALL ON public.payout_accounts TO service_role;
       GRANT SELECT ON public.business_bank_accounts TO authenticated;
       GRANT SELECT, INSERT, UPDATE ON public.business_bank_accounts TO service_role;`;

  return `
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, raw_app_meta_data jsonb NOT NULL DEFAULT '{}');
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt() ->> 'sub')::uuid $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ${m439.slice(start, end)}

    CREATE TABLE public.businesses (id uuid PRIMARY KEY, owner_id uuid NOT NULL);
    GRANT SELECT ON public.businesses TO authenticated, service_role;

    CREATE TABLE public.admin_role_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text NOT NULL, resource text NOT NULL,
      can_read boolean NOT NULL DEFAULT true, can_write boolean NOT NULL DEFAULT false,
      can_delete boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(), UNIQUE (role, resource));
    ALTER TABLE public.admin_role_permissions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Admin manages permissions" ON public.admin_role_permissions FOR ALL TO authenticated
      USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));
    CREATE POLICY "Admin roles read permissions" ON public.admin_role_permissions FOR SELECT TO authenticated
      USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

    CREATE TABLE public.payout_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id),
      gateway varchar(20) NOT NULL, subaccount_code varchar(100), stripe_account_id varchar(100),
      bank_code varchar(10), bank_name varchar(100), account_number varchar(20), account_name varchar(200),
      platform_percentage numeric, is_active boolean DEFAULT true, verified_at timestamptz,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      square_merchant_id text, square_access_token text, country_code text, iban text, routing_number text, swift_code text);
    ALTER TABLE public.payout_accounts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Business owners can view own payout accounts" ON public.payout_accounts FOR SELECT
      USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
    CREATE POLICY "Admins can view all payout accounts" ON public.payout_accounts FOR SELECT TO authenticated
      USING (public.is_admin());

    CREATE TABLE public.business_bank_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES public.businesses(id),
      bank_name varchar(100) NOT NULL, account_number varchar(20) NOT NULL, account_name varchar(200) NOT NULL,
      bank_code varchar(10), is_default boolean DEFAULT true, is_active boolean DEFAULT true,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    ALTER TABLE public.business_bank_accounts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Admin reads bank accounts" ON public.business_bank_accounts FOR SELECT TO authenticated
      USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));
    CREATE POLICY "Service role manages bank accounts" ON public.business_bank_accounts FOR ALL TO service_role
      WITH CHECK (true);

    ${tableGrants}

    CREATE TABLE public.platform_config_versions (id uuid PRIMARY KEY, config_snapshot jsonb, effective_from timestamptz);
    ${m377.slice(fStart, fEnd)}

    INSERT INTO auth.users (id, raw_app_meta_data) VALUES
      ('${USERS.admin}', '{"role":"admin"}'), ('${USERS.support}', '{"role":"support"}'),
      ('${USERS.finance}', '{"role":"finance"}'), ('${USERS.operations}', '{"role":"operations"}'),
      ('${USERS.owner}', '{}'), ('${USERS.other}', '{}');
    INSERT INTO public.businesses VALUES ('${BIZ}', '${USERS.owner}');
    INSERT INTO public.admin_role_permissions (id, role, resource, can_read, can_write, can_delete)
      VALUES ('${PERM}', 'support', 'payouts', false, false, false);
    INSERT INTO public.payout_accounts (id, business_id, gateway, bank_name, account_number, account_name)
      VALUES ('${PAYOUT}', '${BIZ}', 'paystack', 'Synthetic Bank', '0123456789', 'Synthetic Merchant');
    INSERT INTO public.business_bank_accounts (id, business_id, bank_name, account_number, account_name)
      VALUES ('${BANK}', '${BIZ}', 'Synthetic Bank', '9876543210', 'Synthetic Merchant');`;
}

describe('M549 admin access tightening (real PostgreSQL)', () => {
  let control: pg.Client;
  const clients = {} as Record<State, pg.Client>;
  const databases = {} as Record<State, string>;

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
  async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
    try { await fn(); } catch (err) { return err as DbError; }
    return {};
  }
  const staff = (name: keyof typeof USERS, aal = 'aal2'): Caller => ({ role: 'authenticated', sub: USERS[name], aal });

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url });
    await control.connect();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query('ALTER ROLE service_role BYPASSRLS');
    for (const state of STATES) {
      databases[state] = `m549_${state}_${randomUUID().replaceAll('-', '')}`;
      await control.query(`CREATE DATABASE ${databases[state]}`);
      const target = new URL(url!); target.pathname = `/${databases[state]}`;
      clients[state] = new pg.Client({ connectionString: target.toString(), statement_timeout: 5000 });
      await clients[state].connect();
      await clients[state].query(fixture(state));
      await clients[state].query(migration('549_admin_access_tightening.sql'));
      await clients[state].query(migration('549_admin_access_tightening.sql'));
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

      // ── §1 admin_role_permissions ─────────────────────────────────────────
      it('every admin role (aal2) still reads the permission table; others read nothing', async () => {
        for (const name of ['admin', 'support', 'finance', 'operations'] as const) {
          const { rowCount } = await as(state, staff(name), run => run('SELECT 1 FROM public.admin_role_permissions'));
          expect(rowCount, name).toBe(1);
        }
        expect((await as(state, staff('admin', 'aal1'), run => run('SELECT 1 FROM public.admin_role_permissions'))).rowCount).toBe(0);
        expect((await as(state, staff('other'), run => run('SELECT 1 FROM public.admin_role_permissions'))).rowCount).toBe(0);
      });

      it('only a full admin (aal2) can insert, update or delete permission rows', async () => {
        const insert = (run: pg.Client['query']) =>
          run(`INSERT INTO public.admin_role_permissions (role, resource, can_read, can_write) VALUES ('support', 'settings', true, true)`);
        const update = (run: pg.Client['query']) =>
          run(`UPDATE public.admin_role_permissions SET can_read = true, can_write = true, can_delete = true WHERE id = '${PERM}'`);
        const remove = (run: pg.Client['query']) => run(`DELETE FROM public.admin_role_permissions WHERE id = '${PERM}'`);

        expect((await as(state, staff('admin'), insert)).rowCount).toBe(1);
        expect((await as(state, staff('admin'), update)).rowCount).toBe(1);
        expect((await as(state, staff('admin'), remove)).rowCount).toBe(1);

        const refused: Caller[] = [staff('support'), staff('finance'), staff('operations'), staff('admin', 'aal1'), staff('other')];
        for (const caller of refused) {
          const label = `${caller.sub} ${caller.aal}`;
          expect((await errorOf(() => as(state, caller, insert))).code, label).toBe('42501');
          expect((await as(state, caller, update)).rowCount, label).toBe(0);
          expect((await as(state, caller, remove)).rowCount, label).toBe(0);
        }
        const { rows } = await q(`SELECT can_read, can_write, can_delete FROM public.admin_role_permissions WHERE id = '${PERM}'`);
        expect(rows).toEqual([{ can_read: false, can_write: false, can_delete: false }]);
        expect((await q(`SELECT count(*)::int AS n FROM public.admin_role_permissions`)).rows[0].n).toBe(1);
      });

      it('anon has no rights on the permission table', async () => {
        for (const sql of ['SELECT 1 FROM public.admin_role_permissions',
          `INSERT INTO public.admin_role_permissions (role, resource) VALUES ('support', 'team')`,
          `DELETE FROM public.admin_role_permissions`]) {
          expect((await errorOf(() => as(state, { role: 'anon' }, run => run(sql)))).code, sql).toBe('42501');
        }
      });

      it('admin_role_permissions grants and policies are exact', async () => {
        const { rows } = await q(`
          SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) || ':' || a.privilege_type AS g
          FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
          WHERE c.oid = 'public.admin_role_permissions'::regclass
            AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'))
          ORDER BY 1`);
        expect(rows.map(r => r.g)).toEqual(['authenticated:DELETE', 'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE']);
        const policies = await q(`SELECT policyname, cmd, qual, with_check FROM pg_policies
          WHERE tablename = 'admin_role_permissions' ORDER BY policyname`);
        expect(policies.rows.map(p => `${p.policyname}|${p.cmd}`)).toEqual([
          'Admin deletes permissions|DELETE', 'Admin inserts permissions|INSERT',
          'Admin roles read permissions|SELECT', 'Admin updates permissions|UPDATE',
        ]);
        for (const p of policies.rows.filter(r => r.cmd !== 'SELECT')) {
          expect(`${p.qual ?? ''}${p.with_check ?? ''}`).not.toContain('has_admin_role');
        }
      });

      // ── §2 masked account numbers ─────────────────────────────────────────
      it('browser sessions read only the last four digits of payout and bank account numbers', async () => {
        const owner = await as(state, { role: 'authenticated', sub: USERS.owner, aal: 'aal1' },
          run => run(`SELECT account_number_last4 FROM public.payout_accounts`));
        expect(owner.rows).toEqual([{ account_number_last4: '6789' }]);
        const admin = await as(state, staff('admin'), run => run(`SELECT account_number_last4 FROM public.payout_accounts`));
        expect(admin.rows).toEqual([{ account_number_last4: '6789' }]);
        for (const name of ['admin', 'support', 'finance', 'operations'] as const) {
          const bank = await as(state, staff(name), run => run(`SELECT account_number_last4 FROM public.business_bank_accounts`));
          expect(bank.rows, name).toEqual([{ account_number_last4: '3210' }]);
        }

        const full: Array<[Caller, string]> = [
          [{ role: 'authenticated', sub: USERS.owner, aal: 'aal1' }, 'SELECT account_number FROM public.payout_accounts'],
          [staff('admin'), 'SELECT account_number FROM public.payout_accounts'],
          [staff('admin'), 'SELECT * FROM public.payout_accounts'],
          [staff('support'), 'SELECT account_number FROM public.business_bank_accounts'],
          [staff('finance'), 'SELECT * FROM public.business_bank_accounts'],
          [{ role: 'anon' }, 'SELECT account_number_last4 FROM public.payout_accounts'],
          [{ role: 'anon' }, 'SELECT account_number_last4 FROM public.business_bank_accounts'],
        ];
        for (const [caller, sql] of full) {
          expect((await errorOf(() => as(state, caller, run => run(sql)))).code, `${caller.sub ?? caller.role} ${sql}`).toBe('42501');
        }
      });

      it('server routes (service_role) keep the full number; the last four follow a change and never expose a short number', async () => {
        await clients[state].query('BEGIN');
        try {
          await q('SET LOCAL ROLE service_role');
          expect((await q(`SELECT account_number FROM public.payout_accounts`)).rows).toEqual([{ account_number: '0123456789' }]);
          expect((await q(`SELECT account_number FROM public.business_bank_accounts`)).rows).toEqual([{ account_number: '9876543210' }]);
          await q(`UPDATE public.payout_accounts SET account_number = '5550001111' WHERE id = '${PAYOUT}'`);
          // Four characters or fewer: '' so a short number is never shown whole.
          await q(`INSERT INTO public.business_bank_accounts (business_id, bank_name, account_number, account_name)
            VALUES ('${BIZ}', 'Second Bank', '4444', 'Synthetic Merchant'), ('${BIZ}', 'Third Bank', '54321', 'Synthetic Merchant')`);
          expect((await q(`SELECT account_number_last4 FROM public.payout_accounts`)).rows).toEqual([{ account_number_last4: '1111' }]);
          expect((await q(`SELECT account_number_last4 FROM public.business_bank_accounts ORDER BY bank_name`)).rows)
            .toEqual([{ account_number_last4: '' }, { account_number_last4: '3210' }, { account_number_last4: '4321' }]);
          await q(`UPDATE public.payout_accounts SET account_number = NULL WHERE id = '${PAYOUT}'`);
          expect((await q(`SELECT account_number_last4 FROM public.payout_accounts`)).rows).toEqual([{ account_number_last4: null }]);
        } finally { await q('ROLLBACK'); }
      });

      it('authenticated column grants are exactly the masked lists; anon has none', async () => {
        const cols = async (table: string, role: string) => (await q(`
          SELECT attname FROM pg_attribute
          WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
            AND has_column_privilege($2, attrelid, attnum, 'SELECT')
          ORDER BY attname`, [`public.${table}`, role])).rows.map(r => r.attname);
        expect(await cols('payout_accounts', 'authenticated')).toEqual(PAYOUT_COLUMNS);
        expect(await cols('business_bank_accounts', 'authenticated')).toEqual(BANK_COLUMNS);
        expect(await cols('payout_accounts', 'anon')).toEqual([]);
        expect(await cols('business_bank_accounts', 'anon')).toEqual([]);
        for (const table of ['payout_accounts', 'business_bank_accounts']) {
          const { rows } = await q(`SELECT has_table_privilege('authenticated', $1, 'SELECT') AS t`, [`public.${table}`]);
          expect(rows[0].t, table).toBe(false);
        }
      });

      // ── §3 commercial config function ────────────────────────────────────
      it('the commercial-config SECURITY DEFINER function is gone from every schema', async () => {
        const { rows } = await q(`SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'get_effective_commercial_config'`);
        expect(rows).toEqual([]);
        expect((await errorOf(() => as(state, staff('admin'), run => run('SELECT * FROM public.get_effective_commercial_config()')))).code)
          .toBe('42883');
      });
    });
  }
});
