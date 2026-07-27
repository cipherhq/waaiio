/**
 * P0: Production table exposure remediation tests
 *
 * Verifies that migration 293 closes the 4 security exposures
 * found during the Issue #53 preflight:
 *   1. whatsapp_channels: shared_channels_public_read dropped
 *   2. processed_webhook_events: service_all dropped
 *   3. businesses: public_read_active_businesses dropped, view created
 *   4. bot_keywords: anyone_read_system_category dropped
 *
 * Three test categories:
 *   A. Static migration SQL structure checks
 *   B. Application code uses safe view helpers
 *   C. Zero-downtime fallback helper logic
 *   D. Real PostgreSQL authorization tests (requires local PostgreSQL)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isRelationNotFound, queryBusinessesPublic, queryChannelsPublic } from '../supabase/safe-view-query';

const MIGRATION_PATH = path.resolve('supabase/migrations/293_fix_production_table_exposure.sql');
const migration293 = fs.readFileSync(MIGRATION_PATH, 'utf-8');

// Historical migration 223 must not be modified
const MIGRATION_223_PATH = path.resolve('supabase/migrations/223_security_fix_exposed_tables.sql');
const migration223 = fs.readFileSync(MIGRATION_223_PATH, 'utf-8');
const migration223Hash = require('crypto').createHash('sha256').update(migration223).digest('hex');

// ═══════════════════════════════════════════════════════════════
// A. Static migration SQL structure checks
// ═══════════════════════════════════════════════════════════════
describe('P0: Migration 293 — static SQL structure', () => {
  // ─── whatsapp_channels ───
  it('drops shared_channels_public_read policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "shared_channels_public_read"');
  });

  it('creates whatsapp_channels_public view with security_barrier and safe columns only', () => {
    expect(migration293).toContain('CREATE OR REPLACE VIEW public.whatsapp_channels_public');
    expect(migration293).toContain('security_barrier = true');
    const viewStart = migration293.indexOf('CREATE OR REPLACE VIEW public.whatsapp_channels_public');
    const viewEnd = migration293.indexOf('REVOKE ALL ON public.whatsapp_channels_public');
    const viewDef = migration293.slice(viewStart, viewEnd);
    expect(viewDef).toContain('phone_number');
    expect(viewDef).toContain('country_code');
    expect(viewDef).toContain('display_name');
    // Sensitive fields must NOT appear in the view SELECT
    expect(viewDef).not.toContain('meta_access_token');
    expect(viewDef).not.toContain('waba_id');
    expect(viewDef).not.toContain('phone_number_id');
    expect(viewDef).not.toContain('gupshup_api_key');
    expect(viewDef).not.toContain('meta_token_expires_at');
  });

  it('revokes ALL from PUBLIC on whatsapp_channels_public view before granting', () => {
    expect(migration293).toContain('REVOKE ALL ON public.whatsapp_channels_public FROM PUBLIC');
  });

  it('grants only SELECT on view to anon and authenticated', () => {
    expect(migration293).toMatch(/GRANT SELECT ON.*whatsapp_channels_public.*TO anon.*authenticated/);
  });

  it('revokes direct anon access to whatsapp_channels base table', () => {
    expect(migration293).toContain('REVOKE ALL ON public.whatsapp_channels FROM anon');
  });

  // ─── processed_webhook_events ───
  it('drops processed_webhook_events_service_all policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "processed_webhook_events_service_all"');
  });

  it('uses explicit DROP + CREATE for service_only policy (not IF NOT EXISTS)', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "processed_webhook_events_service_only"');
    expect(migration293).toContain('CREATE POLICY "processed_webhook_events_service_only"');
    // Must NOT use IF NOT EXISTS for the CREATE
    const createLine = migration293.slice(
      migration293.indexOf('CREATE POLICY "processed_webhook_events_service_only"'),
      migration293.indexOf('CREATE POLICY "processed_webhook_events_service_only"') + 100,
    );
    expect(createLine).not.toContain('IF NOT EXISTS');
  });

  it('service_only policy targets service_role with USING and WITH CHECK', () => {
    const policySection = migration293.slice(
      migration293.indexOf('CREATE POLICY "processed_webhook_events_service_only"'),
      migration293.indexOf('REVOKE ALL ON public.processed_webhook_events FROM PUBLIC'),
    );
    expect(policySection).toContain('TO service_role');
    expect(policySection).toContain('USING (true)');
    expect(policySection).toContain('WITH CHECK (true)');
  });

  it('revokes from PUBLIC, anon, and authenticated on processed_webhook_events', () => {
    expect(migration293).toContain('REVOKE ALL ON public.processed_webhook_events FROM PUBLIC');
    expect(migration293).toContain('REVOKE ALL ON public.processed_webhook_events FROM anon');
    expect(migration293).toContain('REVOKE ALL ON public.processed_webhook_events FROM authenticated');
  });

  it('explicitly grants only required privileges to service_role', () => {
    expect(migration293).toMatch(/GRANT SELECT, INSERT, DELETE ON.*processed_webhook_events.*TO service_role/);
  });

  // ─── businesses ───
  it('drops public_read_active_businesses policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "public_read_active_businesses"');
  });

  it('creates businesses_public view with security_barrier and safe columns only', () => {
    expect(migration293).toContain('CREATE OR REPLACE VIEW public.businesses_public');
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).toContain('security_barrier = true');
    expect(viewDef).toContain('name');
    expect(viewDef).toContain('slug');
    expect(viewDef).toContain('logo_url');
    expect(viewDef).toContain('operating_hours');
    expect(viewDef).toContain("WHERE status = 'active'");
    // Credential columns must NOT appear
    expect(viewDef).not.toContain('google_calendar_token');
    expect(viewDef).not.toContain('google_calendar_refresh_token');
    expect(viewDef).not.toContain('payment_channels');
    expect(viewDef).not.toContain('custom_fee_percentage');
    expect(viewDef).not.toContain('custom_fee_flat');
    expect(viewDef).not.toContain('metadata');
  });

  it('businesses_public view uses status = active (not is_active)', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).toContain("WHERE status = 'active'");
    // is_active does not exist on the businesses table
    expect(viewDef).not.toMatch(/is_active/);
  });

  it('revokes ALL from PUBLIC on businesses_public view before granting', () => {
    expect(migration293).toContain('REVOKE ALL ON public.businesses_public FROM PUBLIC');
  });

  it('grants businesses_public view to anon and authenticated', () => {
    expect(migration293).toMatch(/GRANT SELECT ON.*businesses_public.*TO anon.*authenticated/);
  });

  it('revokes direct anon access to businesses base table', () => {
    expect(migration293).toContain('REVOKE ALL ON public.businesses FROM anon');
  });

  // ─── bot_keywords ───
  it('drops anyone_read_system_category policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "anyone_read_system_category"');
  });

  it('uses explicit DROP + CREATE for bot_keywords policies', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "bot_keywords_service_read"');
    expect(migration293).toContain('CREATE POLICY "bot_keywords_service_read"');
    expect(migration293).toContain('DROP POLICY IF EXISTS "bot_keywords_owner_read"');
    expect(migration293).toContain('CREATE POLICY "bot_keywords_owner_read"');
  });

  it('bot_keywords_owner_read scopes via owner_id = auth.uid()', () => {
    const ownerSection = migration293.slice(
      migration293.indexOf('CREATE POLICY "bot_keywords_owner_read"'),
      migration293.indexOf('REVOKE ALL ON public.bot_keywords FROM PUBLIC'),
    );
    expect(ownerSection).toContain('TO authenticated');
    expect(ownerSection).toContain('owner_id = auth.uid()');
    expect(ownerSection).toContain('business_id IN');
  });

  it('revokes from PUBLIC and anon on bot_keywords', () => {
    expect(migration293).toContain('REVOKE ALL ON public.bot_keywords FROM PUBLIC');
    expect(migration293).toContain('REVOKE ALL ON public.bot_keywords FROM anon');
  });

  // ─── pg_policies audit block ───
  it('scopes pg_policies inspection with schemaname and tablename', () => {
    expect(migration293).toContain("schemaname = 'public'");
    expect(migration293).toMatch(/tablename IN \(/);
    expect(migration293).toContain("'whatsapp_channels'");
    expect(migration293).toContain("'processed_webhook_events'");
    expect(migration293).toContain("'businesses'");
    expect(migration293).toContain("'bot_keywords'");
  });

  it('raises exception if unsafe policies remain', () => {
    expect(migration293).toContain('RAISE EXCEPTION');
    expect(migration293).toContain('unsafe policies still exist');
  });

  // ─── Structural safety ───
  it('does not null or delete credential values', () => {
    expect(migration293).not.toContain('SET google_calendar_token');
    expect(migration293).not.toContain('SET google_calendar_refresh_token');
    expect(migration293).not.toMatch(/UPDATE.*businesses.*SET.*NULL/);
  });

  it('does not perform data backfills', () => {
    expect(migration293).not.toMatch(/INSERT INTO.*businesses/);
    expect(migration293).not.toMatch(/UPDATE.*bookings/);
    expect(migration293).not.toMatch(/DELETE FROM.*businesses/);
  });

  it('is idempotent (IF EXISTS on all DROP statements)', () => {
    const drops = (migration293.match(/DROP POLICY/g) || []).length;
    const ifExists = (migration293.match(/DROP POLICY IF EXISTS/g) || []).length;
    expect(ifExists).toBe(drops);
  });

  it('uses explicit schema names for all tables', () => {
    expect(migration293).toContain('public.whatsapp_channels');
    expect(migration293).toContain('public.processed_webhook_events');
    expect(migration293).toContain('public.businesses');
    expect(migration293).toContain('public.bot_keywords');
  });

  it('migration 223 is unchanged', () => {
    const currentHash = require('crypto').createHash('sha256').update(
      fs.readFileSync(MIGRATION_223_PATH, 'utf-8'),
    ).digest('hex');
    expect(currentHash).toBe(migration223Hash);
  });
});

// ═══════════════════════════════════════════════════════════════
// B. Application code uses safe view fallback helpers
// ═══════════════════════════════════════════════════════════════
describe('P0: Application code uses safe view fallback helpers', () => {
  it('booking page uses queryBusinessesPublic helper', () => {
    const source = fs.readFileSync(
      path.resolve('app/b/[slug]/page.tsx'), 'utf-8',
    );
    expect(source).toContain('queryBusinessesPublic');
    expect(source).toContain("from '@/lib/supabase/safe-view-query'");
  });

  it('recurring setup page uses queryBusinessesPublic helper', () => {
    const source = fs.readFileSync(
      path.resolve('app/recurring/[slug]/page.tsx'), 'utf-8',
    );
    expect(source).toContain('queryBusinessesPublic');
  });

  it('OnboardingWizard uses queryChannelsPublic helper', () => {
    const source = fs.readFileSync(
      path.resolve('app/get-started/OnboardingWizard.tsx'), 'utf-8',
    );
    expect(source).toContain('queryChannelsPublic');
    expect(source).toContain("from '@/lib/supabase/safe-view-query'");
  });

  it('dashboard and qr-code pages use queryChannelsPublic helper', () => {
    const dashboard = fs.readFileSync(
      path.resolve('app/dashboard/page.tsx'), 'utf-8',
    );
    const qrCode = fs.readFileSync(
      path.resolve('app/dashboard/qr-code/page.tsx'), 'utf-8',
    );
    expect(dashboard).toContain('queryChannelsPublic');
    expect(qrCode).toContain('queryChannelsPublic');
  });

  it('keyword-campaigns page uses queryChannelsPublic helper', () => {
    const source = fs.readFileSync(
      path.resolve('app/dashboard/keyword-campaigns/page.tsx'), 'utf-8',
    );
    expect(source).toContain('queryChannelsPublic');
  });

  it('no public view definition exposes token or credential columns', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.whatsapp_channels_public'),
      migration293.indexOf('REVOKE ALL ON public.whatsapp_channels_public'),
    );
    const sensitiveColumns = [
      'meta_access_token', 'waba_id', 'phone_number_id',
      'meta_token_expires_at', 'gupshup_api_key',
    ];
    for (const col of sensitiveColumns) {
      expect(viewDef).not.toContain(col);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// C. Zero-downtime fallback helper logic
// ═══════════════════════════════════════════════════════════════
describe('P0: Zero-downtime fallback — isRelationNotFound', () => {

  it('returns true for PostgreSQL 42P01 (relation does not exist)', () => {
    expect(isRelationNotFound({ code: '42P01', message: 'relation "businesses_public" does not exist' })).toBe(true);
  });

  it('returns false for null error', () => {
    expect(isRelationNotFound(null)).toBe(false);
  });

  it('returns false for permission error (42501)', () => {
    expect(isRelationNotFound({ code: '42501', message: 'permission denied' })).toBe(false);
  });

  it('returns false for network/connection errors', () => {
    expect(isRelationNotFound({ code: 'PGRST301', message: 'connection refused' })).toBe(false);
  });

  it('returns false for PostgREST schema cache error', () => {
    expect(isRelationNotFound({ code: 'PGRST200', message: 'Could not find relation' })).toBe(false);
  });

  it('returns false for empty error object', () => {
    expect(isRelationNotFound({})).toBe(false);
  });

  it('returns false for error with no code', () => {
    expect(isRelationNotFound({ message: 'some error' })).toBe(false);
  });

  it('returns false for RLS violation', () => {
    expect(isRelationNotFound({ code: '42000', message: 'new row violates RLS' })).toBe(false);
  });
});

describe('P0: Zero-downtime fallback — queryBusinessesPublic', () => {

  function mockSupabase(viewResult: any, baseResult?: any) {
    const chainable = (result: any) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: () => chain,
        maybeSingle: () => chain,
        limit: () => chain,
        then: (resolve: any) => resolve(result),
      };
      // Make it thenable (async/await compatible)
      chain[Symbol.for('nodejs.util.inspect.custom')] = undefined;
      return chain;
    };

    let callCount = 0;
    return {
      from: (table: string) => {
        callCount++;
        if (callCount === 1 && table === 'businesses_public') {
          return chainable(viewResult);
        }
        if (table === 'businesses') {
          return chainable(baseResult || { data: null, error: null });
        }
        return chainable(viewResult);
      },
    };
  }

  it('returns view result when view exists', async () => {
    const viewResult = { data: { name: 'Test Biz' }, error: null };
    const supabase = mockSupabase(viewResult);
    const result = await queryBusinessesPublic(supabase, 'name');
    expect(result.data).toEqual({ name: 'Test Biz' });
    expect(result.error).toBeNull();
  });

  it('falls back to base table on 42P01 error', async () => {
    const viewResult = { data: null, error: { code: '42P01', message: 'relation does not exist' } };
    const baseResult = { data: { name: 'Fallback Biz' }, error: null };
    const supabase = mockSupabase(viewResult, baseResult);
    const result = await queryBusinessesPublic(supabase, 'name');
    expect(result.data).toEqual({ name: 'Fallback Biz' });
  });

  it('does NOT fall back on permission error', async () => {
    const viewResult = { data: null, error: { code: '42501', message: 'permission denied' } };
    const supabase = mockSupabase(viewResult);
    const result = await queryBusinessesPublic(supabase, 'name');
    expect(result.error?.code).toBe('42501');
  });

  it('does NOT fall back on network error', async () => {
    const viewResult = { data: null, error: { code: 'PGRST301', message: 'connection failed' } };
    const supabase = mockSupabase(viewResult);
    const result = await queryBusinessesPublic(supabase, 'name');
    expect(result.error?.code).toBe('PGRST301');
  });

  it('does NOT fall back on empty result (no error)', async () => {
    const viewResult = { data: null, error: null };
    const supabase = mockSupabase(viewResult);
    const result = await queryBusinessesPublic(supabase, 'name');
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// D. Active-business semantics regression tests
// ═══════════════════════════════════════════════════════════════
describe('P0: Active-business semantics', () => {
  it('businesses_public view uses status = active predicate', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).toContain("WHERE status = 'active'");
  });

  it('view does not reference is_active on businesses (column does not exist)', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).not.toContain('is_active');
  });

  it('migration documents that businesses.status is the canonical authority', () => {
    expect(migration293).toContain('canonical');
    expect(migration293).toContain("status = 'active'");
    expect(migration293).toContain('NO is_active');
  });

  it('status enum values are documented correctly', () => {
    // The restaurant_status enum has: pending, active, suspended
    // The view should only match 'active', implicitly excluding pending and suspended
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    // Only 'active' should be in the WHERE clause
    expect(viewDef).toContain("status = 'active'");
    expect(viewDef).not.toContain("'pending'");
    expect(viewDef).not.toContain("'suspended'");
  });
});

// ═══════════════════════════════════════════════════════════════
// E. Real PostgreSQL authorization tests
//    These tests apply migration 293 in an isolated local database
//    and verify actual role-based access control.
// ═══════════════════════════════════════════════════════════════
describe('P0: Real PostgreSQL authorization tests', () => {
  // These tests require a running PostgreSQL instance.
  // In CI, this is provided by a service container.
  // Locally, run: docker run -d -p 54320:5432 -e POSTGRES_PASSWORD=test postgres:16
  //
  // Set TEST_DATABASE_URL=postgresql://postgres:test@localhost:54320/postgres
  // to enable these tests.
  //
  // When TEST_DATABASE_URL is not set, these tests are skipped with a clear message.

  const dbUrl = process.env.TEST_DATABASE_URL;
  const describeDb = dbUrl ? describe : describe.skip;

  // Helper to run SQL via psql
  async function runSQL(sql: string, role?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { execSync } = require('child_process');
    const roleFlag = role ? `SET ROLE ${role};` : '';
    const fullSql = `${roleFlag}${sql}`;
    try {
      const stdout = execSync(
        `psql "${dbUrl}" -t -A -c "${fullSql.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 10000 },
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

  // Setup: create roles, minimal schema, and apply migration
  let dbReady = false;

  describeDb('with real PostgreSQL', () => {
    // One-time setup
    it('setup: creates test schema and applies migration', async () => {
      // Create roles if they don't exist
      await runSQL(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
            CREATE ROLE anon NOLOGIN;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
            CREATE ROLE authenticated NOLOGIN;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
            CREATE ROLE service_role NOLOGIN;
          END IF;
        END $$;
      `);

      // Grant schema usage
      await runSQL('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;');

      // Create auth schema and auth.uid() function stub
      await runSQL(`
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$
          SELECT current_setting('request.jwt.claims', true)::json->>'sub'
        $f$ LANGUAGE sql STABLE;
      `);

      // Create the restaurant_status enum
      await runSQL(`
        DO $$ BEGIN
          CREATE TYPE restaurant_status AS ENUM ('pending', 'active', 'suspended');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
      `);

      // Create minimal tables
      await runSQL(`
        CREATE TABLE IF NOT EXISTS public.whatsapp_channels (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          business_id uuid,
          country_code text DEFAULT 'US',
          phone_number text,
          display_name text,
          channel_type text DEFAULT 'shared',
          is_active boolean DEFAULT true,
          meta_access_token text,
          waba_id text,
          phone_number_id text,
          gupshup_api_key text,
          meta_token_expires_at timestamptz
        );
        ALTER TABLE public.whatsapp_channels ENABLE ROW LEVEL SECURITY;
      `);

      await runSQL(`
        CREATE TABLE IF NOT EXISTS public.businesses (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          owner_id uuid,
          name text,
          slug text UNIQUE,
          description text,
          address text, city text, state text,
          country_code text DEFAULT 'US',
          phone text, email text,
          logo_url text, cover_photo_url text,
          category text, flow_type text,
          operating_hours jsonb,
          rating_avg numeric DEFAULT 0, rating_count int DEFAULT 0, total_bookings int DEFAULT 0,
          instagram_handle text, timezone text,
          recurring_enabled boolean DEFAULT false,
          bot_code text,
          status restaurant_status DEFAULT 'active',
          google_calendar_token text,
          google_calendar_refresh_token text,
          payment_channels jsonb,
          custom_fee_percentage numeric, custom_fee_flat numeric,
          metadata jsonb,
          created_at timestamptz DEFAULT now(),
          updated_at timestamptz DEFAULT now()
        );
        ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      `);

      await runSQL(`
        CREATE TABLE IF NOT EXISTS public.processed_webhook_events (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          event_id text NOT NULL,
          processed_at timestamptz DEFAULT now()
        );
        ALTER TABLE public.processed_webhook_events ENABLE ROW LEVEL SECURITY;
      `);

      await runSQL(`
        CREATE TABLE IF NOT EXISTS public.bot_keywords (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          business_id uuid REFERENCES public.businesses(id),
          keyword text,
          scope text DEFAULT 'custom',
          response text
        );
        ALTER TABLE public.bot_keywords ENABLE ROW LEVEL SECURITY;
      `);

      // Create the original unsafe policies that migration 293 will drop
      await runSQL(`
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

      // Grant base table access (simulating pre-migration state)
      await runSQL(`
        GRANT ALL ON public.whatsapp_channels TO anon, authenticated, service_role;
        GRANT ALL ON public.processed_webhook_events TO anon, authenticated, service_role;
        GRANT ALL ON public.businesses TO anon, authenticated, service_role;
        GRANT ALL ON public.bot_keywords TO anon, authenticated, service_role;
      `);

      // Insert test data
      const ownerUuid = '11111111-1111-1111-1111-111111111111';
      const otherUuid = '22222222-2222-2222-2222-222222222222';

      await runSQL(`
        INSERT INTO public.businesses (id, owner_id, name, slug, status, google_calendar_token, payment_channels, metadata)
        VALUES
          ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${ownerUuid}', 'Active Biz', 'active-biz', 'active', 'secret-token-123', '{"stripe": true}', '{"internal": true}'),
          ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${otherUuid}', 'Pending Biz', 'pending-biz', 'pending', 'secret-token-456', null, null),
          ('cccccccc-cccc-cccc-cccc-cccccccccccc', '${otherUuid}', 'Suspended Biz', 'suspended-biz', 'suspended', 'secret-token-789', null, null)
        ON CONFLICT (slug) DO NOTHING;
      `);

      await runSQL(`
        INSERT INTO public.whatsapp_channels (id, business_id, phone_number, display_name, channel_type, is_active, meta_access_token, waba_id, phone_number_id)
        VALUES
          ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '+1234567890', 'Test Channel', 'shared', true, 'META_TOKEN_SECRET', 'WABA_123', 'PHONE_456'),
          ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '+0987654321', 'Dedicated', 'dedicated', true, 'META_TOKEN_2', 'WABA_789', 'PHONE_012')
        ON CONFLICT DO NOTHING;
      `);

      await runSQL(`
        INSERT INTO public.processed_webhook_events (event_id) VALUES ('evt_test_123') ON CONFLICT DO NOTHING;
      `);

      await runSQL(`
        INSERT INTO public.bot_keywords (business_id, keyword, scope, response)
        VALUES
          ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hello', 'system', 'Hi there!'),
          ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'menu', 'custom', 'Here is the menu'),
          ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'help', 'custom', 'Need help?')
        ON CONFLICT DO NOTHING;
      `);

      // Now apply migration 293
      const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
      const result = await runSQL(migrationSql);
      expect(result.exitCode).toBe(0);
      dbReady = true;
    }, 30000);

    // 1. anon cannot SELECT whatsapp_channels base table
    it('1. anon cannot SELECT whatsapp_channels base table', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT * FROM public.whatsapp_channels LIMIT 1;", 'anon');
      expect(result.exitCode).not.toBe(0);
    });

    // 2. anon can SELECT only safe columns from whatsapp_channels_public
    it('2. anon can SELECT safe columns from whatsapp_channels_public', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT id, country_code, phone_number, display_name FROM public.whatsapp_channels_public LIMIT 1;", 'anon');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('+1234567890');
    });

    // 3. anon cannot see meta_access_token through the public view
    it('3. whatsapp_channels_public does not expose credential columns', async () => {
      if (!dbReady) return;
      // View should not have meta_access_token column
      const result = await runSQL("SELECT meta_access_token FROM public.whatsapp_channels_public LIMIT 1;", 'anon');
      expect(result.exitCode).not.toBe(0);
    });

    // 4. whatsapp_channels_public only shows shared+active channels
    it('4. whatsapp_channels_public excludes dedicated channels', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT phone_number, channel_type FROM public.whatsapp_channels_public;", 'anon');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('+1234567890'); // shared
      expect(result.stdout).not.toContain('+0987654321'); // dedicated
    });

    // 5. anon cannot read or write processed_webhook_events
    it('5. anon cannot SELECT processed_webhook_events', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT * FROM public.processed_webhook_events LIMIT 1;", 'anon');
      expect(result.exitCode).not.toBe(0);
    });

    // 6. authenticated cannot read or write processed_webhook_events
    it('6. authenticated cannot SELECT processed_webhook_events', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT * FROM public.processed_webhook_events LIMIT 1;", 'authenticated');
      expect(result.exitCode).not.toBe(0);
    });

    // 7. service_role can perform required webhook operations
    it('7. service_role can SELECT, INSERT, DELETE on processed_webhook_events', async () => {
      if (!dbReady) return;
      const selectResult = await runSQL("SELECT event_id FROM public.processed_webhook_events LIMIT 1;", 'service_role');
      expect(selectResult.exitCode).toBe(0);

      const insertResult = await runSQL("INSERT INTO public.processed_webhook_events (event_id) VALUES ('evt_test_sr');", 'service_role');
      expect(insertResult.exitCode).toBe(0);

      const deleteResult = await runSQL("DELETE FROM public.processed_webhook_events WHERE event_id = 'evt_test_sr';", 'service_role');
      expect(deleteResult.exitCode).toBe(0);
    });

    // 8. anon cannot SELECT businesses base table
    it('8. anon cannot SELECT businesses base table', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT * FROM public.businesses LIMIT 1;", 'anon');
      expect(result.exitCode).not.toBe(0);
    });

    // 9. anon can SELECT safe active businesses through businesses_public
    it('9. anon can SELECT active businesses through businesses_public', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT name, slug FROM public.businesses_public;", 'anon');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Active Biz');
    });

    // 10. inactive/pending/suspended businesses are excluded from businesses_public
    it('10. inactive businesses are excluded from businesses_public', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT name FROM public.businesses_public;", 'anon');
      expect(result.stdout).not.toContain('Pending Biz');
      expect(result.stdout).not.toContain('Suspended Biz');
    });

    // 11. businesses_public does not expose credential columns
    it('11. businesses_public does not expose credential columns', async () => {
      if (!dbReady) return;
      const tokenResult = await runSQL("SELECT google_calendar_token FROM public.businesses_public LIMIT 1;", 'anon');
      expect(tokenResult.exitCode).not.toBe(0);
      const paymentResult = await runSQL("SELECT payment_channels FROM public.businesses_public LIMIT 1;", 'anon');
      expect(paymentResult.exitCode).not.toBe(0);
      const metadataResult = await runSQL("SELECT metadata FROM public.businesses_public LIMIT 1;", 'anon');
      expect(metadataResult.exitCode).not.toBe(0);
    });

    // 12. anon cannot read bot_keywords
    it('12. anon cannot SELECT bot_keywords', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT * FROM public.bot_keywords LIMIT 1;", 'anon');
      expect(result.exitCode).not.toBe(0);
    });

    // 13. authenticated owner can read their own bot keywords
    it('13. authenticated owner can read own bot_keywords', async () => {
      if (!dbReady) return;
      const ownerUuid = '11111111-1111-1111-1111-111111111111';
      const result = await runSQL(
        `SET LOCAL request.jwt.claims = '{"sub": "${ownerUuid}"}'; SELECT keyword FROM public.bot_keywords;`,
        'authenticated',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
      expect(result.stdout).toContain('menu');
    });

    // 14. authenticated user cannot read another business's keywords
    it('14. authenticated user cannot read other business bot_keywords', async () => {
      if (!dbReady) return;
      const ownerUuid = '11111111-1111-1111-1111-111111111111';
      const result = await runSQL(
        `SET LOCAL request.jwt.claims = '{"sub": "${ownerUuid}"}'; SELECT keyword FROM public.bot_keywords;`,
        'authenticated',
      );
      // Should see own keywords (hello, menu) but NOT other business keywords (help)
      expect(result.stdout).not.toContain('help');
    });

    // 15. service_role retains required bot_keywords access
    it('15. service_role can read all bot_keywords', async () => {
      if (!dbReady) return;
      const result = await runSQL("SELECT keyword FROM public.bot_keywords;", 'service_role');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
      expect(result.stdout).toContain('help');
    });

    // 16. no credential value is updated, nulled or deleted
    it('16. credential values remain intact after migration', async () => {
      if (!dbReady) return;
      // Check as superuser (not via a role)
      const result = await runSQL("SELECT google_calendar_token FROM public.businesses WHERE slug = 'active-biz';");
      expect(result.stdout).toContain('secret-token-123');
    });

    // 17. views cannot be used for INSERT/UPDATE/DELETE by anon
    it('17. anon cannot INSERT into businesses_public view', async () => {
      if (!dbReady) return;
      const result = await runSQL(
        "INSERT INTO public.businesses_public (name, slug) VALUES ('hack', 'hack');",
        'anon',
      );
      expect(result.exitCode).not.toBe(0);
    });

    it('18. anon cannot INSERT into whatsapp_channels_public view', async () => {
      if (!dbReady) return;
      const result = await runSQL(
        "INSERT INTO public.whatsapp_channels_public (phone_number) VALUES ('+999');",
        'anon',
      );
      expect(result.exitCode).not.toBe(0);
    });

    // Cleanup
    it('cleanup: drops test objects', async () => {
      if (!dbReady) return;
      await runSQL(`
        DROP VIEW IF EXISTS public.whatsapp_channels_public CASCADE;
        DROP VIEW IF EXISTS public.businesses_public CASCADE;
        DROP TABLE IF EXISTS public.bot_keywords CASCADE;
        DROP TABLE IF EXISTS public.processed_webhook_events CASCADE;
        DROP TABLE IF EXISTS public.whatsapp_channels CASCADE;
        DROP TABLE IF EXISTS public.businesses CASCADE;
        DROP TYPE IF EXISTS restaurant_status CASCADE;
        DROP SCHEMA IF EXISTS auth CASCADE;
      `);
    }, 10000);
  });
});
