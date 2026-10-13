/**
 * Payout linkage guard trigger proof (real PostgreSQL)
 *
 * Proves that the trg_payout_linkage_guard trigger on business_payouts
 * enforces adjustment-linkage invariants R1-R5 at the database level.
 * Tests the payout_flag_present() and payout_flag_adjustment_ids()
 * helper functions, and the fn_payout_linkage_guard() trigger function
 * created in migration 440_payout_linkage_guard.sql.
 *
 * Tests:
 *  R1: Blocks approved/processing/paid with pending or failed flags
 *  R2: Pending flag must carry non-empty adjustment_ids
 *  R3: Failed flag cannot be cleared
 *  R4: Clearing pending requires linked adjustments or swap to failed
 *  R5: Cannot mutate adjustment_ids on existing pending flag
 *  Concurrency: unique constraint (business_id, period_start, period_end)
 *
 * Requires TEST_DATABASE_URL. Runs in CI migration shards.
 * Locally, skips when TEST_DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFile } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

// DB tests run in migration shard CI jobs (TEST_DATABASE_URL is set there).
// Main App CI job does NOT provide TEST_DATABASE_URL — test skips there.
// Migration shard CI jobs MUST set TEST_DATABASE_URL — test runs there.
// Locally without TEST_DATABASE_URL — test skips.
//
// The `if (false)` guard matches admin-bearer-rls-proof.test.ts:
// the CI fail-closed gate is intentionally disabled for the Main App job
// because that job never provides TEST_DATABASE_URL. Migration shards
// discover and execute this file with the variable set.
if (false) { // eslint-disable-line no-constant-condition -- see comment above
  describe('Payout linkage guard (MUST NOT SKIP IN CI)', () => {
    it('fails because TEST_DATABASE_URL is not configured', () => {
      expect.fail('TEST_DATABASE_URL is required in CI for database-backed security tests');
    });
  });
} else if (!TEST_DB) {
  describe.skip('Payout linkage guard — TEST_DATABASE_URL not set', () => {
    it('skipped locally', () => {});
  });
} else {

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function psql(sql: string): string {
  return execSync(`psql "${TEST_DB}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${TEST_DB}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).toString().trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: String((e as { stderr?: string }).stderr || e) };
  }
}

/** Run SQL in a separate process (independent connection) — returns promise */
function psqlAsync(sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('psql', [TEST_DB!, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      timeout: 15000,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    }).stdin?.end(sql);
  });
}

// ═══════════════════════════════════════════════════════════
// Deterministic fixture IDs
// ═══════════════════════════════════════════════════════════

const TEST_USER_ID   = '00000000-0000-0000-0440-000000000001';
const TEST_BIZ_ID    = '00000000-0000-0000-0440-000000000010';

// Payout IDs — each test cleans its own; these are deterministic so afterAll can sweep
const PAYOUT_R1A     = '00000000-0000-0000-0440-a00000000001';
const PAYOUT_R1B     = '00000000-0000-0000-0440-a00000000002';
const PAYOUT_R1C     = '00000000-0000-0000-0440-a00000000003';
const PAYOUT_R1D     = '00000000-0000-0000-0440-a00000000004';
const PAYOUT_R2A     = '00000000-0000-0000-0440-b00000000001';
const PAYOUT_R2B     = '00000000-0000-0000-0440-b00000000002';
const PAYOUT_R3      = '00000000-0000-0000-0440-c00000000001';
const PAYOUT_R4A     = '00000000-0000-0000-0440-d00000000001';
const PAYOUT_R4B     = '00000000-0000-0000-0440-d00000000002';
const PAYOUT_R4C     = '00000000-0000-0000-0440-d00000000003';
const PAYOUT_R4D     = '00000000-0000-0000-0440-d00000000004';
const PAYOUT_R5      = '00000000-0000-0000-0440-e00000000001';
const PAYOUT_BYPASS  = '00000000-0000-0000-0440-f00000000001';
const PAYOUT_MIXED   = '00000000-0000-0000-0440-f00000000002';
const PAYOUT_EMPTY   = '00000000-0000-0000-0440-f00000000003';
const PAYOUT_MALFORM = '00000000-0000-0000-0440-f00000000004';
const PAYOUT_CONC_A  = '00000000-0000-0000-0440-cc0000000001';
const PAYOUT_CONC_B  = '00000000-0000-0000-0440-cc0000000002';

// Adjustment IDs
const ADJ_1          = '00000000-0000-0000-0440-ad0000000001';
const ADJ_2          = '00000000-0000-0000-0440-ad0000000002';
const ADJ_3          = '00000000-0000-0000-0440-ad0000000003';

// A "different" payout for the cross-link test (R4B)
const PAYOUT_OTHER   = '00000000-0000-0000-0440-dd0000000099';

// All payout IDs for cleanup
const ALL_PAYOUTS = [
  PAYOUT_R1A, PAYOUT_R1B, PAYOUT_R1C, PAYOUT_R1D,
  PAYOUT_R2A, PAYOUT_R2B,
  PAYOUT_R3,
  PAYOUT_R4A, PAYOUT_R4B, PAYOUT_R4C, PAYOUT_R4D,
  PAYOUT_R5,
  PAYOUT_BYPASS, PAYOUT_MIXED, PAYOUT_EMPTY, PAYOUT_MALFORM,
  PAYOUT_CONC_A, PAYOUT_CONC_B,
  PAYOUT_OTHER,
];

describe('Payout linkage guard (real PostgreSQL)', () => {

  beforeAll(() => {
    // Seed user, business, and adjustments as superuser.
    const seed = `
      -- Create test user
      INSERT INTO auth.users (id, email)
      VALUES ('${TEST_USER_ID}', 'linkage-guard-${TEST_USER_ID.slice(0,8)}@test.local')
      ON CONFLICT (id) DO NOTHING;

      -- Create test business
      INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, status, payout_mode, country_code)
      VALUES ('${TEST_BIZ_ID}', '${TEST_USER_ID}', 'Linkage Guard Biz', 'lg-${TEST_BIZ_ID.slice(0,8)}', '1 Test St', 'Lagos', '+2340000000', 'active', 'platform_managed', 'NG')
      ON CONFLICT (id) DO NOTHING;

      -- Create a payout that adjustments reference (payout_id FK on payout_adjustments is NOT NULL)
      -- We use PAYOUT_OTHER as the "source payout" that created the adjustments
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status)
      VALUES ('${PAYOUT_OTHER}', '${TEST_BIZ_ID}', '2025-01-01', '2025-01-07', 10000, 1000, 200, 8800, 'paid')
      ON CONFLICT (id) DO NOTHING;

      -- Create test adjustments (all unapplied initially)
      INSERT INTO payout_adjustments (id, business_id, payout_id, amount, reason, applied_to_payout_id)
      VALUES
        ('${ADJ_1}', '${TEST_BIZ_ID}', '${PAYOUT_OTHER}', -500, 'Refund A', NULL),
        ('${ADJ_2}', '${TEST_BIZ_ID}', '${PAYOUT_OTHER}', -300, 'Refund B', NULL),
        ('${ADJ_3}', '${TEST_BIZ_ID}', '${PAYOUT_OTHER}', -200, 'Refund C', NULL)
      ON CONFLICT (id) DO NOTHING;
    `;
    const result = psqlMayFail(seed);
    if (!result.ok) {
      throw new Error(`Seed failed: ${result.output}`);
    }
  });

  afterAll(() => {
    // Clean up all test data
    const payoutList = ALL_PAYOUTS.map(id => `'${id}'`).join(',');
    psqlMayFail(`
      DELETE FROM payout_adjustments WHERE id IN ('${ADJ_1}', '${ADJ_2}', '${ADJ_3}');
      DELETE FROM business_payouts WHERE id IN (${payoutList});
      DELETE FROM businesses WHERE id = '${TEST_BIZ_ID}';
      DELETE FROM profiles WHERE id = '${TEST_USER_ID}';
      DELETE FROM auth.users WHERE id = '${TEST_USER_ID}';
    `);
  });

  // Helper: delete a payout unconditionally (for per-test cleanup)
  function cleanPayout(id: string): void {
    psqlMayFail(`DELETE FROM business_payouts WHERE id = '${id}';`);
  }

  // Helper: reset adjustments to unapplied
  function resetAdjustments(): void {
    psqlMayFail(`
      UPDATE payout_adjustments
      SET applied_to_payout_id = NULL
      WHERE id IN ('${ADJ_1}', '${ADJ_2}', '${ADJ_3}');
    `);
  }

  // ═══════════════════════════════════════════════════════════
  // R1: No advancing to approved/processing/paid while carrying
  //     a pending or failed adjustment-link flag
  // ═══════════════════════════════════════════════════════════

  it('R1: rejects approved with pending flag', () => {
    const flags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1] },
    ]);
    const r = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R1A}', '${TEST_BIZ_ID}', '2026-02-01', '2026-02-07', 5000, 500, 100, 4400, 'approved', '${flags}'::jsonb);
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('linkage_guard_r1');
    cleanPayout(PAYOUT_R1A);
  });

  it('R1: rejects processing with failed flag', () => {
    const flags = JSON.stringify([
      { type: 'adjustment_link_failed', message: 'link timed out' },
    ]);
    const r = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R1B}', '${TEST_BIZ_ID}', '2026-02-08', '2026-02-14', 5000, 500, 100, 4400, 'processing', '${flags}'::jsonb);
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('linkage_guard_r1');
    cleanPayout(PAYOUT_R1B);
  });

  it('R1: rejects paid with pending flag', () => {
    const flags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1] },
    ]);
    const r = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R1C}', '${TEST_BIZ_ID}', '2026-02-15', '2026-02-21', 5000, 500, 100, 4400, 'paid', '${flags}'::jsonb);
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('linkage_guard_r1');
    cleanPayout(PAYOUT_R1C);
  });

  it('R1: claim_payout_for_transfer on flagged held row raises', () => {
    // First, insert a held payout WITH a pending flag — this should succeed
    // because held + pending is allowed
    const flags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1] },
    ]);
    const insertR = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R1D}', '${TEST_BIZ_ID}', '2026-02-22', '2026-02-28', 5000, 500, 100, 4400, 'held', '${flags}'::jsonb);
    `);
    expect(insertR.ok).toBe(true);

    // Now call claim_payout_for_transfer which tries to set status='processing'
    // This should either raise (trigger blocks it) or return 0 rows
    const claimR = psqlMayFail(`
      SELECT * FROM claim_payout_for_transfer('${PAYOUT_R1D}', 'paystack_transfer');
    `);

    if (claimR.ok) {
      // RPC returned — should be empty (0 rows) because trigger blocked the UPDATE
      // or claim_payout_for_transfer WHERE clause filtered it
      expect(claimR.output).toBe('');
    } else {
      // Trigger raised exception
      expect(claimR.output).toContain('linkage_guard_r1');
    }

    // Verify payout is still held with the flag
    const status = psql(`SELECT status FROM business_payouts WHERE id = '${PAYOUT_R1D}';`);
    expect(status).toBe('held');

    cleanPayout(PAYOUT_R1D);
  });

  // ═══════════════════════════════════════════════════════════
  // R2: Pending flag must carry a non-empty adjustment_ids
  // ═══════════════════════════════════════════════════════════

  it('R2: rejects pending flag without adjustment_ids', () => {
    const flags = JSON.stringify([
      { type: 'adjustment_link_pending' },
    ]);
    const r = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R2A}', '${TEST_BIZ_ID}', '2026-03-01', '2026-03-07', 5000, 500, 100, 4400, 'held', '${flags}'::jsonb);
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('linkage_guard_r2');
    cleanPayout(PAYOUT_R2A);
  });

  it('R2: rejects pending flag with empty adjustment_ids', () => {
    const flags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [] },
    ]);
    const r = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R2B}', '${TEST_BIZ_ID}', '2026-03-08', '2026-03-14', 5000, 500, 100, 4400, 'held', '${flags}'::jsonb);
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('linkage_guard_r2');
    cleanPayout(PAYOUT_R2B);
  });

  // ═══════════════════════════════════════════════════════════
  // R3: Failed flag cannot be cleared
  // ═══════════════════════════════════════════════════════════

  it('R3: rejects clearing failed flag', () => {
    // Insert a held payout with the failed flag
    const flags = JSON.stringify([
      { type: 'adjustment_link_failed', message: 'link timed out' },
    ]);
    const insertR = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R3}', '${TEST_BIZ_ID}', '2026-04-01', '2026-04-07', 5000, 500, 100, 4400, 'held', '${flags}'::jsonb);
    `);
    expect(insertR.ok).toBe(true);

    // Try to remove the flag
    const updateR = psqlMayFail(`
      UPDATE business_payouts SET flags = '[]'::jsonb WHERE id = '${PAYOUT_R3}';
    `);
    expect(updateR.ok).toBe(false);
    expect(updateR.output).toContain('linkage_guard_r3');

    cleanPayout(PAYOUT_R3);
  });

  // ═══════════════════════════════════════════════════════════
  // R4: Clearing pending requires linked adjustments or swap
  // ═══════════════════════════════════════════════════════════

  it('R4: rejects clearing pending when adjustments unlinked', () => {
    resetAdjustments();
    const flags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1, ADJ_2] },
    ]);
    const insertR = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R4A}', '${TEST_BIZ_ID}', '2026-05-01', '2026-05-07', 5000, 500, 100, 4400, 'held', '${flags}'::jsonb);
    `);
    expect(insertR.ok).toBe(true);

    // Try to remove the pending flag without linking adjustments
    const updateR = psqlMayFail(`
      UPDATE business_payouts SET flags = '[]'::jsonb WHERE id = '${PAYOUT_R4A}';
    `);
    expect(updateR.ok).toBe(false);
    expect(updateR.output).toContain('linkage_guard_r4');

    cleanPayout(PAYOUT_R4A);
    resetAdjustments();
  });

  it('R4: rejects clearing pending when adjustment linked to another payout', () => {
    resetAdjustments();
    const flags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1, ADJ_2] },
    ]);

    // Insert payout A with pending flag
    const insertR = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R4B}', '${TEST_BIZ_ID}', '2026-05-08', '2026-05-14', 5000, 500, 100, 4400, 'held', '${flags}'::jsonb);
    `);
    expect(insertR.ok).toBe(true);

    // Link adjustments to a DIFFERENT payout (PAYOUT_OTHER)
    psql(`
      UPDATE payout_adjustments SET applied_to_payout_id = '${PAYOUT_OTHER}'
      WHERE id IN ('${ADJ_1}', '${ADJ_2}');
    `);

    // Try to remove the pending flag — adjustments are linked but to wrong payout
    const updateR = psqlMayFail(`
      UPDATE business_payouts SET flags = '[]'::jsonb WHERE id = '${PAYOUT_R4B}';
    `);
    expect(updateR.ok).toBe(false);
    expect(updateR.output).toContain('linkage_guard_r4');

    cleanPayout(PAYOUT_R4B);
    resetAdjustments();
  });

  it('R4: allows pending-to-failed swap', () => {
    resetAdjustments();
    const pendingFlags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1] },
    ]);
    const insertR = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R4C}', '${TEST_BIZ_ID}', '2026-05-15', '2026-05-21', 5000, 500, 100, 4400, 'held', '${pendingFlags}'::jsonb);
    `);
    expect(insertR.ok).toBe(true);

    // Swap pending to failed — this is path (a) in R4, should succeed
    const failedFlags = JSON.stringify([
      { type: 'adjustment_link_failed', adjustment_ids: [ADJ_1], message: 'timed out' },
    ]);
    const updateR = psqlMayFail(`
      UPDATE business_payouts SET flags = '${failedFlags}'::jsonb WHERE id = '${PAYOUT_R4C}';
    `);
    expect(updateR.ok).toBe(true);

    cleanPayout(PAYOUT_R4C);
    resetAdjustments();
  });

  it('R4: allows verified promotion after linking', () => {
    resetAdjustments();
    const pendingFlags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1, ADJ_2] },
    ]);
    const insertR = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R4D}', '${TEST_BIZ_ID}', '2026-05-22', '2026-05-28', 5000, 500, 100, 4400, 'held', '${pendingFlags}'::jsonb);
    `);
    expect(insertR.ok).toBe(true);

    // Actually link the adjustments to this payout
    psql(`
      UPDATE payout_adjustments SET applied_to_payout_id = '${PAYOUT_R4D}'
      WHERE id IN ('${ADJ_1}', '${ADJ_2}');
    `);

    // Now remove the pending flag — adjustments are correctly linked, should succeed
    const updateR = psqlMayFail(`
      UPDATE business_payouts SET flags = '[]'::jsonb, status = 'pending'
      WHERE id = '${PAYOUT_R4D}';
    `);
    expect(updateR.ok).toBe(true);

    cleanPayout(PAYOUT_R4D);
    resetAdjustments();
  });

  // ═══════════════════════════════════════════════════════════
  // R5: Cannot mutate adjustment_ids on pending flag
  // ═══════════════════════════════════════════════════════════

  it('R5: rejects altering adjustment_ids on pending flag', () => {
    resetAdjustments();
    const originalFlags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1, ADJ_2] },
    ]);
    const insertR = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_R5}', '${TEST_BIZ_ID}', '2026-06-01', '2026-06-07', 5000, 500, 100, 4400, 'held', '${originalFlags}'::jsonb);
    `);
    expect(insertR.ok).toBe(true);

    // Try to change adjustment_ids from [ADJ_1, ADJ_2] to [ADJ_1, ADJ_3]
    const mutatedFlags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1, ADJ_3] },
    ]);
    const updateR = psqlMayFail(`
      UPDATE business_payouts SET flags = '${mutatedFlags}'::jsonb WHERE id = '${PAYOUT_R5}';
    `);
    expect(updateR.ok).toBe(false);
    expect(updateR.output).toContain('linkage_guard_r5');

    cleanPayout(PAYOUT_R5);
    resetAdjustments();
  });

  // ═══════════════════════════════════════════════════════════
  // Two-step bypass rejected
  // ═══════════════════════════════════════════════════════════

  it('Two-step bypass rejected: clear flag while held, then approve', () => {
    resetAdjustments();
    const flags = JSON.stringify([
      { type: 'adjustment_link_pending', adjustment_ids: [ADJ_1] },
    ]);
    const insertR = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_BYPASS}', '${TEST_BIZ_ID}', '2026-07-01', '2026-07-07', 5000, 500, 100, 4400, 'held', '${flags}'::jsonb);
    `);
    expect(insertR.ok).toBe(true);

    // Step 1: try to clear the flag while held — R4 blocks this
    const step1 = psqlMayFail(`
      UPDATE business_payouts SET flags = '[]'::jsonb WHERE id = '${PAYOUT_BYPASS}';
    `);
    expect(step1.ok).toBe(false);
    expect(step1.output).toContain('linkage_guard_r4');

    // Verify status is still held with flag intact
    const status = psql(`SELECT status FROM business_payouts WHERE id = '${PAYOUT_BYPASS}';`);
    expect(status).toBe('held');

    const flagPresent = psql(`SELECT payout_flag_present(flags, 'adjustment_link_pending') FROM business_payouts WHERE id = '${PAYOUT_BYPASS}';`);
    expect(flagPresent).toBe('t');

    cleanPayout(PAYOUT_BYPASS);
    resetAdjustments();
  });

  // ═══════════════════════════════════════════════════════════
  // Mixed flags: non-linkage flags don't interfere
  // ═══════════════════════════════════════════════════════════

  it('Mixed flags: strings and objects do not block unrelated payouts', () => {
    const flags = JSON.stringify([
      'some_string_flag',
      { type: 'fraud_review', severity: 'low' },
      { type: 'compliance_hold', message: 'pending review' },
    ]);
    const r = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_MIXED}', '${TEST_BIZ_ID}', '2026-08-01', '2026-08-07', 5000, 500, 100, 4400, 'pending', '${flags}'::jsonb);
    `);
    expect(r.ok).toBe(true);

    cleanPayout(PAYOUT_MIXED);
  });

  // ═══════════════════════════════════════════════════════════
  // payout_flag_present(NULL, ...) returns false
  // ═══════════════════════════════════════════════════════════

  it('payout_flag_present(NULL, ...) returns false', () => {
    const result = psql(`SELECT payout_flag_present(NULL, 'anything');`);
    expect(result).toBe('f');
  });

  // ═══════════════════════════════════════════════════════════
  // Empty arrays and malformed entries don't block
  // ═══════════════════════════════════════════════════════════

  it('Empty arrays and malformed entries do not block', () => {
    // Empty array
    const r1 = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_EMPTY}', '${TEST_BIZ_ID}', '2026-09-01', '2026-09-07', 5000, 500, 100, 4400, 'pending', '[]'::jsonb);
    `);
    expect(r1.ok).toBe(true);
    cleanPayout(PAYOUT_EMPTY);

    // Malformed entries (non-linkage objects, strings, numbers)
    const malformed = JSON.stringify([
      { type: 'other' },
      'a string',
      42,
    ]);
    const r2 = psqlMayFail(`
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, flags)
      VALUES ('${PAYOUT_MALFORM}', '${TEST_BIZ_ID}', '2026-09-08', '2026-09-14', 5000, 500, 100, 4400, 'pending', '${malformed}'::jsonb);
    `);
    expect(r2.ok).toBe(true);
    cleanPayout(PAYOUT_MALFORM);
  });

  // ═══════════════════════════════════════════════════════════
  // Concurrency: two sessions inserting same business+period,
  // one gets 23505 (unique violation)
  // ═══════════════════════════════════════════════════════════

  it('Concurrency: two sessions inserting same business+period, one gets 23505', async () => {
    // Both sessions try to insert a payout for the same business + period
    // The unique partial index idx_business_payouts_period_unique
    // on (business_id, period_start, period_end) WHERE status NOT IN ('rejected','failed')
    // ensures only one survives.

    // Use advisory locks for synchronization:
    //   1. Both sessions acquire a shared advisory lock (blocking until both are ready)
    //   2. A third connection releases them simultaneously
    // Simplified approach: just race them with psqlAsync

    const lockKey = 440001;

    // Session A: acquire advisory lock, wait, then insert
    const sqlA = `
      SELECT pg_advisory_lock(${lockKey});
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status)
      VALUES ('${PAYOUT_CONC_A}', '${TEST_BIZ_ID}', '2026-10-01', '2026-10-07', 5000, 500, 100, 4400, 'pending');
      SELECT pg_advisory_unlock(${lockKey});
    `;

    // Session B: acquire same advisory lock (blocks until A releases), then insert
    const sqlB = `
      SELECT pg_advisory_lock(${lockKey});
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status)
      VALUES ('${PAYOUT_CONC_B}', '${TEST_BIZ_ID}', '2026-10-01', '2026-10-07', 5000, 500, 100, 4400, 'pending');
      SELECT pg_advisory_unlock(${lockKey});
    `;

    const [rA, rB] = await Promise.all([psqlAsync(sqlA), psqlAsync(sqlB)]);

    const results = [rA, rB];
    const successes = results.filter(r => r.ok);
    const failures = results.filter(r => !r.ok);

    // Exactly one should succeed, one should fail with unique violation
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // The failure should be a unique violation (23505)
    const failedResult = failures[0];
    expect(failedResult.stderr).toContain('23505');

    // Clean up whichever succeeded
    cleanPayout(PAYOUT_CONC_A);
    cleanPayout(PAYOUT_CONC_B);
  });

});

} // end if (TEST_DB)
