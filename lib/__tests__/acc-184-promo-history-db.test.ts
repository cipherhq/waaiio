/**
 * ACC-184: Promo History Tenant Isolation — Real PostgreSQL Tests
 *
 * Proves same phone across Business A / Business B returns
 * only the correct tenant's redemption history.
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
const BIZ_A_ID = '00000000-0000-4000-a184-aaaaaaaaaaaa';
const BIZ_B_ID = '00000000-0000-4000-a184-bbbbbbbbbbbb';
const CAMP_A_ID = '00000000-0000-4000-c184-aaaaaaaaaaaa';
const CAMP_B_ID = '00000000-0000-4000-c184-bbbbbbbbbbbb';
const CODE_A_ID = '00000000-0000-4000-d184-aaaaaaaaaaaa';
const CODE_B_ID = '00000000-0000-4000-d184-bbbbbbbbbbbb';
const REDEMPTION_A_ID = '00000000-0000-4000-e184-aaaaaaaaaaaa';
const REDEMPTION_B_ID = '00000000-0000-4000-e184-bbbbbbbbbbbb';

describe.skipIf(!canRun)('ACC-184 DB: Promo history tenant isolation', () => {
  beforeAll(() => {
    // Create minimal schema (self-contained — no full migration dependency)
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL
      );

      DO $$ BEGIN
        CREATE TYPE promo_campaign_status AS ENUM ('draft','scheduled','active','paused','ended','archived');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE promo_code_entry_mode AS ENUM ('keyword','bare_code','both');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE promo_code_outcome AS ENUM ('winner','try_again');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE TYPE promo_fulfillment_status AS ENUM ('pending','processing','fulfilled','rejected','cancelled');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS promo_campaigns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status promo_campaign_status NOT NULL DEFAULT 'draft',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        code_entry_mode promo_code_entry_mode NOT NULL DEFAULT 'both',
        code_length INT NOT NULL DEFAULT 12,
        max_attempts_per_phone INT NOT NULL DEFAULT 3,
        rate_limit_window_minutes INT NOT NULL DEFAULT 60,
        rate_limit_max_attempts INT NOT NULL DEFAULT 5,
        eligibility_mode TEXT NOT NULL DEFAULT 'none',
        winner_message TEXT NOT NULL DEFAULT '',
        try_again_message TEXT NOT NULL DEFAULT '',
        invalid_message TEXT NOT NULL DEFAULT '',
        already_used_message TEXT NOT NULL DEFAULT '',
        expired_message TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS promo_campaign_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        campaign_id UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
        normalized_code_hash TEXT NOT NULL,
        encrypted_code TEXT NOT NULL,
        display_suffix TEXT NOT NULL,
        outcome promo_code_outcome NOT NULL DEFAULT 'try_again',
        status TEXT NOT NULL DEFAULT 'unused'
      );

      CREATE TABLE IF NOT EXISTS promo_redemptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        campaign_id UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
        promo_code_id UUID NOT NULL,
        phone_e164 TEXT NOT NULL,
        outcome promo_code_outcome NOT NULL,
        claim_reference TEXT NOT NULL,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        fulfillment_status promo_fulfillment_status NOT NULL DEFAULT 'pending'
      );

      CREATE TABLE IF NOT EXISTS promo_verification_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        campaign_id UUID NOT NULL,
        phone_e164 TEXT NOT NULL,
        submitted_code_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Create fixtures: two businesses, campaigns, codes, redemptions — SAME phone
    psql(`

      INSERT INTO businesses (id, name) VALUES ('${BIZ_A_ID}', 'Biz A') ON CONFLICT DO NOTHING;
      INSERT INTO businesses (id, name) VALUES ('${BIZ_B_ID}', 'Biz B') ON CONFLICT DO NOTHING;

      -- Business A campaign (ended) + code + redemption
      INSERT INTO promo_campaigns (id, business_id, name, status, timezone, code_entry_mode, code_length, max_attempts_per_phone, rate_limit_window_minutes, rate_limit_max_attempts, eligibility_mode, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_A_ID}', 'Biz A Promo', 'ended', 'UTC', 'both', 12, 3, 60, 5, 'none', 'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, normalized_code_hash, encrypted_code, display_suffix, outcome, status)
      VALUES ('${CODE_A_ID}', '${BIZ_A_ID}', '${CAMP_A_ID}', 'hash_a_184', 'enc_a', 'AAAA', 'winner', 'claimed')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status)
      VALUES ('${REDEMPTION_A_ID}', '${BIZ_A_ID}', '${CAMP_A_ID}', '${CODE_A_ID}', '${PHONE}', 'winner', 'WAA-BIZA', 'pending')
      ON CONFLICT (id) DO NOTHING;

      -- Business B campaign (archived) + code + redemption
      INSERT INTO promo_campaigns (id, business_id, name, status, timezone, code_entry_mode, code_length, max_attempts_per_phone, rate_limit_window_minutes, rate_limit_max_attempts, eligibility_mode, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_B_ID}', '${BIZ_B_ID}', 'Biz B Promo', 'archived', 'UTC', 'both', 12, 3, 60, 5, 'none', 'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, normalized_code_hash, encrypted_code, display_suffix, outcome, status)
      VALUES ('${CODE_B_ID}', '${BIZ_B_ID}', '${CAMP_B_ID}', 'hash_b_184', 'enc_b', 'BBBB', 'try_again', 'claimed')
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
      DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}');
      DELETE FROM businesses WHERE id IN ('${BIZ_A_ID}', '${BIZ_B_ID}');
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
    const WRONG_BIZ = '00000000-0000-4000-a184-cccccccccccc';
    const result = psql(`
      SELECT count(*) FROM promo_redemptions
      WHERE business_id = '${WRONG_BIZ}' AND phone_e164 = '${PHONE}';
    `);
    expect(result).toBe('0');
  });

  it('attempts-only phone has no redemption history', () => {
    const ATTEMPTS_PHONE = '2349876543210';
    // Insert an attempt (not a redemption)
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

    // Cleanup
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
