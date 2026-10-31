/**
 * M487: Verify PUBLIC/anon revoked on party_tables and seating_resources,
 * while authenticated and service_role access is preserved.
 *
 * Disposable PostgreSQL — requires TEST_DATABASE_URL.
 * Run: TEST_DATABASE_URL=postgres://... npx vitest run lib/__tests__/m487-revoke-inherited-acl.pg.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeDB = TEST_DB_URL ? describe : describe.skip;

describeDB('M487: PUBLIC/anon revoked on party_tables and seating_resources', () => {
  let pool: pg.Pool;

  const OWNER = '00000000-0000-4000-a487-000000000001';
  const BIZ = '00000000-0000-4000-b487-000000000001';
  const PARTY = '00000000-0000-4000-c487-000000000001';

  async function query(sql: string): Promise<string> {
    const r = await pool.query(sql);
    return r.rows.map((row: Record<string, unknown>) => JSON.stringify(row)).join('\n');
  }

  async function queryMayFail(sql: string): Promise<string> {
    try {
      return await query(sql);
    } catch (e: unknown) {
      return (e as Error).message;
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 3 });

    // Minimal schema bootstrap (matches codebase .pg.test.ts pattern)
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_app_meta_data JSONB DEFAULT '{}'
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid;
      $$ LANGUAGE SQL STABLE;

      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;

      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT USAGE ON SCHEMA auth TO service_role, anon, authenticated;
      GRANT SELECT ON auth.users TO service_role;

      CREATE OR REPLACE FUNCTION public.has_admin_role(roles TEXT[]) RETURNS BOOLEAN AS $$
        SELECT false;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      -- Minimal parent tables
      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL,
        name TEXT NOT NULL DEFAULT 'test',
        business_category TEXT NOT NULL DEFAULT 'restaurant',
        address TEXT NOT NULL DEFAULT '123 Test St',
        phone TEXT NOT NULL DEFAULT '+1234567890'
      );
      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      CREATE POLICY businesses_owner ON public.businesses FOR ALL
        USING (owner_id = auth.uid());
      GRANT ALL ON public.businesses TO authenticated, service_role;

      CREATE TABLE IF NOT EXISTS public.parties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'test party',
        max_guests INTEGER DEFAULT 100
      );
      GRANT ALL ON public.parties TO authenticated, service_role;

      -- Create flow_type enum if needed
      DO $$ BEGIN
        CREATE TYPE flow_type AS ENUM ('scheduling', 'ordering', 'table_reservation');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;

      -- Create bookings stub (for FK)
      CREATE TABLE IF NOT EXISTS public.bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        seating_resource_id UUID
      );
      GRANT ALL ON public.bookings TO authenticated, service_role;

      -- Insert owner into auth.users
      INSERT INTO auth.users (id) VALUES ('${OWNER}') ON CONFLICT DO NOTHING;
      INSERT INTO public.businesses (id, owner_id) VALUES ('${BIZ}', '${OWNER}') ON CONFLICT DO NOTHING;
      INSERT INTO public.parties (id, business_id) VALUES ('${PARTY}', '${BIZ}') ON CONFLICT DO NOTHING;
    `);

    // Create party_tables with M457 grants (pre-fix state)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.party_tables (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 10,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(party_id, name)
      );
      ALTER TABLE public.party_tables ENABLE ROW LEVEL SECURITY;
      CREATE POLICY party_tables_owner ON public.party_tables FOR ALL
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_tables TO authenticated;
    `);

    // Create seating_resources with M476 grants (pre-fix state)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.seating_resources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        resource_type VARCHAR(30) NOT NULL DEFAULT 'table',
        capacity INTEGER NOT NULL DEFAULT 2,
        min_party_size INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        reservation_duration_minutes INTEGER NOT NULL DEFAULT 90,
        deposit_amount INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        available_days TEXT[],
        available_from TIME,
        available_to TIME,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        section VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.seating_resources ENABLE ROW LEVEL SECURITY;
      CREATE POLICY sr_owner_select ON public.seating_resources FOR SELECT
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY sr_owner_insert ON public.seating_resources FOR INSERT
        WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY sr_owner_update ON public.seating_resources FOR UPDATE
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY sr_service ON public.seating_resources FOR ALL TO service_role
        USING (true) WITH CHECK (true);
      GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO authenticated;
      GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO service_role;
    `);

    // Apply M487 (the migration under test)
    const m487 = require('fs').readFileSync(
      require('path').join(__dirname, '../../supabase/migrations/487_revoke_inherited_acl_party_seating.sql'),
      'utf8',
    );
    await pool.query(m487);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`
        DROP TABLE IF EXISTS public.seating_resources CASCADE;
        DROP TABLE IF EXISTS public.party_tables CASCADE;
        DROP TABLE IF EXISTS public.parties CASCADE;
        DROP TABLE IF EXISTS public.bookings CASCADE;
        DROP TABLE IF EXISTS public.businesses CASCADE;
      `);
      await pool.end();
    }
  });

  // ── PUBLIC/anon denied ──

  it('anon cannot SELECT party_tables', async () => {
    const result = await queryMayFail(`
      SET ROLE anon;
      SELECT * FROM public.party_tables LIMIT 1;
    `);
    expect(result).toContain('permission denied');
  });

  it('anon cannot SELECT seating_resources', async () => {
    const result = await queryMayFail(`
      SET ROLE anon;
      SELECT * FROM public.seating_resources LIMIT 1;
    `);
    expect(result).toContain('permission denied');
  });

  it('anon cannot INSERT party_tables', async () => {
    const result = await queryMayFail(`
      SET ROLE anon;
      INSERT INTO public.party_tables (business_id, party_id, name) VALUES ('${BIZ}', '${PARTY}', 'anon-table');
    `);
    expect(result).toContain('permission denied');
  });

  it('anon cannot INSERT seating_resources', async () => {
    const result = await queryMayFail(`
      SET ROLE anon;
      INSERT INTO public.seating_resources (business_id, name) VALUES ('${BIZ}', 'anon-resource');
    `);
    expect(result).toContain('permission denied');
  });

  // ── authenticated preserved (with RLS) ──

  it('authenticated owner can SELECT party_tables', async () => {
    await pool.query(`SET ROLE service_role;
      INSERT INTO public.party_tables (business_id, party_id, name) VALUES ('${BIZ}', '${PARTY}', 'auth-test')
      ON CONFLICT DO NOTHING;`);
    await pool.query('RESET ROLE;');

    const result = await queryMayFail(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER}';
      SELECT name FROM public.party_tables WHERE party_id = '${PARTY}';
    `);
    expect(result).toContain('auth-test');
  });

  it('authenticated owner can SELECT seating_resources', async () => {
    await pool.query(`SET ROLE service_role;
      INSERT INTO public.seating_resources (business_id, name) VALUES ('${BIZ}', 'sr-auth-test')
      ON CONFLICT DO NOTHING;`);
    await pool.query('RESET ROLE;');

    const result = await queryMayFail(`
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER}';
      SELECT name FROM public.seating_resources WHERE business_id = '${BIZ}';
    `);
    expect(result).toContain('sr-auth-test');
  });

  // ── service_role preserved ──

  it('service_role can SELECT party_tables', async () => {
    const result = await queryMayFail(`
      SET ROLE service_role;
      SELECT COUNT(*)::int AS c FROM public.party_tables;
    `);
    expect(result).not.toContain('permission denied');
  });

  it('service_role can INSERT party_tables', async () => {
    const result = await queryMayFail(`
      SET ROLE service_role;
      INSERT INTO public.party_tables (business_id, party_id, name) VALUES ('${BIZ}', '${PARTY}', 'svc-test')
      ON CONFLICT DO NOTHING;
    `);
    expect(result).not.toContain('permission denied');
  });

  it('service_role can SELECT seating_resources', async () => {
    const result = await queryMayFail(`
      SET ROLE service_role;
      SELECT COUNT(*)::int AS c FROM public.seating_resources;
    `);
    expect(result).not.toContain('permission denied');
  });

  it('service_role can INSERT seating_resources', async () => {
    const result = await queryMayFail(`
      SET ROLE service_role;
      INSERT INTO public.seating_resources (business_id, name) VALUES ('${BIZ}', 'svc-sr-test')
      ON CONFLICT DO NOTHING;
    `);
    expect(result).not.toContain('permission denied');
  });

  // ── RLS intact ──

  it('RLS is enabled on party_tables', async () => {
    const result = await query(`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'party_tables';
    `);
    expect(result).toContain('"relrowsecurity":true');
  });

  it('RLS is enabled on seating_resources', async () => {
    const result = await query(`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'seating_resources';
    `);
    expect(result).toContain('"relrowsecurity":true');
  });

  // ── Grant inventory ──

  it('party_tables: no PUBLIC or anon grants exist', async () => {
    const result = await query(`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'party_tables'
        AND grantee IN ('PUBLIC', 'anon')
      ORDER BY grantee, privilege_type;
    `);
    expect(result).toBe('');
  });

  it('seating_resources: no PUBLIC or anon grants exist', async () => {
    const result = await query(`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'seating_resources'
        AND grantee IN ('PUBLIC', 'anon')
      ORDER BY grantee, privilege_type;
    `);
    expect(result).toBe('');
  });
});
