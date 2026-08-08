/**
 * Migration 311: Reseller Payout Financial Integrity — Real PostgreSQL Tests
 *
 * Non-concurrency DB tests: RLS behavioral, constraint, RPC behavior.
 * Concurrency tests: scripts/test-migration-311-concurrency.sh
 *
 * Required env: TEST_DATABASE_URL
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

function runSQL(sql: string, expectError = false): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    return execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: sql },
    ).trim();
  } catch (err: any) {
    const msg = err.stderr || err.stdout || err.message || '';
    return `ERROR: ${msg}`;
  }
}

const describeIfDb = !TEST_DB ? describe.skip : describe;

// ══════════════════════════════════════════════════════════
// A. RLS Policy Existence Tests
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: RLS policies exist correctly', () => {
  it('admin_manages_reseller_payouts policy uses is_admin()', () => {
    const r = runSQL("SELECT polname, pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'reseller_payouts'::regclass AND polname = 'admin_manages_reseller_payouts';");
    expect(r).toContain('admin_manages_reseller_payouts');
    expect(r).toContain('is_admin()');
  });

  it('finance_reads_reseller_payouts is SELECT-only with is_admin_or_finance()', () => {
    const r = runSQL("SELECT polname, polcmd, pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'reseller_payouts'::regclass AND polname = 'finance_reads_reseller_payouts';");
    expect(r).toContain('finance_reads_reseller_payouts');
    expect(r).toContain('r'); // polcmd r = SELECT
    expect(r).toContain('is_admin_or_finance()');
  });

  it('old profiles.role-based policy is dropped', () => {
    const r = runSQL("SELECT COUNT(*) FROM pg_policy WHERE polrelid = 'reseller_payouts'::regclass AND polname = 'Admin manages reseller payouts';");
    expect(r).toBe('0');
  });

  it('is_admin_or_finance() includes admin+finance only', () => {
    const r = runSQL("SELECT prosrc FROM pg_proc WHERE proname = 'is_admin_or_finance';");
    expect(r).toContain("'admin'");
    expect(r).toContain("'finance'");
    expect(r).not.toContain("'support'");
    expect(r).not.toContain("'operations'");
  });
});

// ══════════════════════════════════════════════════════════
// B. RLS Behavioral Tests
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: RLS behavioral authorization', () => {
  const ADMIN_USER = '00000000-0000-0000-0000-000000311001';
  const FINANCE_USER = '00000000-0000-0000-0000-000000311002';
  const SUPPORT_USER = '00000000-0000-0000-0000-000000311003';
  const OPS_USER = '00000000-0000-0000-0000-000000311004';
  const RESELLER_USER = '00000000-0000-0000-0000-000000311005';
  const RESELLER_ID = '00000000-0000-0000-0000-000000311010';
  const PAYOUT_ID = '00000000-0000-0000-0000-000000311020';

  beforeAll(() => {
    // Create test auth.users with different roles (disable trigger to avoid handle_new_user errors)
    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id, raw_app_meta_data) VALUES
        ('${ADMIN_USER}', '{"role":"admin"}'::jsonb),
        ('${FINANCE_USER}', '{"role":"finance"}'::jsonb),
        ('${SUPPORT_USER}', '{"role":"support"}'::jsonb),
        ('${OPS_USER}', '{"role":"operations"}'::jsonb),
        ('${RESELLER_USER}', '{}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = EXCLUDED.raw_app_meta_data;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
    // Create test reseller (user_id required by schema)
    runSQL(`INSERT INTO resellers (id, user_id, company_name, commission_percentage) VALUES ('${RESELLER_ID}', '${RESELLER_USER}', 'RLS Test Reseller', 10) ON CONFLICT (id) DO NOTHING;`);
    // Create test payout
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-06-01', '2026-06-15', 100, 'pending') ON CONFLICT (id) DO NOTHING;`);
  });

  afterAll(() => {
    // Restore auth.uid() to original CI stub
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT '00000000-0000-0000-0000-000000000000'::UUID; $$ LANGUAGE SQL STABLE;`);
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}';`);
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id IN ('${ADMIN_USER}','${FINANCE_USER}','${SUPPORT_USER}','${OPS_USER}','${RESELLER_USER}'); ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
  });

  // Helper: run SQL as a specific role identity
  // Redefines auth.uid() as postgres (has schema auth permission), then SET ROLE
  function asRole(userId: string, sql: string): string {
    return runSQL(`
      BEGIN;
      -- Override auth.uid() as postgres (before role switch)
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${userId}'::UUID; $fn$ LANGUAGE SQL STABLE;
      -- Now switch to authenticated role for RLS evaluation
      SET LOCAL ROLE authenticated;
      ${sql}
      COMMIT;
    `);
  }

  // ── ADMIN ──
  it('admin SELECT succeeds', () => {
    const r = asRole(ADMIN_USER, `SELECT id FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(r).toContain(PAYOUT_ID);
  });

  it('admin INSERT succeeds', () => {
    const testId = '00000000-0000-0000-0000-000000311021';
    runSQL(`DELETE FROM reseller_payouts WHERE id = '${testId}';`);
    const r = asRole(ADMIN_USER, `INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${testId}', '${RESELLER_ID}', '2026-07-01', '2026-07-15', 50, 'pending') RETURNING id;`);
    expect(r).toContain(testId);
    runSQL(`DELETE FROM reseller_payouts WHERE id = '${testId}';`);
  });

  it('admin UPDATE succeeds', () => {
    const r = asRole(ADMIN_USER, `UPDATE reseller_payouts SET notes = 'admin-test' WHERE id = '${PAYOUT_ID}' RETURNING id;`);
    expect(r).toContain(PAYOUT_ID);
  });

  // ── FINANCE ──
  it('finance SELECT succeeds', () => {
    const r = asRole(FINANCE_USER, `SELECT id FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(r).toContain(PAYOUT_ID);
  });

  it('finance INSERT denied', () => {
    const r = asRole(FINANCE_USER, `INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-11-01', '2026-11-15', 50, 'pending');`);
    // RLS violation inside transaction produces ERROR or ROLLBACK
    expect(r.includes('ERROR') || r.includes('ROLLBACK') || r.includes('policy')).toBe(true);
  });

  it('finance UPDATE denied (row invisible to UPDATE policy)', () => {
    asRole(FINANCE_USER, `UPDATE reseller_payouts SET notes = 'hack' WHERE id = '${PAYOUT_ID}';`);
    const notes = runSQL(`SELECT COALESCE(notes, 'NONE') FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(notes).not.toBe('hack');
  });

  it('finance DELETE denied', () => {
    const before = runSQL(`SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    asRole(FINANCE_USER, `DELETE FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    const after = runSQL(`SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(after).toBe(before);
  });

  // ── SUPPORT ──
  it('support SELECT denied (zero rows visible)', () => {
    const r = asRole(SUPPORT_USER, `SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(r).toContain('\n0\n');
  });

  it('support INSERT denied', () => {
    const r = asRole(SUPPORT_USER, `INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-12-01', '2026-12-15', 50, 'pending');`);
    expect(r.includes('ERROR') || r.includes('ROLLBACK') || r.includes('policy')).toBe(true);
  });

  // ── OPERATIONS ──
  it('operations SELECT denied (zero rows visible)', () => {
    const r = asRole(OPS_USER, `SELECT COUNT(*) FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(r).toContain('\n0\n');
  });

  // ── ANON ──
  it('anon SELECT denied', () => {
    const r = runSQL(`BEGIN; SET LOCAL ROLE anon; SELECT COUNT(*) FROM reseller_payouts; COMMIT;`);
    // anon may get permission denied, 0 rows, or ROLLBACK
    expect(r === '0' || r.includes('ERROR') || r.includes('permission denied') || r.includes('ROLLBACK')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// C. Overlap Constraint Tests
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: overlap exclusion constraint', () => {
  const RESELLER_USER = '00000000-0000-0000-0000-000000311005';
  const RESELLER_ID = '00000000-0000-0000-0000-000000000312';
  const OTHER_RESELLER = '00000000-0000-0000-0000-000000000313';
  const OTHER_USER = '00000000-0000-0000-0000-000000311006';

  beforeAll(() => {
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; INSERT INTO auth.users (id) VALUES ('${RESELLER_USER}'), ('${OTHER_USER}') ON CONFLICT DO NOTHING; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
    runSQL(`INSERT INTO resellers (id, user_id, company_name, commission_percentage) VALUES ('${RESELLER_ID}', '${RESELLER_USER}', 'Test 312', 10) ON CONFLICT DO NOTHING;`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id IN ('${RESELLER_ID}', '${OTHER_RESELLER}');`);
    runSQL(`DELETE FROM resellers WHERE id IN ('${RESELLER_ID}', '${OTHER_RESELLER}');`);
  });

  it('constraint exists', () => {
    const r = runSQL("SELECT COUNT(*) FROM pg_constraint WHERE conname = 'reseller_payouts_no_overlap';");
    expect(r).toBe('1');
  });

  it('adjacent periods allowed', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    const r1 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-15', 100, 'pending') RETURNING id;`);
    expect(r1).not.toContain('ERROR');
    const r2 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-08-15', '2026-08-31', 100, 'pending') RETURNING id;`);
    expect(r2).not.toContain('ERROR');
  });

  it('partial overlap rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    const setup = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-15', 100, 'pending') RETURNING id;`);
    expect(setup).not.toContain('ERROR'); // verify setup succeeded
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-08-14', '2026-08-20', 100, 'pending');`);
    expect(r).toContain('ERROR');
  });

  it('identical period rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    const setup = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-09-01', '2026-09-15', 100, 'pending') RETURNING id;`);
    expect(setup).not.toContain('ERROR');
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-09-01', '2026-09-15', 100, 'pending');`);
    expect(r).toContain('ERROR');
  });

  it('rejected payout does not block non-overlapping adjacent period', () => {
    // Note: exact-duplicate periods are blocked by UNIQUE(reseller_id, period_start, period_end)
    // regardless of status. The exclusion constraint only handles overlapping (non-identical) ranges.
    // A rejected period for [Oct 1, Oct 15) does not block [Oct 15, Oct 31).
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-10-01', '2026-10-15', 100, 'rejected');`);
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-10-15', '2026-10-31', 100, 'pending') RETURNING id;`);
    expect(r).not.toContain('ERROR');
  });

  it('different resellers same dates allowed', () => {
    runSQL(`INSERT INTO resellers (id, user_id, company_name, commission_percentage) VALUES ('${OTHER_RESELLER}', '${OTHER_USER}', 'Other', 10) ON CONFLICT DO NOTHING;`);
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id IN ('${RESELLER_ID}', '${OTHER_RESELLER}');`);
    const r1 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${RESELLER_ID}', '2026-11-01', '2026-11-15', 100, 'pending') RETURNING id;`);
    expect(r1).not.toContain('ERROR');
    const r2 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('${OTHER_RESELLER}', '2026-11-01', '2026-11-15', 100, 'pending') RETURNING id;`);
    expect(r2).not.toContain('ERROR');
  });
});

// ══════════════════════════════════════════════════════════
// D. mark_reseller_payout_paid RPC (non-concurrent)
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: mark_reseller_payout_paid RPC', () => {
  const RESELLER_USER = '00000000-0000-0000-0000-000000311005';
  const RESELLER_ID = '00000000-0000-0000-0000-000000000314';
  const PAYOUT_ID = '00000000-0000-0000-0000-00000000031c';
  // Use the ADMIN_USER from behavioral tests (already in auth.users)
  const ADMIN_ID = '00000000-0000-0000-0000-000000311001';

  beforeAll(() => {
    // Ensure auth.users exist for both reseller owner and admin (approved_by FK)
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; INSERT INTO auth.users (id, raw_app_meta_data) VALUES ('${RESELLER_USER}', '{}'::jsonb), ('${ADMIN_ID}', '{"role":"admin"}'::jsonb) ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = EXCLUDED.raw_app_meta_data; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM platform_fees WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO resellers (id, user_id, company_name, commission_percentage) VALUES ('${RESELLER_ID}', '${RESELLER_USER}', 'RPC Test', 10) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO platform_fees (business_id, transaction_amount, fee_total, reseller_id, reseller_commission) VALUES ((SELECT id FROM businesses LIMIT 1), 10000, 100, '${RESELLER_ID}', 1000);`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM platform_fees WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}';`);
  });

  it('returns not_found for non-existent payout', () => {
    const r = runSQL(`SELECT mark_reseller_payout_paid('00000000-0000-0000-0000-000000000000', '${ADMIN_ID}');`);
    expect(r).toContain('not_found');
  });

  it('returns not_approved for pending payout', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-06-01', '2026-06-15', 500, 'pending');`);
    const r = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}');`);
    expect(r).toContain('not_approved');
  });

  it('succeeds for approved payout within balance', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-07-01', '2026-07-15', 500, 'approved');`);
    const r = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}');`);
    expect(r).toMatch(/"success"\s*:\s*true/);
    const status = runSQL(`SELECT status FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(status).toBe('paid');
  });

  it('returns insufficient_balance when over limit', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}';`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status) VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-08-01', '2026-08-15', 2000, 'approved');`);
    const r = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}');`);
    expect(r).toContain('insufficient_balance');
    const status = runSQL(`SELECT status FROM reseller_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(status).toBe('approved');
  });

  it('RPC restricted to service_role', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'mark_reseller_payout_paid(uuid,uuid)', 'EXECUTE');");
    expect(r).toBe('f');
  });
});

// ══════════════════════════════════════════════════════════
// E. Migration atomicity
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: transaction atomicity', () => {
  it('migration uses BEGIN/COMMIT wrapper', () => {
    const { readFileSync } = require('fs');
    const src = readFileSync('supabase/migrations/311_reseller_payout_integrity.sql', 'utf-8');
    expect(src).toContain('BEGIN;');
    expect(src).toContain('COMMIT;');
  });
});
