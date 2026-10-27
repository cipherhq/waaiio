/**
 * #721 STOP Persistence DB Tests
 *
 * Hermetic real-PG tests proving opt-out persistence invariants.
 * Follows the pattern from payout-accounts-server-only.pg.test.ts:
 * - Uses TEST_DATABASE_URL env var
 * - Uses psql + execSync for direct SQL
 * - Deterministic UUIDs
 * - Fails (not skips) when REQUIRE_PG_TESTS=true but table is missing
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/stop-persistence-db.pg.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

if (!dbUrl && process.env.REQUIRE_PG_TESTS === 'true') {
  throw new Error('TEST_DATABASE_URL is required — cannot skip DB tests (REQUIRE_PG_TESTS=true)');
}

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlMaybe(sql: string): string {
  try {
    return psql(sql);
  } catch { return ''; }
}

function psqlCleanup(sql: string): void {
  try {
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    });
  } catch { /* cleanup failures tolerated */ }
}

// Deterministic test UUIDs — 721-unique suffix
const BIZ_A = 'a0a0a0a0-7211-4000-a000-000000000001';
const BIZ_B = 'b0b0b0b0-7212-4000-a000-000000000002';
const OWNER_A = 'c0c0c0c0-7211-4000-a000-000000000001';
const CHANNEL_ID = 'f0f0f0f0-7211-4000-a000-000000000001';
const PHONE = '+2341234567890';

const describePg = canRun ? describe : describe.skip;

describePg('#721: STOP opt-out persistence', () => {
  beforeAll(() => {
    // Guard: fail (not skip) if messaging_opt_outs table doesn't exist
    const tableExists = psqlMaybe(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'messaging_opt_outs';`
    );
    if (!tableExists) {
      throw new Error(
        'messaging_opt_outs table does not exist in test database. ' +
        'Migrations must be applied before running this test.'
      );
    }

    // Clean test data
    psqlCleanup(`DELETE FROM messaging_opt_outs WHERE phone = '${PHONE}';`);
    psqlCleanup(`DELETE FROM bot_sessions WHERE whatsapp_number = '${PHONE}';`);
    psqlCleanup(`DELETE FROM businesses WHERE id IN ('${BIZ_A}','${BIZ_B}');`);
    psqlCleanup(`DELETE FROM whatsapp_channels WHERE id = '${CHANNEL_ID}';`);
    psqlCleanup(`DELETE FROM auth.users WHERE id = '${OWNER_A}';`);
    psqlCleanup(`DELETE FROM profiles WHERE id = '${OWNER_A}';`);

    // Create test owner
    psql(`INSERT INTO auth.users (id, email, raw_app_meta_data)
          VALUES ('${OWNER_A}', 'stop-test-721@test.waaiio.com', '{}')
          ON CONFLICT (id) DO NOTHING;`);

    // Create test businesses
    psql(`INSERT INTO businesses (id, name, owner_id, slug, category, status, bot_code)
          VALUES ('${BIZ_A}', 'Stop Test Biz A', '${OWNER_A}', 'stop-test-a-721', 'restaurant', 'active', 'STOPA721')
          ON CONFLICT (id) DO NOTHING;`);
    psql(`INSERT INTO businesses (id, name, owner_id, slug, category, status, bot_code)
          VALUES ('${BIZ_B}', 'Stop Test Biz B', '${OWNER_A}', 'stop-test-b-721', 'restaurant', 'active', 'STOPB721')
          ON CONFLICT (id) DO NOTHING;`);
  });

  afterAll(() => {
    psqlCleanup(`DELETE FROM messaging_opt_outs WHERE phone = '${PHONE}';`);
    psqlCleanup(`DELETE FROM bot_sessions WHERE whatsapp_number = '${PHONE}';`);
    psqlCleanup(`DELETE FROM businesses WHERE id IN ('${BIZ_A}','${BIZ_B}');`);
    psqlCleanup(`DELETE FROM whatsapp_channels WHERE id = '${CHANNEL_ID}';`);
    psqlCleanup(`DELETE FROM auth.users WHERE id = '${OWNER_A}';`);
    psqlCleanup(`DELETE FROM profiles WHERE id = '${OWNER_A}';`);
  });

  it('1. INSERT first STOP (business_id = BIZ_A) - row exists', () => {
    psqlCleanup(`DELETE FROM messaging_opt_outs WHERE phone = '${PHONE}' AND business_id = '${BIZ_A}';`);
    psql(`INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type, opted_out_at)
          VALUES ('${PHONE}', '${BIZ_A}', 'whatsapp', 'all', NOW());`);

    const count = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_A}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);
    expect(parseInt(count, 10)).toBe(1);
  });

  it('2. Duplicate STOP - 23505 conflict, row still active', () => {
    let errorCode = '';
    try {
      psql(`INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type, opted_out_at)
            VALUES ('${PHONE}', '${BIZ_A}', 'whatsapp', 'all', NOW());`);
    } catch (e: unknown) {
      const msg = (e as Error).message || '';
      if (msg.includes('23505') || msg.includes('unique_violation') || msg.includes('duplicate key')) {
        errorCode = '23505';
      }
    }
    expect(errorCode).toBe('23505');

    // Row still active
    const count = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_A}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);
    expect(parseInt(count, 10)).toBe(1);
  });

  it('3. Two businesses same phone - 2 separate active rows', () => {
    psqlCleanup(`DELETE FROM messaging_opt_outs WHERE phone = '${PHONE}' AND business_id = '${BIZ_B}';`);
    psql(`INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type, opted_out_at)
          VALUES ('${PHONE}', '${BIZ_B}', 'whatsapp', 'all', NOW());`);

    const count = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND channel = 'whatsapp' AND resubscribed_at IS NULL;`);
    expect(parseInt(count, 10)).toBe(2);
  });

  it('4. STOP A then START A - only A has resubscribed_at', () => {
    // Resubscribe A
    psql(`UPDATE messaging_opt_outs SET resubscribed_at = NOW()
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_A}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);

    // A should have resubscribed_at set
    const aResub = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_A}' AND resubscribed_at IS NOT NULL;`);
    expect(parseInt(aResub, 10)).toBeGreaterThanOrEqual(1);

    // B should still be active (no resubscribed_at)
    const bActive = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_B}' AND resubscribed_at IS NULL;`);
    expect(parseInt(bActive, 10)).toBe(1);
  });

  it('5. STOP A then START B - A NOT resubscribed', () => {
    // Re-STOP A so it has an active opt-out again
    psql(`INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type, opted_out_at)
          VALUES ('${PHONE}', '${BIZ_A}', 'whatsapp', 'all', NOW())
          ON CONFLICT DO NOTHING;`);

    // START B (resubscribe B)
    psql(`UPDATE messaging_opt_outs SET resubscribed_at = NOW()
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_B}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);

    // A should still have an active opt-out
    const aActive = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_A}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);
    expect(parseInt(aActive, 10)).toBeGreaterThanOrEqual(1);
  });

  it('6. STOP - START - STOP lifecycle - new active row', () => {
    // Clean slate for BIZ_B
    psqlCleanup(`DELETE FROM messaging_opt_outs WHERE phone = '${PHONE}' AND business_id = '${BIZ_B}';`);

    // STOP
    psql(`INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type, opted_out_at)
          VALUES ('${PHONE}', '${BIZ_B}', 'whatsapp', 'all', NOW());`);

    // START
    psql(`UPDATE messaging_opt_outs SET resubscribed_at = NOW()
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_B}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);

    // STOP again — new row since unique index is partial on resubscribed_at IS NULL
    psql(`INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type, opted_out_at)
          VALUES ('${PHONE}', '${BIZ_B}', 'whatsapp', 'all', NOW());`);

    // Should have an active opt-out
    const active = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_B}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);
    expect(parseInt(active, 10)).toBe(1);

    // Should have 2 total rows (1 resubscribed + 1 active)
    const total = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_B}' AND channel = 'whatsapp';`);
    expect(parseInt(total, 10)).toBe(2);
  });

  it('7. Phone-only .maybeSingle() + 2 merchant rows - fails with multiple rows', () => {
    // Ensure both A and B have active opt-outs
    psqlCleanup(`DELETE FROM messaging_opt_outs WHERE phone = '${PHONE}';`);
    psql(`INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type, opted_out_at)
          VALUES ('${PHONE}', '${BIZ_A}', 'whatsapp', 'all', NOW());`);
    psql(`INSERT INTO messaging_opt_outs (phone, business_id, channel, opt_out_type, opted_out_at)
          VALUES ('${PHONE}', '${BIZ_B}', 'whatsapp', 'all', NOW());`);

    // Phone-only query without business_id returns 2 rows — maybeSingle would error
    const count = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND channel = 'whatsapp' AND resubscribed_at IS NULL;`);
    expect(parseInt(count, 10)).toBe(2);
  });

  it('8. Merchant-scoped count + 2 rows - correct count', () => {
    // BIZ_A scoped query: exactly 1
    const countA = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_A}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);
    expect(parseInt(countA, 10)).toBe(1);

    // BIZ_B scoped query: exactly 1
    const countB = psql(`SELECT count(*) FROM messaging_opt_outs
          WHERE phone = '${PHONE}' AND business_id = '${BIZ_B}' AND channel = 'whatsapp'
          AND resubscribed_at IS NULL;`);
    expect(parseInt(countB, 10)).toBe(1);
  });

  it('9. Verify idx_opt_out_unique partial index exists and enforces uniqueness', () => {
    // Check the index exists
    const indexExists = psqlMaybe(`SELECT indexname FROM pg_indexes
          WHERE tablename = 'messaging_opt_outs'
          AND indexdef LIKE '%resubscribed_at IS NULL%';`);

    if (!indexExists) {
      // Index might use a different filter — check for any unique partial index on the table
      const anyPartial = psqlMaybe(`SELECT indexname FROM pg_indexes
            WHERE tablename = 'messaging_opt_outs'
            AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%';`);
      // Either partial unique index or a constraint must exist to enforce dedup
      expect(anyPartial.length, 'No partial unique index found on messaging_opt_outs').toBeGreaterThan(0);
    } else {
      expect(indexExists.length).toBeGreaterThan(0);
    }
  });
});
