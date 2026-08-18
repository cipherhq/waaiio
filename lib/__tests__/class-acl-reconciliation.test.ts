/**
 * Class ACL Reconciliation Test (migration 326)
 *
 * Proves migration 326 fixes the Supabase default-privilege ACL issues
 * discovered during production migration 325 verification:
 * 1. book_slot_atomic anon/authenticated EXECUTE → service_role only
 * 2. class table anon/authenticated excessive DML → canonical grants
 *
 * Requires TEST_DATABASE_URL env var pointing to a PostgreSQL instance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const TEST_DB = process.env.TEST_DATABASE_URL;

function getConnInfo() {
  if (!TEST_DB) return null;
  const url = new URL(TEST_DB);
  return { host: url.hostname, port: url.port || '5432', user: url.username, password: url.password, mainDb: url.pathname.slice(1) };
}

const DB_NAME = 'waaiio_acl326_test';

function dbUrl(): string {
  if (!TEST_DB) return '';
  const url = new URL(TEST_DB);
  url.pathname = '/' + DB_NAME;
  return url.toString();
}

function psql(sql: string): string {
  return execSync(`psql "${dbUrl()}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 30_000 }).trim();
}

function psqlFile(filePath: string): void {
  execSync(`psql "${dbUrl()}" -v ON_ERROR_STOP=1 -f "${filePath}"`, { encoding: 'utf-8', timeout: 60_000 });
}

// ── Shared prerequisite stubs ──
const STUBS = `
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT gen_random_uuid(); $$ LANGUAGE SQL STABLE;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$ SELECT 'authenticated'::TEXT; $$ LANGUAGE SQL STABLE;
  CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT, raw_app_meta_data JSONB DEFAULT '{}');
  DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
  DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT, owner_id UUID REFERENCES auth.users(id), status TEXT DEFAULT 'active', subscription_tier TEXT DEFAULT 'free', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS business_members (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id), user_id UUID REFERENCES auth.users(id));
  CREATE TABLE IF NOT EXISTS admin_audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID, action TEXT, entity_type TEXT, entity_id TEXT, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS business_staff (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id), name TEXT, is_active BOOLEAN DEFAULT true);
  CREATE TABLE IF NOT EXISTS business_locations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id), name TEXT, is_active BOOLEAN DEFAULT true);
  CREATE TABLE IF NOT EXISTS services (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id), name TEXT, price INTEGER DEFAULT 0, duration_minutes INTEGER DEFAULT 60, max_capacity INTEGER DEFAULT 1, is_class BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true, class_schedule JSONB DEFAULT '[]', requires_staff BOOLEAN DEFAULT false, buffer_minutes INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS appointments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id), max_capacity INTEGER DEFAULT 1, buffer_minutes INTEGER DEFAULT 0, duration_minutes INTEGER DEFAULT 30, requires_staff BOOLEAN DEFAULT false);
  DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','appointment','ordering','reservation','ticketing','payment','recurring','crowdfunding','giving','class'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','dashboard','api','web'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','no_show','in_progress'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE IF NOT EXISTS bookings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id), user_id UUID, service_id UUID REFERENCES services(id), appointment_id UUID REFERENCES appointments(id), staff_id UUID, date DATE, time TIME, party_size INTEGER DEFAULT 1, flow_type flow_type, channel booking_channel DEFAULT 'whatsapp', deposit_amount INTEGER DEFAULT 0, deposit_status deposit_status DEFAULT 'none', status reservation_status DEFAULT 'pending', guest_name TEXT, guest_phone TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS promo_codes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id), code TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS bot_sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), whatsapp_number TEXT NOT NULL, business_id UUID, current_step TEXT, session_data JSONB DEFAULT '{}', is_active BOOLEAN DEFAULT true, version INT DEFAULT 0, user_id UUID, expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS business_capabilities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, capability TEXT, is_enabled BOOLEAN DEFAULT true, sort_order INT DEFAULT 0);
  CREATE TABLE IF NOT EXISTS capability_overrides (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, capability TEXT);
  CREATE OR REPLACE FUNCTION check_appointment_schedule(p_appointment_id UUID, p_business_id UUID, p_date DATE, p_time TEXT) RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$ SELECT true, NULL::text; $$ LANGUAGE SQL;
  CREATE OR REPLACE FUNCTION check_staff_availability(p_staff_id UUID, p_business_id UUID, p_date DATE, p_time TEXT, p_duration INTEGER DEFAULT 60) RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$ SELECT true, NULL::text; $$ LANGUAGE SQL;
`;

describe.skipIf(!TEST_DB)('Class ACL Reconciliation (migration 326)', () => {
  const conn = getConnInfo()!;

  function adminExec(cmd: string) {
    execSync(cmd, { encoding: 'utf-8', timeout: 15_000, env: { ...process.env, PGHOST: conn.host, PGPORT: conn.port, PGUSER: conn.user, PGPASSWORD: conn.password } });
  }

  beforeAll(() => {
    try { adminExec(`dropdb --if-exists --maintenance-db=${conn.mainDb} ${DB_NAME}`); } catch { /* ignore */ }
    adminExec(`createdb --maintenance-db=${conn.mainDb} ${DB_NAME}`);

    // Apply stubs + canonical 321 + 322 + 323
    psql(STUBS);
    psqlFile('supabase/migrations/321_promotions_schema.sql');
    psqlFile('supabase/migrations/322_class_session_booking.sql');
    psqlFile('supabase/migrations/323_get_bot_context.sql');

    // Simulate Supabase default-privilege drift on production:
    // Give book_slot_atomic direct EXECUTE to anon/authenticated
    psql(`
      GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
        uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,
        text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,
        integer,integer,uuid,uuid
      ) TO anon;
      GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
        uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,
        text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,
        integer,integer,uuid,uuid
      ) TO authenticated;
    `);

    // Give class tables excessive Supabase default privileges
    psql(`
      GRANT ALL ON TABLE public.class_sessions TO anon;
      GRANT ALL ON TABLE public.class_sessions TO authenticated;
      GRANT ALL ON TABLE public.class_recurrence_rules TO anon;
      GRANT ALL ON TABLE public.class_recurrence_rules TO authenticated;
    `);
  }, 120_000);

  afterAll(() => {
    try { adminExec(`dropdb --if-exists --maintenance-db=${conn.mainDb} ${DB_NAME}`); } catch { /* ignore */ }
  });

  // ── Pre-326: Verifier MUST fail ──

  it('ACL326-1: Production verifier FAILS before migration 326 (book_slot_atomic ACL)', () => {
    let error = '';
    try {
      psqlFile('docs/sql/verify-production-321-322-postconditions.sql');
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('322-GRANT-SVC FAIL');
    expect(error).toContain('book_slot_atomic');
  });

  it('ACL326-2: Confirms anon CAN execute book_slot_atomic before 326', () => {
    const result = psql(`
      SELECT has_function_privilege('anon',
        'public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid)',
        'EXECUTE');
    `);
    expect(result).toBe('t');
  });

  it('ACL326-3: Confirms anon HAS TRUNCATE on class_sessions before 326', () => {
    const result = psql(`SELECT has_table_privilege('anon', 'public.class_sessions', 'TRUNCATE');`);
    expect(result).toBe('t');
  });

  // ── Apply migration 326 ──

  it('ACL326-4: Migration 326 applies successfully', () => {
    expect(() => {
      psqlFile('supabase/migrations/326_class_acl_reconciliation.sql');
    }).not.toThrow();
  });

  // ── Post-326: book_slot_atomic ──

  it('ACL326-5: book_slot_atomic — anon cannot EXECUTE', () => {
    const result = psql(`
      SELECT has_function_privilege('anon',
        'public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid)',
        'EXECUTE');
    `);
    expect(result).toBe('f');
  });

  it('ACL326-6: book_slot_atomic — authenticated cannot EXECUTE', () => {
    const result = psql(`
      SELECT has_function_privilege('authenticated',
        'public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid)',
        'EXECUTE');
    `);
    expect(result).toBe('f');
  });

  it('ACL326-7: book_slot_atomic — service_role CAN EXECUTE', () => {
    const result = psql(`
      SELECT has_function_privilege('service_role',
        'public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid)',
        'EXECUTE');
    `);
    expect(result).toBe('t');
  });

  // ── Post-326: class table privileges ──

  it('ACL326-8: class_sessions — authenticated has exactly SELECT/INSERT/UPDATE/DELETE', () => {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const r = psql(`SELECT has_table_privilege('authenticated', 'public.class_sessions', '${priv}');`);
      expect(r, `authenticated should have ${priv} on class_sessions`).toBe('t');
    }
    for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const r = psql(`SELECT has_table_privilege('authenticated', 'public.class_sessions', '${priv}');`);
      expect(r, `authenticated should NOT have ${priv} on class_sessions`).toBe('f');
    }
  });

  it('ACL326-9: class_sessions — anon has NO privileges', () => {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const r = psql(`SELECT has_table_privilege('anon', 'public.class_sessions', '${priv}');`);
      expect(r, `anon should NOT have ${priv} on class_sessions`).toBe('f');
    }
  });

  it('ACL326-10: class_recurrence_rules — authenticated has exactly SELECT/INSERT/UPDATE/DELETE', () => {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const r = psql(`SELECT has_table_privilege('authenticated', 'public.class_recurrence_rules', '${priv}');`);
      expect(r, `authenticated should have ${priv} on class_recurrence_rules`).toBe('t');
    }
    for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const r = psql(`SELECT has_table_privilege('authenticated', 'public.class_recurrence_rules', '${priv}');`);
      expect(r, `authenticated should NOT have ${priv} on class_recurrence_rules`).toBe('f');
    }
  });

  it('ACL326-11: class_recurrence_rules — anon has NO privileges', () => {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const r = psql(`SELECT has_table_privilege('anon', 'public.class_recurrence_rules', '${priv}');`);
      expect(r, `anon should NOT have ${priv} on class_recurrence_rules`).toBe('f');
    }
  });

  // ── Post-326: Discovery RPC unchanged ──

  it('ACL326-12: get_upcoming_class_sessions — anon/authenticated STILL have EXECUTE', () => {
    const anon = psql(`SELECT has_function_privilege('anon', 'public.get_upcoming_class_sessions(uuid,integer)', 'EXECUTE');`);
    const auth = psql(`SELECT has_function_privilege('authenticated', 'public.get_upcoming_class_sessions(uuid,integer)', 'EXECUTE');`);
    const svc = psql(`SELECT has_function_privilege('service_role', 'public.get_upcoming_class_sessions(uuid,integer)', 'EXECUTE');`);
    expect(anon).toBe('t');
    expect(auth).toBe('t');
    expect(svc).toBe('t');
  });

  // ── Post-326: Other class RPCs unchanged ──

  it('ACL326-13: Other sensitive class RPCs remain service_role only', () => {
    const rpcs = [
      'book_manual_slot_atomic', 'reschedule_booking_atomic', 'create_class_atomic',
      'create_class_recurrence_atomic', 'update_class_session_atomic',
      'reconcile_class_recurrence', 'generate_class_sessions',
    ];
    for (const rpc of rpcs) {
      const anon = psql(`SELECT has_function_privilege('anon', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='${rpc}'), 'EXECUTE');`);
      const svc = psql(`SELECT has_function_privilege('service_role', (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='${rpc}'), 'EXECUTE');`);
      expect(anon, `${rpc} anon should be false`).toBe('f');
      expect(svc, `${rpc} service_role should be true`).toBe('t');
    }
  });

  // ── Post-326: get_bot_context unchanged ──

  it('ACL326-14: get_bot_context remains canonical', () => {
    const anon = psql(`SELECT has_function_privilege('anon', 'public.get_bot_context(text,uuid)', 'EXECUTE');`);
    const svc = psql(`SELECT has_function_privilege('service_role', 'public.get_bot_context(text,uuid)', 'EXECUTE');`);
    expect(anon).toBe('f');
    expect(svc).toBe('t');
  });

  // ── Post-326: Full verifier passes ──

  it('ACL326-15: Production verifier PASSES after migration 326', () => {
    expect(() => {
      psqlFile('docs/sql/verify-production-321-322-postconditions.sql');
    }).not.toThrow();
  });

  // ── Idempotency ──

  it('ACL326-16: Migration 326 is safe to run twice', () => {
    expect(() => {
      psqlFile('supabase/migrations/326_class_acl_reconciliation.sql');
    }).not.toThrow();
  });

  // ── Source verification ──

  it('ACL326-17: Migration 326 does not alter function bodies', () => {
    const sql = readFileSync('supabase/migrations/326_class_acl_reconciliation.sql', 'utf-8');
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/DROP\s+FUNCTION/i);
  });

  it('ACL326-18: Migration 326 does not alter RLS or policies', () => {
    const sql = readFileSync('supabase/migrations/326_class_acl_reconciliation.sql', 'utf-8');
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/DROP\s+POLICY/i);
    expect(sql).not.toMatch(/ENABLE\s+ROW\s+LEVEL/i);
    expect(sql).not.toMatch(/FORCE\s+ROW\s+LEVEL/i);
  });
});
