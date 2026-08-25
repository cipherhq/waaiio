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

    // ── Database A: Clean canonical chain (321 + 322) — must succeed independently ──
    // This proves the canonical migrations work on their own, before 325 is tested.
    // Failures here are real migration defects — do NOT catch/continue.
    const migrationDir = 'supabase/migrations';

    // Database A needs the same prerequisite stubs as Database B for FK references
    psql(dbUrl(DB_A), `
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
        actor_id UUID, action TEXT, entity_type TEXT, entity_id UUID,
        details JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS business_staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id), name TEXT, is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS business_locations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id), name TEXT, is_active BOOLEAN DEFAULT true
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
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','appointment','ordering','reservation','ticketing','payment','recurring','crowdfunding','giving','class'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','dashboard','api','web'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','no_show','in_progress'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        user_id UUID, service_id UUID REFERENCES services(id),
        appointment_id UUID REFERENCES appointments(id),
        staff_id UUID, staff_name TEXT, date DATE, time TIME,
        party_size INTEGER DEFAULT 1, flow_type flow_type,
        channel booking_channel DEFAULT 'whatsapp',
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
      CREATE TABLE IF NOT EXISTS promo_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id), code TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION check_appointment_schedule(
        p_appointment_id UUID, p_business_id UUID, p_date DATE, p_time TEXT
      ) RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$
        SELECT true, NULL::text;
      $$ LANGUAGE SQL;
      CREATE OR REPLACE FUNCTION check_staff_availability(
        p_staff_id UUID, p_business_id UUID, p_date DATE, p_time TEXT, p_duration INTEGER DEFAULT 60
      ) RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$
        SELECT true, NULL::text;
      $$ LANGUAGE SQL;
    `);

    // Apply canonical 321 — must succeed with no catch
    psqlFile(dbUrl(DB_A), `${migrationDir}/321_promotions_schema.sql`);

    // Apply canonical 322 — must succeed with no catch
    psqlFile(dbUrl(DB_A), `${migrationDir}/322_class_session_booking.sql`);

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
        actor_id UUID, action TEXT, entity_type TEXT, entity_id UUID,
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

      -- Production has existing indexes on class tables
      CREATE INDEX IF NOT EXISTS idx_recurrence_rules_service ON class_recurrence_rules(service_id);
      CREATE INDEX IF NOT EXISTS idx_recurrence_rules_active ON class_recurrence_rules(business_id, is_active) WHERE is_active = true;
      CREATE INDEX IF NOT EXISTS idx_class_sessions_business ON class_sessions(business_id, date);
      CREATE INDEX IF NOT EXISTS idx_class_sessions_service ON class_sessions(service_id, date);

      -- Production has generate_class_sessions (old SECURITY DEFINER version)
      CREATE OR REPLACE FUNCTION generate_class_sessions(
        p_service_id UUID,
        p_days_ahead INTEGER DEFAULT 28
      ) RETURNS INTEGER
      LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        RETURN 0;
      END;
      $$;

      -- Production has get_upcoming_class_sessions (old SECURITY DEFINER STABLE version)
      CREATE OR REPLACE FUNCTION get_upcoming_class_sessions(
        p_service_id UUID,
        p_limit INTEGER DEFAULT 10
      ) RETURNS TABLE(
        session_id uuid, session_date date, start_time time, end_time time,
        capacity integer, spots_taken bigint, staff_name text, location_name text, status text
      )
      LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT NULL::uuid, NULL::date, NULL::time, NULL::time, NULL::integer, NULL::bigint, NULL::text, NULL::text, NULL::text LIMIT 0;
      $$;

      -- Production has book_slot_atomic with canonical 28-arg signature (old version)
      CREATE OR REPLACE FUNCTION public.book_slot_atomic(
        p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
        p_date date, p_time text, p_party_size int, p_max_capacity int,
        p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
        p_guest_name text, p_guest_phone text, p_guest_email text,
        p_special_requests text, p_venue_address text, p_end_date date,
        p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
        p_location_id uuid DEFAULT NULL, p_appointment_id uuid DEFAULT NULL,
        p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
        p_bot_session_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL
      ) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
      LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      END;
      $$;
    `);

    // Apply migration 325 on drift fixture
    psqlFile(dbUrl(DB_B), 'supabase/migrations/325_production_drift_reconciliation.sql');
  }, 120_000);

  afterAll(() => {
    try { adminExec(`dropdb --if-exists --maintenance-db=${conn.mainDb} ${DB_A}`); } catch { /* ignore */ }
    try { adminExec(`dropdb --if-exists --maintenance-db=${conn.mainDb} ${DB_B}`); } catch { /* ignore */ }
  });

  // ── Clean Chain Postcondition Assertions (DB_A before 325) ──

  it('DRIFT-0a: Clean chain 321 postconditions exist independently', () => {
    // These must exist from 321 alone, BEFORE 325 is applied
    for (const table of PROMO_TABLES) {
      const exists = psql(dbUrl(DB_A), `
        SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='${table}') AS e;
      `);
      expect(exists, `321 postcondition: table ${table} missing from clean chain`).toBe('t');
    }
    // Canonical 321 functions
    for (const fn of ['claim_promo_code', 'validate_promo_campaign_activation',
      'admin_promo_governance', 'activate_promo_campaign']) {
      const exists = psql(dbUrl(DB_A), `
        SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
        WHERE n.nspname='public' AND p.proname='${fn}') AS e;
      `);
      expect(exists, `321 postcondition: function ${fn} missing`).toBe('t');
    }
  });

  it('DRIFT-0b: Clean chain 322 postconditions exist independently', () => {
    // class_recurrence_rules and class_sessions must exist from 322
    for (const table of CLASS_TABLES) {
      const exists = psql(dbUrl(DB_A), `
        SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='${table}') AS e;
      `);
      expect(exists, `322 postcondition: table ${table} missing from clean chain`).toBe('t');
    }
    // bookings.class_session_id must exist
    const csCol = psql(dbUrl(DB_A), `
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name='bookings' AND column_name='class_session_id') AS e;
    `);
    expect(csCol, '322 postcondition: bookings.class_session_id missing').toBe('t');
    // Canonical RPCs
    for (const fn of ['generate_class_sessions', 'get_upcoming_class_sessions',
      'book_slot_atomic', 'create_class_atomic', 'reschedule_booking_atomic']) {
      const exists = psql(dbUrl(DB_A), `
        SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
        WHERE n.nspname='public' AND p.proname='${fn}') AS e;
      `);
      expect(exists, `322 postcondition: function ${fn} missing`).toBe('t');
    }
  });

  it('DRIFT-0c: Migration 325 is idempotent on canonical clean chain', () => {
    // Apply 325 on top of already-canonical DB_A — must succeed (no-op)
    expect(() => {
      psqlFile(dbUrl(DB_A), 'supabase/migrations/325_production_drift_reconciliation.sql');
    }).not.toThrow();
  });

  // ── Schema Convergence Tests (DB_A after 321+322+325 vs DB_B after drift+325) ──

  it('DRIFT-1: All target tables exist in both databases', () => {
    const tablesA = psql(dbUrl(DB_A), TABLES_QUERY).split('\n').filter(Boolean);
    const tablesB = psql(dbUrl(DB_B), TABLES_QUERY).split('\n').filter(Boolean);

    for (const table of TARGET_TABLES) {
      expect(tablesA, `Table ${table} missing from clean chain (DB_A)`).toContain(table);
      expect(tablesB, `Table ${table} missing from drift fixture (DB_B)`).toContain(table);
    }
  });

  it('DRIFT-2: Target table columns + defaults match between databases', () => {
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT column_name || '|' || data_type || '|' || is_nullable || '|' || COALESCE(column_default, 'NULL')
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}'
        ORDER BY column_name;
      `;
      const colsA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const colsB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(colsA, `Columns+defaults mismatch for table ${table}`).toEqual(colsB);
    }
  });

  it('DRIFT-2b: Primary keys match between databases', () => {
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT a.attname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
        WHERE n.nspname = 'public' AND c.relname = '${table}' AND con.contype = 'p'
        ORDER BY a.attname;
      `;
      const pkA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const pkB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(pkA, `Primary key mismatch for ${table}`).toEqual(pkB);
    }
  });

  it('DRIFT-2c: Foreign keys match between databases', () => {
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT con.conname || '|' ||
          array_agg(sa.attname ORDER BY sa.attnum)::text || '|' ||
          ref_c.relname || '|' ||
          array_agg(ra.attname ORDER BY ra.attnum)::text || '|' ||
          con.confdeltype::text || '|' || con.confupdtype::text
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class ref_c ON ref_c.oid = con.confrelid
        JOIN pg_attribute sa ON sa.attrelid = c.oid AND sa.attnum = ANY(con.conkey)
        JOIN pg_attribute ra ON ra.attrelid = ref_c.oid AND ra.attnum = ANY(con.confkey)
        WHERE n.nspname = 'public' AND c.relname = '${table}' AND con.contype = 'f'
        GROUP BY con.conname, ref_c.relname, con.confdeltype, con.confupdtype
        ORDER BY con.conname;
      `;
      const fkA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const fkB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(fkA, `Foreign key mismatch for ${table}`).toEqual(fkB);
    }
  });

  it('DRIFT-2d: CHECK constraints match between databases', () => {
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT con.conname || '|' || pg_get_constraintdef(con.oid)
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = '${table}' AND con.contype = 'c'
        ORDER BY con.conname;
      `;
      const chkA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const chkB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(chkA, `CHECK constraint mismatch for ${table}`).toEqual(chkB);
    }
  });

  it('DRIFT-2e: UNIQUE constraints match between databases', () => {
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT con.conname || '|' || pg_get_constraintdef(con.oid)
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = '${table}' AND con.contype = 'u'
        ORDER BY con.conname;
      `;
      const unqA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const unqB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(unqA, `UNIQUE constraint mismatch for ${table}`).toEqual(unqB);
    }
  });

  it('DRIFT-2f: Indexes match between databases', () => {
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT pg_get_indexdef(i.indexrelid)
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = '${table}'
        ORDER BY pg_get_indexdef(i.indexrelid);
      `;
      const idxA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const idxB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(idxA, `Index mismatch for ${table}`).toEqual(idxB);
    }
  });

  it('DRIFT-2g: bookings.class_session_id FK and index match between databases', () => {
    // Verify column exists in both
    for (const db of [DB_A, DB_B]) {
      const col = psql(dbUrl(db), `
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'class_session_id';
      `);
      expect(col, `bookings.class_session_id missing from ${db}`).toBe('class_session_id');
    }

    // Verify FK target is class_sessions with ON DELETE SET NULL
    for (const db of [DB_A, DB_B]) {
      const fk = psql(dbUrl(db), `
        SELECT ref_c.relname || '|' || con.confdeltype::text
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class ref_c ON ref_c.oid = con.confrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
        WHERE n.nspname = 'public' AND c.relname = 'bookings'
          AND con.contype = 'f' AND a.attname = 'class_session_id';
      `);
      expect(fk, `bookings.class_session_id FK wrong in ${db}`).toBe('class_sessions|n');
    }

    // Verify index exists
    for (const db of [DB_A, DB_B]) {
      const idx = psql(dbUrl(db), `
        SELECT COUNT(*) FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'bookings'
          AND indexname = 'idx_bookings_class_session';
      `);
      expect(idx, `idx_bookings_class_session missing from ${db}`).toBe('1');
    }
  });

  it('DRIFT-3: Target functions exist in both databases with matching signatures', () => {
    for (const func of TARGET_FUNCTIONS) {
      const query = `
        SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
        FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = '${func}'
        ORDER BY 1;
      `;
      const sigsA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const sigsB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(sigsA.length, `Function ${func} missing from DB_A`).toBeGreaterThan(0);
      expect(sigsB.length, `Function ${func} missing from DB_B`).toBeGreaterThan(0);
      expect(sigsA, `Function ${func} signature mismatch`).toEqual(sigsB);
    }
  });

  it('DRIFT-4: Function SECURITY DEFINER and search_path match between databases', () => {
    for (const func of TARGET_FUNCTIONS) {
      const query = `
        SELECT p.proname || '|' ||
          CASE WHEN p.prosecdef THEN 'SECURITY_DEFINER' ELSE 'INVOKER' END || '|' ||
          COALESCE(array_to_string(p.proconfig, ','), 'NULL')
        FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = '${func}'
        ORDER BY p.proname, pg_get_function_identity_arguments(p.oid);
      `;
      const secA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const secB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(secA, `Function ${func} security/proconfig mismatch`).toEqual(secB);
    }
  });

  it('DRIFT-4b: Function EXECUTE privileges match for anon, authenticated, service_role', () => {
    for (const func of TARGET_FUNCTIONS) {
      // Get the full function signature(s) for privilege check
      const sigQuery = `
        SELECT p.oid::text || '|' || pg_get_function_identity_arguments(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = '${func}'
        ORDER BY pg_get_function_identity_arguments(p.oid);
      `;
      const sigs = psql(dbUrl(DB_A), sigQuery).split('\n').filter(Boolean);
      if (sigs.length === 0) continue;

      const privQuery = `
        SELECT p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' ||
          has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|' ||
          has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' ||
          has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = '${func}'
        ORDER BY pg_get_function_identity_arguments(p.oid);
      `;
      const privA = psql(dbUrl(DB_A), privQuery).split('\n').filter(Boolean);
      const privB = psql(dbUrl(DB_B), privQuery).split('\n').filter(Boolean);
      expect(privA, `Function ${func} EXECUTE privilege mismatch`).toEqual(privB);
    }
  });

  it('DRIFT-5: RLS enabled + FORCE ROW LEVEL SECURITY match between databases', () => {
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT c.relrowsecurity::text || '|' || c.relforcerowsecurity::text
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public' AND c.relname = '${table}';
      `;
      const rlsA = psql(dbUrl(DB_A), query);
      const rlsB = psql(dbUrl(DB_B), query);
      expect(rlsA, `RLS/FORCE mismatch for ${table}`).toEqual(rlsB);
    }
  });

  it('DRIFT-6: Full RLS policy definitions match between databases', () => {
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT pol.polname || '|' || pol.polcmd::text || '|' ||
          pol.polroles::text || '|' ||
          COALESCE(pg_get_expr(pol.polqual, pol.polrelid), 'NULL') || '|' ||
          COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), 'NULL')
        FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = '${table}'
        ORDER BY pol.polname;
      `;
      const polA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const polB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(polA, `RLS policy definition mismatch for ${table}`).toEqual(polB);
    }
  });

  it('DRIFT-6b: Table DML grants match for authenticated and service_role', () => {
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
    for (const table of TARGET_TABLES) {
      const query = `
        SELECT '${table}' || '|' || privilege_type || '|' || grantee
        FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = '${table}'
          AND grantee IN ('authenticated', 'service_role')
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        ORDER BY privilege_type, grantee;
      `;
      const grantsA = psql(dbUrl(DB_A), query).split('\n').filter(Boolean);
      const grantsB = psql(dbUrl(DB_B), query).split('\n').filter(Boolean);
      expect(grantsA, `Table grant mismatch for ${table}`).toEqual(grantsB);
    }
  });

  it('DRIFT-7: Migration 325 is safe to run twice on drift fixture (idempotent)', () => {
    // Run 325 again on DB_B — should succeed without errors
    expect(() => {
      psqlFile(dbUrl(DB_B), 'supabase/migrations/325_production_drift_reconciliation.sql');
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
