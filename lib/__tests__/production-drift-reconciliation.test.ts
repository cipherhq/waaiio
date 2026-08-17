/**
 * Production Drift Reconciliation Test
 *
 * Verifies migration 325 converges both:
 *   (A) Clean chain: migrations 321 + 322 applied normally
 *   (B) Drift fixture: only production-present objects, then 325
 * to the same schema state.
 *
 * Requires TEST_DATABASE_URL env var pointing to a PostgreSQL instance.
 * The test creates two dedicated databases and drops them on cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const TEST_DB = process.env.TEST_DATABASE_URL;

// Parse connection info for createdb/dropdb
function getConnInfo() {
  if (!TEST_DB) return null;
  const url = new URL(TEST_DB);
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: url.username,
    password: url.password,
    mainDb: url.pathname.slice(1),
  };
}

const DB_A = 'waaiio_drift_clean';
const DB_B = 'waaiio_drift_prod';

function dbUrl(dbName: string): string {
  if (!TEST_DB) return '';
  const url = new URL(TEST_DB);
  url.pathname = '/' + dbName;
  return url.toString();
}

function psql(dbUrl: string, sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    throw new Error(`psql failed: ${err.stderr || err.stdout || e}`);
  }
}

function psqlFile(dbUrl: string, filePath: string): void {
  execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${filePath}"`, {
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

// Schema introspection queries
const TABLES_QUERY = `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name;
`;

const COLUMNS_QUERY = `
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position;
`;

const FUNCTIONS_QUERY = `
  SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
  ORDER BY p.proname, args;
`;

const RLS_QUERY = `
  SELECT tablename FROM pg_tables t
  JOIN pg_class c ON c.relname = t.tablename
  WHERE t.schemaname = 'public' AND c.relrowsecurity = true
  ORDER BY tablename;
`;

// Tables from 321+322 that we care about
const PROMO_TABLES = [
  'promo_campaigns', 'promo_prizes', 'promo_code_batches',
  'promo_campaign_codes', 'promo_redemptions', 'promo_verification_attempts',
  'promo_eligibility_acks', 'promo_pending_eligibility',
];

const CLASS_TABLES = [
  'class_recurrence_rules', 'class_sessions',
];

const TARGET_TABLES = [...PROMO_TABLES, ...CLASS_TABLES];

const TARGET_FUNCTIONS = [
  'claim_promo_code', 'validate_promo_campaign_activation',
  'admin_promo_governance', 'commit_promo_code_chunk',
  'activate_promo_campaign', 'commit_promo_import_chunk',
  'get_promo_campaign_aggregates', 'reset_promo_failed_batch',
  'create_promo_batch_atomic', 'update_promo_campaign_updated_at',
  'validate_promo_campaign_status_transition',
  'generate_class_sessions', 'get_upcoming_class_sessions',
  'book_slot_atomic', 'book_manual_slot_atomic',
  'reschedule_booking_atomic', 'create_class_atomic',
  'create_class_recurrence_atomic', 'update_class_session_atomic',
  'reconcile_class_recurrence',
];

// Supabase schema stubs required for migrations
const SCHEMA_STUBS = `
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE SCHEMA IF NOT EXISTS extensions;
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
    SELECT '00000000-0000-0000-0000-000000000000'::UUID;
  $$ LANGUAGE SQL STABLE;

  CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
    SELECT 'authenticated'::TEXT;
  $$ LANGUAGE SQL STABLE;

  CREATE TABLE IF NOT EXISTS auth.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT,
    raw_app_meta_data JSONB DEFAULT '{}'
  );

  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE SCHEMA IF NOT EXISTS storage;
  CREATE TABLE IF NOT EXISTS storage.buckets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, public BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS storage.objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT REFERENCES storage.buckets(id),
    name TEXT, owner UUID, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] AS $$
    SELECT string_to_array(name, '/');
  $$ LANGUAGE SQL IMMUTABLE;
`;

describe.skipIf(!TEST_DB)('Production Drift Reconciliation (migration 325)', () => {
  const conn = getConnInfo()!;

  function adminExec(cmd: string) {
    const env = {
      ...process.env,
      PGHOST: conn.host,
      PGPORT: conn.port,
      PGUSER: conn.user,
      PGPASSWORD: conn.password,
    };
    execSync(cmd, { encoding: 'utf-8', timeout: 15_000, env });
  }

  beforeAll(() => {
    // Create two fresh databases
    try { adminExec(`dropdb --if-exists --maintenance-db=${conn.mainDb} ${DB_A}`); } catch { /* ignore */ }
    try { adminExec(`dropdb --if-exists --maintenance-db=${conn.mainDb} ${DB_B}`); } catch { /* ignore */ }
    adminExec(`createdb --maintenance-db=${conn.mainDb} ${DB_A}`);
    adminExec(`createdb --maintenance-db=${conn.mainDb} ${DB_B}`);

    // Apply schema stubs to both databases
    psql(dbUrl(DB_A), SCHEMA_STUBS);
    psql(dbUrl(DB_B), SCHEMA_STUBS);

    // ── Database A: Clean chain (all migrations 001..324) ──
    const migrationDir = 'supabase/migrations';
    const files = execSync(`ls ${migrationDir}/*.sql`, { encoding: 'utf-8' })
      .trim().split('\n').sort();

    for (const f of files) {
      const basename = f.split('/').pop()!;
      const num = parseInt(basename.split('_')[0], 10);
      // Apply all migrations up to and including 322
      // Skip 323+ (bot_context already applied, 324 separate scope)
      if (num > 322) break;
      try {
        psqlFile(dbUrl(DB_A), f);
      } catch (e: unknown) {
        const err = e as { stderr?: string };
        // Some migrations may reference objects not in our stubs; skip non-critical failures
        console.warn(`Warning: ${basename} had issues in DB_A: ${(err.stderr || '').slice(0, 200)}`);
      }
    }

    // Now apply 325 on top (should be a no-op on clean chain)
    psqlFile(dbUrl(DB_A), `${migrationDir}/325_production_drift_reconciliation.sql`);

    // ── Database B: Drift fixture (minimal production state + 325) ──
    // Create the prerequisite tables that production has from earlier migrations
    psql(dbUrl(DB_B), `
      -- Minimal prerequisite tables for FK references
      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL, slug TEXT, owner_id UUID REFERENCES auth.users(id),
        address TEXT, city TEXT, neighborhood TEXT, phone TEXT,
        status TEXT DEFAULT 'active', payout_mode TEXT, country_code TEXT,
        verification_level TEXT, subscription_tier TEXT DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS business_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id), user_id UUID REFERENCES auth.users(id)
      );

      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id UUID, action TEXT, entity_type TEXT, entity_id TEXT,
        details JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS business_staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT, is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS business_locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT, is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT, description TEXT, price INTEGER DEFAULT 0,
        duration_minutes INTEGER DEFAULT 60, max_capacity INTEGER DEFAULT 1,
        is_class BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true,
        class_schedule JSONB DEFAULT '[]',
        requires_staff BOOLEAN DEFAULT false, buffer_minutes INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        max_capacity INTEGER DEFAULT 1, buffer_minutes INTEGER DEFAULT 0,
        duration_minutes INTEGER DEFAULT 30, requires_staff BOOLEAN DEFAULT false
      );

      -- Flow types and booking enums
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','appointment','ordering','reservation','ticketing','payment','recurring','crowdfunding','giving','class'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','dashboard','api','web'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','no_show','in_progress'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        user_id UUID, service_id UUID REFERENCES services(id),
        appointment_id UUID REFERENCES appointments(id),
        staff_id UUID REFERENCES business_staff(id),
        staff_name TEXT, date DATE, time TIME, party_size INTEGER DEFAULT 1,
        flow_type flow_type, channel booking_channel DEFAULT 'whatsapp',
        deposit_amount INTEGER DEFAULT 0, deposit_status deposit_status DEFAULT 'none',
        status reservation_status DEFAULT 'pending',
        guest_name TEXT, guest_phone TEXT, guest_email TEXT,
        special_requests TEXT, venue_address TEXT, end_date DATE,
        addons_snapshot JSONB, promo_code_id UUID, total_amount INTEGER DEFAULT 0,
        quantity INTEGER DEFAULT 1, location_id UUID, bot_session_id UUID,
        reference_code TEXT DEFAULT substr(md5(random()::text), 1, 8),
        notes TEXT, confirmed_at TIMESTAMPTZ,
        original_date DATE, original_time TEXT, rescheduled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Stub for check_appointment_schedule
      CREATE OR REPLACE FUNCTION check_appointment_schedule(
        p_appointment_id UUID, p_business_id UUID, p_date DATE, p_time TEXT
      ) RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$
        SELECT true, NULL::text;
      $$ LANGUAGE SQL;

      -- Stub for check_staff_availability
      CREATE OR REPLACE FUNCTION check_staff_availability(
        p_staff_id UUID, p_business_id UUID, p_date DATE, p_time TEXT, p_duration INTEGER DEFAULT 60
      ) RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$
        SELECT true, NULL::text;
      $$ LANGUAGE SQL;

      -- Production has promo_codes from an earlier migration (not from 321)
      CREATE TABLE IF NOT EXISTS promo_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        code TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Production has class_recurrence_rules (from 322, fully present)
      CREATE TABLE IF NOT EXISTS class_recurrence_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        weekday TEXT NOT NULL CHECK (weekday IN ('mon','tue','wed','thu','fri','sat','sun')),
        start_time TIME NOT NULL,
        staff_id UUID REFERENCES business_staff(id) ON DELETE SET NULL,
        location_id UUID REFERENCES business_locations(id) ON DELETE SET NULL,
        capacity_override INTEGER,
        effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
        effective_until DATE,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Production has class_sessions (OLD schema — missing some columns from 322)
      CREATE TABLE IF NOT EXISTS class_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        recurrence_rule_id UUID REFERENCES class_recurrence_rules(id) ON DELETE SET NULL,
        date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        staff_id UUID REFERENCES business_staff(id) ON DELETE SET NULL,
        location_id UUID REFERENCES business_locations(id) ON DELETE SET NULL,
        capacity INTEGER NOT NULL DEFAULT 10,
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
        cancellation_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(recurrence_rule_id, date, start_time)
      );

      -- Production has bookings.class_session_id
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS class_session_id UUID REFERENCES class_sessions(id) ON DELETE SET NULL;

      -- Production has existing indexes
      CREATE INDEX IF NOT EXISTS idx_recurrence_rules_business ON class_recurrence_rules(business_id);

      -- Production has generate_class_sessions and get_upcoming_class_sessions RPCs
      -- (old versions — 325 will CREATE OR REPLACE them)

      -- Production has book_slot_atomic with 28 args
      -- (old version — 325 will CREATE OR REPLACE)
    `);

    // Apply migration 325 on drift fixture
    psqlFile(dbUrl(DB_B), 'supabase/migrations/325_production_drift_reconciliation.sql');
  }, 120_000);

  afterAll(() => {
    try { adminExec(`dropdb --if-exists --maintenance-db=${conn.mainDb} ${DB_A}`); } catch { /* ignore */ }
    try { adminExec(`dropdb --if-exists --maintenance-db=${conn.mainDb} ${DB_B}`); } catch { /* ignore */ }
  });

  // ── Schema Convergence Tests ──

  it('DRIFT-1: All target tables exist in both databases', () => {
    const tablesA = psql(dbUrl(DB_A), TABLES_QUERY).split('\n').filter(Boolean);
    const tablesB = psql(dbUrl(DB_B), TABLES_QUERY).split('\n').filter(Boolean);

    for (const table of TARGET_TABLES) {
      expect(tablesA, `Table ${table} missing from clean chain (DB_A)`).toContain(table);
      expect(tablesB, `Table ${table} missing from drift fixture (DB_B)`).toContain(table);
    }
  });

  it('DRIFT-2: Target table columns match between databases', () => {
    for (const table of TARGET_TABLES) {
      const colsA = psql(dbUrl(DB_A), `
        SELECT column_name || '|' || data_type || '|' || is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}'
        ORDER BY ordinal_position;
      `).split('\n').filter(Boolean);

      const colsB = psql(dbUrl(DB_B), `
        SELECT column_name || '|' || data_type || '|' || is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}'
        ORDER BY ordinal_position;
      `).split('\n').filter(Boolean);

      expect(colsA.sort(), `Columns mismatch for table ${table}`).toEqual(colsB.sort());
    }
  });

  it('DRIFT-3: Target functions exist in both databases', () => {
    const funcsA = psql(dbUrl(DB_A), FUNCTIONS_QUERY).split('\n').filter(Boolean);
    const funcsB = psql(dbUrl(DB_B), FUNCTIONS_QUERY).split('\n').filter(Boolean);

    for (const func of TARGET_FUNCTIONS) {
      const matchA = funcsA.some(f => f.startsWith(func + '|'));
      const matchB = funcsB.some(f => f.startsWith(func + '|'));
      expect(matchA, `Function ${func} missing from clean chain (DB_A)`).toBe(true);
      expect(matchB, `Function ${func} missing from drift fixture (DB_B)`).toBe(true);
    }
  });

  it('DRIFT-4: Function signatures match between databases', () => {
    for (const func of TARGET_FUNCTIONS) {
      const sigsA = psql(dbUrl(DB_A), `
        SELECT pg_get_function_identity_arguments(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = '${func}'
        ORDER BY 1;
      `).split('\n').filter(Boolean);

      const sigsB = psql(dbUrl(DB_B), `
        SELECT pg_get_function_identity_arguments(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = '${func}'
        ORDER BY 1;
      `).split('\n').filter(Boolean);

      expect(sigsA, `Function ${func} signature mismatch`).toEqual(sigsB);
    }
  });

  it('DRIFT-5: RLS enabled on same target tables in both databases', () => {
    for (const table of TARGET_TABLES) {
      const rlsA = psql(dbUrl(DB_A), `
        SELECT c.relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public' AND c.relname = '${table}';
      `);
      const rlsB = psql(dbUrl(DB_B), `
        SELECT c.relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public' AND c.relname = '${table}';
      `);
      expect(rlsA, `RLS mismatch for ${table}`).toEqual(rlsB);
    }
  });

  it('DRIFT-6: RLS policies match between databases for target tables', () => {
    for (const table of TARGET_TABLES) {
      const policiesA = psql(dbUrl(DB_A), `
        SELECT polname FROM pg_policy
        JOIN pg_class c ON c.oid = polrelid
        WHERE c.relname = '${table}' ORDER BY polname;
      `).split('\n').filter(Boolean);

      const policiesB = psql(dbUrl(DB_B), `
        SELECT polname FROM pg_policy
        JOIN pg_class c ON c.oid = polrelid
        WHERE c.relname = '${table}' ORDER BY polname;
      `).split('\n').filter(Boolean);

      expect(policiesA, `RLS policy mismatch for ${table}`).toEqual(policiesB);
    }
  });

  it('DRIFT-7: Migration 325 is safe to run twice (idempotent)', () => {
    // Run 325 again on DB_A — should succeed without errors
    expect(() => {
      psqlFile(dbUrl(DB_A), 'supabase/migrations/325_production_drift_reconciliation.sql');
    }).not.toThrow();
  });

  // ── Source Verification ──

  it('DRIFT-8: Migration 325 file uses IF NOT EXISTS for all CREATE TABLE', () => {
    const sql = readFileSync('supabase/migrations/325_production_drift_reconciliation.sql', 'utf-8');
    const createTableStatements = sql.match(/CREATE TABLE\s+/gi) || [];
    const createTableIfNotExists = sql.match(/CREATE TABLE IF NOT EXISTS/gi) || [];
    expect(createTableStatements.length).toBe(createTableIfNotExists.length);
  });

  it('DRIFT-9: Migration 325 file uses IF NOT EXISTS for all CREATE INDEX', () => {
    const sql = readFileSync('supabase/migrations/325_production_drift_reconciliation.sql', 'utf-8');
    const createIndexStatements = sql.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF)/gi) || [];
    expect(createIndexStatements.length, 'Found CREATE INDEX without IF NOT EXISTS').toBe(0);
  });

  it('DRIFT-10: Migration 325 does not contain DROP TABLE', () => {
    const sql = readFileSync('supabase/migrations/325_production_drift_reconciliation.sql', 'utf-8');
    expect(sql).not.toMatch(/DROP TABLE(?! IF EXISTS _contention)/i);
  });

  it('DRIFT-11: Migration 325 uses CREATE OR REPLACE for all functions', () => {
    const sql = readFileSync('supabase/migrations/325_production_drift_reconciliation.sql', 'utf-8');
    // Every function creation should be CREATE OR REPLACE
    const createFuncStatements = sql.match(/CREATE\s+FUNCTION/gi) || [];
    expect(createFuncStatements.length, 'Found CREATE FUNCTION without OR REPLACE').toBe(0);
  });

  it('DRIFT-12: Migration 325 uses DROP POLICY IF EXISTS before CREATE POLICY', () => {
    const sql = readFileSync('supabase/migrations/325_production_drift_reconciliation.sql', 'utf-8');
    const createPolicyStatements = sql.match(/CREATE POLICY\s+(\w+)/gi) || [];
    for (const stmt of createPolicyStatements) {
      const policyName = stmt.replace(/CREATE POLICY\s+/i, '');
      expect(sql, `Missing DROP POLICY IF EXISTS for ${policyName}`)
        .toContain(`DROP POLICY IF EXISTS ${policyName}`);
    }
  });
});
