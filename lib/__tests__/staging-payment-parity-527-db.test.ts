/**
 * #527 / Migration 426 — staging payment setup parity, role-faithful PostgreSQL proofs.
 *
 * Runs against a fully migrated database (scripts/ci-bootstrap-test-db.sh), which —
 * like staging — has no public-schema default privileges, so every privilege a
 * role has on these tables comes from the migrations themselves.
 *
 * Statements run under the real roles (SET ROLE service_role / authenticated /
 * anon, with request.jwt.claims for auth.uid()). Application code paths
 * (classifyBusinessPaymentCredential, resolvePaymentRoutingAuthority,
 * triggerSequences) run unmodified against PostgreSQL through a minimal
 * PostgREST-shaped client (pgRoleClient below), so their results reflect the
 * real schema, RLS and grants rather than mocks.
 *
 * Requires TEST_DATABASE_URL. CI wires this in migration-shard-b.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyBusinessPaymentCredential } from '@/lib/payments/saved-card-compat';
import { resolvePaymentRoutingAuthority } from '@/lib/payments/resolve-stripe-routing';
import { triggerSequences } from '@/lib/bot/automation/sequence-service';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;
const MIGRATION = join(__dirname, '../../supabase/migrations/426_staging_payment_setup_parity.sql');

// Deterministic UUIDs — no collision with other suites
const OWNER_A = '00000000-0000-4426-a000-000000000001';
const OWNER_B = '00000000-0000-4426-a000-000000000002';
const BIZ_A = '00000000-0000-4426-b000-000000000001'; // empty credentials → platform
const BIZ_B = '00000000-0000-4426-b000-000000000002'; // owned by B
const BIZ_SUB = '00000000-0000-4426-b000-000000000003';
const BIZ_CONNECT = '00000000-0000-4426-b000-000000000004';
const BIZ_BYO = '00000000-0000-4426-b000-000000000005';
const BIZ_AMBIG = '00000000-0000-4426-b000-000000000006';
const BIZ_INACTIVE = '00000000-0000-4426-b000-000000000007';
const PAYMENT_A = '00000000-0000-4426-c000-000000000001';
const SEQ_A = '00000000-0000-4426-d000-000000000001';
const SEQ_A_INACTIVE = '00000000-0000-4426-d000-000000000002';
const SEQ_B = '00000000-0000-4426-d000-000000000003';
const CUSTOMER = '+2348000004260';

// ─── psql helpers ───────────────────────────────────────────────────────────

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30_000,
  }).trim();
}

interface PgError { message: string; code: string }

type Role = 'service_role' | 'authenticated' | 'anon';

interface RoleOpts {
  /** auth.uid() for authenticated */
  sub?: string;
  /** SQL run as postgres inside the same transaction before SET ROLE */
  preamble?: string;
  /** roll the transaction back instead of committing */
  rollback?: boolean;
}

/** Run one statement as a role. Returns parsed JSON output or a SQLSTATE error. */
function runAs(role: Role, statement: string, opts: RoleOpts = {}): { data: unknown; error: PgError | null } {
  const claims = JSON.stringify({ sub: opts.sub ?? null, role });
  const script = [
    '\\set VERBOSITY verbose',
    'BEGIN;',
    opts.preamble ?? '',
    `SET LOCAL ROLE ${role};`,
    `SET LOCAL request.jwt.claims = ${lit(claims)};`,
    statement.trim().replace(/;?$/, ';'),
    opts.rollback ? 'ROLLBACK;' : 'COMMIT;',
  ].join('\n');
  try {
    const out = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: script, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // -q suppresses command tags, so stdout is exactly the final SELECT's JSON
    // (json_agg emits newlines between elements, so parse the whole output).
    return { data: out ? JSON.parse(out) : null, error: null };
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr || err);
    const m = stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+(.*)/);
    return { data: null, error: { code: m?.[1] ?? 'UNKNOWN', message: m?.[2] ?? stderr } };
  }
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsupported identifier: ${name}`);
  return name;
}

// ─── Minimal PostgREST-shaped client over psql (only what the tested code uses) ───

type Filter = string;

class RoleQuery implements PromiseLike<{ data: unknown; error: PgError | null }> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private columns = '*';
  private returning: string | null = null;
  private filters: Filter[] = [];
  private orderBy: string | null = null;
  private limitN: number | null = null;
  private cardinality: 'many' | 'maybeSingle' | 'single' = 'many';
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;

  constructor(private table: string, private role: Role, private opts: RoleOpts) {
    ident(table);
  }

  select(cols = '*') {
    const parsed = cols.split(',').map(c => c.trim()).map(c => (c === '*' ? '*' : ident(c))).join(', ');
    if (this.op === 'select') this.columns = parsed;
    else this.returning = parsed;
    return this;
  }
  insert(values: Record<string, unknown> | Record<string, unknown>[]) { this.op = 'insert'; this.payload = values; return this; }
  update(values: Record<string, unknown>) { this.op = 'update'; this.payload = values; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, v: unknown) { this.filters.push(`${ident(col)} = ${lit(v)}`); return this; }
  in(col: string, vs: unknown[]) { this.filters.push(`${ident(col)} IN (${vs.map(lit).join(', ')})`); return this; }
  not(col: string, op: string, v: unknown) {
    if (op !== 'is' || v !== null) throw new Error('pgRoleClient: only .not(col, "is", null) is supported');
    this.filters.push(`${ident(col)} IS NOT NULL`);
    return this;
  }
  order(col: string, o: { ascending?: boolean } = {}) { this.orderBy = `${ident(col)} ${o.ascending === false ? 'DESC' : 'ASC'}`; return this; }
  limit(n: number) { this.limitN = n; return this; }
  maybeSingle() { this.cardinality = 'maybeSingle'; return this; }
  single() { this.cardinality = 'single'; return this; }

  private sql(): string {
    const where = this.filters.length ? ` WHERE ${this.filters.join(' AND ')}` : '';
    if (this.op === 'select') {
      const order = this.orderBy ? ` ORDER BY ${this.orderBy}` : '';
      const limit = this.limitN !== null ? ` LIMIT ${this.limitN}` : '';
      return `SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT ${this.columns} FROM public.${this.table}${where}${order}${limit}) t`;
    }
    const ret = this.returning ? ` RETURNING ${this.returning}` : '';
    let dml: string;
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const cols = Object.keys(rows[0]).map(ident);
      const values = rows.map(r => `(${cols.map(c => lit(r[c])).join(', ')})`).join(', ');
      dml = `INSERT INTO public.${this.table} (${cols.join(', ')}) VALUES ${values}${ret}`;
    } else if (this.op === 'update') {
      const sets = Object.entries(this.payload as Record<string, unknown>).map(([k, v]) => `${ident(k)} = ${lit(v)}`).join(', ');
      dml = `UPDATE public.${this.table} SET ${sets}${where}${ret}`;
    } else {
      dml = `DELETE FROM public.${this.table}${where}${ret}`;
    }
    // Without .select() PostgREST uses return=minimal (no RETURNING → no SELECT privilege needed)
    return this.returning
      ? `WITH r AS (${dml}) SELECT coalesce(json_agg(r), '[]'::json) FROM r`
      : `${dml}; SELECT '[]'::json`;
  }

  private execute(): { data: unknown; error: PgError | null } {
    const res = runAs(this.role, this.sql(), this.opts);
    if (res.error) return res;
    const rows = res.data as unknown[];
    if (this.cardinality === 'many') return { data: rows, error: null };
    if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
    if (rows.length === 0 && this.cardinality === 'single') return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    return { data: rows[0] ?? null, error: null };
  }

  then<R1 = { data: unknown; error: PgError | null }, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: PgError | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
  }
}

function pgRoleClient(role: Role, opts: RoleOpts = {}): SupabaseClient {
  return { from: (table: string) => new RoleQuery(table, role, opts) } as unknown as SupabaseClient;
}

// ─── Catalog helpers ────────────────────────────────────────────────────────

function hasTablePriv(role: Role, table: string, priv: string): boolean {
  return psql(`SELECT has_table_privilege('${role}', 'public.${table}', '${priv}');`) === 't';
}

function hasColumnPriv(role: Role, table: string, col: string, priv: string): boolean {
  return psql(`SELECT has_column_privilege('${role}', 'public.${table}', '${col}', '${priv}');`) === 't';
}

function aclSnapshot(): string {
  return psql(`
    SELECT json_build_object(
      'rel', (SELECT json_agg(json_build_object('t', relname, 'acl', relacl::text, 'rls', relrowsecurity) ORDER BY relname)
              FROM pg_class WHERE relnamespace = 'public'::regnamespace
                AND relname IN ('business_payment_credentials','bot_sequences','bot_sequence_steps',
                                'bot_sequence_enrollments','platform_fees','payment_confirmation_deliveries')),
      'col', (SELECT json_agg(json_build_object('c', attname, 'acl', attacl::text) ORDER BY attname)
              FROM pg_attribute WHERE attrelid = 'public.business_payment_credentials'::regclass AND attacl IS NOT NULL),
      'pol', (SELECT json_agg(json_build_object('p', policyname, 'cmd', cmd, 'roles', roles::text, 'qual', qual) ORDER BY policyname)
              FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_payment_credentials'),
      'con', (SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname)
              FROM pg_constraint WHERE conrelid = 'public.business_payment_credentials'::regclass)
    );`);
}

const migrationSql = canRun ? readFileSync(MIGRATION, 'utf-8') : '';

// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!canRun)('#527 / M426 staging payment setup parity (role-faithful PostgreSQL)', () => {
  beforeAll(() => {
    psql(`
      INSERT INTO auth.users (id, email) VALUES
        ('${OWNER_A}', 'owner-a-426@waaiio.test'), ('${OWNER_B}', 'owner-b-426@waaiio.test')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO businesses (id, name, slug, owner_id, address, city, phone, country_code) VALUES
        ('${BIZ_A}', 'T426 A', 't426-a', '${OWNER_A}', '1 Test', 'Lagos', '+2348000004261', 'NG'),
        ('${BIZ_B}', 'T426 B', 't426-b', '${OWNER_B}', '2 Test', 'Lagos', '+2348000004262', 'NG'),
        ('${BIZ_SUB}', 'T426 Sub', 't426-sub', '${OWNER_A}', '3 Test', 'Lagos', '+2348000004263', 'NG'),
        ('${BIZ_CONNECT}', 'T426 Connect', 't426-connect', '${OWNER_A}', '4 Test', 'Lagos', '+2348000004264', 'NG'),
        ('${BIZ_BYO}', 'T426 BYO', 't426-byo', '${OWNER_A}', '5 Test', 'Lagos', '+2348000004265', 'NG'),
        ('${BIZ_AMBIG}', 'T426 Ambiguous', 't426-ambig', '${OWNER_A}', '6 Test', 'Lagos', '+2348000004266', 'NG'),
        ('${BIZ_INACTIVE}', 'T426 Inactive', 't426-inactive', '${OWNER_A}', '7 Test', 'Lagos', '+2348000004267', 'NG')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO payments (id, business_id, amount, gateway_reference, status)
      VALUES ('${PAYMENT_A}', '${BIZ_A}', 5000, 'ref-426-a', 'success')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO bot_sequences (id, business_id, name, trigger_event, is_active) VALUES
        ('${SEQ_A}', '${BIZ_A}', 'After order A', 'after_order', true),
        ('${SEQ_A_INACTIVE}', '${BIZ_A}', 'Inactive A', 'after_order', false),
        ('${SEQ_B}', '${BIZ_B}', 'After order B', 'after_order', true)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO bot_sequence_steps (sequence_id, step_order, delay_minutes, message_content)
      SELECT s, 0, 30, 'Thanks {customer_name}' FROM unnest(ARRAY['${SEQ_A}'::uuid, '${SEQ_B}'::uuid]) s
      WHERE NOT EXISTS (SELECT 1 FROM bot_sequence_steps WHERE sequence_id = s);
    `);
  });

  // ── 1. Exact privilege matrix ─────────────────────────────────────────────
  describe('privilege matrix (catalog)', () => {
    const NONE_EXTRA = ['TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const matrix: Record<string, Record<Role, string[]>> = {
      business_payment_credentials: { service_role: ['SELECT', 'INSERT', 'UPDATE'], authenticated: [], anon: [] },
      bot_sequences: { service_role: ['SELECT'], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], anon: [] },
      bot_sequence_steps: { service_role: ['SELECT'], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], anon: [] },
      bot_sequence_enrollments: { service_role: ['SELECT', 'INSERT', 'UPDATE'], authenticated: ['SELECT'], anon: [] },
      platform_fees: { service_role: ['SELECT', 'INSERT'], authenticated: [], anon: [] },
      payment_confirmation_deliveries: { service_role: ['SELECT'], authenticated: [], anon: [] },
    };

    for (const [table, roles] of Object.entries(matrix)) {
      for (const role of ['service_role', 'authenticated', 'anon'] as Role[]) {
        it(`${table}: ${role} has exactly [${roles[role].join(', ') || 'none'}] at table level`, () => {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', ...NONE_EXTRA]) {
            expect({ priv, held: hasTablePriv(role, table, priv) })
              .toEqual({ priv, held: roles[role].includes(priv) });
          }
        });
      }
    }

    it('business_payment_credentials: authenticated can SELECT only the non-secret metadata columns', () => {
      const allowed = ['id', 'business_id', 'gateway', 'platform_subaccount_code', 'connect_account_id',
        'connection_type', 'is_active', 'verified_at', 'created_at'];
      const denied = ['secret_key', 'public_key', 'updated_at'];
      for (const c of allowed) expect({ c, ok: hasColumnPriv('authenticated', 'business_payment_credentials', c, 'SELECT') }).toEqual({ c, ok: true });
      for (const c of denied) expect({ c, ok: hasColumnPriv('authenticated', 'business_payment_credentials', c, 'SELECT') }).toEqual({ c, ok: false });
      for (const c of [...allowed, ...denied]) {
        for (const p of ['INSERT', 'UPDATE']) {
          expect({ c, p, ok: hasColumnPriv('authenticated', 'business_payment_credentials', c, p) }).toEqual({ c, p, ok: false });
        }
      }
      expect(psql(`SELECT has_any_column_privilege('anon', 'public.business_payment_credentials', 'SELECT');`)).toBe('f');
    });

    it('business_payment_credentials: RLS enabled with a single owner SELECT policy for authenticated', () => {
      expect(psql(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.business_payment_credentials'::regclass;`)).toBe('t');
      expect(psql(`SELECT string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ';') FROM pg_policies WHERE tablename = 'business_payment_credentials';`))
        .toBe('bpc_owner_select:SELECT:authenticated');
    });

    it('sequence RLS policies from M040 are unchanged', () => {
      expect(psql(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ';' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename LIKE 'bot_sequence%';`))
        .toBe('bot_sequence_enrollments:owner_view:SELECT;bot_sequence_enrollments:service_role_all:ALL;bot_sequence_steps:owner_crud:ALL;bot_sequences:owner_crud:ALL');
    });
  });

  // ── 2. Credential schema contract ─────────────────────────────────────────
  describe('business_payment_credentials schema contract', () => {
    it('has the production-compatible constraints and partial unique index', () => {
      const cons = psql(`SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), E'\\n' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.business_payment_credentials'::regclass;`);
      expect(cons).toContain("business_payment_credentials_gateway_check=CHECK (((gateway)::text = ANY ((ARRAY['paystack'::character varying, 'flutterwave'::character varying, 'stripe'::character varying])::text[])))");
      expect(cons).toContain("business_payment_credentials_connection_type_check=CHECK (((connection_type)::text = ANY ((ARRAY['manual'::character varying, 'connect'::character varying])::text[])))");
      expect(cons).toContain('chk_credentials_mode=CHECK (((secret_key IS NOT NULL) OR (connect_account_id IS NOT NULL)))');
      expect(cons).toContain('business_payment_credentials_business_id_fkey=FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE');
      expect(psql(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_bpc_active';`))
        .toBe('CREATE UNIQUE INDEX idx_bpc_active ON public.business_payment_credentials USING btree (business_id, gateway) WHERE (is_active = true)');
    });

    it('rejects rows that violate chk_credentials_mode, connection_type, gateway, or one-active-per-gateway', async () => {
      const svc = pgRoleClient('service_role', { rollback: true });
      const neither = await svc.from('business_payment_credentials').insert({ business_id: BIZ_A, gateway: 'paystack', verified_at: new Date().toISOString() });
      expect(neither.error?.code).toBe('23514');
      const badType = await svc.from('business_payment_credentials').insert({ business_id: BIZ_A, gateway: 'paystack', secret_key: 'enc', connection_type: 'oauth' });
      expect(badType.error?.code).toBe('23514');
      const badGateway = await svc.from('business_payment_credentials').insert({ business_id: BIZ_A, gateway: 'paypal', secret_key: 'enc' });
      expect(badGateway.error?.code).toBe('23514');
      const dup = runAs('service_role', `
        INSERT INTO business_payment_credentials (business_id, gateway, secret_key) VALUES ('${BIZ_A}', 'paystack', 'enc1');
        INSERT INTO business_payment_credentials (business_id, gateway, secret_key) VALUES ('${BIZ_A}', 'paystack', 'enc2');
        SELECT '[]'::json`, { rollback: true });
      expect(dup.error?.code).toBe('23505');
    });
  });

  // ── 3. Service runtime: credential classification + server write paths ────
  describe('service_role runtime: credential classification (real classifier code)', () => {
    beforeAll(() => {
      // Rows written exactly as the server routes write them, as service_role.
      const now = new Date().toISOString();
      const rows = [
        // paystack-connect route shape (connection_type connect, no secret)
        { business_id: BIZ_CONNECT, gateway: 'paystack', platform_subaccount_code: null, connect_account_id: 'ACCT_connect', connection_type: 'connect', secret_key: null, verified_at: now, is_active: true },
        // platform subaccount: subaccount code, no secret (connect_account_id satisfies chk_credentials_mode)
        { business_id: BIZ_SUB, gateway: 'paystack', platform_subaccount_code: 'ACCT_sub', connect_account_id: 'ACCT_sub', connection_type: 'connect', secret_key: null, verified_at: now, is_active: true },
        // payment-credentials POST (BYO) shape
        { business_id: BIZ_BYO, gateway: 'paystack', secret_key: 'enc:byo', public_key: 'pk_byo', platform_subaccount_code: 'ACCT_platform_fee', verified_at: now, is_active: true },
        // ambiguous: secret key without platform subaccount
        { business_id: BIZ_AMBIG, gateway: 'paystack', secret_key: 'enc:ambig', verified_at: now, is_active: true },
        // inactive + unverified rows must be ignored → platform
        { business_id: BIZ_INACTIVE, gateway: 'paystack', secret_key: 'enc:old', platform_subaccount_code: 'ACCT_old', verified_at: now, is_active: false },
        { business_id: BIZ_INACTIVE, gateway: 'stripe', secret_key: 'enc:unverified', platform_subaccount_code: 'stripe_connect', verified_at: null, is_active: true },
      ];
      for (const r of rows) {
        const res = runAs('service_role', `
          INSERT INTO business_payment_credentials (${Object.keys(r).join(', ')})
          SELECT ${Object.values(r).map(lit).join(', ')}
          WHERE NOT EXISTS (SELECT 1 FROM business_payment_credentials WHERE business_id = ${lit(r.business_id)} AND gateway = ${lit(r.gateway)} AND is_active = ${lit(r.is_active)});
          SELECT '[]'::json`);
        expect(res.error).toBeNull();
      }
    });

    it('empty credential table → platform (the staging checkout path)', async () => {
      expect(await classifyBusinessPaymentCredential(pgRoleClient('service_role'), BIZ_A)).toEqual({ classification: 'platform' });
    });

    it('platform subaccount → platform_subaccount', async () => {
      const r = await classifyBusinessPaymentCredential(pgRoleClient('service_role'), BIZ_SUB);
      expect(r.classification).toBe('platform_subaccount');
      expect(r.credential?.platform_subaccount_code).toBe('ACCT_sub');
    });

    it('Connect → connect', async () => {
      const r = await classifyBusinessPaymentCredential(pgRoleClient('service_role'), BIZ_CONNECT);
      expect(r.classification).toBe('connect');
      expect(r.credential?.connect_account_id).toBe('ACCT_connect');
    });

    it('BYO → byo (service_role can read the encrypted secret_key)', async () => {
      const r = await classifyBusinessPaymentCredential(pgRoleClient('service_role'), BIZ_BYO);
      expect(r.classification).toBe('byo');
      expect(r.credential?.secret_key).toBe('enc:byo');
    });

    it('ambiguous → ambiguous (still fails closed in routing)', async () => {
      const svc = pgRoleClient('service_role');
      expect((await classifyBusinessPaymentCredential(svc, BIZ_AMBIG)).classification).toBe('ambiguous');
      expect(await resolvePaymentRoutingAuthority(svc, BIZ_AMBIG, 'paystack', 5000)).toBeNull();
    });

    it('inactive or unverified rows are ignored → platform', async () => {
      expect((await classifyBusinessPaymentCredential(pgRoleClient('service_role'), BIZ_INACTIVE)).classification).toBe('platform');
    });

    it('payment routing authority resolves (non-null, platform) for an empty-credential business', async () => {
      const routing = await resolvePaymentRoutingAuthority(pgRoleClient('service_role'), BIZ_A, 'paystack', 5000);
      expect(routing).not.toBeNull();
      expect(routing!.classification).toBe('platform');
      expect(routing!.isByo).toBe(false);
    });

    it('RED baseline: without the table (staging today) the classifier fails closed', async () => {
      const staging = pgRoleClient('service_role', { preamble: 'DROP TABLE public.business_payment_credentials CASCADE;', rollback: true });
      expect(await classifyBusinessPaymentCredential(staging, BIZ_A)).toEqual({ classification: 'error' });
      expect(await resolvePaymentRoutingAuthority(staging, BIZ_A, 'paystack', 5000)).toBeNull();
    });

    it('RED baseline: table without the service_role grant also fails closed', async () => {
      const ungranted = pgRoleClient('service_role', { preamble: 'REVOKE ALL ON public.business_payment_credentials FROM service_role;', rollback: true });
      expect(await classifyBusinessPaymentCredential(ungranted, BIZ_A)).toEqual({ classification: 'error' });
    });

    it('settings routes: service_role deactivate (UPDATE) + insert works; DELETE is denied', async () => {
      const svc = pgRoleClient('service_role', { rollback: true });
      // payment-credentials POST: deactivate then insert in one transaction
      const res = runAs('service_role', `
        UPDATE business_payment_credentials SET is_active = false, updated_at = now() WHERE business_id = '${BIZ_BYO}' AND gateway = 'paystack';
        INSERT INTO business_payment_credentials (business_id, gateway, secret_key, public_key, platform_subaccount_code, is_active, verified_at)
          VALUES ('${BIZ_BYO}', 'paystack', 'enc:new', NULL, 'ACCT_platform_fee', true, now());
        SELECT json_agg(t) FROM (SELECT secret_key, is_active FROM business_payment_credentials WHERE business_id = '${BIZ_BYO}' ORDER BY is_active) t`, { rollback: true });
      expect(res.error).toBeNull();
      expect(res.data).toEqual([{ secret_key: 'enc:byo', is_active: false }, { secret_key: 'enc:new', is_active: true }]);
      const del = await svc.from('business_payment_credentials').delete().eq('business_id', BIZ_BYO);
      expect(del.error?.code).toBe('42501');
    });
  });

  // ── 4. Authenticated owner: non-secret metadata only, no writes ───────────
  describe('authenticated owner access to credentials', () => {
    const GET_COLUMNS = 'id, gateway, platform_subaccount_code, is_active, verified_at, created_at, connection_type, connect_account_id';

    it('owner reads own non-secret metadata exactly as the settings GET route queries it', async () => {
      const owner = pgRoleClient('authenticated', { sub: OWNER_A });
      const { data, error } = await owner.from('business_payment_credentials').select(GET_COLUMNS).eq('business_id', BIZ_BYO).eq('is_active', true);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect((data as Record<string, unknown>[])[0]).toMatchObject({ gateway: 'paystack', platform_subaccount_code: 'ACCT_platform_fee', is_active: true });
      expect(Object.keys((data as Record<string, unknown>[])[0]).sort()).toEqual(GET_COLUMNS.split(', ').sort());
    });

    it('owner B cannot see owner A credentials (RLS)', async () => {
      const other = pgRoleClient('authenticated', { sub: OWNER_B });
      const { data, error } = await other.from('business_payment_credentials').select(GET_COLUMNS).eq('business_id', BIZ_BYO);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('owner cannot read secret_key, public_key, or select *', async () => {
      const owner = pgRoleClient('authenticated', { sub: OWNER_A });
      for (const cols of ['secret_key', 'public_key', '*', 'id, secret_key']) {
        const { error } = await owner.from('business_payment_credentials').select(cols).eq('business_id', BIZ_BYO);
        expect({ cols, code: error?.code }).toEqual({ cols, code: '42501' });
      }
    });

    it('owner cannot directly insert a verified credential, update routing fields, or delete', async () => {
      const owner = pgRoleClient('authenticated', { sub: OWNER_A, rollback: true });
      const ins = await owner.from('business_payment_credentials').insert({
        business_id: BIZ_A, gateway: 'paystack', connect_account_id: 'ACCT_attacker', platform_subaccount_code: 'ACCT_attacker',
        connection_type: 'connect', verified_at: new Date().toISOString(), is_active: true,
      });
      expect(ins.error?.code).toBe('42501');
      const upd = await owner.from('business_payment_credentials').update({ platform_subaccount_code: 'ACCT_attacker' }).eq('business_id', BIZ_BYO);
      expect(upd.error?.code).toBe('42501');
      const del = await owner.from('business_payment_credentials').delete().eq('business_id', BIZ_BYO);
      expect(del.error?.code).toBe('42501');
    });
  });

  // ── 5. anon has no access anywhere in scope ───────────────────────────────
  describe('anon', () => {
    for (const table of ['business_payment_credentials', 'bot_sequences', 'bot_sequence_steps', 'bot_sequence_enrollments', 'platform_fees', 'payment_confirmation_deliveries']) {
      it(`${table}: anon SELECT and INSERT are denied`, async () => {
        const anon = pgRoleClient('anon', { rollback: true });
        expect((await anon.from(table).select('id')).error?.code).toBe('42501');
        expect((await anon.from(table).insert({ id: '00000000-0000-4426-f000-000000000001' })).error?.code).toBe('42501');
      });
    }
  });

  // ── 6. Bot sequences: runtime (service_role) ──────────────────────────────
  describe('bot sequences runtime (service_role, real sequence-service code)', () => {
    it('after_order triggerSequences enrolls once into the active sequence only (deduped)', async () => {
      const svc = pgRoleClient('service_role');
      await triggerSequences(svc, BIZ_A, 'after_order', CUSTOMER, { customer_name: 'Ada' });
      await triggerSequences(svc, BIZ_A, 'after_order', CUSTOMER, { customer_name: 'Ada' });
      const rows = JSON.parse(psql(`SELECT coalesce(json_agg(t), '[]') FROM (SELECT sequence_id, business_id, status, current_step FROM bot_sequence_enrollments WHERE customer_phone = '${CUSTOMER}') t;`));
      expect(rows).toEqual([{ sequence_id: SEQ_A, business_id: BIZ_A, status: 'active', current_step: 0 }]);
      const delay = psql(`SELECT round(extract(epoch FROM next_send_at - created_at) / 60) FROM bot_sequence_enrollments WHERE customer_phone = '${CUSTOMER}';`);
      expect(Number(delay)).toBe(30);
    });

    it('RED baseline: without grants (staging today) triggerSequences fails on bot_sequences', async () => {
      const staging = pgRoleClient('service_role', { preamble: 'REVOKE ALL ON public.bot_sequences FROM service_role;', rollback: true });
      await expect(triggerSequences(staging, BIZ_A, 'after_order', CUSTOMER)).rejects.toThrow(/sequence_discovery_failed:.*permission denied/);
    });

    it('process-sequences cron shape: due scan, step read, advance/complete update', () => {
      const res = runAs('service_role', `
        UPDATE bot_sequence_enrollments SET next_send_at = now() - interval '1 minute' WHERE customer_phone = '${CUSTOMER}';
        UPDATE bot_sequence_enrollments SET status = 'completed', current_step = 1
          WHERE id IN (SELECT e.id FROM bot_sequence_enrollments e
                       JOIN bot_sequence_steps s ON s.sequence_id = e.sequence_id
                       WHERE e.status = 'active' AND e.next_send_at <= now() AND e.customer_phone = '${CUSTOMER}');
        SELECT json_agg(t) FROM (SELECT status, current_step FROM bot_sequence_enrollments WHERE customer_phone = '${CUSTOMER}') t`, { rollback: true });
      expect(res.error).toBeNull();
      expect(res.data).toEqual([{ status: 'completed', current_step: 1 }]);
    });

    it('service_role has no DELETE on sequence tables', async () => {
      const svc = pgRoleClient('service_role', { rollback: true });
      for (const t of ['bot_sequences', 'bot_sequence_steps', 'bot_sequence_enrollments']) {
        expect({ t, code: (await svc.from(t).delete().eq('id', SEQ_A)).error?.code }).toEqual({ t, code: '42501' });
      }
    });
  });

  // ── 7. Bot sequences: dashboard (authenticated owner) ─────────────────────
  describe('bot sequences dashboard (authenticated, app/dashboard/sequences/page.tsx operations)', () => {
    it('owner can create, edit, toggle, manage steps, list enrollments, and delete (cascade) their own sequence', async () => {
      const owner = pgRoleClient('authenticated', { sub: OWNER_A });
      const created = await owner.from('bot_sequences').insert({ business_id: BIZ_A, name: 'Dashboard seq', trigger_event: 'after_booking', is_active: true }).select('id').single();
      expect(created.error).toBeNull();
      const seqId = (created.data as { id: string }).id;

      expect((await owner.from('bot_sequences').update({ name: 'Renamed' }).eq('id', seqId)).error).toBeNull();
      expect((await owner.from('bot_sequences').update({ is_active: false }).eq('id', seqId)).error).toBeNull();
      expect((await owner.from('bot_sequence_steps').insert({ sequence_id: seqId, step_order: 0, delay_minutes: 5, message_type: 'text', message_content: 'Hi' })).error).toBeNull();
      const steps = await owner.from('bot_sequence_steps').select('id').eq('sequence_id', seqId);
      expect(steps.error).toBeNull();
      const stepId = (steps.data as { id: string }[])[0].id;
      expect((await owner.from('bot_sequence_steps').update({ message_content: 'Hello' }).eq('id', stepId)).error).toBeNull();

      // runtime enrolls a customer, owner can see it
      psql(`INSERT INTO bot_sequence_enrollments (sequence_id, business_id, customer_phone, next_send_at) VALUES ('${seqId}', '${BIZ_A}', '+2348000004269', now());`);
      const enr = await owner.from('bot_sequence_enrollments').select('sequence_id').eq('business_id', BIZ_A);
      expect(enr.error).toBeNull();
      expect((enr.data as { sequence_id: string }[]).map(r => r.sequence_id)).toContain(seqId);

      // page deletes steps, then (ignored) enrollments, then the sequence
      expect((await owner.from('bot_sequence_steps').delete().eq('sequence_id', seqId)).error).toBeNull();
      const enrDelete = await owner.from('bot_sequence_enrollments').delete().eq('sequence_id', seqId);
      expect(enrDelete.error?.code).toBe('42501'); // result ignored by the page; cascade below removes rows
      expect((await owner.from('bot_sequences').delete().eq('id', seqId)).error).toBeNull();
      expect(psql(`SELECT count(*) FROM bot_sequence_enrollments WHERE sequence_id = '${seqId}';`)).toBe('0');
      expect(psql(`SELECT count(*) FROM bot_sequences WHERE id = '${seqId}';`)).toBe('0');
    });

    it('owner A cannot read, modify, or create sequences/steps for owner B (RLS)', async () => {
      const a = pgRoleClient('authenticated', { sub: OWNER_A, rollback: true });
      expect((await a.from('bot_sequences').select('id').eq('id', SEQ_B)).data).toEqual([]);
      expect((await a.from('bot_sequence_steps').select('id').eq('sequence_id', SEQ_B)).data).toEqual([]);
      const upd = await a.from('bot_sequences').update({ name: 'pwned' }).eq('id', SEQ_B).select('id');
      expect(upd.error).toBeNull();
      expect(upd.data).toEqual([]);
      const del = await a.from('bot_sequences').delete().eq('id', SEQ_B).select('id');
      expect(del.data).toEqual([]);
      const ins = await a.from('bot_sequences').insert({ business_id: BIZ_B, name: 'x', trigger_event: 'after_order' });
      expect(ins.error?.code).toBe('42501'); // RLS WITH CHECK violation
      const stepIns = await a.from('bot_sequence_steps').insert({ sequence_id: SEQ_B, step_order: 9, message_content: 'x' });
      expect(stepIns.error?.code).toBe('42501');
      expect(psql(`SELECT name FROM bot_sequences WHERE id = '${SEQ_B}';`)).toBe('After order B');
    });

    it('authenticated cannot write enrollments directly', async () => {
      const a = pgRoleClient('authenticated', { sub: OWNER_A, rollback: true });
      expect((await a.from('bot_sequence_enrollments').insert({ sequence_id: SEQ_A, business_id: BIZ_A, customer_phone: '+1', next_send_at: new Date().toISOString() })).error?.code).toBe('42501');
      expect((await a.from('bot_sequence_enrollments').update({ status: 'cancelled' }).eq('business_id', BIZ_A)).error?.code).toBe('42501');
    });
  });

  // ── 8. Golden payment journey runtime tables ──────────────────────────────
  describe('golden payment journey: finalization + confirmation', () => {
    it('service_role records a platform fee (recordPlatformFee insert shape) and verifies it (direct-transfer select)', async () => {
      const svc = pgRoleClient('service_role', { rollback: true });
      const ins = await svc.from('platform_fees').insert({
        business_id: BIZ_A, payment_id: PAYMENT_A, booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: null,
        transaction_amount: 5000, fee_percentage: 5, fee_flat: 0, fee_total: 250, gateway_fee: 0, tier: 'free', reseller_id: null, reseller_commission: 0,
      });
      expect(ins.error).toBeNull();
      const res = runAs('service_role', `
        INSERT INTO platform_fees (business_id, payment_id, transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee, tier)
          VALUES ('${BIZ_A}', '${PAYMENT_A}', 5000, 5, 0, 250, 0, 'free');
        SELECT json_agg(t) FROM (SELECT fee_total FROM platform_fees WHERE payment_id = '${PAYMENT_A}') t`, { rollback: true });
      expect(res.error).toBeNull();
      expect(res.data).toEqual([{ fee_total: 250 }]);
    });

    it('RED baseline: without the grant (staging today) the fee insert fails — a critical Stage-2 error', async () => {
      const staging = pgRoleClient('service_role', { preamble: 'REVOKE ALL ON public.platform_fees FROM service_role;', rollback: true });
      const ins = await staging.from('platform_fees').insert({ business_id: BIZ_A, transaction_amount: 1, fee_total: 0 });
      expect(ins.error?.code).toBe('42501');
    });

    it('service_role reads confirmation delivery status after the M342 RPC creates the attempt', () => {
      const res = runAs('service_role', `
        DO $$ BEGIN PERFORM claim_confirmation_delivery('${PAYMENT_A}'::uuid, 'webhook_stage3'); END $$;
        SELECT json_agg(t) FROM (SELECT delivery_status FROM payment_confirmation_deliveries WHERE payment_id = '${PAYMENT_A}') t`, { rollback: true });
      expect(res.error).toBeNull();
      expect(res.data).toEqual([{ delivery_status: 'claiming' }]);
    });

    it('service_role cannot write payment_confirmation_deliveries or modify platform_fees directly', async () => {
      const svc = pgRoleClient('service_role', { rollback: true });
      expect((await svc.from('payment_confirmation_deliveries').insert({ payment_id: PAYMENT_A, attempt_source: 'webhook_stage3' })).error?.code).toBe('42501');
      expect((await svc.from('payment_confirmation_deliveries').update({ delivery_status: 'read' }).eq('payment_id', PAYMENT_A)).error?.code).toBe('42501');
      expect((await svc.from('platform_fees').update({ fee_total: 0 }).eq('payment_id', PAYMENT_A)).error?.code).toBe('42501');
      expect((await svc.from('platform_fees').delete().eq('payment_id', PAYMENT_A)).error?.code).toBe('42501');
    });
  });

  // ── 9. Idempotency + pre-existing (production-shaped) table ───────────────
  describe('migration idempotency', () => {
    it('re-applying M426 twice leaves the catalog unchanged', () => {
      const before = aclSnapshot();
      psql(migrationSql);
      psql(migrationSql);
      expect(aclSnapshot()).toBe(before);
    });

    it('production-shaped existing table: no REVOKE, no policy change, no column grants, data preserved', () => {
      const out = psql(`
        BEGIN;
        DROP TABLE public.business_payment_credentials CASCADE;
        CREATE TABLE public.business_payment_credentials (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          gateway varchar NOT NULL CHECK (gateway IN ('paystack','flutterwave','stripe')),
          secret_key text, public_key text, platform_subaccount_code varchar, connect_account_id varchar,
          connection_type varchar DEFAULT 'manual' CHECK (connection_type IN ('manual','connect')),
          is_active boolean DEFAULT true, verified_at timestamptz,
          created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
          CONSTRAINT chk_credentials_mode CHECK (secret_key IS NOT NULL OR connect_account_id IS NOT NULL));
        CREATE UNIQUE INDEX idx_bpc_active ON public.business_payment_credentials (business_id, gateway) WHERE is_active = true;
        ALTER TABLE public.business_payment_credentials ENABLE ROW LEVEL SECURITY;
        CREATE POLICY owner_crud ON public.business_payment_credentials FOR ALL
          USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
        CREATE POLICY service_read ON public.business_payment_credentials FOR SELECT USING (auth.role() = 'service_role');
        GRANT ALL ON public.business_payment_credentials TO anon, authenticated, service_role;
        INSERT INTO public.business_payment_credentials (business_id, gateway, connect_account_id, connection_type, verified_at)
          VALUES ('${BIZ_CONNECT}', 'paystack', 'ACCT_prod', 'connect', now());
        CREATE TEMP TABLE snap AS SELECT 1 AS k, (${aclSnapshotExpr()})::text AS v;
        ${migrationSql}
        INSERT INTO snap SELECT 2, (${aclSnapshotExpr()})::text;
        SELECT json_build_object(
          'unchanged', (SELECT v FROM snap WHERE k = 1) = (SELECT v FROM snap WHERE k = 2),
          'rows', (SELECT count(*) FROM public.business_payment_credentials WHERE connect_account_id = 'ACCT_prod'),
          'policies', (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE tablename = 'business_payment_credentials'));
        ROLLBACK;`);
      expect(JSON.parse(out.split('\n').pop()!)).toEqual({ unchanged: true, rows: 1, policies: 'owner_crud,service_read' });
    });

    it('existing table missing the CHECK constraints: they are added, nothing else is dropped', () => {
      const out = psql(`
        BEGIN;
        ALTER TABLE public.business_payment_credentials DROP CONSTRAINT chk_credentials_mode;
        ALTER TABLE public.business_payment_credentials DROP CONSTRAINT business_payment_credentials_connection_type_check;
        ${migrationSql}
        SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.business_payment_credentials'::regclass AND contype = 'c';
        ROLLBACK;`);
      expect(out.split('\n').pop()).toBe('business_payment_credentials_connection_type_check,business_payment_credentials_gateway_check,chk_credentials_mode');
    });
  });
});

/** Same content as aclSnapshot(), usable inside a single psql transaction. */
function aclSnapshotExpr(): string {
  return `SELECT json_build_object(
    'rel', (SELECT json_agg(json_build_object('t', relname, 'acl', relacl::text, 'rls', relrowsecurity) ORDER BY relname)
            FROM pg_class WHERE relnamespace = 'public'::regnamespace
              AND relname IN ('business_payment_credentials','bot_sequences','bot_sequence_steps',
                              'bot_sequence_enrollments','platform_fees','payment_confirmation_deliveries')),
    'col', (SELECT json_agg(json_build_object('c', attname, 'acl', attacl::text) ORDER BY attname)
            FROM pg_attribute WHERE attrelid = 'public.business_payment_credentials'::regclass AND attacl IS NOT NULL),
    'pol', (SELECT json_agg(json_build_object('p', policyname, 'cmd', cmd, 'roles', roles::text, 'qual', qual) ORDER BY policyname)
            FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_payment_credentials'),
    'con', (SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname)
            FROM pg_constraint WHERE conrelid = 'public.business_payment_credentials'::regclass))`;
}
