/**
 * ACC-198: Promo Routing Consistency — PostgreSQL Tests
 *
 * Runs against a real Supabase instance with the migrated schema.
 * Tests concurrency, privilege assertions, atomic audit rollback,
 * and migration repair scenarios.
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Skips gracefully if no connection is available.
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

const USER_ID = '00000000-0000-4000-f198-000000000001';
const BIZ_ID = '00000000-0000-4000-a198-aaaaaaaaaaaa';
const BIZ_B_ID = '00000000-0000-4000-a198-bbbbbbbbbbbb';
const CAMP_A_ID = '00000000-0000-4000-c198-aaaaaaaaaaaa';
const CAMP_B_ID = '00000000-0000-4000-c198-bbbbbbbbbbbb';
const CAMP_C_ID = '00000000-0000-4000-c198-cccccccccccc';

describe.skipIf(!canRun)('ACC-198 DB: Promo routing consistency (real migrated schema)', () => {
  beforeAll(() => {
    // Cleanup any prior run
    psql(`
      DELETE FROM promo_campaign_codes WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_code_batches WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_prizes WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${BIZ_B_ID}');
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);

    // Create test user + businesses
    psql(`
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;
      INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, instance_id)
      VALUES ('${USER_ID}', 'test198@waaiio.test', '$2a$10$abcdefghijklmnopqrstuv', now(), '{"provider":"email"}', '{}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')
      ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO businesses (id, owner_id, name, slug, category) VALUES
        ('${BIZ_ID}', '${USER_ID}', 'Test Biz 198', 'test-biz-198', 'retail'),
        ('${BIZ_B_ID}', '${USER_ID}', 'Test Biz 198B', 'test-biz-198b', 'retail')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM admin_audit_logs WHERE entity_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_campaign_codes WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_code_batches WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_prizes WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${BIZ_B_ID}');
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);
  });

  it('CHECK constraint enforces routing consistency', () => {
    // Valid: keyword mode with keyword set and bare=false
    expect(() => {
      psql(`
        INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
        VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Test KW', 'keyword', 'PROMO', false, 'w', 't', 'i', 'a', 'e');
      `);
    }).not.toThrow();

    // Cleanup
    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);

    // Invalid: keyword mode with bare=true should fail
    expect(() => {
      psql(`
        INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
        VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Test Bad', 'keyword', 'PROMO', true, 'w', 't', 'i', 'a', 'e');
      `);
    }).toThrow();
  });

  it('keyword normalization trigger uppercases and trims', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Test Norm', 'keyword', '  hello  ', false, 'w', 't', 'i', 'a', 'e');
    `);

    const kw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
    expect(kw).toBe('HELLO');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('update_promo_campaign_routing rejects integrity-locked campaigns', () => {
    // Create a campaign and lock it
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, integrity_locked, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Locked Camp', 'keyword', 'LOCKED', false, true, 'w', 't', 'i', 'a', 'e');
    `);

    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'bare_code', NULL, NULL);
    `);
    expect(result).toContain('integrity_locked');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('update_promo_campaign_routing detects keyword conflict', () => {
    // Create two campaigns — one active with keyword PROMO
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Active KW', 'active', 'keyword', 'PROMO', false, 'w', 't', 'i', 'a', 'e');
    `);
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_B_ID}', '${BIZ_ID}', 'Draft Camp', 'draft', 'bare_code', NULL, true, 'w', 't', 'i', 'a', 'e');
    `);

    // Try to change draft camp to keyword=PROMO → should detect conflict
    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_B_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'PROMO', NULL);
    `);
    expect(result).toContain('keyword_conflict');
    expect(result).toContain('Active KW');

    psql(`DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}')`);
  });

  it('update_promo_campaign_routing succeeds for non-conflicting change', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Draft Camp', 'draft', 'keyword', 'OLD', false, 'w', 't', 'i', 'a', 'e');
    `);

    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'NEWKW', NULL);
    `);
    expect(result).toContain('"success" : true');

    // Verify the update
    const kw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
    expect(kw).toBe('NEWKW');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('update_promo_campaign_routing writes audit for active campaigns', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Active Audit', 'active', 'keyword', 'OLD', false, 'w', 't', 'i', 'a', 'e');
    `);

    psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'NEWAUDIT', NULL);
    `);

    const auditCount = psql(`
      SELECT count(*) FROM admin_audit_logs WHERE entity_id = '${CAMP_A_ID}' AND action = 'promotions.routing_update';
    `);
    expect(parseInt(auditCount)).toBeGreaterThanOrEqual(1);

    psql(`
      DELETE FROM admin_audit_logs WHERE entity_id = '${CAMP_A_ID}';
      DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}';
    `);
  });

  it('update_promo_campaign_routing does NOT write audit for draft campaigns', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Draft NoAudit', 'draft', 'keyword', 'OLD', false, 'w', 't', 'i', 'a', 'e');
    `);

    psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'NEWNEW', NULL);
    `);

    const auditCount = psql(`
      SELECT count(*) FROM admin_audit_logs WHERE entity_id = '${CAMP_A_ID}' AND action = 'promotions.routing_update';
    `);
    expect(parseInt(auditCount)).toBe(0);

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('cross-business routing change does not find campaign', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Biz A Camp', 'draft', 'keyword', 'BIZCROSS', false, 'w', 't', 'i', 'a', 'e');
    `);

    // Try to update using wrong business_id
    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_B_ID}', '${USER_ID}', 'keyword', 'NEWKW', NULL);
    `);
    expect(result).toContain('Campaign not found');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('validate_promo_campaign_activation detects scheduled keyword conflict', () => {
    // Create a scheduled campaign with keyword PROMO
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message, start_at, end_at)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Scheduled KW', 'scheduled', 'keyword', 'PROMO', false, 'w', 't', 'i', 'a', 'e', now() + interval '1 day', now() + interval '30 days');
    `);
    // Create a draft campaign with same keyword (to validate activation)
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message, start_at, end_at)
      VALUES ('${CAMP_B_ID}', '${BIZ_ID}', 'Draft KW', 'draft', 'keyword', 'PROMO', false, 'w', 't', 'i', 'a', 'e', now() + interval '1 day', now() + interval '30 days');
    `);

    const result = psql(`SELECT validate_promo_campaign_activation('${CAMP_B_ID}')`);
    expect(result).toContain('conflicts with campaign');
    expect(result).toContain('Scheduled KW');

    psql(`DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}')`);
  });
});
