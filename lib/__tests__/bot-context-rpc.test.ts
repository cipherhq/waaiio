/**
 * BOT-PERF: get_bot_context RPC — source verification + real PostgreSQL tests
 *
 * Source verification: migration structure, security, grant/revoke, column coverage, tenant scoping
 * Real PostgreSQL tests (require TEST_DATABASE_URL): cross-business isolation, input validation,
 *   same-phone multi-tenant isolation, permission enforcement
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// ══════════════════════════════════════════════════════════
// Source Verification
// ══════════════════════════════════════════════════════════

describe('BOT-PERF: get_bot_context source verification', () => {
  const migration323 = readFileSync('supabase/migrations/323_get_bot_context.sql', 'utf-8');

  it('CTX-1: function created with SECURITY DEFINER', () => {
    expect(migration323).toContain('SECURITY DEFINER');
  });

  it('CTX-2: search_path set to public (prevents injection)', () => {
    expect(migration323).toContain("SET search_path = public");
  });

  it('CTX-3: REVOKE ALL from PUBLIC (new signature)', () => {
    expect(migration323).toContain("REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM PUBLIC");
  });

  it('CTX-3b: REVOKE ALL from anon (Supabase default privilege override)', () => {
    expect(migration323).toContain("REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM anon");
  });

  it('CTX-4: REVOKE ALL from authenticated (new signature)', () => {
    expect(migration323).toContain("REVOKE ALL ON FUNCTION public.get_bot_context(TEXT, UUID) FROM authenticated");
  });

  it('CTX-5: GRANT EXECUTE only to service_role (new signature)', () => {
    expect(migration323).toContain("GRANT EXECUTE ON FUNCTION public.get_bot_context(TEXT, UUID) TO service_role");
  });

  it('CTX-6: input validation rejects null/empty phone', () => {
    expect(migration323).toContain("p_phone IS NULL OR LENGTH(TRIM(p_phone)) = 0");
  });

  it('CTX-7: returns has_session=false when no session found', () => {
    expect(migration323).toContain("jsonb_build_object('has_session', false)");
  });

  it('CTX-8: session scoped by whatsapp_number + is_active + expires_at', () => {
    expect(migration323).toContain("whatsapp_number = p_phone");
    expect(migration323).toContain("is_active = true");
    expect(migration323).toContain("expires_at >= NOW()");
  });

  it('CTX-9: business lookup scoped to session business_id only', () => {
    expect(migration323).toContain("b.id = v_session.business_id");
  });

  it('CTX-10: capabilities scoped to session business_id', () => {
    expect(migration323).toContain("bc.business_id = v_session.business_id");
  });

  it('CTX-11: overrides scoped to session business_id', () => {
    expect(migration323).toContain("co.business_id = v_session.business_id");
  });

  it('CTX-12: returns session id, version, current_step for CAS protection', () => {
    expect(migration323).toContain("'id', v_session.id");
    expect(migration323).toContain("'version', v_session.version");
    expect(migration323).toContain("'current_step', v_session.current_step");
  });

  it('CTX-13: returns business status for active check', () => {
    expect(migration323).toContain("'status', b.status");
  });

  it('CTX-14: returns subscription_tier for capability gating', () => {
    expect(migration323).toContain("'subscription_tier', b.subscription_tier");
  });

  it('CTX-15: does NOT return capacity/availability/payment/financial data', () => {
    expect(migration323).not.toContain('remaining_capacity');
    expect(migration323).not.toContain('available_slots');
    expect(migration323).not.toContain('payment_status');
    expect(migration323).not.toContain('stripe_');
    expect(migration323).not.toContain('paystack_');
    expect(migration323).not.toContain('balance');
    expect(migration323).not.toContain('amount');
    expect(migration323).not.toContain('class_sessions');
    expect(migration323).not.toContain('bookings');
  });

  it('CTX-16: only reads from bot_sessions, businesses, business_capabilities, capability_overrides', () => {
    const functionBody = migration323.slice(
      migration323.indexOf('BEGIN'),
      migration323.indexOf('END;')
    );
    const fromClauses = functionBody.match(/FROM\s+(\w+)/g) || [];
    const tables = fromClauses.map(f => f.replace(/FROM\s+/, ''));
    const allowedTables = ['bot_sessions', 'businesses', 'business_capabilities', 'capability_overrides'];
    for (const table of tables) {
      expect(allowedTables).toContain(table);
    }
  });

  it('CTX-17: read-only — no INSERT, UPDATE, DELETE', () => {
    const functionBody = migration323.slice(
      migration323.indexOf('BEGIN'),
      migration323.indexOf('END;')
    );
    expect(functionBody).not.toMatch(/\bINSERT\b/i);
    expect(functionBody).not.toMatch(/\bUPDATE\b/i);
    expect(functionBody).not.toMatch(/\bDELETE\b/i);
  });

  // ── Tenant scoping source tests ──

  it('CTX-18: p_business_id parameter exists in function signature', () => {
    expect(migration323).toContain('p_business_id UUID DEFAULT NULL');
  });

  it('CTX-19: business-scoped predicate exists — AND business_id = p_business_id', () => {
    expect(migration323).toContain('AND business_id = p_business_id');
  });

  it('CTX-20: business-scoped branch requires p_business_id IS NOT NULL', () => {
    expect(migration323).toContain('IF p_business_id IS NOT NULL THEN');
  });

  it('CTX-21: NULL business fallback preserves legacy latest-session behavior', () => {
    // The ELSE branch must NOT include business_id in its WHERE clause
    const functionBody = migration323.slice(
      migration323.indexOf('BEGIN'),
      migration323.indexOf('END;')
    );
    // Find the ELSE block (legacy path)
    const elseIdx = functionBody.indexOf('ELSE');
    const endIfIdx = functionBody.indexOf('END IF', elseIdx);
    const elseBranch = functionBody.slice(elseIdx, endIfIdx);
    // The ELSE branch queries bot_sessions but must NOT filter by business_id
    expect(elseBranch).toContain('whatsapp_number = p_phone');
    expect(elseBranch).toContain('is_active = true');
    expect(elseBranch).toContain('expires_at >= NOW()');
    expect(elseBranch).not.toContain('p_business_id');
  });

  it('CTX-22: no caller-controlled cross-business query path in business-scoped branch', () => {
    // In the business-scoped branch (IF p_business_id IS NOT NULL), the session query
    // must use p_business_id. After session is found, all subsequent queries use
    // v_session.business_id (derived from the matched session, not from user input).
    const functionBody = migration323.slice(
      migration323.indexOf('BEGIN'),
      migration323.indexOf('END;')
    );
    // Business/capabilities/overrides lookups all use v_session.business_id
    const businessQueries = functionBody.match(/b\.id\s*=\s*\S+/g) || [];
    for (const q of businessQueries) {
      expect(q).toContain('v_session.business_id');
    }
    const capQueries = functionBody.match(/bc\.business_id\s*=\s*\S+/g) || [];
    for (const q of capQueries) {
      expect(q).toContain('v_session.business_id');
    }
    const overrideQueries = functionBody.match(/co\.business_id\s*=\s*\S+/g) || [];
    for (const q of overrideQueries) {
      expect(q).toContain('v_session.business_id');
    }
  });

  it('CTX-23: drops old single-arg signature before creating new one', () => {
    expect(migration323).toContain('DROP FUNCTION IF EXISTS public.get_bot_context(TEXT)');
  });

  it('CTX-24: GRANT/REVOKE uses new (TEXT, UUID) signature', () => {
    // Must NOT have old TEXT-only grants (those would be stale)
    const grantRevokeSection = migration323.slice(migration323.lastIndexOf('REVOKE ALL'));
    expect(grantRevokeSection).not.toMatch(/get_bot_context\(TEXT\)\s/);
    // Must have new signature
    expect(grantRevokeSection).toContain('get_bot_context(TEXT, UUID)');
  });
});

// ══════════════════════════════════════════════════════════
// Real PostgreSQL Tests (require TEST_DATABASE_URL)
// ══════════════════════════════════════════════════════════

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('BOT-PERF: get_bot_context real PostgreSQL tests', () => {
  const BIZ_A = '11111111-1111-1111-1111-111111111111';
  const BIZ_B = '22222222-2222-2222-2222-222222222222';
  const BIZ_UNKNOWN = '99999999-9999-9999-9999-999999999999';
  const USR = '33333333-3333-3333-3333-333333333333';
  const PHONE = '+1234567890';
  const PHONE2 = '+9876543210';

  function psql(sql: string): string {
    const raw = execSync(`psql "${TEST_DB}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 15_000 });
    return raw.split('\n').filter(l => { const t = l.trim(); return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t); }).join('\n').trim();
  }

  function psqlJson(sql: string): unknown {
    const raw = psql(sql);
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function reset() {
    psql(`DELETE FROM bot_sessions WHERE whatsapp_number IN ('${PHONE}', '${PHONE2}');`);
  }

  beforeAll(() => {
    // Bootstrap minimal schema if tables don't exist yet (local dev without full migrations)
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT gen_random_uuid(); $$;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT, phone TEXT);
      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY, owner_id UUID, name TEXT, slug TEXT, category TEXT,
        flow_type TEXT DEFAULT 'scheduling', subscription_tier TEXT DEFAULT 'free',
        trial_ends_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', operating_hours JSONB DEFAULT '{}',
        country_code TEXT DEFAULT 'NG', payment_gateway TEXT, status TEXT DEFAULT 'active',
        is_whitelabel BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), whatsapp_number TEXT NOT NULL,
        business_id UUID, current_step TEXT DEFAULT 'greeting', session_data JSONB DEFAULT '{}',
        is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(), version INT DEFAULT 0, user_id UUID,
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour'
      );
      CREATE TABLE IF NOT EXISTS business_capabilities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID NOT NULL,
        capability TEXT NOT NULL, is_enabled BOOLEAN DEFAULT true, sort_order INT DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS capability_overrides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID NOT NULL, capability TEXT NOT NULL
      );
    `);
    // Apply the get_bot_context function (drops old signature + creates new)
    const migration323 = require('fs').readFileSync('supabase/migrations/323_get_bot_context.sql', 'utf-8');
    psql(migration323);
    // Insert test businesses
    psql(`INSERT INTO businesses (id, name, slug, category, status) VALUES ('${BIZ_A}', 'Business A', 'biz-a', 'salon', 'active') ON CONFLICT (id) DO NOTHING;`);
    psql(`INSERT INTO businesses (id, name, slug, category, status) VALUES ('${BIZ_B}', 'Business B', 'biz-b', 'restaurant', 'active') ON CONFLICT (id) DO NOTHING;`);
    reset();
  });

  afterAll(() => {
    reset();
  });

  // ── Basic input validation ──

  it('DB-CTX-1: returns has_session=false for unknown phone', () => {
    const r = psqlJson(`SELECT get_bot_context('+0000000000');`) as Record<string, unknown>;
    expect(r.has_session).toBe(false);
  });

  it('DB-CTX-2: returns has_session=false for null input', () => {
    const r = psqlJson(`SELECT get_bot_context(NULL);`) as Record<string, unknown>;
    expect(r.has_session).toBe(false);
  });

  it('DB-CTX-3: returns has_session=false for empty string', () => {
    const r = psqlJson(`SELECT get_bot_context('');`) as Record<string, unknown>;
    expect(r.has_session).toBe(false);
  });

  // ── Business-scoped session lookup ──

  it('DB-CTX-4: returns session + business when scoped to correct business', () => {
    reset();
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
      VALUES ('${PHONE}', '${BIZ_A}', 'select_capability', '{"capabilities":["scheduling"]}', true, NOW() + INTERVAL '1 hour');`);

    const r = psqlJson(`SELECT get_bot_context('${PHONE}', '${BIZ_A}');`) as Record<string, unknown>;
    expect(r.has_session).toBe(true);

    const session = r.session as Record<string, unknown>;
    expect(session.whatsapp_number).toBe(PHONE);
    expect(session.business_id).toBe(BIZ_A);
    expect(session.current_step).toBe('select_capability');
    expect(session.version).toBeDefined();

    const business = r.business as Record<string, unknown>;
    expect(business.id).toBe(BIZ_A);
    expect(business.name).toBe('Business A');
    expect(business.status).toBe('active');
  });

  it('DB-CTX-5: expired session returns has_session=false', () => {
    reset();
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
      VALUES ('${PHONE}', '${BIZ_A}', 'greeting', '{}', true, NOW() - INTERVAL '1 hour');`);

    const r = psqlJson(`SELECT get_bot_context('${PHONE}', '${BIZ_A}');`) as Record<string, unknown>;
    expect(r.has_session).toBe(false);
  });

  it('DB-CTX-6: inactive session returns has_session=false', () => {
    reset();
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
      VALUES ('${PHONE}', '${BIZ_A}', 'greeting', '{}', false, NOW() + INTERVAL '1 hour');`);

    const r = psqlJson(`SELECT get_bot_context('${PHONE}', '${BIZ_A}');`) as Record<string, unknown>;
    expect(r.has_session).toBe(false);
  });

  // ── Same-phone cross-business isolation (CORE TENANT SCOPING) ──

  it('DB-CTX-7: same phone, two businesses — scoped to BIZ_A returns only BIZ_A session', () => {
    reset();
    // Create active sessions for the SAME phone on TWO different businesses
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, created_at, expires_at)
      VALUES ('${PHONE}', '${BIZ_A}', 'select_service', '{"flow":"scheduling"}', true, NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '1 hour');`);
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, created_at, expires_at)
      VALUES ('${PHONE}', '${BIZ_B}', 'greeting', '{"flow":"ordering"}', true, NOW(), NOW() + INTERVAL '1 hour');`);

    const r = psqlJson(`SELECT get_bot_context('${PHONE}', '${BIZ_A}');`) as Record<string, unknown>;
    expect(r.has_session).toBe(true);
    const session = r.session as Record<string, unknown>;
    expect(session.business_id).toBe(BIZ_A);
    expect(session.current_step).toBe('select_service');
    const business = r.business as Record<string, unknown>;
    expect(business.id).toBe(BIZ_A);
    expect(business.name).toBe('Business A');
  });

  it('DB-CTX-8: same phone, two businesses — scoped to BIZ_B returns only BIZ_B session', () => {
    // Uses sessions created in DB-CTX-7 (no reset)
    const r = psqlJson(`SELECT get_bot_context('${PHONE}', '${BIZ_B}');`) as Record<string, unknown>;
    expect(r.has_session).toBe(true);
    const session = r.session as Record<string, unknown>;
    expect(session.business_id).toBe(BIZ_B);
    expect(session.current_step).toBe('greeting');
    const business = r.business as Record<string, unknown>;
    expect(business.id).toBe(BIZ_B);
    expect(business.name).toBe('Business B');
  });

  it('DB-CTX-9: same phone, two businesses — scoped to UNKNOWN returns has_session=false, MUST NOT return A or B', () => {
    // Uses sessions created in DB-CTX-7 (no reset)
    const r = psqlJson(`SELECT get_bot_context('${PHONE}', '${BIZ_UNKNOWN}');`) as Record<string, unknown>;
    expect(r.has_session).toBe(false);
    // Must not leak any session data
    expect(r).not.toHaveProperty('session');
    expect(r).not.toHaveProperty('business');
  });

  it('DB-CTX-10: same phone, two businesses — NULL business preserves legacy latest-session behavior', () => {
    // Uses sessions created in DB-CTX-7 (no reset)
    // BIZ_B was created more recently (NOW() vs NOW() - 5 min), so legacy picks BIZ_B
    const r = psqlJson(`SELECT get_bot_context('${PHONE}', NULL);`) as Record<string, unknown>;
    expect(r.has_session).toBe(true);
    const session = r.session as Record<string, unknown>;
    // Legacy behavior returns the most recent session (BIZ_B, created later)
    expect(session.business_id).toBe(BIZ_B);
  });

  it('DB-CTX-11: same phone, two businesses — default (no second arg) preserves legacy behavior', () => {
    // DEFAULT NULL should behave identically to explicit NULL
    const r = psqlJson(`SELECT get_bot_context('${PHONE}');`) as Record<string, unknown>;
    expect(r.has_session).toBe(true);
    const session = r.session as Record<string, unknown>;
    expect(session.business_id).toBe(BIZ_B);
  });

  // ── Capabilities and overrides ──

  it('DB-CTX-12: capabilities returned as array', () => {
    reset();
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
      VALUES ('${PHONE}', '${BIZ_A}', 'greeting', '{}', true, NOW() + INTERVAL '1 hour');`);

    const r = psqlJson(`SELECT get_bot_context('${PHONE}', '${BIZ_A}');`) as Record<string, unknown>;
    expect(Array.isArray(r.capabilities)).toBe(true);
    expect(Array.isArray(r.capability_overrides)).toBe(true);
  });

  it('DB-CTX-13: session without business_id returns null business', () => {
    reset();
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
      VALUES ('${PHONE}', NULL, 'greeting', '{}', true, NOW() + INTERVAL '1 hour');`);

    const r = psqlJson(`SELECT get_bot_context('${PHONE}');`) as Record<string, unknown>;
    expect(r.has_session).toBe(true);
    expect(r.business).toBeNull();
    expect(r.capabilities).toEqual([]);
    expect(r.capability_overrides).toEqual([]);
  });

  // ── Different phones, different businesses (original cross-phone test) ──

  it('DB-CTX-14: cross-phone isolation — phone A cannot see phone B business', () => {
    reset();
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
      VALUES ('${PHONE}', '${BIZ_A}', 'greeting', '{}', true, NOW() + INTERVAL '1 hour');`);
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
      VALUES ('${PHONE2}', '${BIZ_B}', 'greeting', '{}', true, NOW() + INTERVAL '1 hour');`);

    const r1 = psqlJson(`SELECT get_bot_context('${PHONE}', '${BIZ_A}');`) as Record<string, unknown>;
    const r2 = psqlJson(`SELECT get_bot_context('${PHONE2}', '${BIZ_B}');`) as Record<string, unknown>;

    expect((r1.business as Record<string, unknown>).id).toBe(BIZ_A);
    expect((r2.business as Record<string, unknown>).id).toBe(BIZ_B);
    expect((r1.business as Record<string, unknown>).id).not.toBe(BIZ_B);
    expect((r2.business as Record<string, unknown>).id).not.toBe(BIZ_A);
  });

  // ── Real role permission tests ──

  it('DB-CTX-PERM-1: anon cannot execute get_bot_context', () => {
    const result = psql(`
      SET ROLE anon;
      SELECT has_function_privilege('anon', 'public.get_bot_context(text, uuid)', 'EXECUTE');
    `);
    expect(result).toBe('f');
    psql('RESET ROLE;');
  });

  it('DB-CTX-PERM-2: authenticated cannot execute get_bot_context', () => {
    const result = psql(`
      SET ROLE authenticated;
      SELECT has_function_privilege('authenticated', 'public.get_bot_context(text, uuid)', 'EXECUTE');
    `);
    expect(result).toBe('f');
    psql('RESET ROLE;');
  });

  it('DB-CTX-PERM-3: service_role can execute get_bot_context', () => {
    const result = psql(`
      SELECT has_function_privilege('service_role', 'public.get_bot_context(text, uuid)', 'EXECUTE');
    `);
    expect(result).toBe('t');
  });

  it('DB-CTX-PERM-4: anon direct call fails with permission denied', () => {
    reset();
    psql(`INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, expires_at)
      VALUES ('${PHONE}', '${BIZ_A}', 'greeting', '{}', true, NOW() + INTERVAL '1 hour');`);

    let error = '';
    try {
      psql(`SET ROLE anon; SELECT get_bot_context('${PHONE}', '${BIZ_A}');`);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  it('DB-CTX-PERM-5: authenticated direct call fails with permission denied', () => {
    let error = '';
    try {
      psql(`SET ROLE authenticated; SELECT get_bot_context('${PHONE}', '${BIZ_A}');`);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });
});
