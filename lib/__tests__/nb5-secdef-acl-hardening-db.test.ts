/**
 * NB-5: SECURITY DEFINER ACL hardening — Disposable PostgreSQL tests
 *
 * Requires TEST_DATABASE_URL with all migrations applied through M463.
 * Tests actual anon/authenticated/service_role execution permissions
 * against real PostgreSQL, not source-text assertions.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/nb5-secdef-acl-hardening-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRunDb = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

// ── Pre-M463 baseline (before migration applied) ─────────────────────────

describe.skipIf(!canRunDb)('NB-5 M463: pre-migration baseline', () => {
  it('all 6 functions exist', () => {
    const count = psql(`
      SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname IN (
        'calculate_volume_discount', 'check_conversation_limit',
        'get_business_revenue', 'get_order_revenue', 'get_outstanding_invoices',
        'check_business_role'
      );
    `);
    expect(parseInt(count)).toBe(6);
  });

  it('calculate_volume_discount is SECURITY DEFINER', () => {
    const secdef = psql(`
      SELECT prosecdef FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'calculate_volume_discount';
    `);
    expect(secdef).toBe('t');
  });
});

// ── Post-M463 permission matrix ──────────────────────────────────────────
// These tests verify the ACL state AFTER M463 is applied.
// If running against a DB without M463, they should be run after applying it.

describe.skipIf(!canRunDb)('NB-5 M463: has_function_privilege matrix', () => {
  // Group A: service_role only (calculate_volume_discount, check_conversation_limit)
  it.each([
    'calculate_volume_discount(uuid,uuid,integer,integer)',
    'check_conversation_limit(uuid)',
  ])('%s: anon=DENY, authenticated=DENY, service_role=ALLOW', (sig) => {
    const anon = psql(`SELECT has_function_privilege('anon', 'public.${sig}', 'EXECUTE');`);
    const auth = psql(`SELECT has_function_privilege('authenticated', 'public.${sig}', 'EXECUTE');`);
    const svc = psql(`SELECT has_function_privilege('service_role', 'public.${sig}', 'EXECUTE');`);
    expect(anon).toBe('f');
    expect(auth).toBe('f');
    expect(svc).toBe('t');
  });

  // Group B: authenticated + service_role (dashboard RPCs + check_business_role)
  it.each([
    'get_business_revenue(uuid)',
    'get_order_revenue(uuid)',
    'get_outstanding_invoices(uuid)',
    'check_business_role(uuid,uuid,business_role[])',
  ])('%s: anon=DENY, authenticated=ALLOW, service_role=ALLOW', (sig) => {
    const anon = psql(`SELECT has_function_privilege('anon', 'public.${sig}', 'EXECUTE');`);
    const auth = psql(`SELECT has_function_privilege('authenticated', 'public.${sig}', 'EXECUTE');`);
    const svc = psql(`SELECT has_function_privilege('service_role', 'public.${sig}', 'EXECUTE');`);
    expect(anon).toBe('f');
    expect(auth).toBe('t');
    expect(svc).toBe('t');
  });
});

describe.skipIf(!canRunDb)('NB-5 M463: search_path verification', () => {
  it('calculate_volume_discount has search_path=public in proconfig', () => {
    const config = psql(`
      SELECT array_to_string(proconfig, ',') FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'calculate_volume_discount';
    `);
    expect(config).toContain('search_path=public');
  });
});

describe.skipIf(!canRunDb)('NB-5 M463: actual execution deny (SET ROLE)', () => {
  it('anon cannot execute calculate_volume_discount', () => {
    const err = psqlMayFail(`
      SET ROLE anon;
      SELECT public.calculate_volume_discount(
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid,
        1, 1000
      );
    `);
    expect(err).toContain('permission denied');
  });

  it('anon cannot execute check_conversation_limit', () => {
    const err = psqlMayFail(`
      SET ROLE anon;
      SELECT public.check_conversation_limit('00000000-0000-0000-0000-000000000001'::uuid);
    `);
    expect(err).toContain('permission denied');
  });

  it('anon cannot execute get_business_revenue', () => {
    const err = psqlMayFail(`
      SET ROLE anon;
      SELECT public.get_business_revenue('00000000-0000-0000-0000-000000000001'::uuid);
    `);
    expect(err).toContain('permission denied');
  });

  it('anon cannot execute check_business_role', () => {
    const err = psqlMayFail(`
      SET ROLE anon;
      SELECT public.check_business_role(
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid,
        ARRAY['owner']::business_role[]
      );
    `);
    expect(err).toContain('permission denied');
  });

  it('authenticated CAN execute get_business_revenue', () => {
    // Will fail with a data error (no business exists), not a permission error
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SELECT public.get_business_revenue('00000000-0000-0000-0000-000000000001'::uuid);
    `);
    expect(result).not.toContain('permission denied');
  });

  it('authenticated CANNOT execute calculate_volume_discount', () => {
    const err = psqlMayFail(`
      SET ROLE authenticated;
      SELECT public.calculate_volume_discount(
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid,
        1, 1000
      );
    `);
    expect(err).toContain('permission denied');
  });
});

// ── Intentionally-public functions NOT affected ──────────────────────────

describe.skipIf(!canRunDb)('NB-5 M463: intentionally-public functions unchanged', () => {
  it.each([
    'handle_new_user',
    'get_active_appointments_public',
    'get_upcoming_class_sessions',
  ])('%s: remains callable by anon (intentionally public)', (fnName) => {
    const result = psql(`
      SELECT has_function_privilege('anon', oid, 'EXECUTE')
      FROM pg_proc WHERE proname = '${fnName}'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      LIMIT 1;
    `);
    // If function exists, it should be anon-callable; if not, skip
    if (result) expect(result).toBe('t');
  });
});
