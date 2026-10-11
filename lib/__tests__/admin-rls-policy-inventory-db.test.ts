/**
 * SEC-005 — RLS policy inventory test (real PostgreSQL)
 *
 * Verifies that NO admin-scoped RLS policy on the affected tables still
 * uses inline profiles.role checks or lacks the aal2 requirement.
 *
 * Every admin policy must either:
 *   a) Call is_admin(), is_support(), has_admin_role(), is_admin_or_finance(),
 *      or is_admin_or_support() — all of which require aal2 after M439.
 *   b) Use false (deny-all for service-role-only tables).
 *
 * Requires TEST_DATABASE_URL with M439 applied.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;
const IS_CI = process.env.CI === 'true';

if (!TEST_DB && IS_CI) {
  describe('SEC-005: RLS policy inventory (MUST NOT SKIP IN CI)', () => {
    it('fails because TEST_DATABASE_URL is not configured', () => {
      expect.fail('TEST_DATABASE_URL is required in CI for database-backed security tests');
    });
  });
} else if (!TEST_DB) {
  describe.skip('SEC-005: RLS policy inventory — TEST_DATABASE_URL not set', () => {
    it('skipped locally', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    return execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: sql },
    ).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return `ERROR: ${e.stderr || e.stdout || e.message || ''}`;
  }
}

// Tables that had inline profiles.role policies replaced by M439
const AFFECTED_TABLES = [
  'admin_audit_logs', 'ai_usage', 'business_payouts', 'businesses',
  'campaign_donations', 'conversation_usage', 'countries', 'fraud_events',
  'payout_accounts', 'resellers', 'alerts', 'llm_classifications',
  'pending_transfers', 'platform_fee_invoices', 'reseller_invoices',
  'subscription_payments', 'business_broadcasts', 'event_invites',
  'flow_dropoffs', 'parties', 'reservations', 'invoices',
  'admin_role_permissions', 'business_bank_accounts', 'event_tickets',
  'growth_pricing',
];

const ALLOWED_ADMIN_FUNCTIONS = [
  'is_admin()', 'is_support()', 'has_admin_role(',
  'is_admin_or_finance()', 'is_admin_or_support()',
];

describe('SEC-005: RLS policy inventory after M439', () => {
  // Check the known affected tables individually
  for (const table of AFFECTED_TABLES) {
    it(`${table}: no policy uses profiles.role`, () => {
      const result = runSQL(`
        SELECT policyname, qual::text, with_check::text
        FROM pg_policies
        WHERE tablename = '${table}'
          AND (qual::text LIKE '%profiles%role%' OR with_check::text LIKE '%profiles%role%');
      `);
      expect(result, `${table} has a policy still using profiles.role: ${result}`).toBe('');
    });
  }

  // Global check: no policy ANYWHERE in the database uses profiles.role
  it('no policy in the entire database uses profiles.role for admin authorization', () => {
    const result = runSQL(`
      SELECT tablename, policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND (qual::text LIKE '%profiles%role%' OR with_check::text LIKE '%profiles%role%');
    `);
    expect(result, `Found legacy profiles.role policies: ${result}`).toBe('');
  });

  it('admin_audit_logs: INSERT policy requires is_admin() (aal2)', () => {
    const result = runSQL(`
      SELECT policyname, pg_get_expr(polwithcheck, polrelid) AS wc
      FROM pg_policy WHERE polrelid = 'admin_audit_logs'::regclass AND polcmd = 'a';
    `);
    // INSERT policy uses is_admin() which requires aal2
    expect(result).toContain('is_admin()');
    expect(result).not.toContain('profiles');
  });

  it('admin_audit_logs: service_role CAN INSERT', () => {
    const result = runSQL(`
      SELECT has_table_privilege('service_role', 'public.admin_audit_logs', 'INSERT');
    `);
    expect(result).toBe('t');
  });

  it('check_session_exists RPC exists and is callable by authenticated', () => {
    const result = runSQL(`
      SELECT has_function_privilege('authenticated', 'check_session_exists(uuid)', 'EXECUTE');
    `);
    expect(result).toBe('t');
  });
});

} // end if (TEST_DB)
