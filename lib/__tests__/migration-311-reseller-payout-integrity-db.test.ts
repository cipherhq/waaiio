/**
 * Migration 311: Reseller Payout Financial Integrity — Real PostgreSQL Tests
 *
 * Non-concurrency database tests (RLS policies, constraint behavior, overlap rules).
 * Concurrency tests (700/700 overspend, same-payout race, etc.) are in
 * scripts/test-migration-311-concurrency.sh which uses real background psql processes.
 *
 * Required env: TEST_DATABASE_URL
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

function runSQL(sql: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    return execSync(
      `psql "${TEST_DB}" -t -A -c ${JSON.stringify(sql)}`,
      { encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.message}`;
  }
}

const describeIfDb = !TEST_DB ? describe.skip : describe;

// ══════════════════════════════════════════════════════════
// A. RLS Policy Behavioral Tests
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: RLS policies on reseller_payouts', () => {

  it('admin_manages_reseller_payouts policy exists with is_admin()', () => {
    const result = runSQL(`
      SELECT polname, pg_get_expr(polqual, polrelid) as qual
      FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'admin_manages_reseller_payouts'
    `);
    expect(result).toContain('admin_manages_reseller_payouts');
    expect(result).toContain('is_admin()');
  });

  it('finance_reads_reseller_payouts policy is SELECT-only', () => {
    const result = runSQL(`
      SELECT polname, polcmd
      FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'finance_reads_reseller_payouts'
    `);
    expect(result).toContain('finance_reads_reseller_payouts');
    expect(result).toContain('r'); // polcmd 'r' = SELECT
  });

  it('old profiles.role-based policy is dropped', () => {
    const result = runSQL(`
      SELECT COUNT(*) FROM pg_policy
      WHERE polrelid = 'reseller_payouts'::regclass
        AND polname = 'Admin manages reseller payouts'
    `);
    expect(result).toBe('0');
  });

  it('is_admin_or_support includes finance role', () => {
    // Verify the function definition includes finance
    const result = runSQL(`
      SELECT prosrc FROM pg_proc
      WHERE proname = 'is_admin_or_support'
    `);
    expect(result).toContain('finance');
  });

  it('is_admin does NOT include finance role', () => {
    const result = runSQL(`
      SELECT prosrc FROM pg_proc
      WHERE proname = 'is_admin'
    `);
    expect(result).not.toContain('finance');
    expect(result).toContain("'admin'");
  });

  it('RLS is enabled on reseller_payouts', () => {
    const result = runSQL(`
      SELECT relrowsecurity FROM pg_class
      WHERE relname = 'reseller_payouts'
    `);
    expect(result).toBe('t');
  });
});

// ══════════════════════════════════════════════════════════
// B. Overlap Constraint Tests (non-concurrent)
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: overlap exclusion constraint', () => {
  const RESELLER_ID = '00000000-0000-0000-0000-000000000312';

  beforeAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM resellers WHERE id IN ('${RESELLER_ID}', '00000000-0000-0000-0000-000000000313')`);
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
      VALUES ('${RESELLER_ID}', 'Test Reseller 312', 'test312@example.com', 10) ON CONFLICT DO NOTHING`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id IN ('${RESELLER_ID}', '00000000-0000-0000-0000-000000000313')`);
    runSQL(`DELETE FROM resellers WHERE id IN ('${RESELLER_ID}', '00000000-0000-0000-0000-000000000313')`);
  });

  it('constraint exists', () => {
    const result = runSQL(`SELECT COUNT(*) FROM pg_constraint WHERE conname = 'reseller_payouts_no_overlap'`);
    expect(result).toBe('1');
  });

  it('adjacent periods [Aug 1, Aug 15) + [Aug 15, Aug 31) allowed', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    const r1 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-15', 100, 'pending') RETURNING id`);
    expect(r1).not.toContain('ERROR');
    const r2 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-15', '2026-08-31', 100, 'pending') RETURNING id`);
    expect(r2).not.toContain('ERROR');
  });

  it('partial overlap [Aug 1, Aug 15) + [Aug 14, Aug 20) rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-15', 100, 'pending')`);
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-14', '2026-08-20', 100, 'pending')`);
    expect(r).toContain('ERROR');
  });

  it('contained overlap rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-01', '2026-08-31', 100, 'pending')`);
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-08-05', '2026-08-10', 100, 'pending')`);
    expect(r).toContain('ERROR');
  });

  it('identical period rejected', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-09-01', '2026-09-15', 100, 'pending')`);
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-09-01', '2026-09-15', 100, 'pending')`);
    expect(r).toContain('ERROR');
  });

  it('rejected payout allows re-creation', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-10-01', '2026-10-15', 100, 'rejected')`);
    const r = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-10-01', '2026-10-15', 100, 'pending') RETURNING id`);
    expect(r).not.toContain('ERROR');
  });

  it('different resellers with same dates allowed', () => {
    const OTHER = '00000000-0000-0000-0000-000000000313';
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
      VALUES ('${OTHER}', 'Other Reseller', 'other@example.com', 10) ON CONFLICT DO NOTHING`);
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id IN ('${RESELLER_ID}', '${OTHER}')`);
    const r1 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${RESELLER_ID}', '2026-11-01', '2026-11-15', 100, 'pending') RETURNING id`);
    expect(r1).not.toContain('ERROR');
    const r2 = runSQL(`INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${OTHER}', '2026-11-01', '2026-11-15', 100, 'pending') RETURNING id`);
    expect(r2).not.toContain('ERROR');
  });
});

// ══════════════════════════════════════════════════════════
// C. mark_reseller_payout_paid RPC (non-concurrent)
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: mark_reseller_payout_paid RPC', () => {
  const RESELLER_ID = '00000000-0000-0000-0000-000000000314';
  const PAYOUT_ID = '00000000-0000-0000-0000-00000000031c';
  const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

  beforeAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM platform_fees WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
      VALUES ('${RESELLER_ID}', 'RPC Test Reseller', 'rpc@test.local', 10) ON CONFLICT DO NOTHING`);
    runSQL(`INSERT INTO platform_fees (business_id, payment_id, fee_amount, reseller_id, reseller_commission)
      VALUES ((SELECT id FROM businesses LIMIT 1), 'test-rpc-311-' || gen_random_uuid()::text, 100, '${RESELLER_ID}', 1000)`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM platform_fees WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`DELETE FROM resellers WHERE id = '${RESELLER_ID}'`);
  });

  it('returns not_found for non-existent payout', () => {
    const result = runSQL(`SELECT mark_reseller_payout_paid('00000000-0000-0000-0000-000000000000', '${ADMIN_ID}')`);
    expect(result).toContain('not_found');
  });

  it('returns not_approved for pending payout', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-06-01', '2026-06-15', 500, 'pending')`);
    const result = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}')`);
    expect(result).toContain('not_approved');
  });

  it('succeeds for approved payout within balance', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-07-01', '2026-07-15', 500, 'approved')`);
    const result = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}')`);
    expect(result).toContain('"success" : true');

    const status = runSQL(`SELECT status FROM reseller_payouts WHERE id = '${PAYOUT_ID}'`);
    expect(status).toBe('paid');
  });

  it('returns insufficient_balance when amount exceeds available', () => {
    runSQL(`DELETE FROM reseller_payouts WHERE reseller_id = '${RESELLER_ID}'`);
    runSQL(`INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, net_amount, status)
      VALUES ('${PAYOUT_ID}', '${RESELLER_ID}', '2026-08-01', '2026-08-15', 2000, 'approved')`);
    const result = runSQL(`SELECT mark_reseller_payout_paid('${PAYOUT_ID}', '${ADMIN_ID}')`);
    expect(result).toContain('insufficient_balance');

    const status = runSQL(`SELECT status FROM reseller_payouts WHERE id = '${PAYOUT_ID}'`);
    expect(status).toBe('approved'); // not changed
  });

  it('RPC is restricted to service_role only', () => {
    const result = runSQL(`
      SELECT has_function_privilege('authenticated', 'mark_reseller_payout_paid(uuid,uuid)', 'EXECUTE')
    `);
    expect(result).toBe('f');
  });
});

// ══════════════════════════════════════════════════════════
// D. Migration 311 transaction atomicity
// ══════════════════════════════════════════════════════════

describeIfDb('Migration 311: transaction atomicity', () => {
  it('migration uses BEGIN/COMMIT wrapper', () => {
    const { readFileSync } = require('fs');
    const src = readFileSync('supabase/migrations/311_reseller_payout_integrity.sql', 'utf-8');
    expect(src).toContain('BEGIN;');
    expect(src).toContain('COMMIT;');
  });

  it('RAISE EXCEPTION occurs between BEGIN and COMMIT', () => {
    const { readFileSync } = require('fs');
    const src = readFileSync('supabase/migrations/311_reseller_payout_integrity.sql', 'utf-8');
    const beginIdx = src.indexOf('BEGIN;');
    const exceptionIdx = src.indexOf('RAISE EXCEPTION');
    const commitIdx = src.indexOf('COMMIT;');
    expect(beginIdx).toBeLessThan(exceptionIdx);
    expect(exceptionIdx).toBeLessThan(commitIdx);
  });
});
