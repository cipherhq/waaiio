/**
 * ACC-204: Fulfillment Notification Intent — PostgreSQL Tests
 *
 * Tests:
 * A. transition_promo_fulfillment creates atomic notification intent
 * B. Idempotent: duplicate transition does not create duplicate intent
 * C. finalize_promo_fulfillment_notification: pending -> sent/failed
 * D. advance_promo_fulfillment_notification_status: monotonic delivery
 * E. Privilege hardening: service_role only
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Skips gracefully in local dev if no DB connection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFile } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function psqlJson(sql: string): Record<string, unknown> {
  const raw = psql(sql);
  return JSON.parse(raw);
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).toString().trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: String((e as { stderr?: string }).stderr || e) };
  }
}

// Unique IDs for test isolation
const testBizId = '00000000-0000-0000-0000-000000204001';
const testCampaignId = '00000000-0000-0000-0000-000000204002';
const testPrizeId = '00000000-0000-0000-0000-000000204003';
const testCodeId = '00000000-0000-0000-0000-000000204004';
const testRedemptionId = '00000000-0000-0000-0000-000000204005';
const testUserId = '00000000-0000-0000-0000-000000204006';
const testBatchId = '00000000-0000-0000-0000-000000204007';

describe.skipIf(!canRun)('ACC-204: Fulfillment Notification Intent (DB)', () => {
  beforeAll(() => {
    // Clean up any prior test data
    psql(`
      DELETE FROM promo_fulfillment_notification_intents WHERE business_id = '${testBizId}';
      DELETE FROM admin_audit_logs WHERE entity_id = '${testRedemptionId}';
      DELETE FROM promo_redemptions WHERE id = '${testRedemptionId}';
      DELETE FROM promo_campaign_codes WHERE id = '${testCodeId}';
      DELETE FROM promo_code_batches WHERE id = '${testBatchId}';
      DELETE FROM promo_prizes WHERE id = '${testPrizeId}';
      DELETE FROM promo_campaigns WHERE id = '${testCampaignId}';
      DELETE FROM businesses WHERE id = '${testBizId}';
      DELETE FROM auth.users WHERE id = '${testUserId}';
    `);

    // Create test fixtures (CI-compatible column lists matching ACC-184 pattern)
    psql(`
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;
      INSERT INTO auth.users (id, phone) VALUES ('${testUserId}', '+0002040001')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level, subscription_tier, category)
      VALUES ('${testBizId}', 'Test Biz 204', 'test-biz-204', '${testUserId}', '1 Test', 'Lagos', 'VI', '+0002040002', 'active', 'manual', 'NG', 'basic', 'growth', 'other')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, accept_bare_codes, max_attempts_per_phone, rate_limit_window_minutes, rate_limit_max_attempts, eligibility_mode, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${testCampaignId}', '${testBizId}', 'Test Campaign 204', 'active', 'bare_code', true, 100, 60, 100, 'none', 'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count)
      VALUES ('${testPrizeId}', '${testCampaignId}', 'Gold Watch', 'product', 10, 1)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_code_batches (id, campaign_id, requested_count, generated_count, status, failed_count)
      VALUES ('${testBatchId}', '${testCampaignId}', 1, 1, 'completed', 0)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
      VALUES ('${testCodeId}', '${testBizId}', '${testCampaignId}', '${testBatchId}', 'hash204', 'enc_204', '204X', 'winner', '${testPrizeId}', 'claimed')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
      VALUES ('${testRedemptionId}', '${testBizId}', '${testCampaignId}', '${testCodeId}', '+2348012345678', 'winner', 'WAA-TEST-204', 'pending', 'standard', 'phone_verified')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM promo_fulfillment_notification_intents WHERE business_id = '${testBizId}';
      DELETE FROM admin_audit_logs WHERE entity_id = '${testRedemptionId}';
      DELETE FROM promo_redemptions WHERE id = '${testRedemptionId}';
      DELETE FROM promo_campaign_codes WHERE id = '${testCodeId}';
      DELETE FROM promo_code_batches WHERE id = '${testBatchId}';
      DELETE FROM promo_prizes WHERE id = '${testPrizeId}';
      DELETE FROM promo_campaigns WHERE id = '${testCampaignId}';
      DELETE FROM businesses WHERE id = '${testBizId}';
      DELETE FROM auth.users WHERE id = '${testUserId}';
    `);
  });

  // ── A. Atomic notification intent creation ──

  describe('A. Transition creates notification intent', () => {
    it('creates intent on pending -> processing', () => {
      const result = psqlJson(`
        SELECT transition_promo_fulfillment(
          '${testBizId}', '${testRedemptionId}', 'processing', '${testUserId}', NULL, NULL
        );
      `);
      expect(result.success).toBe(true);
      expect(result.new_status).toBe('processing');

      // Verify intent was created
      const intent = psql(`
        SELECT to_status, delivery_status FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${testRedemptionId}' AND to_status = 'processing';
      `);
      expect(intent).toContain('processing');
      expect(intent).toContain('pending');
    });

    it('creates intent on processing -> fulfilled', () => {
      const result = psqlJson(`
        SELECT transition_promo_fulfillment(
          '${testBizId}', '${testRedemptionId}', 'fulfilled', '${testUserId}', 'REF-123', NULL
        );
      `);
      expect(result.success).toBe(true);

      const intent = psql(`
        SELECT to_status, delivery_status FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${testRedemptionId}' AND to_status = 'fulfilled';
      `);
      expect(intent).toContain('fulfilled');
      expect(intent).toContain('pending');
    });
  });

  // ── B. Idempotent ──

  describe('B. Idempotent intent creation', () => {
    it('does not create duplicate intent for same transition', () => {
      // The transition to 'processing' was already done, so a retry would fail
      // but the intent should already exist from test A
      const count = psql(`
        SELECT count(*) FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${testRedemptionId}' AND to_status = 'processing';
      `);
      expect(parseInt(count)).toBe(1);
    });
  });

  // ── C. Finalize RPC ──

  describe('C. finalize_promo_fulfillment_notification', () => {
    it('finalizes pending intent as sent with WAMID', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${testRedemptionId}' AND to_status = 'processing';
      `);

      const result = psqlJson(`
        SELECT finalize_promo_fulfillment_notification(
          '${intentId}', 'sent', 'wamid.test204'
        );
      `);
      expect(result.success).toBe(true);

      const status = psql(`
        SELECT delivery_status, provider_message_id FROM promo_fulfillment_notification_intents
        WHERE id = '${intentId}';
      `);
      expect(status).toContain('sent');
      expect(status).toContain('wamid.test204');
    });

    it('rejects finalize on non-pending intent', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${testRedemptionId}' AND to_status = 'processing';
      `);

      const result = psqlJson(`
        SELECT finalize_promo_fulfillment_notification('${intentId}', 'sent', 'wamid.dup');
      `);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('not_pending');
    });

    it('finalizes as failed', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${testRedemptionId}' AND to_status = 'fulfilled';
      `);

      const result = psqlJson(`
        SELECT finalize_promo_fulfillment_notification('${intentId}', 'failed', NULL);
      `);
      expect(result.success).toBe(true);

      const status = psql(`
        SELECT delivery_status FROM promo_fulfillment_notification_intents
        WHERE id = '${intentId}';
      `);
      expect(status).toBe('failed');
    });
  });

  // ── D. Monotonic advance ──

  describe('D. advance_promo_fulfillment_notification_status', () => {
    it('advances sent -> delivered', () => {
      const result = psqlJson(`
        SELECT advance_promo_fulfillment_notification_status(
          'wamid.test204', 'delivered', now()
        );
      `);
      expect(result.advanced).toBe(true);
      expect(result.new_status).toBe('delivered');
    });

    it('advances delivered -> read', () => {
      const result = psqlJson(`
        SELECT advance_promo_fulfillment_notification_status(
          'wamid.test204', 'read', now()
        );
      `);
      expect(result.advanced).toBe(true);
      expect(result.new_status).toBe('read');
    });

    it('rejects backward transition read -> sent', () => {
      const result = psqlJson(`
        SELECT advance_promo_fulfillment_notification_status(
          'wamid.test204', 'sent', now()
        );
      `);
      expect(result.advanced).toBe(false);
      expect(result.reason).toBe('already_at_or_past');
    });

    it('ignores late failure after delivered/read', () => {
      const result = psqlJson(`
        SELECT advance_promo_fulfillment_notification_status(
          'wamid.test204', 'failed', now()
        );
      `);
      expect(result.advanced).toBe(false);
      expect(result.reason).toBe('late_failure_ignored');
    });

    it('returns unknown_message for non-existent WAMID', () => {
      const result = psqlJson(`
        SELECT advance_promo_fulfillment_notification_status(
          'wamid.nonexistent', 'delivered', now()
        );
      `);
      expect(result.advanced).toBe(false);
      expect(result.reason).toBe('unknown_message');
    });
  });

  // ── E-conc. Real two-session concurrency (Blocker 5b) ──

  describe('E-conc. Two-session concurrency', () => {
    const concRedemptionId = '00000000-0000-0000-0000-000000204015';
    const concCodeId = '00000000-0000-0000-0000-000000204016';

    beforeAll(() => {
      // Create a fresh redemption for concurrency test
      psql(`
        INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES ('${concCodeId}', '${testBizId}', '${testCampaignId}', '${testBatchId}', 'hash204conc', 'enc_204conc', 'CONC', 'winner', '${testPrizeId}', 'claimed')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
        VALUES ('${concRedemptionId}', '${testBizId}', '${testCampaignId}', '${concCodeId}', '+2348099999999', 'winner', 'WAA-CONC-204', 'pending', 'standard', 'phone_verified')
        ON CONFLICT (id) DO NOTHING;
      `);
    });

    afterAll(() => {
      psql(`
        DELETE FROM promo_fulfillment_notification_intents WHERE redemption_id = '${concRedemptionId}';
        DELETE FROM admin_audit_logs WHERE entity_id = '${concRedemptionId}';
        DELETE FROM promo_redemptions WHERE id = '${concRedemptionId}';
        DELETE FROM promo_campaign_codes WHERE id = '${concCodeId}';
      `);
    });

    it('exactly 1 wins when two sessions race on same transition', async () => {
      function psqlAsync(sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
          const child = execFile('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
            timeout: 20000,
          }, (err, stdout, stderr) => {
            resolve({
              ok: !err,
              stdout: (stdout || '').toString().trim(),
              stderr: (stderr || '').toString().trim(),
            });
          });
          child.stdin!.write(sql);
          child.stdin!.end();
        });
      }

      // Session A: BEGIN -> transition (holds row lock via FOR UPDATE) -> pg_sleep(2) -> COMMIT
      const sessionA = psqlAsync(`
        BEGIN;
        SELECT transition_promo_fulfillment(
          '${testBizId}', '${concRedemptionId}', 'processing', '${testUserId}', NULL, NULL
        );
        SELECT pg_sleep(2);
        COMMIT;
      `);

      // Give session A a moment to acquire the lock
      await new Promise(r => setTimeout(r, 300));

      // Session B: attempts same transition -> blocks on lock -> gets invalid_transition after A commits
      const sessionB = psqlAsync(`
        SELECT transition_promo_fulfillment(
          '${testBizId}', '${concRedemptionId}', 'processing', '${testUserId}', NULL, NULL
        );
      `);

      const [resultA, resultB] = await Promise.all([sessionA, sessionB]);

      // Session A should succeed
      expect(resultA.ok).toBe(true);
      expect(resultA.stdout).toContain('"success": true');

      // Session B should get invalid_transition (row is already 'processing')
      expect(resultB.ok).toBe(true);
      expect(resultB.stdout).toContain('invalid_transition');

      // Exactly 1 notification intent created
      const intentCount = psql(`
        SELECT count(*) FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${concRedemptionId}' AND to_status = 'processing';
      `);
      expect(parseInt(intentCount)).toBe(1);
    }, 25000);
  });

  // ── E. Privilege hardening ──

  describe('E. Privilege hardening', () => {
    it('service_role can execute transition_promo_fulfillment', () => {
      const result = psql(`
        SELECT has_function_privilege('service_role', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE');
      `);
      expect(result).toBe('t');
    });

    it('anon cannot execute transition_promo_fulfillment', () => {
      const result = psql(`
        SELECT has_function_privilege('anon', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE');
      `);
      expect(result).toBe('f');
    });

    it('service_role can execute advance_promo_fulfillment_notification_status', () => {
      const result = psql(`
        SELECT has_function_privilege('service_role', 'advance_promo_fulfillment_notification_status(text, text, timestamptz)', 'EXECUTE');
      `);
      expect(result).toBe('t');
    });

    it('anon cannot execute advance_promo_fulfillment_notification_status', () => {
      const result = psql(`
        SELECT has_function_privilege('anon', 'advance_promo_fulfillment_notification_status(text, text, timestamptz)', 'EXECUTE');
      `);
      expect(result).toBe('f');
    });

    it('service_role can execute finalize_promo_fulfillment_notification', () => {
      const result = psql(`
        SELECT has_function_privilege('service_role', 'finalize_promo_fulfillment_notification(uuid, text, text)', 'EXECUTE');
      `);
      expect(result).toBe('t');
    });

    it('anon cannot execute finalize_promo_fulfillment_notification', () => {
      const result = psql(`
        SELECT has_function_privilege('anon', 'finalize_promo_fulfillment_notification(uuid, text, text)', 'EXECUTE');
      `);
      expect(result).toBe('f');
    });
  });
});
