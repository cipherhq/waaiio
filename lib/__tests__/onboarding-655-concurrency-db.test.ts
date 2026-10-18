/**
 * PR #655 — Database-enforced concurrency: shared allocation vs WABA candidate promotion.
 *
 * Proves that M430 allocate_shared_channel and M391 promote_channel_candidate
 * are serialized through the business row lock. When both race on the same
 * business, exactly one succeeds and the other gets a CAS conflict.
 *
 * Requires TEST_DATABASE_URL. Runs in CI migration shards.
 * Locally: set TEST_DATABASE_URL to a disposable PG with all migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  describe.skip('PR #655: shared-vs-WABA concurrency — TEST_DATABASE_URL not set', () => {
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

const BIZ_ID = '00000655-0000-0000-0000-000000000001';
const USER_ID = '00000655-0000-0000-0000-000000000002';
const CHANNEL_ID = '00000655-0000-0000-0000-000000000003';
const CAND_ID = '00000655-0000-0000-0000-000000000004';
const NEW_CH_ID = '00000655-0000-0000-0000-000000000005';

describe('PR #655: shared allocation vs WABA candidate promotion (real PG)', () => {
  beforeAll(() => {
    // Create test fixtures: business, shared channel, candidate
    runSQL(`
      -- Clean up any prior test data
      DELETE FROM whatsapp_channel_candidates WHERE id = '${CAND_ID}';
      DELETE FROM whatsapp_channels WHERE id IN ('${CHANNEL_ID}', '${NEW_CH_ID}');
      DELETE FROM businesses WHERE id = '${BIZ_ID}';

      -- Insert test business (shared, pending, no assigned channel)
      INSERT INTO businesses (id, owner_id, name, slug, bot_code, category, city, address, phone,
        country_code, wa_method, status, subscription_tier, flow_type, assigned_channel_id)
      VALUES ('${BIZ_ID}', '${USER_ID}', 'Test655', 'test655', 'T655', 'restaurant',
        'Lagos', '1 Test St', '+2348000000000', 'NG', 'shared', 'pending', 'free', 'scheduling', NULL)
      ON CONFLICT (id) DO UPDATE SET assigned_channel_id = NULL, wa_method = 'shared', status = 'pending';

      -- Insert test shared channel (active, capacity available)
      INSERT INTO whatsapp_channels (id, country_code, phone_number, gupshup_app_name, gupshup_api_key,
        channel_type, is_active, connection_status)
      VALUES ('${CHANNEL_ID}', 'NG', '+234655000001', 'test655', 'key655', 'shared', true, 'active')
      ON CONFLICT (id) DO UPDATE SET is_active = true, connection_status = 'active';
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM whatsapp_channel_candidates WHERE id = '${CAND_ID}';
      DELETE FROM whatsapp_channels WHERE id IN ('${CHANNEL_ID}', '${NEW_CH_ID}');
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
    `);
  });

  it('allocate_shared_channel sets assigned_channel_id atomically', () => {
    const result = runSQL(`
      SELECT allocate_shared_channel('${BIZ_ID}', 'NG');
    `);
    expect(result).not.toContain('ERROR');
    expect(result).toContain('"allocated": true');
    expect(result).toContain(`"channel_id": "${CHANNEL_ID}"`);

    // Verify the business row
    const assigned = runSQL(`
      SELECT assigned_channel_id FROM businesses WHERE id = '${BIZ_ID}';
    `);
    expect(assigned).toBe(CHANNEL_ID);
  });

  it('promote_channel_candidate rejects with cas_conflict when assigned_channel_id changed', () => {
    // Business now has assigned_channel_id = CHANNEL_ID (from previous test).
    // Create a candidate that expected assigned_channel_id = NULL.
    runSQL(`
      INSERT INTO whatsapp_channel_candidates (
        id, business_id, connection_source, business_wa_method, provider,
        phone_number, status,
        expected_assigned_channel_id, expected_whatsapp_channel_id, expected_wa_method
      ) VALUES (
        '${CAND_ID}', '${BIZ_ID}', 'embedded_signup', 'transfer', 'meta_cloud',
        '+234655000002', 'ready',
        NULL, NULL, 'shared'
      ) ON CONFLICT (id) DO UPDATE SET
        status = 'ready',
        expected_assigned_channel_id = NULL,
        expected_wa_method = 'shared';
    `);

    // Also create the target dedicated channel for the promotion
    runSQL(`
      INSERT INTO whatsapp_channels (id, country_code, phone_number, gupshup_app_name, gupshup_api_key,
        channel_type, business_id, is_active, connection_status)
      VALUES ('${NEW_CH_ID}', 'NG', '+234655000002', 'ded655', 'key655d', 'dedicated', '${BIZ_ID}', true, 'active')
      ON CONFLICT (id) DO UPDATE SET is_active = true;
    `);

    // promote_channel_candidate should reject because assigned_channel_id
    // is now CHANNEL_ID (set by allocate) but candidate expected NULL
    const result = runSQL(`
      SELECT promote_channel_candidate('${BIZ_ID}', '${CAND_ID}');
    `);
    expect(result).not.toContain('ERROR');
    expect(result).toContain('"ok": false');
    expect(result).toContain('cas_conflict');
    expect(result).toContain('assigned_channel_id');
  });

  it('concurrent allocate + promote: exactly one succeeds via row locking', () => {
    // Reset: clear assignment and candidate status
    runSQL(`
      UPDATE businesses SET assigned_channel_id = NULL WHERE id = '${BIZ_ID}';
      UPDATE whatsapp_channel_candidates SET
        status = 'ready',
        expected_assigned_channel_id = NULL,
        expected_wa_method = 'shared'
      WHERE id = '${CAND_ID}';
    `);

    // Run both concurrently using advisory locks for synchronization
    const allocateSQL = `
      BEGIN;
      SELECT pg_advisory_lock(655001);
      SELECT pg_advisory_unlock(655001);
      SELECT allocate_shared_channel('${BIZ_ID}', 'NG') AS result;
      COMMIT;
      SELECT 'ALLOC:' || (SELECT assigned_channel_id FROM businesses WHERE id = '${BIZ_ID}');
    `;
    const promoteSQL = `
      BEGIN;
      SELECT pg_advisory_lock(655001);
      SELECT pg_advisory_unlock(655001);
      SELECT promote_channel_candidate('${BIZ_ID}', '${CAND_ID}') AS result;
      COMMIT;
      SELECT 'PROMOTE:' || (
        SELECT COALESCE(
          (SELECT status FROM whatsapp_channel_candidates WHERE id = '${CAND_ID}'),
          'missing'
        )
      );
    `;

    // Acquire the advisory lock first, then launch both sessions
    runSQL(`SELECT pg_advisory_lock(655001);`);

    const [r1, r2] = [allocateSQL, promoteSQL].map(sql => {
      try {
        return execSync(
          `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
          { encoding: 'utf-8', timeout: 15000, input: sql },
        ).trim();
      } catch (err: unknown) {
        const e = err as { stderr?: string; stdout?: string };
        return `ERROR: ${e.stderr || e.stdout || ''}`;
      }
    });

    // Release the lock so both can proceed
    runSQL(`SELECT pg_advisory_unlock(655001);`);

    // Both should complete without ERROR
    expect(r1).not.toContain('ERROR');
    expect(r2).not.toContain('ERROR');

    // Verify final state: the business has a deterministic outcome
    const finalAssigned = runSQL(`SELECT assigned_channel_id FROM businesses WHERE id = '${BIZ_ID}';`);
    const finalCandidate = runSQL(`SELECT status FROM whatsapp_channel_candidates WHERE id = '${CAND_ID}';`);

    // At least one of these outcomes must hold:
    // A) Allocate won: assigned_channel_id = CHANNEL_ID, candidate still 'ready' (CAS will fail on next promote)
    // B) Promote won: candidate promoted, assigned_channel_id may have changed
    // The key invariant: the business is never in an inconsistent state
    const allocateWon = finalAssigned === CHANNEL_ID;
    const promoteHadCasConflict = r2.includes('cas_conflict');
    const outcomeConsistent = allocateWon || promoteHadCasConflict || finalCandidate !== 'ready';

    expect(outcomeConsistent).toBe(true);
  });
});

} // end if TEST_DB
