/**
 * ACC-184: Promo History Tenant Isolation — Real Migrated Schema PostgreSQL Tests
 *
 * Runs against the ACTUAL Waaiio migrated schema (waaiio_test).
 * Creates fixture ROWS only — one ADD COLUMN IF NOT EXISTS to complete the
 * CI-minimal auth.users table so the production handle_new_user() trigger fires.
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

const PHONE = '2341234567890';
const USER_ID = '00000000-0000-4000-f184-000000000001';
const BIZ_A_ID = '00000000-0000-4000-a184-aaaaaaaaaaaa';
const BIZ_B_ID = '00000000-0000-4000-a184-bbbbbbbbbbbb';
const CAMP_A_ID = '00000000-0000-4000-c184-aaaaaaaaaaaa';
const CAMP_B_ID = '00000000-0000-4000-c184-bbbbbbbbbbbb';
const CODE_A_ID = '00000000-0000-4000-d184-aaaaaaaaaaaa';
const CODE_B_ID = '00000000-0000-4000-d184-bbbbbbbbbbbb';
const BATCH_A_ID = '00000000-0000-4000-b184-aaaaaaaaaaaa';
const BATCH_B_ID = '00000000-0000-4000-b184-bbbbbbbbbbbb';
const PRIZE_A_ID = '00000000-0000-4000-9184-aaaaaaaaaaaa';
const REDEMPTION_A_ID = '00000000-0000-4000-e184-aaaaaaaaaaaa';
const REDEMPTION_B_ID = '00000000-0000-4000-e184-bbbbbbbbbbbb';

describe.skipIf(!canRun)('ACC-184 DB: Promo history tenant isolation (real migrated schema)', () => {
  beforeAll(() => {
    // Cleanup any prior run (reverse FK order)
    psql(`
      DELETE FROM promo_verification_attempts WHERE business_id IN ('${BIZ_A_ID}', '${BIZ_B_ID}');
      DELETE FROM promo_redemptions WHERE id IN ('${REDEMPTION_A_ID}', '${REDEMPTION_B_ID}');
      DELETE FROM promo_campaign_codes WHERE id IN ('${CODE_A_ID}', '${CODE_B_ID}');
      DELETE FROM promo_code_batches WHERE id IN ('${BATCH_A_ID}', '${BATCH_B_ID}');
      DELETE FROM promo_prizes WHERE id = '${PRIZE_A_ID}';
      DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}');
      DELETE FROM businesses WHERE id IN ('${BIZ_A_ID}', '${BIZ_B_ID}');
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);

    // CI creates auth.users without phone; add it so the production
    // handle_new_user() trigger can fire (INSERT INTO profiles(id,phone,email))
    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;`);

    // Create test user — trigger fires and auto-creates profiles row
    psql(`
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0001840001')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create businesses with all required NOT NULL columns
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_A_ID}', 'ACC184 Biz A', 'acc184-biz-a-184', '${USER_ID}', '1 Test', 'Lagos', 'VI', '+000', 'active', 'platform_managed', 'NG', 'basic')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_B_ID}', 'ACC184 Biz B', 'acc184-biz-b-184', '${USER_ID}', '2 Test', 'Lagos', 'VI', '+001', 'active', 'platform_managed', 'NG', 'basic')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create campaigns, codes, redemptions
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, timezone, code_entry_mode, keyword, accept_bare_codes, code_length, max_attempts_per_phone, rate_limit_window_minutes, rate_limit_max_attempts, eligibility_mode, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_A_ID}', 'Biz A Promo', 'ended', 'UTC', 'both', 'TESTPROMO', true, 12, 3, 60, 5, 'none', 'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count, sort_order)
      VALUES ('${PRIZE_A_ID}', '${CAMP_A_ID}', 'Cash Prize', 'cash', 10, 1, 0)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_code_batches (id, campaign_id, source, requested_count, status)
      VALUES ('${BATCH_A_ID}', '${CAMP_A_ID}', 'generated', 1, 'completed')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
      VALUES ('${CODE_A_ID}', '${BIZ_A_ID}', '${CAMP_A_ID}', '${BATCH_A_ID}', 'hash_a_184', 'enc_a', 'AAAA', 'winner', '${PRIZE_A_ID}', 'claimed')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, prize_id, claim_reference, fulfillment_status)
      VALUES ('${REDEMPTION_A_ID}', '${BIZ_A_ID}', '${CAMP_A_ID}', '${CODE_A_ID}', '${PHONE}', 'winner', '${PRIZE_A_ID}', 'WAA-BIZA', 'pending')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaigns (id, business_id, name, status, timezone, code_entry_mode, keyword, accept_bare_codes, code_length, max_attempts_per_phone, rate_limit_window_minutes, rate_limit_max_attempts, eligibility_mode, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_B_ID}', '${BIZ_B_ID}', 'Biz B Promo', 'archived', 'UTC', 'both', 'TESTPROMO', true, 12, 3, 60, 5, 'none', 'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_code_batches (id, campaign_id, source, requested_count, status)
      VALUES ('${BATCH_B_ID}', '${CAMP_B_ID}', 'generated', 1, 'completed')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, status)
      VALUES ('${CODE_B_ID}', '${BIZ_B_ID}', '${CAMP_B_ID}', '${BATCH_B_ID}', 'hash_b_184', 'enc_b', 'BBBB', 'try_again', 'claimed')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status)
      VALUES ('${REDEMPTION_B_ID}', '${BIZ_B_ID}', '${CAMP_B_ID}', '${CODE_B_ID}', '${PHONE}', 'try_again', 'WAA-BIZB', 'fulfilled')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM promo_verification_attempts WHERE business_id IN ('${BIZ_A_ID}', '${BIZ_B_ID}');
      DELETE FROM promo_redemptions WHERE id IN ('${REDEMPTION_A_ID}', '${REDEMPTION_B_ID}');
      DELETE FROM promo_campaign_codes WHERE id IN ('${CODE_A_ID}', '${CODE_B_ID}');
      DELETE FROM promo_code_batches WHERE id IN ('${BATCH_A_ID}', '${BATCH_B_ID}');
      DELETE FROM promo_prizes WHERE id = '${PRIZE_A_ID}';
      DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}');
      DELETE FROM businesses WHERE id IN ('${BIZ_A_ID}', '${BIZ_B_ID}');
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);
  });

  it('Business A + same phone → only A redemption', () => {
    const result = psql(`
      SELECT claim_reference FROM promo_redemptions
      WHERE business_id = '${BIZ_A_ID}' AND phone_e164 = '${PHONE}'
      ORDER BY claimed_at DESC;
    `);
    expect(result).toContain('WAA-BIZA');
    expect(result).not.toContain('WAA-BIZB');
  });

  it('Business B + same phone → only B redemption', () => {
    const result = psql(`
      SELECT claim_reference FROM promo_redemptions
      WHERE business_id = '${BIZ_B_ID}' AND phone_e164 = '${PHONE}'
      ORDER BY claimed_at DESC;
    `);
    expect(result).toContain('WAA-BIZB');
    expect(result).not.toContain('WAA-BIZA');
  });

  it('wrong business + same phone → zero results', () => {
    const result = psql(`
      SELECT count(*) FROM promo_redemptions
      WHERE business_id = '00000000-0000-4000-a184-cccccccccccc' AND phone_e164 = '${PHONE}';
    `);
    expect(result).toBe('0');
  });

  it('attempts-only phone has no redemption history', () => {
    const ATTEMPTS_PHONE = '2349876543210';
    psql(`
      INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result)
      VALUES ('${BIZ_A_ID}', '${CAMP_A_ID}', '${ATTEMPTS_PHONE}', 'attempt_hash_184', 'invalid')
      ON CONFLICT DO NOTHING;
    `);
    const result = psql(`
      SELECT count(*) FROM promo_redemptions
      WHERE business_id = '${BIZ_A_ID}' AND phone_e164 = '${ATTEMPTS_PHONE}';
    `);
    expect(result).toBe('0');
    psql(`DELETE FROM promo_verification_attempts WHERE submitted_code_hash = 'attempt_hash_184';`);
  });

  it('ended campaign redemption is queryable', () => {
    const result = psql(`
      SELECT r.claim_reference, c.status FROM promo_redemptions r
      JOIN promo_campaigns c ON c.id = r.campaign_id
      WHERE r.business_id = '${BIZ_A_ID}' AND r.phone_e164 = '${PHONE}';
    `);
    expect(result).toContain('WAA-BIZA');
    expect(result).toContain('ended');
  });

  it('archived campaign redemption is queryable', () => {
    const result = psql(`
      SELECT r.claim_reference, c.status FROM promo_redemptions r
      JOIN promo_campaigns c ON c.id = r.campaign_id
      WHERE r.business_id = '${BIZ_B_ID}' AND r.phone_e164 = '${PHONE}';
    `);
    expect(result).toContain('WAA-BIZB');
    expect(result).toContain('archived');
  });
});
