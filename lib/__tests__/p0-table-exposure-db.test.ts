/**
 * P0: Real PostgreSQL authorization tests for migration 293.
 *
 * These tests verify actual role-based access control using SET ROLE queries
 * against a real PostgreSQL database where migration 293 has been applied.
 *
 * Works in two modes:
 *   CI: TEST_DATABASE_URL points to the CI PostgreSQL where ALL migrations
 *       have been applied by the "Apply all migrations" step. Tables exist
 *       with full schema constraints.
 *   Local: TEST_DATABASE_URL points to an isolated container. The test sets
 *       up minimal tables and applies migration 293 itself.
 *
 * Requires TEST_DATABASE_URL environment variable (NOT staging or production).
 *
 * Local:
 *   docker run --rm -d --name waaiio-p0-postgres -p 54320:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54320/postgres npm test -- lib/__tests__/p0-table-exposure-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.resolve('supabase/migrations/293_fix_production_table_exposure.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('P0: Real PostgreSQL authorization tests (TEST_DATABASE_URL not set)', () => {
    it('skipped — set TEST_DATABASE_URL to enable', () => {});
  });
} else {

function runSQL(sql: string, role?: string): { stdout: string; stderr: string; exitCode: number } {
  const fullSql = role ? `SET ROLE ${role};\n${sql}` : sql;
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      exitCode: err.status || 1,
    };
  }
}

const OWNER_UUID = '11111111-1111-1111-1111-111111111111';
const OTHER_UUID = '22222222-2222-2222-2222-222222222222';
const BIZ_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BIZ_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CH_SHARED = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const CH_DEDICATED = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

describe('P0: Real PostgreSQL authorization tests', () => {
  let isFullSchema = false;

  beforeAll(() => {
    // Detect whether we're in CI (full schema) or local (empty DB)
    const check = runSQL("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'businesses';");
    isFullSchema = check.stdout.includes('1');

    if (!isFullSchema) {
      // Local mode: create minimal schema, roles, and apply migration
      runSQL(`
        DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      `);
      runSQL('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;');
      runSQL(`
        CREATE SCHEMA IF NOT EXISTS auth;
        GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS
        $fn$ SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid $fn$
        LANGUAGE sql STABLE;
        GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      `);
      runSQL(`
        DO $$ BEGIN CREATE TYPE restaurant_status AS ENUM ('pending', 'active', 'suspended');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      `);
      runSQL(`
        CREATE TABLE IF NOT EXISTS public.whatsapp_channels (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY, business_id uuid,
          country_code text DEFAULT 'US', phone_number text, display_name text,
          channel_type text DEFAULT 'shared', is_active boolean DEFAULT true,
          meta_access_token text, waba_id text, phone_number_id text,
          gupshup_api_key text, meta_token_expires_at timestamptz);
        ALTER TABLE public.whatsapp_channels ENABLE ROW LEVEL SECURITY;

        CREATE TABLE IF NOT EXISTS public.businesses (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY, owner_id uuid,
          name text, slug text UNIQUE, description text, address text, city text, state text,
          country_code text DEFAULT 'US', phone text, email text,
          logo_url text, cover_photo_url text, category text, flow_type text,
          operating_hours jsonb,
          rating_avg numeric DEFAULT 0, rating_count int DEFAULT 0, total_bookings int DEFAULT 0,
          instagram_handle text, timezone text, recurring_enabled boolean DEFAULT false,
          bot_code text, status restaurant_status DEFAULT 'active',
          google_calendar_token text, google_calendar_refresh_token text,
          payment_channels jsonb, custom_fee_percentage numeric, custom_fee_flat numeric,
          metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
        ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

        CREATE TABLE IF NOT EXISTS public.processed_webhook_events (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          event_id text NOT NULL UNIQUE, gateway text, event_type text,
          status text DEFAULT 'pending', attempts int DEFAULT 1,
          first_received_at timestamptz DEFAULT now(), last_attempted_at timestamptz DEFAULT now(),
          completed_at timestamptz, processed_at timestamptz DEFAULT now());
        ALTER TABLE public.processed_webhook_events ENABLE ROW LEVEL SECURITY;

        CREATE TABLE IF NOT EXISTS public.bot_keywords (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          business_id uuid REFERENCES public.businesses(id),
          keyword text, scope text DEFAULT 'custom', response text);
        ALTER TABLE public.bot_keywords ENABLE ROW LEVEL SECURITY;
      `);

      // Owner RLS policies (from earlier migrations, not part of 293)
      runSQL(`
        CREATE POLICY "businesses_owner_select" ON public.businesses
          FOR SELECT TO authenticated USING (owner_id = auth.uid());
        CREATE POLICY "whatsapp_channels_owner_select" ON public.whatsapp_channels
          FOR SELECT TO authenticated USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      `);

      // Pre-migration unsafe policies
      runSQL(`
        DROP POLICY IF EXISTS "shared_channels_public_read" ON public.whatsapp_channels;
        CREATE POLICY "shared_channels_public_read" ON public.whatsapp_channels
          FOR SELECT TO anon, authenticated USING (channel_type = 'shared' AND is_active = true);
        DROP POLICY IF EXISTS "processed_webhook_events_service_all" ON public.processed_webhook_events;
        CREATE POLICY "processed_webhook_events_service_all" ON public.processed_webhook_events
          FOR ALL USING (true);
        DROP POLICY IF EXISTS "public_read_active_businesses" ON public.businesses;
        CREATE POLICY "public_read_active_businesses" ON public.businesses
          FOR SELECT TO anon, authenticated USING (status = 'active');
        DROP POLICY IF EXISTS "anyone_read_system_category" ON public.bot_keywords;
        CREATE POLICY "anyone_read_system_category" ON public.bot_keywords
          FOR SELECT USING (scope IN ('system', 'category'));
      `);

      // Pre-migration grants
      runSQL(`
        GRANT ALL ON public.whatsapp_channels TO anon, authenticated, service_role;
        GRANT ALL ON public.processed_webhook_events TO anon, authenticated, service_role;
        GRANT ALL ON public.businesses TO anon, authenticated, service_role;
        GRANT ALL ON public.bot_keywords TO anon, authenticated, service_role;
      `);

      // Apply migration 293
      const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
      const result = runSQL(migrationSql);
      if (result.exitCode !== 0) {
        throw new Error(`Migration 293 failed:\n${result.stderr}\n${result.stdout}`);
      }
    }

    // In CI, override the hardcoded auth.uid() stub with one that reads request.jwt.claims
    if (isFullSchema) {
      runSQL(`
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS
        $fn$ SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid $fn$
        LANGUAGE sql STABLE;
      `);
    }

    // Insert test data (works in both modes)
    // Use ON CONFLICT DO NOTHING to be idempotent
    if (isFullSchema) {
      // CI full schema: must satisfy FK to profiles→auth.users and NOT NULL constraints
      runSQL(`
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        INSERT INTO auth.users (id, email) VALUES
          ('${OWNER_UUID}', 'p0owner@test.local'),
          ('${OTHER_UUID}', 'p0other@test.local')
        ON CONFLICT DO NOTHING;
        ALTER TABLE auth.users ENABLE TRIGGER ALL;

        INSERT INTO profiles (id, first_name, last_name, email) VALUES
          ('${OWNER_UUID}', 'P0', 'Owner', 'p0owner@test.local'),
          ('${OTHER_UUID}', 'P0', 'Other', 'p0other@test.local')
        ON CONFLICT DO NOTHING;

        INSERT INTO public.businesses (id, owner_id, name, slug, status, address, city, neighborhood, phone,
          google_calendar_token, payment_channels, metadata, country_code)
        VALUES
          ('${BIZ_A}', '${OWNER_UUID}', 'P0 Active Biz', 'p0-active-biz', 'active', '1 Test St', 'Lagos', 'VI', '+0', 'secret-token-123', '{"stripe": true}', '{"internal": true}', 'NG'),
          ('${BIZ_B}', '${OTHER_UUID}', 'P0 Pending Biz', 'p0-pending-biz', 'pending', '2 Test St', 'Lagos', 'VI', '+0', 'secret-token-456', null, null, 'NG'),
          ('${BIZ_C}', '${OTHER_UUID}', 'P0 Suspended Biz', 'p0-suspended-biz', 'suspended', '3 Test St', 'Lagos', 'VI', '+0', 'secret-token-789', null, null, 'NG')
        ON CONFLICT (slug) DO NOTHING;
      `);
    } else {
      // Local minimal schema: fewer required fields
      runSQL(`
        INSERT INTO public.businesses (id, owner_id, name, slug, status, google_calendar_token, payment_channels, metadata)
        VALUES
          ('${BIZ_A}', '${OWNER_UUID}', 'P0 Active Biz', 'p0-active-biz', 'active', 'secret-token-123', '{"stripe": true}', '{"internal": true}'),
          ('${BIZ_B}', '${OTHER_UUID}', 'P0 Pending Biz', 'p0-pending-biz', 'pending', 'secret-token-456', null, null),
          ('${BIZ_C}', '${OTHER_UUID}', 'P0 Suspended Biz', 'p0-suspended-biz', 'suspended', 'secret-token-789', null, null)
        ON CONFLICT (slug) DO NOTHING;
      `);
    }

    runSQL(`
      INSERT INTO public.whatsapp_channels (id, business_id, phone_number, display_name, channel_type, is_active, meta_access_token, waba_id, phone_number_id)
      VALUES
        ('${CH_SHARED}', '${BIZ_A}', '+1234567890', 'P0 Test Channel', 'shared', true, 'META_TOKEN_SECRET', 'WABA_123', 'PHONE_456'),
        ('${CH_DEDICATED}', '${BIZ_A}', '+0987654321', 'P0 Dedicated', 'dedicated', true, 'META_TOKEN_2', 'WABA_789', 'PHONE_012')
      ON CONFLICT DO NOTHING;
    `);

    runSQL(`INSERT INTO public.processed_webhook_events (event_id, gateway, status) VALUES ('p0_evt_test', 'test', 'pending') ON CONFLICT DO NOTHING;`);

    runSQL(`
      INSERT INTO public.bot_keywords (business_id, keyword, scope, response)
      VALUES
        ('${BIZ_A}', 'p0hello', 'system', 'Hi!'),
        ('${BIZ_A}', 'p0menu', 'custom', 'Menu'),
        ('${BIZ_B}', 'p0help', 'custom', 'Help')
      ON CONFLICT DO NOTHING;
    `);
  }, 30000);

  afterAll(() => {
    // Clean up test data only — never drop tables
    runSQL(`
      DELETE FROM public.bot_keywords WHERE keyword IN ('p0hello', 'p0menu', 'p0help');
      DELETE FROM public.processed_webhook_events WHERE event_id IN ('p0_evt_test', 'p0_evt_sr');
      DELETE FROM public.whatsapp_channels WHERE id IN ('${CH_SHARED}', '${CH_DEDICATED}');
      DELETE FROM public.businesses WHERE slug IN ('p0-active-biz', 'p0-pending-biz', 'p0-suspended-biz');
    `);
    if (isFullSchema) {
      // Restore original CI auth.uid() stub
      runSQL(`
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS
        $fn$ SELECT '00000000-0000-0000-0000-000000000000'::UUID $fn$
        LANGUAGE SQL STABLE;
      `);
      runSQL(`
        DELETE FROM profiles WHERE id IN ('${OWNER_UUID}', '${OTHER_UUID}');
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        DELETE FROM auth.users WHERE id IN ('${OWNER_UUID}', '${OTHER_UUID}');
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
      `);
    }

    if (!isFullSchema) {
      // Local mode only: clean up tables and schema
      runSQL(`
        DROP VIEW IF EXISTS public.whatsapp_channels_public CASCADE;
        DROP VIEW IF EXISTS public.businesses_public CASCADE;
        DROP TABLE IF EXISTS public.bot_keywords CASCADE;
        DROP TABLE IF EXISTS public.processed_webhook_events CASCADE;
        DROP TABLE IF EXISTS public.whatsapp_channels CASCADE;
        DROP TABLE IF EXISTS public.businesses CASCADE;
        DROP TYPE IF EXISTS restaurant_status CASCADE;
        DROP SCHEMA IF EXISTS auth CASCADE;
      `);
    }
  }, 10000);

  // ─── whatsapp_channels ───

  it('1. anon cannot SELECT whatsapp_channels base table', () => {
    const result = runSQL('SELECT * FROM public.whatsapp_channels LIMIT 1;', 'anon');
    expect(result.exitCode).not.toBe(0);
  });

  it('2. anon can SELECT safe columns from whatsapp_channels_public', () => {
    const result = runSQL("SELECT phone_number FROM public.whatsapp_channels_public WHERE phone_number = '+1234567890';", 'anon');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('+1234567890');
  });

  it('3. whatsapp_channels_public does not expose credential columns', () => {
    const result = runSQL('SELECT meta_access_token FROM public.whatsapp_channels_public LIMIT 1;', 'anon');
    expect(result.exitCode).not.toBe(0);
  });

  it('4. whatsapp_channels_public excludes dedicated channels', () => {
    const result = runSQL("SELECT phone_number FROM public.whatsapp_channels_public WHERE phone_number IN ('+1234567890', '+0987654321');", 'anon');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('+1234567890');
    expect(result.stdout).not.toContain('+0987654321');
  });

  // ─── processed_webhook_events ───

  it('5. anon cannot SELECT processed_webhook_events', () => {
    const result = runSQL('SELECT * FROM public.processed_webhook_events LIMIT 1;', 'anon');
    expect(result.exitCode).not.toBe(0);
  });

  it('6. authenticated cannot SELECT processed_webhook_events', () => {
    const result = runSQL('SELECT * FROM public.processed_webhook_events LIMIT 1;', 'authenticated');
    expect(result.exitCode).not.toBe(0);
  });

  it('7. service_role can SELECT, INSERT, UPDATE, DELETE on processed_webhook_events', () => {
    const selectR = runSQL("SELECT event_id FROM public.processed_webhook_events WHERE event_id = 'p0_evt_test';", 'service_role');
    expect(selectR.exitCode).toBe(0);

    const insertR = runSQL("INSERT INTO public.processed_webhook_events (event_id, gateway, status) VALUES ('p0_evt_sr', 'test', 'pending');", 'service_role');
    expect(insertR.exitCode).toBe(0);

    const updateR = runSQL("UPDATE public.processed_webhook_events SET status = 'completed' WHERE event_id = 'p0_evt_sr';", 'service_role');
    expect(updateR.exitCode).toBe(0);

    const deleteR = runSQL("DELETE FROM public.processed_webhook_events WHERE event_id = 'p0_evt_sr';", 'service_role');
    expect(deleteR.exitCode).toBe(0);
  });

  // ─── businesses ───

  it('8. anon cannot SELECT businesses base table', () => {
    const result = runSQL('SELECT * FROM public.businesses LIMIT 1;', 'anon');
    expect(result.exitCode).not.toBe(0);
  });

  it('9. anon can SELECT active businesses through businesses_public', () => {
    const result = runSQL("SELECT name FROM public.businesses_public WHERE slug = 'p0-active-biz';", 'anon');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('P0 Active Biz');
  });

  it('10. pending and suspended businesses are excluded from businesses_public', () => {
    const result = runSQL("SELECT name FROM public.businesses_public WHERE slug IN ('p0-pending-biz', 'p0-suspended-biz');", 'anon');
    expect(result.stdout).not.toContain('P0 Pending Biz');
    expect(result.stdout).not.toContain('P0 Suspended Biz');
  });

  it('11. businesses_public does not expose credential columns', () => {
    const r1 = runSQL('SELECT google_calendar_token FROM public.businesses_public LIMIT 1;', 'anon');
    expect(r1.exitCode).not.toBe(0);
    const r2 = runSQL('SELECT payment_channels FROM public.businesses_public LIMIT 1;', 'anon');
    expect(r2.exitCode).not.toBe(0);
    const r3 = runSQL('SELECT metadata FROM public.businesses_public LIMIT 1;', 'anon');
    expect(r3.exitCode).not.toBe(0);
  });

  // ─── bot_keywords ───

  it('12. anon cannot SELECT bot_keywords', () => {
    const result = runSQL('SELECT * FROM public.bot_keywords LIMIT 1;', 'anon');
    expect(result.exitCode).not.toBe(0);
  });

  it('13. authenticated owner can read own bot_keywords', () => {
    const result = runSQL(
      `BEGIN;
       SET LOCAL ROLE authenticated;
       SET LOCAL request.jwt.claims = '{"sub": "${OWNER_UUID}"}';
       SELECT keyword FROM public.bot_keywords WHERE keyword LIKE 'p0%';
       COMMIT;`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('p0hello');
    expect(result.stdout).toContain('p0menu');
  });

  it('14. authenticated user cannot read other business bot_keywords', () => {
    const result = runSQL(
      `BEGIN;
       SET LOCAL ROLE authenticated;
       SET LOCAL request.jwt.claims = '{"sub": "${OWNER_UUID}"}';
       SELECT keyword FROM public.bot_keywords WHERE keyword LIKE 'p0%';
       COMMIT;`,
    );
    expect(result.stdout).not.toContain('p0help');
  });

  it('15. service_role can read all bot_keywords', () => {
    const result = runSQL("SELECT keyword FROM public.bot_keywords WHERE keyword LIKE 'p0%';", 'service_role');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('p0hello');
    expect(result.stdout).toContain('p0help');
  });

  // ─── Credential integrity ───

  it('16. credential values remain intact after migration', () => {
    const result = runSQL("SELECT google_calendar_token FROM public.businesses WHERE slug = 'p0-active-biz';");
    expect(result.stdout).toContain('secret-token-123');
  });

  // ─── View write protection ───

  it('17. anon cannot INSERT into businesses_public view', () => {
    const result = runSQL("INSERT INTO public.businesses_public (name, slug) VALUES ('hack', 'hack');", 'anon');
    expect(result.exitCode).not.toBe(0);
  });

  it('18. anon cannot INSERT into whatsapp_channels_public view', () => {
    const result = runSQL("INSERT INTO public.whatsapp_channels_public (phone_number) VALUES ('+999');", 'anon');
    expect(result.exitCode).not.toBe(0);
  });

  // ─── Effective privilege verification ───

  it('19. anon has no effective base-table privileges on any sensitive table', () => {
    for (const tbl of ['whatsapp_channels', 'processed_webhook_events', 'businesses', 'bot_keywords']) {
      const result = runSQL(`SELECT has_table_privilege('anon', 'public.${tbl}', 'SELECT');`);
      expect(result.stdout).toBe('f');
    }
  });

  it('20. PUBLIC role has no effective base-table privileges on sensitive tables', () => {
    for (const tbl of ['whatsapp_channels', 'processed_webhook_events', 'businesses', 'bot_keywords']) {
      const result = runSQL(
        `SELECT count(*) FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = '${tbl}' AND grantee = 'PUBLIC';`
      );
      expect(result.stdout).toBe('0');
    }
  });
});

} // end of if (dbUrl)
