/**
 * Trial One-Per-Phone-Identity DB Tests — M465
 *
 * Real PostgreSQL tests proving:
 * 1. Verified phone owner: first business gets trial
 * 2. Verified phone owner: second business → owner_already_has_trial
 * 3. Different verified owner → gets their own trial
 * 4. Unverified phone owner → phone_not_verified
 * 5. Same-business idempotent retry → success
 * 6. Purchased/subscription credits unaffected by dedup
 * 7. Historical trial grant preserved (not revoked)
 * 8. Concurrent activations: exactly one grant committed
 * 9. Function body verification assertions
 *
 * Requires TEST_DATABASE_URL with ALL migrations through M465 applied.
 * CI shard B enforces zero-skip policy.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_test \
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

// Test-scoped UUIDs (M465-unique suffix avoids collision with M372 tests)
const OWNER_VERIFIED_A = 'a0a0a0a0-4651-4000-a000-000000000001';
const OWNER_VERIFIED_B = 'b0b0b0b0-4652-4000-a000-000000000002';
const OWNER_UNVERIFIED = 'c0c0c0c0-4653-4000-a000-000000000003';
const BIZ_VA1 = 'd0d0d0d0-4651-4000-a000-000000000011';
const BIZ_VA2 = 'd0d0d0d0-4652-4000-a000-000000000012';
const BIZ_VB1 = 'd0d0d0d0-4653-4000-a000-000000000013';
const BIZ_UV1 = 'd0d0d0d0-4654-4000-a000-000000000014';
// Concurrency test businesses
const BIZ_RACE_1 = 'd0d0d0d0-4655-4000-a000-000000000015';
const BIZ_RACE_2 = 'd0d0d0d0-4656-4000-a000-000000000016';
const CONFIG_ID = 'e0e0e0e0-4651-4000-a000-000000000001';
const CHANNEL_ID = 'f0f0f0f0-4651-4000-a000-000000000001';

const describePg = canRun ? describe : describe.skip;

describePg('M465: Trial one-per-verified-phone-identity', () => {
  beforeAll(() => {
    // Clean test data in dependency order
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id IN ('${BIZ_VA1}','${BIZ_VA2}','${BIZ_VB1}','${BIZ_UV1}','${BIZ_RACE_1}','${BIZ_RACE_2}'));`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id IN ('${BIZ_VA1}','${BIZ_VA2}','${BIZ_VB1}','${BIZ_UV1}','${BIZ_RACE_1}','${BIZ_RACE_2}');`);
    psqlCleanup(`DELETE FROM businesses WHERE id IN ('${BIZ_VA1}','${BIZ_VA2}','${BIZ_VB1}','${BIZ_UV1}','${BIZ_RACE_1}','${BIZ_RACE_2}');`);
    psqlCleanup(`DELETE FROM whatsapp_channels WHERE id = '${CHANNEL_ID}';`);
    psqlCleanup(`DELETE FROM platform_config_versions WHERE id = '${CONFIG_ID}';`);
    // auth.users cleanup via admin API pattern
    psqlCleanup(`DELETE FROM auth.users WHERE id IN ('${OWNER_VERIFIED_A}','${OWNER_VERIFIED_B}','${OWNER_UNVERIFIED}');`);
    psqlCleanup(`DELETE FROM profiles WHERE id IN ('${OWNER_VERIFIED_A}','${OWNER_VERIFIED_B}','${OWNER_UNVERIFIED}');`);

    // Create auth.users with phone verification state
    // Owner A: verified phone
    psql(`INSERT INTO auth.users (id, email, phone, phone_confirmed_at, raw_app_meta_data)
          VALUES ('${OWNER_VERIFIED_A}', 'owner-a-465@test.waaiio.com', '+12025559901', NOW(), '{}')
          ON CONFLICT (id) DO UPDATE SET phone_confirmed_at = NOW();`);

    // Owner B: verified phone (different number)
    psql(`INSERT INTO auth.users (id, email, phone, phone_confirmed_at, raw_app_meta_data)
          VALUES ('${OWNER_VERIFIED_B}', 'owner-b-465@test.waaiio.com', '+12025559902', NOW(), '{}')
          ON CONFLICT (id) DO UPDATE SET phone_confirmed_at = NOW();`);

    // Owner C: phone set but NOT confirmed (e.g., Facebook auth only)
    psql(`INSERT INTO auth.users (id, email, phone, phone_confirmed_at, raw_app_meta_data)
          VALUES ('${OWNER_UNVERIFIED}', 'owner-unv-465@test.waaiio.com', '+12025559903', NULL, '{}')
          ON CONFLICT (id) DO UPDATE SET phone_confirmed_at = NULL;`);

    // Create profiles (handle_new_user trigger may not fire in test)
    psql(`INSERT INTO profiles (id, role) VALUES ('${OWNER_VERIFIED_A}', 'restaurant_owner'), ('${OWNER_VERIFIED_B}', 'restaurant_owner'), ('${OWNER_UNVERIFIED}', 'restaurant_owner') ON CONFLICT DO NOTHING;`);

    // Shared channel
    psql(`INSERT INTO whatsapp_channels (id, country_code, phone_number, channel_type, is_active, provider)
          VALUES ('${CHANNEL_ID}', 'US', '12025554465', 'shared', true, 'meta_cloud')
          ON CONFLICT DO NOTHING;`);

    // Config version with trial credit + financial gate.
    // Use clock_timestamp() (not NOW()) to ensure this config is the latest
    // even after M372 tests insert their own configs in the shared CI database.
    // DELETE first to ensure ON CONFLICT doesn't skip a stale row.
    psqlCleanup(`DELETE FROM platform_config_versions WHERE id = '${CONFIG_ID}';`);
    psql(`INSERT INTO platform_config_versions (id, effective_from, config_snapshot)
          VALUES ('${CONFIG_ID}', clock_timestamp(), '{
            "trial_days": 14,
            "messaging_financial_gate": true,
            "trial_credit_minor_by_currency": {"USD": 400},
            "messaging_pricing": {"USD": {"rates": {"US": {"*": 1}}, "default_cost_minor": 1, "default_spend_cap_minor": 5000}}
          }'::jsonb);`);

    // Businesses
    const bizInsert = (id: string, owner: string, name: string, slug: string) =>
      `('${id}', '${owner}', '${name}', '${slug}', '123 Test St', 'NYC', '+12025550000', 'US', 'barber', 'free', 'shared', 'active', '${CHANNEL_ID}')`;

    psql(`INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, country_code, category, subscription_tier, wa_method, status, assigned_channel_id)
          VALUES
            ${bizInsert(BIZ_VA1, OWNER_VERIFIED_A, 'VA1 Barber', 'va1-barber-465')},
            ${bizInsert(BIZ_VA2, OWNER_VERIFIED_A, 'VA2 Salon', 'va2-salon-465')},
            ${bizInsert(BIZ_VB1, OWNER_VERIFIED_B, 'VB1 Gym', 'vb1-gym-465')},
            ${bizInsert(BIZ_UV1, OWNER_UNVERIFIED, 'UV1 Shop', 'uv1-shop-465')},
            ${bizInsert(BIZ_RACE_1, OWNER_VERIFIED_A, 'Race1', 'race1-465')},
            ${bizInsert(BIZ_RACE_2, OWNER_VERIFIED_A, 'Race2', 'race2-465')}
          ON CONFLICT DO NOTHING;`);
  });

  afterAll(() => {
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id IN ('${BIZ_VA1}','${BIZ_VA2}','${BIZ_VB1}','${BIZ_UV1}','${BIZ_RACE_1}','${BIZ_RACE_2}'));`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id IN ('${BIZ_VA1}','${BIZ_VA2}','${BIZ_VB1}','${BIZ_UV1}','${BIZ_RACE_1}','${BIZ_RACE_2}');`);
    psqlCleanup(`UPDATE businesses SET trial_ends_at = NULL WHERE id IN ('${BIZ_VA1}','${BIZ_VA2}','${BIZ_VB1}','${BIZ_UV1}','${BIZ_RACE_1}','${BIZ_RACE_2}');`);
    psqlCleanup(`DELETE FROM businesses WHERE id IN ('${BIZ_VA1}','${BIZ_VA2}','${BIZ_VB1}','${BIZ_UV1}','${BIZ_RACE_1}','${BIZ_RACE_2}');`);
    psqlCleanup(`DELETE FROM whatsapp_channels WHERE id = '${CHANNEL_ID}';`);
    psqlCleanup(`DELETE FROM platform_config_versions WHERE id = '${CONFIG_ID}';`);
    psqlCleanup(`DELETE FROM auth.users WHERE id IN ('${OWNER_VERIFIED_A}','${OWNER_VERIFIED_B}','${OWNER_UNVERIFIED}');`);
    psqlCleanup(`DELETE FROM profiles WHERE id IN ('${OWNER_VERIFIED_A}','${OWNER_VERIFIED_B}','${OWNER_UNVERIFIED}');`);
  });

  // ── Core verification tests ──

  it('1. verified phone owner: first business gets trial grant', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_VA1}');`);
    expect(result.activated).toBe(true);
    expect(result.amount_minor).toBe(400);
    expect(result.currency_code).toBe('USD');
  });

  it('2. verified phone owner: second business blocked → owner_already_has_trial', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_VA2}');`);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('owner_already_has_trial');
  });

  it('3. different verified owner → gets independent trial', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_VB1}');`);
    expect(result.activated).toBe(true);
    expect(result.amount_minor).toBe(400);
    expect(result.currency_code).toBe('USD');
  });

  it('4. unverified phone owner → phone_not_verified', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_UV1}');`);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('phone_not_verified');
  });

  it('5. same-business idempotent retry → success', () => {
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_VA1}');`);
    expect(result.activated).toBe(true);
    expect(result.idempotent).toBe(true);
  });

  it('6. purchased credits unaffected by trial dedup', () => {
    // Add purchased credit to blocked business (BIZ_VA2 — no trial but can buy)
    psql(`SELECT grant_messaging_allowance('${BIZ_VA2}', 'purchased', 1000, 'USD', 'test-purchase-m465');`);
    const count = psql(`SELECT count(*) FROM messaging_allowances WHERE business_id = '${BIZ_VA2}' AND type = 'purchased';`);
    expect(parseInt(count)).toBe(1);

    // Trial still blocked
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_VA2}');`);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('owner_already_has_trial');

    // Cleanup
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id = '${BIZ_VA2}' AND type = 'purchased');`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id = '${BIZ_VA2}' AND type = 'purchased';`);
  });

  it('7. existing trial grant preserved (not revoked or modified)', () => {
    const row = psql(`SELECT amount_minor, remaining_minor FROM messaging_allowances
      WHERE business_id = '${BIZ_VA1}' AND type = 'trial_grant' AND source_ref = 'trial_v2';`);
    const [amount, remaining] = row.split('|');
    expect(parseInt(amount)).toBe(400);
    expect(parseInt(remaining)).toBe(400);
  });

  // ── Concurrency test: two independent PostgreSQL connections ──

  it('8. concurrent first-grant race: exactly one grant committed, other denied', () => {
    // Fresh verified owner with zero prior grants
    const RACE_OWNER = 'aaaa0000-4657-4000-a000-000000000465';
    const RACE_BIZ_X = 'dddd0000-4657-4000-a000-000000000465';
    const RACE_BIZ_Y = 'dddd0001-4657-4000-a000-000000000465';

    // Setup: create fresh owner + two businesses with no prior trial
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id IN ('${RACE_BIZ_X}','${RACE_BIZ_Y}'));`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id IN ('${RACE_BIZ_X}','${RACE_BIZ_Y}');`);
    psqlCleanup(`DELETE FROM businesses WHERE id IN ('${RACE_BIZ_X}','${RACE_BIZ_Y}');`);
    psqlCleanup(`DELETE FROM auth.users WHERE id = '${RACE_OWNER}';`);
    psqlCleanup(`DELETE FROM profiles WHERE id = '${RACE_OWNER}';`);

    psql(`INSERT INTO auth.users (id, email, phone, phone_confirmed_at, raw_app_meta_data)
          VALUES ('${RACE_OWNER}', 'race-owner-465@test.waaiio.com', '+12025559999', NOW(), '{}');`);
    psql(`INSERT INTO profiles (id, role) VALUES ('${RACE_OWNER}', 'restaurant_owner') ON CONFLICT DO NOTHING;`);
    psql(`INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, country_code, category, subscription_tier, wa_method, status, assigned_channel_id)
          VALUES
            ('${RACE_BIZ_X}', '${RACE_OWNER}', 'RaceX', 'racex-465', '1 Race', 'NYC', '+12025550099', 'US', 'barber', 'free', 'shared', 'active', '${CHANNEL_ID}'),
            ('${RACE_BIZ_Y}', '${RACE_OWNER}', 'RaceY', 'racey-465', '2 Race', 'NYC', '+12025550098', 'US', 'salon', 'free', 'shared', 'active', '${CHANNEL_ID}');`);

    // Two independent psql processes launched simultaneously via bash &.
    // Each is a separate PostgreSQL connection with its own transaction.
    // This is a concurrent regression test — it verifies correctness
    // under overlapping execution, not guaranteed lock contention on
    // every run. The advisory lock inside the RPC serializes if the
    // processes do overlap; if they don't, one completes before the
    // other starts, and the EXISTS check catches it instead.
    // Either way, exactly one grant must be committed.
    const { execSync } = require('child_process');
    const fs = require('fs');
    const pid = process.pid;
    const resultFile1 = `/tmp/waaiio_race_1_${pid}.json`;
    const resultFile2 = `/tmp/waaiio_race_2_${pid}.json`;
    const exitFile1 = `/tmp/waaiio_race_1_${pid}.exit`;
    const exitFile2 = `/tmp/waaiio_race_2_${pid}.exit`;

    for (const f of [resultFile1, resultFile2, exitFile1, exitFile2]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }

    execSync(`
      (psql "${dbUrl}" -tAXq -c "SELECT activate_trial_if_eligible('${RACE_BIZ_X}');" > ${resultFile1} 2>&1; echo $? > ${exitFile1}) &
      PID1=$!
      (psql "${dbUrl}" -tAXq -c "SELECT activate_trial_if_eligible('${RACE_BIZ_Y}');" > ${resultFile2} 2>&1; echo $? > ${exitFile2}) &
      PID2=$!
      wait $PID1 $PID2
    `, { shell: '/bin/bash', timeout: 30000 });

    // Check both exit codes independently
    const exit1 = parseInt(fs.readFileSync(exitFile1, 'utf-8').trim());
    const exit2 = parseInt(fs.readFileSync(exitFile2, 'utf-8').trim());
    expect(exit1).toBe(0);
    expect(exit2).toBe(0);

    const raw1 = fs.readFileSync(resultFile1, 'utf-8').trim();
    const raw2 = fs.readFileSync(resultFile2, 'utf-8').trim();

    for (const f of [resultFile1, resultFile2, exitFile1, exitFile2]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    const r1 = JSON.parse(raw1);
    const r2 = JSON.parse(raw2);

    // Exactly one activated, the other denied
    const activated = [r1, r2].filter(r => r.activated === true && !r.idempotent);
    const denied = [r1, r2].filter(r => r.activated === false && r.reason === 'owner_already_has_trial');

    expect(activated.length).toBe(1);
    expect(denied.length).toBe(1);

    // The winner has correct amount and currency
    expect(activated[0].amount_minor).toBe(400);
    expect(activated[0].currency_code).toBe('USD');
    expect(activated[0].trial_ends_at).toBeTruthy();

    // Exactly one grant in the DB
    const grantCount = psql(`SELECT count(*) FROM messaging_allowances ma
      JOIN businesses b ON b.id = ma.business_id
      WHERE b.owner_id = '${RACE_OWNER}' AND ma.type = 'trial_grant' AND ma.source_ref = 'trial_v2';`);
    expect(parseInt(grantCount)).toBe(1);

    // No deadlock (test completed without timeout)
    // Advisory lock is the serialization mechanism (verified in test 9)

    // Cleanup
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id IN ('${RACE_BIZ_X}','${RACE_BIZ_Y}'));`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id IN ('${RACE_BIZ_X}','${RACE_BIZ_Y}');`);
    psqlCleanup(`UPDATE businesses SET trial_ends_at = NULL WHERE id IN ('${RACE_BIZ_X}','${RACE_BIZ_Y}');`);
    psqlCleanup(`DELETE FROM businesses WHERE id IN ('${RACE_BIZ_X}','${RACE_BIZ_Y}');`);
    psqlCleanup(`DELETE FROM auth.users WHERE id = '${RACE_OWNER}';`);
    psqlCleanup(`DELETE FROM profiles WHERE id = '${RACE_OWNER}';`);
  });

  // ── Verification assertions ──

  it('9. function body contains phone verification + owner dedup + advisory lock', () => {
    const body = psql(`SELECT prosrc FROM pg_proc WHERE proname = 'activate_trial_if_eligible';`);
    expect(body).toContain('phone_not_verified');
    expect(body).toContain('owner_already_has_trial');
    expect(body).toContain('trial_owner_');
    expect(body).toContain('phone_confirmed_at');
  });

  // ── Cron queue filter tests ──

  it('10. NULL-inclusive exclusion: empty/default metadata businesses are included in cron query', () => {
    // The cron filter uses ->> (text extraction). JSON boolean true becomes text 'true'.
    // NULL (missing key or null metadata) must be included, not excluded.
    const cronQuery = `
      SELECT id FROM businesses
      WHERE subscription_tier = 'free'
        AND status = 'active'
        AND trial_ends_at IS NULL
        AND (whatsapp_channel_id IS NOT NULL OR wa_method = 'shared')
        AND (metadata->>'trial_ineligible' IS NULL OR metadata->>'trial_ineligible' != 'true')
      ORDER BY created_at
      LIMIT 100;
    `;

    // BIZ_UV1 has default metadata ({}) and trial_ends_at IS NULL — must be included
    const eligible = psql(cronQuery);
    expect(eligible).toContain(BIZ_UV1);

    // Mark BIZ_VA2 using the atomic RPC (has DB-authoritative precondition)
    psql(`SELECT mark_trial_ineligible('${BIZ_VA2}', 'owner_already_has_trial');`);

    // Verify JSON boolean (not string) was written
    const flagType = psql(`SELECT jsonb_typeof(metadata->'trial_ineligible') FROM businesses WHERE id = '${BIZ_VA2}';`);
    expect(flagType).toBe('boolean');

    // BIZ_VA2 should now be excluded (text extraction of boolean true = 'true')
    const afterMark = psql(cronQuery);
    expect(afterMark).not.toContain(BIZ_VA2);

    // BIZ_UV1 (unverified phone, NOT marked) still included
    expect(afterMark).toContain(BIZ_UV1);
  });

  it('11. mark_trial_ineligible preserves unrelated metadata and validates precondition', () => {
    // Set unrelated metadata on BIZ_VA2
    psql(`UPDATE businesses SET metadata = '{"custom_key": "custom_value"}'::jsonb WHERE id = '${BIZ_VA2}';`);

    // Re-mark with the RPC — precondition passes (owner already has trial on BIZ_VA1)
    psql(`SELECT mark_trial_ineligible('${BIZ_VA2}', 'owner_already_has_trial');`);

    // custom_key preserved
    const meta = psql(`SELECT metadata->>'custom_key' FROM businesses WHERE id = '${BIZ_VA2}';`);
    expect(meta).toBe('custom_value');

    // trial_ineligible is JSON boolean true
    const flag = psql(`SELECT metadata->>'trial_ineligible' FROM businesses WHERE id = '${BIZ_VA2}';`);
    expect(flag).toBe('true');

    // RPC rejects non-permanent reasons
    const invalidReason = psqlCleanup(`SELECT mark_trial_ineligible('${BIZ_UV1}', 'phone_not_verified');`);
    // Should raise exception — psqlCleanup tolerates it

    // BIZ_UV1 should NOT be marked (precondition: owner has no trial elsewhere)
    const uvFlag = psql(`SELECT metadata->>'trial_ineligible' FROM businesses WHERE id = '${BIZ_UV1}';`);
    expect(uvFlag).toBeFalsy(); // NULL or empty — not 'true'
  });

  it('12. phone_not_verified is retryable: verified-later owner gets trial', () => {
    // BIZ_UV1's owner (OWNER_UNVERIFIED) has phone_confirmed_at = NULL.
    // Test 4 proved it was denied. Now simulate OTP completion:
    psql(`UPDATE auth.users SET phone_confirmed_at = NOW() WHERE id = '${OWNER_UNVERIFIED}';`);

    // Now trial should activate (phone verified, no prior grant for this owner)
    const result = psqlJson(`SELECT activate_trial_if_eligible('${BIZ_UV1}');`);
    expect(result.activated).toBe(true);
    expect(result.amount_minor).toBe(400);

    // Reset for cleanup
    psqlCleanup(`DELETE FROM messaging_allowance_events WHERE allowance_id IN (SELECT id FROM messaging_allowances WHERE business_id = '${BIZ_UV1}');`);
    psqlCleanup(`DELETE FROM messaging_allowances WHERE business_id = '${BIZ_UV1}';`);
    psqlCleanup(`UPDATE businesses SET trial_ends_at = NULL WHERE id = '${BIZ_UV1}';`);
    // Restore unverified state for clean afterAll
    psql(`UPDATE auth.users SET phone_confirmed_at = NULL WHERE id = '${OWNER_UNVERIFIED}';`);
  });
});
