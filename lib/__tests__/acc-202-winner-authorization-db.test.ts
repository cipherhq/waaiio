/**
 * ACC-202: Winner Authorization — PostgreSQL Tests
 *
 * Tests the updated transition_promo_fulfillment function with atomic audit,
 * and privilege assertions.
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Skips gracefully in local dev if no DB connection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
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

const USER_ID = '00000000-0000-4000-f202-000000000001';
const BIZ_ID = '00000000-0000-4000-a202-aaaaaaaaaaaa';
const CAMP_ID = '00000000-0000-4000-c202-aaaaaaaaaaaa';
const PRIZE_ID = '00000000-0000-4000-9202-aaaaaaaaaaaa';
const BATCH_ID = '00000000-0000-4000-b202-aaaaaaaaaaaa';
const CODE_ID = '00000000-0000-4000-e202-aaaaaaaaaaaa';
const RED_ID = '00000000-0000-4000-d202-aaaaaaaaaaaa';

describe.skipIf(!canRun)('ACC-202 DB: Fulfillment audit + privileges', () => {
  beforeAll(() => {
    // Create test fixtures
    psql(`
      -- CI-compatible auth.users INSERT (no raw_user_meta_data — doesn't exist in bare PG)
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0002020001')
      ON CONFLICT (id) DO NOTHING;

      -- Test business (full NOT NULL columns matching ACC-184 pattern)
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level, subscription_tier, category)
      VALUES ('${BIZ_ID}', 'ACC202 Test Biz', 'acc202-test', '${USER_ID}', '1 Test', 'Lagos', 'VI', '+0002020002', 'active', 'manual', 'NG', 'basic', 'growth', 'other')
      ON CONFLICT (id) DO UPDATE SET name = 'ACC202 Test Biz';

      -- Test campaign (bare_code mode satisfies chk_routing_consistency)
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, accept_bare_codes, max_attempts_per_phone, rate_limit_window_minutes, rate_limit_max_attempts, eligibility_mode, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_ID}', '${BIZ_ID}', 'ACC202 Test', 'active', 'bare_code', true, 100, 60, 100, 'none', 'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;

      -- Test prize
      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count)
      VALUES ('${PRIZE_ID}', '${CAMP_ID}', 'Test Prize', 'product', 1, 1)
      ON CONFLICT (id) DO NOTHING;

      -- Test batch
      INSERT INTO promo_code_batches (id, campaign_id, requested_count, generated_count, status, failed_count)
      VALUES ('${BATCH_ID}', '${CAMP_ID}', 1, 1, 'completed', 0)
      ON CONFLICT (id) DO NOTHING;

      -- Test code
      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, prize_id, normalized_code_hash, encrypted_code, display_suffix, outcome, status)
      VALUES ('${CODE_ID}', '${BIZ_ID}', '${CAMP_ID}', '${BATCH_ID}', '${PRIZE_ID}', 'hash202test', 'enc202', '0202', 'winner', 'claimed')
      ON CONFLICT (id) DO NOTHING;

      -- Test redemption (winner, pending fulfillment)
      INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
      VALUES ('${RED_ID}', '${BIZ_ID}', '${CAMP_ID}', '${CODE_ID}', '+2348099999999', 'winner', 'WAA-202-TEST-0001-0001', 'pending', 'standard', 'phone_verified')
      ON CONFLICT (id) DO UPDATE SET fulfillment_status = 'pending', updated_at = now();
    `);
  });

  afterAll(() => {
    psqlMayFail(`
      DELETE FROM admin_audit_logs WHERE entity_id = '${RED_ID}';
      DELETE FROM promo_redemptions WHERE id = '${RED_ID}';
      DELETE FROM promo_campaign_codes WHERE id = '${CODE_ID}';
      DELETE FROM promo_code_batches WHERE id = '${BATCH_ID}';
      DELETE FROM promo_prizes WHERE id = '${PRIZE_ID}';
      DELETE FROM promo_campaigns WHERE id = '${CAMP_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);
  });

  it('fulfillment transition creates audit log atomically', () => {
    // Reset redemption to pending
    psql(`UPDATE promo_redemptions SET fulfillment_status = 'pending', updated_at = now() WHERE id = '${RED_ID}'`);
    psql(`DELETE FROM admin_audit_logs WHERE entity_id = '${RED_ID}'`);

    const result = psql(`
      SELECT transition_promo_fulfillment(
        '${BIZ_ID}', '${RED_ID}', 'processing', '${USER_ID}', 'ref-202', 'test notes'
      );
    `);

    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.new_status).toBe('processing');

    // Verify audit log was created
    const auditCount = psql(`
      SELECT COUNT(*) FROM admin_audit_logs
      WHERE entity_id = '${RED_ID}'
      AND action = 'promotions.fulfillment_transition'
    `);
    expect(parseInt(auditCount)).toBe(1);

    // Verify audit details
    const auditDetails = psql(`
      SELECT details FROM admin_audit_logs
      WHERE entity_id = '${RED_ID}'
      AND action = 'promotions.fulfillment_transition'
      ORDER BY created_at DESC LIMIT 1
    `);
    const details = JSON.parse(auditDetails);
    expect(details.from_status).toBe('pending');
    expect(details.to_status).toBe('processing');
    expect(details.business_id).toBe(BIZ_ID);
    expect(details.campaign_id).toBe(CAMP_ID);
  });

  it('service_role can execute transition_promo_fulfillment', () => {
    const result = psql(`
      SELECT has_function_privilege(
        'service_role',
        'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)',
        'EXECUTE'
      );
    `);
    expect(result).toBe('t');
  });

  it('anon cannot execute transition_promo_fulfillment', () => {
    const result = psql(`
      SELECT has_function_privilege(
        'anon',
        'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)',
        'EXECUTE'
      );
    `);
    expect(result).toBe('f');
  });

  it('authenticated cannot execute transition_promo_fulfillment', () => {
    const result = psql(`
      SELECT has_function_privilege(
        'authenticated',
        'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)',
        'EXECUTE'
      );
    `);
    expect(result).toBe('f');
  });

  it('fulfillment audit failure rolls back the entire transition', () => {
    // Reset redemption to known baseline
    psql(`UPDATE promo_redemptions SET
      fulfillment_status = 'pending',
      fulfillment_reference = NULL,
      fulfillment_notes = NULL,
      fulfilled_at = NULL,
      fulfilled_by = NULL,
      updated_at = now()
    WHERE id = '${RED_ID}'`);
    psql(`DELETE FROM admin_audit_logs WHERE entity_id = '${RED_ID}'`);

    // Create a targeted trigger that only blocks fulfillment audit for this specific redemption
    psql(`
      CREATE OR REPLACE FUNCTION temp_block_fulfillment_audit_202()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.action = 'promotions.fulfillment_transition' AND NEW.entity_id = '${RED_ID}'::uuid THEN
          RAISE EXCEPTION 'Injected audit failure for rollback test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_temp_block_fulfillment_audit_202
        BEFORE INSERT ON admin_audit_logs
        FOR EACH ROW EXECUTE FUNCTION temp_block_fulfillment_audit_202();
    `);

    try {
      // Attempt fulfillment transition with values that would change all fields
      const result = psqlMayFail(`
        SELECT transition_promo_fulfillment(
          '${BIZ_ID}'::uuid, '${RED_ID}'::uuid, 'fulfilled',
          '${USER_ID}'::uuid, 'REF-TEST-202', 'Test notes for rollback'
        );
      `);

      // RPC should have errored (trigger blocked the audit INSERT)
      expect(result.ok).toBe(false);
      expect(result.output).toContain('Injected audit failure');

      // All five fields must remain exactly at baseline (transaction rolled back)
      const status = psql(`SELECT fulfillment_status FROM promo_redemptions WHERE id = '${RED_ID}'`);
      expect(status).toBe('pending');

      const ref = psql(`SELECT COALESCE(fulfillment_reference, 'NULL') FROM promo_redemptions WHERE id = '${RED_ID}'`);
      expect(ref).toBe('NULL');

      const notes = psql(`SELECT COALESCE(fulfillment_notes, 'NULL') FROM promo_redemptions WHERE id = '${RED_ID}'`);
      expect(notes).toBe('NULL');

      const fulfilledAt = psql(`SELECT COALESCE(fulfilled_at::text, 'NULL') FROM promo_redemptions WHERE id = '${RED_ID}'`);
      expect(fulfilledAt).toBe('NULL');

      const fulfilledBy = psql(`SELECT COALESCE(fulfilled_by::text, 'NULL') FROM promo_redemptions WHERE id = '${RED_ID}'`);
      expect(fulfilledBy).toBe('NULL');

      // Zero matching audit rows
      const auditCount = psql(`SELECT count(*)::int FROM admin_audit_logs WHERE entity_id = '${RED_ID}'`);
      expect(auditCount).toBe('0');
    } finally {
      // Clean up trigger and function
      psql(`DROP TRIGGER IF EXISTS trg_temp_block_fulfillment_audit_202 ON admin_audit_logs`);
      psql(`DROP FUNCTION IF EXISTS temp_block_fulfillment_audit_202()`);
    }
  });
});
