/**
 * M508 — server-managed business control columns. Real PostgreSQL proof
 * (disposable local database). Applies 442 → 507 → 508 from disk.
 *
 * Proves: owners (authenticated + RLS) cannot change assigned_channel_id,
 * whatsapp_channel_id, wa_method, country_code, status, bot_code,
 * trial_ends_at, is_verified, verified_at, verified_by, whatsapp_plan or
 * is_whitelabel, and
 * cannot create a business at all (server-only creation); the server
 * (service_role) and SECURITY DEFINER functions still can; ordinary
 * owner edits still work; ON DELETE SET NULL on channel FKs still works.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for the M508 business control columns proof');
const parsed = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Disposable local PostgreSQL required');

const m442 = readFileSync('supabase/migrations/442_business_server_managed_columns.sql', 'utf8');
const m507 = readFileSync('supabase/migrations/507_first_shared_channel_assignment.sql', 'utf8');
const m508 = readFileSync('supabase/migrations/508_business_control_columns_guard.sql', 'utf8');
const database = `m508_${randomUUID().replaceAll('-', '')}`;

const OWNER = '00000000-0000-4000-f508-000000000001';
const BIZ = '00000000-0000-4000-a508-000000000001';
const SHARED_NG = '00000000-0000-4000-b508-000000000001';
const SHARED_US = '00000000-0000-4000-b508-000000000002';
const DEDICATED_OTHER = '00000000-0000-4000-b508-000000000003';

let control: pg.Client;
let client: pg.Client;

/** Run statements as role `role` (authenticated = the owner's JWT), in a rolled-back transaction. Returns the error message or null. */
async function as(role: 'authenticated' | 'service_role', sql: string, params: unknown[] = []): Promise<string | null> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: OWNER, role })]);
    await client.query(sql, params);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await client.query('ROLLBACK');
  }
}
async function value(col: string) {
  return (await client.query(`SELECT ${col} AS v FROM businesses WHERE id=$1`, [BIZ])).rows[0].v;
}

const CONTROL: Array<[string, string]> = [
  ['assigned_channel_id', `'${SHARED_US}'`],
  ['whatsapp_channel_id', `'${DEDICATED_OTHER}'`],
  ['wa_method', `'own_phone'`],
  ['country_code', `'US'`],
  ['status', `'suspended'`],
  ['bot_code', `'OTHER-CODE'`],
  ['trial_ends_at', `'2030-01-01T00:00:00Z'`],
  ['is_verified', 'true'],
  ['verified_at', `'2026-01-01T00:00:00Z'`],
  ['verified_by', `'${OWNER}'`],
  ['whatsapp_plan', `'business'`],
  ['is_whitelabel', 'true'],
];

describe('M508 business control columns (real PostgreSQL)', () => {
  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;`);
  });
  afterAll(async () => {
    await client?.end();
    if (control) { await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await control.end(); }
  });

  async function schema() {
    await client.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public; CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
        SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub','')::uuid $f$;
      CREATE TABLE whatsapp_channels(
        id uuid PRIMARY KEY, country_code varchar NOT NULL DEFAULT 'NG',
        channel_type varchar NOT NULL DEFAULT 'shared', business_id uuid,
        is_active boolean NOT NULL DEFAULT true, connection_status varchar DEFAULT 'active');
      CREATE TABLE businesses(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, name text, slug text, category text,
        country_code varchar NOT NULL DEFAULT 'NG', status text NOT NULL DEFAULT 'pending', bot_code text UNIQUE,
        wa_method varchar DEFAULT 'transfer',
        assigned_channel_id uuid REFERENCES whatsapp_channels(id) ON DELETE SET NULL,
        whatsapp_channel_id uuid REFERENCES whatsapp_channels(id) ON DELETE SET NULL,
        verification_level text DEFAULT 'unverified', verification_status text DEFAULT 'unverified',
        payout_limit_monthly bigint DEFAULT 0, payout_mode text DEFAULT 'platform_managed',
        custom_fee_percentage numeric(5,2), custom_fee_flat integer, subscription_tier text DEFAULT 'free',
        reseller_id uuid, flow_type text, trial_ends_at timestamptz, metadata jsonb, operating_hours jsonb,
        payment_gateway text, is_whitelabel boolean DEFAULT false, is_verified boolean DEFAULT false, verified_at timestamptz,
        verified_by uuid, whatsapp_plan text, updated_at timestamptz DEFAULT now());
      ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Owners manage own businesses" ON businesses FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
      GRANT SELECT, INSERT, UPDATE ON businesses TO authenticated;
      GRANT ALL ON businesses, whatsapp_channels TO service_role;
      GRANT SELECT ON whatsapp_channels TO authenticated;`);
    await client.query(`INSERT INTO whatsapp_channels(id, country_code, channel_type) VALUES ($1,'NG','shared'), ($2,'US','shared')`, [SHARED_NG, SHARED_US]);
    await client.query(`INSERT INTO whatsapp_channels(id, country_code, channel_type, business_id) VALUES ($1,'NG','dedicated', gen_random_uuid())`, [DEDICATED_OTHER]);
    await client.query(m442);
    await client.query(m507);
  }
  async function seedBusiness() {
    await client.query(`INSERT INTO businesses(id, owner_id, name, country_code, status, bot_code, wa_method, assigned_channel_id)
      VALUES ($1,$2,'Citadel','NG','active','CITADEL','shared',$3)`, [BIZ, OWNER, SHARED_NG]);
  }

  describe('control: before M508', () => {
    beforeEach(async () => { await schema(); await seedBusiness(); });
    it('the 442 guard does not cover these columns or inserts', async () => {
      for (const [col, v] of CONTROL) {
        expect(await as('authenticated', `UPDATE businesses SET ${col} = ${v} WHERE id = '${BIZ}'`), col).toBeNull();
      }
      expect(await as('authenticated', `INSERT INTO businesses(owner_id, name, status, assigned_channel_id) VALUES ('${OWNER}','X','active','${SHARED_US}')`)).toBeNull();
      expect(await as('authenticated', `INSERT INTO businesses(owner_id, name, custom_fee_percentage, subscription_tier) VALUES ('${OWNER}','Y',1.5,'growth')`)).toBeNull();
    });
  });

  describe('after M508', () => {
    beforeEach(async () => { await schema(); await seedBusiness(); await client.query(m508); });

    it.each(CONTROL)('owner cannot change %s', async (col, v) => {
      const err = await as('authenticated', `UPDATE businesses SET ${col} = ${v} WHERE id = '${BIZ}'`);
      expect(err).toContain(`${col} can only be modified by the server`);
    });

    it('442 columns stay guarded', async () => {
      expect(await as('authenticated', `UPDATE businesses SET subscription_tier='business' WHERE id='${BIZ}'`)).toContain('subscription_tier can only be modified by the server');
      expect(await as('authenticated', `UPDATE businesses SET owner_id=gen_random_uuid() WHERE id='${BIZ}'`)).toContain('owner_id can only be modified by the server');
    });

    it('owner can still edit ordinary columns, and re-saving the same control values is allowed', async () => {
      expect(await as('authenticated', `UPDATE businesses SET name='Citadel Shop', slug='citadel-shop', status='active', bot_code='CITADEL' WHERE id='${BIZ}'`)).toBeNull();
    });

    it.each(CONTROL)('service_role can change %s', async (col, v) => {
      expect(await as('service_role', `UPDATE businesses SET ${col} = ${v} WHERE id = '${BIZ}'`)).toBeNull();
    });

    it.each([
      ['plain pending', '', ''],
      ['channel + active', ', assigned_channel_id, status', `, '${SHARED_US}', 'active'`],
      ['country, bot code, method', ', country_code, bot_code, wa_method', `, 'US', 'NEWCODE', 'shared'`],
      ['fee setting', ', custom_fee_percentage', ', 1.5'],
      ['plan + verification + payout limit', ', subscription_tier, verification_level, payout_limit_monthly', `, 'growth', 'verified', 1000`],
    ])('owner cannot create a business (%s)', async (_label, cols, vals) => {
      expect(await as('authenticated', `INSERT INTO businesses(owner_id, name${cols}) VALUES ('${OWNER}','X'${vals})`)).toContain('businesses can only be created by the server');
    });

    it('service_role can create an active business with a channel', async () => {
      expect(await as('service_role', `INSERT INTO businesses(owner_id, name, status, assigned_channel_id) VALUES ('${OWNER}','Srv','active','${SHARED_NG}')`)).toBeNull();
    });

    it('a SECURITY DEFINER function passes the guard even when called by a non-service role', async () => {
      await client.query(`UPDATE businesses SET assigned_channel_id = NULL, status = 'pending' WHERE id = $1`, [BIZ]);
      await client.query('GRANT EXECUTE ON FUNCTION public.assign_first_shared_channel(uuid) TO authenticated');
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE authenticated');
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: OWNER })]);
        const r = (await client.query('SELECT public.assign_first_shared_channel($1::uuid) AS r', [BIZ])).rows[0].r;
        expect(r).toMatchObject({ allocated: true, channel_id: SHARED_NG });
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      expect(await value('assigned_channel_id')).toBe(SHARED_NG);
    });

    it('ON DELETE SET NULL on a channel still clears the pointer when the server deletes the channel', async () => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE service_role');
        await client.query('DELETE FROM whatsapp_channels WHERE id = $1', [SHARED_NG]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      expect(await value('assigned_channel_id')).toBeNull();
    });

    it('guard functions keep the 442 grants: no PUBLIC/anon/authenticated EXECUTE', async () => {
      const r = (await client.query(`SELECT p.proname,
          has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
        FROM pg_proc p WHERE p.proname IN ('guard_server_managed_columns','guard_business_insert') ORDER BY 1`)).rows;
      expect(r).toEqual([
        { proname: 'guard_business_insert', anon: false, auth: false },
        { proname: 'guard_server_managed_columns', anon: false, auth: false },
      ]);
    });
  });
});
