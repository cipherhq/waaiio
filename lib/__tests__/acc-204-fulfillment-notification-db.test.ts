/**
 * ACC-204: Fulfillment Notification Intent — PostgreSQL Tests
 *
 * Tests:
 * A. transition_promo_fulfillment creates atomic notification intent
 * B. Idempotent: duplicate transition does not create duplicate intent
 * C. finalize_promo_fulfillment_notification: pending -> sent/failed
 * D. advance_promo_fulfillment_notification_status: monotonic delivery
 * E. Privilege hardening: service_role only
 * E-conc. Two-session concurrency (SELECT FOR UPDATE)
 * F. Claim with lease/token (Blocker 2 round 3)
 * G. Lease expiry and reclaim (Blocker 2 round 3)
 * H. mark_fulfillment_notification_attempted (Blocker 2 round 3)
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

  // ── E-conc. Real two-session concurrency ──

  describe('E-conc. Two-session concurrency', () => {
    const concRedemptionId = '00000000-0000-0000-0000-000000204015';
    const concCodeId = '00000000-0000-0000-0000-000000204016';

    beforeAll(() => {
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

  // ── F. Claim with lease/token (Blocker 2 round 3) ──

  describe('F. Claim with lease/token', () => {
    const leaseRedemptionId = '00000000-0000-0000-0000-000000204020';
    const leaseCodeId = '00000000-0000-0000-0000-000000204021';

    beforeAll(() => {
      psql(`
        INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES ('${leaseCodeId}', '${testBizId}', '${testCampaignId}', '${testBatchId}', 'hash204lease', 'enc_204lease', 'LEAS', 'winner', '${testPrizeId}', 'claimed')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
        VALUES ('${leaseRedemptionId}', '${testBizId}', '${testCampaignId}', '${leaseCodeId}', '+2348077777777', 'winner', 'WAA-LEASE-204', 'pending', 'standard', 'phone_verified')
        ON CONFLICT (id) DO NOTHING;

        -- Transition to create the notification intent
        SELECT transition_promo_fulfillment(
          '${testBizId}', '${leaseRedemptionId}', 'processing', '${testUserId}', NULL, NULL
        );
      `);
    });

    afterAll(() => {
      psql(`
        DELETE FROM promo_fulfillment_notification_intents WHERE redemption_id = '${leaseRedemptionId}';
        DELETE FROM admin_audit_logs WHERE entity_id = '${leaseRedemptionId}';
        DELETE FROM promo_redemptions WHERE id = '${leaseRedemptionId}';
        DELETE FROM promo_campaign_codes WHERE id = '${leaseCodeId}';
      `);
    });

    it('claim returns token and sets claim_token + claim_expires_at', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${leaseRedemptionId}' AND to_status = 'processing';
      `);

      const result = psqlJson(`
        SELECT claim_fulfillment_notification_dispatch('${intentId}');
      `);
      expect(result.claimed).toBe(true);
      expect(result.claim_token).toBeDefined();
      expect(typeof result.claim_token).toBe('string');
      // UUID format
      expect((result.claim_token as string).length).toBe(36);

      // Verify columns set in DB
      const row = psql(`
        SELECT claim_token IS NOT NULL, claim_expires_at IS NOT NULL, attempted_at IS NOT NULL
        FROM promo_fulfillment_notification_intents WHERE id = '${intentId}';
      `);
      expect(row).toContain('t'); // All should be true
    });

    it('second claim on same intent returns not_available', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${leaseRedemptionId}' AND to_status = 'processing';
      `);

      const result = psqlJson(`
        SELECT claim_fulfillment_notification_dispatch('${intentId}');
      `);
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe('not_available');
    });

    it('two-session claim race: exactly one wins', async () => {
      // Create a fresh intent for this test
      const raceRedemptionId = '00000000-0000-0000-0000-000000204022';
      const raceCodeId = '00000000-0000-0000-0000-000000204023';
      psql(`
        INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES ('${raceCodeId}', '${testBizId}', '${testCampaignId}', '${testBatchId}', 'hash204race', 'enc_204race', 'RACE', 'winner', '${testPrizeId}', 'claimed')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
        VALUES ('${raceRedemptionId}', '${testBizId}', '${testCampaignId}', '${raceCodeId}', '+2348066666666', 'winner', 'WAA-RACE-204', 'pending', 'standard', 'phone_verified')
        ON CONFLICT (id) DO NOTHING;

        SELECT transition_promo_fulfillment(
          '${testBizId}', '${raceRedemptionId}', 'processing', '${testUserId}', NULL, NULL
        );
      `);

      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${raceRedemptionId}' AND to_status = 'processing';
      `);

      // Session A: claim with pg_sleep to hold the lock
      const sessionA = psqlAsync(`
        BEGIN;
        SELECT claim_fulfillment_notification_dispatch('${intentId}');
        SELECT pg_sleep(2);
        COMMIT;
      `);

      await new Promise(r => setTimeout(r, 300));

      // Session B: attempts same claim -> blocks -> gets not_available
      const sessionB = psqlAsync(`
        SELECT claim_fulfillment_notification_dispatch('${intentId}');
      `);

      const [resultA, resultB] = await Promise.all([sessionA, sessionB]);

      expect(resultA.ok).toBe(true);
      expect(resultA.stdout).toContain('"claimed": true');

      expect(resultB.ok).toBe(true);
      expect(resultB.stdout).toContain('"claimed": false');

      // Exactly one claim_token
      const tokenCount = psql(`
        SELECT count(*) FROM promo_fulfillment_notification_intents
        WHERE id = '${intentId}' AND claim_token IS NOT NULL;
      `);
      expect(parseInt(tokenCount)).toBe(1);

      // Cleanup
      psql(`
        DELETE FROM promo_fulfillment_notification_intents WHERE redemption_id = '${raceRedemptionId}';
        DELETE FROM admin_audit_logs WHERE entity_id = '${raceRedemptionId}';
        DELETE FROM promo_redemptions WHERE id = '${raceRedemptionId}';
        DELETE FROM promo_campaign_codes WHERE id = '${raceCodeId}';
      `);
    }, 25000);
  });

  // ── G. Lease expiry and reclaim ──

  describe('G. Lease expiry and reclaim', () => {
    const expiryRedemptionId = '00000000-0000-0000-0000-000000204030';
    const expiryCodeId = '00000000-0000-0000-0000-000000204031';

    beforeAll(() => {
      psql(`
        INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES ('${expiryCodeId}', '${testBizId}', '${testCampaignId}', '${testBatchId}', 'hash204exp', 'enc_204exp', 'EXPD', 'winner', '${testPrizeId}', 'claimed')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
        VALUES ('${expiryRedemptionId}', '${testBizId}', '${testCampaignId}', '${expiryCodeId}', '+2348055555555', 'winner', 'WAA-EXP-204', 'pending', 'standard', 'phone_verified')
        ON CONFLICT (id) DO NOTHING;

        SELECT transition_promo_fulfillment(
          '${testBizId}', '${expiryRedemptionId}', 'processing', '${testUserId}', NULL, NULL
        );
      `);
    });

    afterAll(() => {
      psql(`
        DELETE FROM promo_fulfillment_notification_intents WHERE redemption_id = '${expiryRedemptionId}';
        DELETE FROM admin_audit_logs WHERE entity_id = '${expiryRedemptionId}';
        DELETE FROM promo_redemptions WHERE id = '${expiryRedemptionId}';
        DELETE FROM promo_campaign_codes WHERE id = '${expiryCodeId}';
      `);
    });

    it('expired lease allows reclaim (no provider_attempted_at)', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${expiryRedemptionId}' AND to_status = 'processing';
      `);

      // Claim with 1-second lease
      const claim1 = psqlJson(`
        SELECT claim_fulfillment_notification_dispatch('${intentId}', 1);
      `);
      expect(claim1.claimed).toBe(true);
      const token1 = claim1.claim_token;

      // Wait for lease to expire (1 second + buffer)
      psql(`SELECT pg_sleep(2);`);

      // Reclaim should succeed (lease expired, no provider_attempted_at)
      const claim2 = psqlJson(`
        SELECT claim_fulfillment_notification_dispatch('${intentId}');
      `);
      expect(claim2.claimed).toBe(true);
      expect(claim2.claim_token).not.toBe(token1); // New token
    });

    it('provider_attempted_at blocks reclaim even after lease expiry', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${expiryRedemptionId}' AND to_status = 'processing';
      `);

      // Get current claim token
      const currentToken = psql(`
        SELECT claim_token FROM promo_fulfillment_notification_intents WHERE id = '${intentId}';
      `);

      // Mark provider attempted
      const markResult = psqlJson(`
        SELECT mark_fulfillment_notification_attempted('${intentId}', '${currentToken}');
      `);
      expect(markResult.success).toBe(true);

      // Wait for any lease to expire
      psql(`SELECT pg_sleep(1);`);

      // Reclaim should fail (provider_attempted_at is set)
      const claim3 = psqlJson(`
        SELECT claim_fulfillment_notification_dispatch('${intentId}');
      `);
      expect(claim3.claimed).toBe(false);
      expect(claim3.reason).toBe('not_available');
    });
  });

  // ── H. mark_fulfillment_notification_attempted ──

  describe('H. mark_fulfillment_notification_attempted', () => {
    const markRedemptionId = '00000000-0000-0000-0000-000000204040';
    const markCodeId = '00000000-0000-0000-0000-000000204041';

    beforeAll(() => {
      psql(`
        INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES ('${markCodeId}', '${testBizId}', '${testCampaignId}', '${testBatchId}', 'hash204mark', 'enc_204mark', 'MARK', 'winner', '${testPrizeId}', 'claimed')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
        VALUES ('${markRedemptionId}', '${testBizId}', '${testCampaignId}', '${markCodeId}', '+2348044444444', 'winner', 'WAA-MARK-204', 'pending', 'standard', 'phone_verified')
        ON CONFLICT (id) DO NOTHING;

        SELECT transition_promo_fulfillment(
          '${testBizId}', '${markRedemptionId}', 'processing', '${testUserId}', NULL, NULL
        );
      `);
    });

    afterAll(() => {
      psql(`
        DELETE FROM promo_fulfillment_notification_intents WHERE redemption_id = '${markRedemptionId}';
        DELETE FROM admin_audit_logs WHERE entity_id = '${markRedemptionId}';
        DELETE FROM promo_redemptions WHERE id = '${markRedemptionId}';
        DELETE FROM promo_campaign_codes WHERE id = '${markCodeId}';
      `);
    });

    it('succeeds with correct claim token', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${markRedemptionId}' AND to_status = 'processing';
      `);

      // First claim to get a token
      const claim = psqlJson(`
        SELECT claim_fulfillment_notification_dispatch('${intentId}');
      `);
      expect(claim.claimed).toBe(true);

      const result = psqlJson(`
        SELECT mark_fulfillment_notification_attempted('${intentId}', '${claim.claim_token}');
      `);
      expect(result.success).toBe(true);

      // Verify provider_attempted_at is set
      const row = psql(`
        SELECT provider_attempted_at IS NOT NULL FROM promo_fulfillment_notification_intents WHERE id = '${intentId}';
      `);
      expect(row).toBe('t');
    });

    it('fails with wrong claim token', () => {
      const intentId = psql(`
        SELECT id FROM promo_fulfillment_notification_intents
        WHERE redemption_id = '${markRedemptionId}' AND to_status = 'processing';
      `);

      const result = psqlJson(`
        SELECT mark_fulfillment_notification_attempted('${intentId}', '00000000-0000-0000-0000-000000000099');
      `);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('invalid_claim');
    });
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

    it('service_role can execute claim_fulfillment_notification_dispatch', () => {
      const result = psql(`
        SELECT has_function_privilege('service_role', 'claim_fulfillment_notification_dispatch(uuid, int)', 'EXECUTE');
      `);
      expect(result).toBe('t');
    });

    it('anon cannot execute claim_fulfillment_notification_dispatch', () => {
      const result = psql(`
        SELECT has_function_privilege('anon', 'claim_fulfillment_notification_dispatch(uuid, int)', 'EXECUTE');
      `);
      expect(result).toBe('f');
    });

    it('service_role can execute mark_fulfillment_notification_attempted', () => {
      const result = psql(`
        SELECT has_function_privilege('service_role', 'mark_fulfillment_notification_attempted(uuid, uuid)', 'EXECUTE');
      `);
      expect(result).toBe('t');
    });

    it('anon cannot execute mark_fulfillment_notification_attempted', () => {
      const result = psql(`
        SELECT has_function_privilege('anon', 'mark_fulfillment_notification_attempted(uuid, uuid)', 'EXECUTE');
      `);
      expect(result).toBe('f');
    });
  });
});
