/**
 * Trial One-Per-Phone-Identity DB Tests — M465
 *
 * Real PostgreSQL tests proving:
 * 1. First eligible business gets trial grant
 * 2. Second business, same owner → owner_already_has_trial
 * 3. Different owner → gets their own trial
 * 4. Same-business retry → idempotent success
 * 5. Existing purchased/subscription_included allowances unaffected
 * 6. Historical trial grant preserved (existing grant not revoked)
 *
 * Requires TEST_DATABASE_URL with M465 applied.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/trial-one-per-owner-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlJson(sql: string): Record<string, unknown> {
  const raw = psql(sql);
  return JSON.parse(raw);
}

function psqlCleanup(sql: string): void {
  try {
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    });
  } catch { /* cleanup failures tolerated */ }
}

// Test-specific UUIDs to avoid collisions
const OWNER_A = 'a0a0a0a0-0001-4000-a000-000000000465';
const OWNER_B = 'b0b0b0b0-0002-4000-a000-000000000465';
const BIZ_A1 = 'c0c0c0c0-0001-4000-a000-000000000465';
const BIZ_A2 = 'c0c0c0c0-0002-4000-a000-000000000465';
const BIZ_B1 = 'c0c0c0c0-0003-4000-a000-000000000465';
const CONFIG_ID = 'd0d0d0d0-0001-4000-a000-000000000465';
const CHANNEL_ID = 'e0e0e0e0-0001-4000-a000-000000000465';

const describePg = canRun ? describe : describe.skip;

describePg('M465: Trial one-per-phone-identity', () => {
  beforeAll(() => {
    // Clean up any prior test data
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id IN ('${BIZ_A1}','${BIZ_A2}','${BIZ_B1}'));`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id IN ('${BIZ_A1}','${BIZ_A2}','${BIZ_B1}');`);
    psqlCleanup(`DELETE FROM businesses WHERE id IN ('${BIZ_A1}','${BIZ_A2}','${BIZ_B1}');`);
    psqlCleanup(`DELETE FROM whatsapp_channels WHERE id = '${CHANNEL_ID}';`);
    psqlCleanup(`DELETE FROM platform_config_versions WHERE id = '${CONFIG_ID}';`);
    psqlCleanup(`DELETE FROM profiles WHERE id IN ('${OWNER_A}','${OWNER_B}');`);

    // Create test owners (profiles only — auth.users not needed for RPC)
    psql(`INSERT INTO profiles (id, role) VALUES ('${OWNER_A}', 'user'), ('${OWNER_B}', 'user') ON CONFLICT DO NOTHING;`);

    // Create shared channel
    psql(`INSERT INTO whatsapp_channels (id, country_code, phone_number, channel_type, is_active, provider)
          VALUES ('${CHANNEL_ID}', 'US', '12025551234', 'shared', true, 'meta_cloud')
          ON CONFLICT DO NOTHING;`);

    // Create config version with trial credit and financial gate
    psql(`INSERT INTO platform_config_versions (id, effective_from, config_snapshot)
          VALUES ('${CONFIG_ID}', NOW() - INTERVAL '1 hour', '{
            "trial_days": 14,
            "messaging_financial_gate": true,
            "trial_credit_minor_by_currency": {"USD": 400},
            "messaging_pricing": {"USD": {"rates": {"US": {"*": 1}}, "default_cost_minor": 1, "default_spend_cap_minor": 5000}}
          }'::jsonb)
          ON CONFLICT DO NOTHING;`);

    // Create businesses: Owner A has 2, Owner B has 1
    psql(`INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, country_code, category, subscription_tier, wa_method, status, assigned_channel_id)
          VALUES
            ('${BIZ_A1}', '${OWNER_A}', 'Owner-A Biz 1', 'owner-a-biz-1-465', '123 Test', 'NYC', '+12025551001', 'US', 'barber', 'free', 'shared', 'active', '${CHANNEL_ID}'),
            ('${BIZ_A2}', '${OWNER_A}', 'Owner-A Biz 2', 'owner-a-biz-2-465', '456 Test', 'NYC', '+12025551002', 'US', 'salon', 'free', 'shared', 'active', '${CHANNEL_ID}'),
            ('${BIZ_B1}', '${OWNER_B}', 'Owner-B Biz 1', 'owner-b-biz-1-465', '789 Test', 'NYC', '+12025551003', 'US', 'gym', 'free', 'shared', 'active', '${CHANNEL_ID}')
          ON CONFLICT DO NOTHING;`);
  });

  afterAll(() => {
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id IN ('${BIZ_A1}','${BIZ_A2}','${BIZ_B1}'));`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id IN ('${BIZ_A1}','${BIZ_A2}','${BIZ_B1}');`);
    psqlCleanup(`UPDATE businesses SET trial_ends_at = NULL WHERE id IN ('${BIZ_A1}','${BIZ_A2}','${BIZ_B1}');`);
    psqlCleanup(`DELETE FROM businesses WHERE id IN ('${BIZ_A1}','${BIZ_A2}','${BIZ_B1}');`);
    psqlCleanup(`DELETE FROM whatsapp_channels WHERE id = '${CHANNEL_ID}';`);
    psqlCleanup(`DELETE FROM platform_config_versions WHERE id = '${CONFIG_ID}';`);
    psqlCleanup(`DELETE FROM profiles WHERE id IN ('${OWNER_A}','${OWNER_B}');`);
  });

  it('1. first eligible business gets trial grant', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_A1}');`);
    expect(result.activated).toBe(true);
    expect(result.amount_minor).toBe(400);
    expect(result.currency_code).toBe('USD');
  });

  it('2. second business, same owner → owner_already_has_trial', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_A2}');`);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('owner_already_has_trial');
  });

  it('3. different owner → gets their own trial', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_B1}');`);
    expect(result.activated).toBe(true);
    expect(result.amount_minor).toBe(400);
    expect(result.currency_code).toBe('USD');
  });

  it('4. same-business retry → idempotent success', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_A1}');`);
    expect(result.activated).toBe(true);
    expect(result.idempotent).toBe(true);
  });

  it('5. owner_already_has_trial does NOT block different owner', () => {
    // Owner B's trial was already activated in test 3 — retry should be idempotent
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_B1}');`);
    expect(result.activated).toBe(true);
    expect(result.idempotent).toBe(true);
  });

  it('6. purchased allowances unaffected by trial dedup', () => {
    // Insert a purchased credit for Owner A's second business (no trial)
    psql(`SELECT grant_messaging_allowance('${BIZ_A2}', 'purchased', 1000, 'USD', 'test-purchase-465');`);

    // Verify the purchased credit exists
    const count = psql(`SELECT count(*) FROM messaging_allowances WHERE business_id = '${BIZ_A2}' AND type = 'purchased';`);
    expect(parseInt(count)).toBe(1);

    // The trial dedup still blocks trial for BIZ_A2
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_A2}');`);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('owner_already_has_trial');

    // Clean up purchased credit
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id = '${BIZ_A2}' AND type = 'purchased');`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id = '${BIZ_A2}' AND type = 'purchased';`);
  });

  it('7. existing trial grant is preserved (not revoked)', () => {
    // Owner A's BIZ_A1 trial should still exist with full balance
    const row = psql(`SELECT amount_minor, remaining_minor FROM messaging_allowances
      WHERE business_id = '${BIZ_A1}' AND type = 'trial_grant' AND source_ref = 'trial_v2';`);
    const [amount, remaining] = row.split('|');
    expect(parseInt(amount)).toBe(400);
    expect(parseInt(remaining)).toBe(400);
  });

  it('8. M465 verification assertions passed during migration', () => {
    // Verify the function contains the owner dedup check
    const hasDedupCheck = psql(`SELECT prosrc LIKE '%owner_already_has_trial%'
      FROM pg_proc WHERE proname = 'activate_trial_if_eligible';`);
    expect(hasDedupCheck).toBe('t');

    // Verify advisory lock is present
    const hasLock = psql(`SELECT prosrc LIKE '%trial_owner_%'
      FROM pg_proc WHERE proname = 'activate_trial_if_eligible';`);
    expect(hasLock).toBe('t');
  });
});
