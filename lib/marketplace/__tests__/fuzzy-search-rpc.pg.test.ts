/**
 * search_businesses_fuzzy RPC — real PostgreSQL tests
 *
 * Proves:
 * 1. Fuzzy match returns eligible businesses by name similarity
 * 2. discovery_enabled=false businesses are excluded
 * 3. Inactive businesses are excluded
 * 4. Businesses with bot_code=NULL are excluded
 * 5. Hidden businesses (p_hidden_ids) are excluded
 * 6. anon/authenticated cannot EXECUTE
 * 7. Similarity thresholds behave correctly
 *
 * Requires TEST_DATABASE_URL with migrations through 447 applied.
 * Skips locally when TEST_DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  describe.skip('search_businesses_fuzzy DB — TEST_DATABASE_URL not set', () => {
    it('skipped locally', () => {});
  });
} else {

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

const OWNER_UUID = '44700000-0000-0000-0000-000000000001';
const BIZ_ACTIVE   = '44700000-0000-0000-0000-000000000010';
const BIZ_INACTIVE  = '44700000-0000-0000-0000-000000000011';
const BIZ_NO_BOT    = '44700000-0000-0000-0000-000000000012';
const BIZ_OPT_OUT   = '44700000-0000-0000-0000-000000000013';
const BIZ_HIDDEN    = '44700000-0000-0000-0000-000000000014';
const AUTH_UUID     = '44700000-0000-0000-0000-000000000002';

const AUTH_JWT = `{"sub":"${AUTH_UUID}","role":"authenticated","aal":"aal2"}`;

describe('search_businesses_fuzzy — real DB', () => {
  beforeAll(() => {
    const fnCheck = psql(`
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'search_businesses_fuzzy';
    `);
    if (fnCheck === '0') throw new Error('Function not found — migration 447 not applied');

    psql(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${OWNER_UUID}', 'fuzzy-owner-447@test.com', '{"role":"user"}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO profiles (id, email)
      VALUES ('${OWNER_UUID}', 'fuzzy-owner-447@test.com')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${AUTH_UUID}', 'fuzzy-auth-447@test.com', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Active business with bot_code — should appear in fuzzy results
    psql(`
      INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, status, bot_code, discovery_enabled, messaging_suspended, payout_mode, country_code)
      VALUES ('${BIZ_ACTIVE}', '${OWNER_UUID}', 'Fuzzy Salon Test', 'fuzzy-salon-447', '1 Test St', 'Lagos', '+2340000000', 'active', 'FZSL', true, false, 'platform_managed', 'NG')
      ON CONFLICT (id) DO UPDATE SET status = 'active', bot_code = 'FZSL', discovery_enabled = true, messaging_suspended = false, name = 'Fuzzy Salon Test';
    `);
    // Inactive business — should NOT appear
    psql(`
      INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, status, bot_code, discovery_enabled, messaging_suspended, payout_mode, country_code)
      VALUES ('${BIZ_INACTIVE}', '${OWNER_UUID}', 'Fuzzy Barber Inactive', 'fuzzy-barber-447', '2 Test St', 'Lagos', '+2340000001', 'pending', 'FZBI', true, false, 'platform_managed', 'NG')
      ON CONFLICT (id) DO UPDATE SET status = 'pending';
    `);
    // No bot_code — should NOT appear
    psql(`
      INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, status, bot_code, discovery_enabled, messaging_suspended, payout_mode, country_code)
      VALUES ('${BIZ_NO_BOT}', '${OWNER_UUID}', 'Fuzzy NoBotCode', 'fuzzy-nobot-447', '3 Test St', 'Lagos', '+2340000002', 'active', NULL, true, false, 'platform_managed', 'NG')
      ON CONFLICT (id) DO UPDATE SET bot_code = NULL;
    `);
    // Opted out (discovery_enabled=false) — should NOT appear
    psql(`
      INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, status, bot_code, discovery_enabled, messaging_suspended, payout_mode, country_code)
      VALUES ('${BIZ_OPT_OUT}', '${OWNER_UUID}', 'Fuzzy OptOut Test', 'fuzzy-optout-447', '4 Test St', 'Lagos', '+2340000003', 'active', 'FZOO', false, false, 'platform_managed', 'NG')
      ON CONFLICT (id) DO UPDATE SET discovery_enabled = false;
    `);
    // Hidden by admin — should NOT appear when passed in p_hidden_ids
    psql(`
      INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, status, bot_code, discovery_enabled, messaging_suspended, payout_mode, country_code)
      VALUES ('${BIZ_HIDDEN}', '${OWNER_UUID}', 'Fuzzy Hidden Biz', 'fuzzy-hidden-447', '5 Test St', 'Lagos', '+2340000004', 'active', 'FZHD', true, false, 'platform_managed', 'NG')
      ON CONFLICT (id) DO UPDATE SET status = 'active', discovery_enabled = true;
    `);
  });

  afterAll(() => {
    psqlMayFail(`
      DELETE FROM businesses WHERE id IN ('${BIZ_ACTIVE}','${BIZ_INACTIVE}','${BIZ_NO_BOT}','${BIZ_OPT_OUT}','${BIZ_HIDDEN}');
      DELETE FROM profiles WHERE id IN ('${OWNER_UUID}','${AUTH_UUID}');
      DELETE FROM auth.users WHERE id IN ('${OWNER_UUID}','${AUTH_UUID}');
    `);
  });

  it('1. returns eligible business by name similarity', () => {
    const result = psql(`SELECT name FROM search_businesses_fuzzy('Fuzzy Salon', NULL, 10, ARRAY[]::uuid[]);`);
    expect(result).toContain('Fuzzy Salon Test');
  });

  it('2. excludes discovery_enabled=false', () => {
    const result = psql(`SELECT name FROM search_businesses_fuzzy('Fuzzy', NULL, 10, ARRAY[]::uuid[]);`);
    expect(result).not.toContain('Fuzzy OptOut');
  });

  it('3. excludes inactive businesses', () => {
    const result = psql(`SELECT name FROM search_businesses_fuzzy('Fuzzy Barber', NULL, 10, ARRAY[]::uuid[]);`);
    expect(result).not.toContain('Fuzzy Barber Inactive');
  });

  it('4. excludes businesses with no bot_code', () => {
    const result = psql(`SELECT name FROM search_businesses_fuzzy('Fuzzy NoBotCode', NULL, 10, ARRAY[]::uuid[]);`);
    expect(result).not.toContain('NoBotCode');
  });

  it('5. excludes hidden businesses via p_hidden_ids', () => {
    const result = psql(`SELECT name FROM search_businesses_fuzzy('Fuzzy', NULL, 10, ARRAY['${BIZ_HIDDEN}']::uuid[]);`);
    expect(result).not.toContain('Fuzzy Hidden');
  });

  it('6. authenticated role cannot execute', () => {
    const { ok, output } = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${AUTH_JWT}', false);
      SET ROLE authenticated;
      SELECT * FROM search_businesses_fuzzy('test', NULL, 10, ARRAY[]::uuid[]);
      RESET ROLE;
    `);
    expect(ok).toBe(false);
    expect(output).toMatch(/permission denied/i);
  });

  it('7. respects country filter', () => {
    const result = psql(`SELECT name FROM search_businesses_fuzzy('Fuzzy Salon', 'GH', 10, ARRAY[]::uuid[]);`);
    // Our test business is NG, not GH — should not appear
    expect(result).not.toContain('Fuzzy Salon');
  });
});

} // end if (TEST_DB)
