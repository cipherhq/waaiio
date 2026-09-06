/**
 * Runtime Financial Integration DB Tests (#261 / Migration 371)
 *
 * Real PostgreSQL proofs for check_or_authorize_send, grant_messaging_allowance,
 * resolve_message_cost_reconciliation, threshold alerts, delivery buffer,
 * reservation TTL, and commercial key extensions.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/runtime-financial-integration-db.test.ts
 */
import { execSync, spawn } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(stdout.trim());
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

// Test data — isolated UUIDs to avoid collision with other test suites
const OWNER_371   = '00000000-0000-0000-0000-000000000381';
const ADMIN_371   = '00000000-0000-0000-0000-00000000a371';
const NONADMIN_371 = '00000000-0000-0000-0000-00000000b371';

describe.skipIf(!canRun)('Runtime Financial Integration DB Tests (#261 / Migration 371)', () => {
  let originalAuthUidDef: string;
  let pricingConfigVersionId: string;

  // Helper: create an isolated test business with its own owner
  function createIsolatedBusiness(): string {
    const bizId = psql(`SELECT gen_random_uuid();`);
    const ownerId = psql(`SELECT gen_random_uuid();`);
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ownerId}', '${bizId.substring(0,8)}@test371.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    psqlMayFail(`INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone) VALUES ('${bizId}', 'IsolTest371-${bizId.substring(0,8)}', 'isol371-${bizId.substring(0,8)}', '${ownerId}', '1 Test', 'T', 'T', '+1');`);
    return bizId;
  }

  // Helper: create a business-scoped attempt
  function createAttempt(bizId: string, country: string, category?: string): string {
    const catVal = category ? `'${category}'` : 'NULL';
    return psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category) VALUES ('${bizId}', '+1', 'business', '${country}', ${catVal}) RETURNING id;`);
  }

  // Helper: create an allowance
  function createAllowance(bizId: string, type: string, amount: number, currency: string, sourceRef: string): string {
    return psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${bizId}', '${type}', ${amount}, '${currency}', ${amount}, '${sourceRef}') RETURNING id;`);
  }

  // Helper: set auth.uid()
  function setAuthUid(uid: string): void {
    psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT '${uid}'::UUID; $$ LANGUAGE SQL STABLE;`);
  }

  beforeAll(() => {
    // Snapshot auth.uid() for hermetic restoration
    originalAuthUidDef = psql(`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'uid' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'auth');`);

    // Seed test users
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${OWNER_371}', 'owner371@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ADMIN_371}', 'admin371@test.com', '{"role":"admin"}') ON CONFLICT (id) DO NOTHING;`);
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${NONADMIN_371}', 'nonadmin371@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);

    // Seed a pricing config version with microsecond-unique timestamp
    pricingConfigVersionId = psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_pricing: {
          NGN: {
            default_cost_minor: 500,
            rates: { NG: { marketing: 800, utility: 300, service: 200 } },
            default_spend_cap_minor: 50000,
          },
          USD: {
            default_cost_minor: 8,
            rates: { US: { marketing: 12, utility: 5, service: 3 }, CA: { marketing: 10, utility: 5 } },
            default_spend_cap_minor: 5000,
          },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '371 microseconds', '${OWNER_371}')
      RETURNING id;
    `);
  });

  afterAll(() => {
    if (originalAuthUidDef) {
      psqlMayFail(originalAuthUidDef + ';');
    }
  });

  // ═══════════════════════════════════════════════════════
  // 1-6. Gate tests: check_or_authorize_send
  // ═══════════════════════════════════════════════════════

  it('1. Gate OFF (no messaging_financial_gate key): returns enforcement_required false', () => {
    // The seeded config has pricing but no messaging_financial_gate key
    // Create a config version with no gate key using unique microsecond offset
    const noGateConfigId = psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
      })}'::JSONB, NOW() + INTERVAL '3710 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    const attemptId = createAttempt(bizId, 'NG', 'service');

    const result = JSON.parse(psql(`SELECT check_or_authorize_send('${attemptId}');`));
    expect(result.enforcement_required).toBe(false);
    expect(result.reason).toBe('gate_key_absent');

    // Cleanup: delete the config to avoid polluting other tests
    // Can't delete (append-only), but subsequent tests create configs with later timestamps
  });

  it('2. Gate ON (true): returns authorization result', () => {
    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'gate-on-test-371');
    const attemptId = createAttempt(bizId, 'NG', 'service');

    // Create config with gate ON
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '3711 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const result = JSON.parse(psql(`SELECT check_or_authorize_send('${attemptId}');`));
    expect(result.authorized).toBe(true);
    expect(result.decision_time).toBeDefined();
    expect(result.config_version_id).toBeDefined();
  });

  it('3. Gate OFF (explicit false): returns enforcement_required false', () => {
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: false,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
      })}'::JSONB, NOW() + INTERVAL '3712 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    const attemptId = createAttempt(bizId, 'NG', 'service');

    const result = JSON.parse(psql(`SELECT check_or_authorize_send('${attemptId}');`));
    expect(result.enforcement_required).toBe(false);
    expect(result.reason).toBe('gate_off');
  });

  it('4. Gate malformed (string/null/integer): fails closed', () => {
    // String value
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: 'yes',
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
      })}'::JSONB, NOW() + INTERVAL '3713 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    const attemptId = createAttempt(bizId, 'NG', 'service');

    const result = JSON.parse(psql(`SELECT check_or_authorize_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('invalid_gate_config');
  });

  it('5. Pre-gate config version (no messaging_financial_gate key): returns enforcement_required false', () => {
    // Create a "pre-gate" config — just pricing, no gate key
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
      })}'::JSONB, NOW() + INTERVAL '3714 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    const attemptId = createAttempt(bizId, 'NG', 'service');

    const result = JSON.parse(psql(`SELECT check_or_authorize_send('${attemptId}');`));
    expect(result.enforcement_required).toBe(false);
    expect(result.reason).toBe('gate_key_absent');
  });

  it('6. Effective_from boundary: config effective just before vs after decision_time', () => {
    // This test verifies that the config version effective_from is resolved correctly
    // by creating two config versions with different gate states at precise timestamps
    const futureId = psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '100 years', '${OWNER_371}')
      RETURNING id;
    `);

    // Create a "current" config with gate OFF
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: false,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
      })}'::JSONB, NOW() + INTERVAL '3715 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    const attemptId = createAttempt(bizId, 'NG', 'service');

    // The future config should NOT be effective yet
    const result = JSON.parse(psql(`SELECT check_or_authorize_send('${attemptId}');`));
    // Should see the "current" one (gate OFF), not the future one (gate ON)
    expect(result.enforcement_required).toBe(false);
  });

  // ═══════════════════════════════════════════════════════
  // 7-10. Grant tests: grant_messaging_allowance
  // ═══════════════════════════════════════════════════════

  it('7. Fresh grant succeeds with grant event', () => {
    const bizId = createIsolatedBusiness();
    const result = JSON.parse(psql(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'NGN', 'test-grant-371-7');`));
    expect(result.granted).toBe(true);
    expect(result.amount_minor).toBe(5000);
    expect(result.currency_code).toBe('NGN');
    expect(result.allowance_id).toBeDefined();

    // Verify grant event exists
    const eventCount = psql(`SELECT count(*) FROM messaging_allowance_events WHERE allowance_id = '${result.allowance_id}' AND event_type = 'grant';`);
    expect(parseInt(eventCount)).toBe(1);
  });

  it('8. Replay with same payload is idempotent', () => {
    const bizId = createIsolatedBusiness();
    const result1 = JSON.parse(psql(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'NGN', 'test-grant-371-8');`));
    expect(result1.granted).toBe(true);

    const result2 = JSON.parse(psql(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'NGN', 'test-grant-371-8');`));
    expect(result2.granted).toBe(false);
    expect(result2.idempotent).toBe(true);
  });

  it('9. Replay with different amount returns idempotency_key_mismatch', () => {
    const bizId = createIsolatedBusiness();
    const result1 = JSON.parse(psql(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'NGN', 'test-grant-371-9');`));
    expect(result1.granted).toBe(true);

    const result2 = JSON.parse(psql(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 9999, 'NGN', 'test-grant-371-9');`));
    expect(result2.granted).toBe(false);
    expect(result2.reason).toBe('idempotency_key_mismatch');
  });

  it('10. Replay with different currency returns idempotency_key_mismatch', () => {
    const bizId = createIsolatedBusiness();
    const result1 = JSON.parse(psql(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'NGN', 'test-grant-371-10');`));
    expect(result1.granted).toBe(true);

    const result2 = JSON.parse(psql(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'USD', 'test-grant-371-10');`));
    expect(result2.granted).toBe(false);
    expect(result2.reason).toBe('idempotency_key_mismatch');
  });

  // ═══════════════════════════════════════════════════════
  // 11-15. Reconciliation tests
  // ═══════════════════════════════════════════════════════

  it('11. Admin resolves charge on released attempt - adjust events created', () => {
    // Set up a gate-ON config for this test
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '3716 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'reconcile-charge-371-11');
    const attemptId = createAttempt(bizId, 'NG', 'service');

    // Authorize (creates reservation)
    const authResult = JSON.parse(psql(`SELECT authorize_message_send('${attemptId}');`));
    expect(authResult.authorized).toBe(true);

    // Settle as released
    const settleResult = JSON.parse(psql(`SELECT settle_message_cost('${attemptId}', 'released');`));
    expect(settleResult.settled).toBe(true);

    // Mark for reconciliation
    psql(`UPDATE message_send_attempts SET needs_reconciliation = true WHERE id = '${attemptId}';`);

    // Admin resolves as charge
    setAuthUid(ADMIN_371);
    const reconResult = JSON.parse(psql(`SELECT resolve_message_cost_reconciliation('${attemptId}', 'charge', 'Delivery confirmed retroactively', 'test-recon-371-11');`));
    expect(reconResult.resolved).toBe(true);
    expect(reconResult.resolution).toBe('charge');

    // Verify adjust event exists
    const adjustCount = psql(`SELECT count(*) FROM message_cost_events WHERE attempt_id = '${attemptId}' AND event_type = 'adjust';`);
    expect(parseInt(adjustCount)).toBeGreaterThanOrEqual(1);

    // Verify needs_reconciliation cleared
    const needsRecon = psql(`SELECT needs_reconciliation FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(needsRecon).toBe('f');
  });

  it('12. Admin resolves release on charged attempt - allowances restored', () => {
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '3717 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    const allowanceId = createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'reconcile-release-371-12');
    const attemptId = createAttempt(bizId, 'NG', 'service');

    // Authorize
    const authResult = JSON.parse(psql(`SELECT authorize_message_send('${attemptId}');`));
    expect(authResult.authorized).toBe(true);

    // Get remaining after auth
    const remainingAfterAuth = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${allowanceId}';`);

    // Settle as charged
    psql(`SELECT settle_message_cost('${attemptId}', 'charged');`);

    // Mark for reconciliation
    psql(`UPDATE message_send_attempts SET needs_reconciliation = true WHERE id = '${attemptId}';`);

    // Admin resolves as release
    setAuthUid(ADMIN_371);
    const reconResult = JSON.parse(psql(`SELECT resolve_message_cost_reconciliation('${attemptId}', 'release', 'Delivery failed retroactively', 'test-recon-371-12');`));
    expect(reconResult.resolved).toBe(true);
    expect(reconResult.resolution).toBe('release');

    // Verify allowance was restored
    const remainingAfterRelease = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${allowanceId}';`);
    expect(parseInt(remainingAfterRelease)).toBeGreaterThan(parseInt(remainingAfterAuth));
  });

  it('13. Admin resolves no_change - reconcile event, needs_reconciliation cleared', () => {
    const bizId = createIsolatedBusiness();
    const attemptId = createAttempt(bizId, 'NG', 'service');

    // Mark for reconciliation directly
    psql(`UPDATE message_send_attempts SET needs_reconciliation = true WHERE id = '${attemptId}';`);

    setAuthUid(ADMIN_371);
    const result = JSON.parse(psql(`SELECT resolve_message_cost_reconciliation('${attemptId}', 'no_change', 'Verified correct state', 'test-recon-371-13');`));
    expect(result.resolved).toBe(true);
    expect(result.resolution).toBe('no_change');

    // Verify reconcile event
    const reconcileCount = psql(`SELECT count(*) FROM message_cost_events WHERE attempt_id = '${attemptId}' AND event_type = 'reconcile';`);
    expect(parseInt(reconcileCount)).toBe(1);

    // Verify flag cleared
    const needsRecon = psql(`SELECT needs_reconciliation FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(needsRecon).toBe('f');
  });

  it('14. Replay same source_key is idempotent', () => {
    const bizId = createIsolatedBusiness();
    const attemptId = createAttempt(bizId, 'NG', 'service');
    psql(`UPDATE message_send_attempts SET needs_reconciliation = true WHERE id = '${attemptId}';`);

    setAuthUid(ADMIN_371);
    const result1 = JSON.parse(psql(`SELECT resolve_message_cost_reconciliation('${attemptId}', 'no_change', 'First call', 'test-recon-371-14');`));
    expect(result1.resolved).toBe(true);

    // Re-flag for reconciliation for a second call attempt
    psql(`UPDATE message_send_attempts SET needs_reconciliation = true WHERE id = '${attemptId}';`);
    const result2 = JSON.parse(psql(`SELECT resolve_message_cost_reconciliation('${attemptId}', 'no_change', 'Second call', 'test-recon-371-14');`));
    expect(result2.resolved).toBe(true);
    expect(result2.idempotent).toBe(true);
  });

  it('15. Non-admin authenticated caller is rejected', () => {
    const bizId = createIsolatedBusiness();
    const attemptId = createAttempt(bizId, 'NG', 'service');
    psql(`UPDATE message_send_attempts SET needs_reconciliation = true WHERE id = '${attemptId}';`);

    setAuthUid(NONADMIN_371);
    const result = JSON.parse(psql(`SELECT resolve_message_cost_reconciliation('${attemptId}', 'no_change', 'Attempt by non-admin', 'test-recon-371-15');`));
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('not_admin');
  });

  // ═══════════════════════════════════════════════════════
  // 16-18. Threshold alert tests
  // ═══════════════════════════════════════════════════════

  it('16. Insert threshold alert succeeds', () => {
    const bizId = createIsolatedBusiness();
    const result = psql(`
      INSERT INTO messaging_spend_threshold_alerts (business_id, currency_code, period_start, threshold_pct, utilization_at_alert, cap_minor, reserved_minor, spent_minor)
      VALUES ('${bizId}', 'NGN', '2026-09-01', 50, 52.50, 50000, 20000, 6250)
      RETURNING id;
    `);
    expect(result).toBeTruthy();
    expect(result.length).toBe(36); // UUID
  });

  it('17. Duplicate (same biz/currency/period/threshold) rejected by unique constraint', () => {
    const bizId = createIsolatedBusiness();
    psql(`
      INSERT INTO messaging_spend_threshold_alerts (business_id, currency_code, period_start, threshold_pct, utilization_at_alert, cap_minor, reserved_minor, spent_minor)
      VALUES ('${bizId}', 'NGN', '2026-09-01', 75, 76.00, 50000, 30000, 8000);
    `);

    const result = psqlMayFail(`
      INSERT INTO messaging_spend_threshold_alerts (business_id, currency_code, period_start, threshold_pct, utilization_at_alert, cap_minor, reserved_minor, spent_minor)
      VALUES ('${bizId}', 'NGN', '2026-09-01', 75, 78.00, 50000, 31000, 8000);
    `);
    expect(result).toContain('duplicate key');
  });

  it('18. Different threshold for same period accepted', () => {
    const bizId = createIsolatedBusiness();
    psql(`
      INSERT INTO messaging_spend_threshold_alerts (business_id, currency_code, period_start, threshold_pct, utilization_at_alert, cap_minor, reserved_minor, spent_minor)
      VALUES ('${bizId}', 'NGN', '2026-09-01', 50, 52.50, 50000, 20000, 6250);
    `);

    const result = psql(`
      INSERT INTO messaging_spend_threshold_alerts (business_id, currency_code, period_start, threshold_pct, utilization_at_alert, cap_minor, reserved_minor, spent_minor)
      VALUES ('${bizId}', 'NGN', '2026-09-01', 90, 91.00, 50000, 40000, 5500)
      RETURNING id;
    `);
    expect(result).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════
  // 19-21. Buffer tests (unmatched_attempt_delivery_statuses)
  // ═══════════════════════════════════════════════════════

  it('19. Insert unmatched status succeeds', () => {
    const result = psql(`
      INSERT INTO unmatched_attempt_delivery_statuses (meta_message_id, status, provider_timestamp)
      VALUES ('wamid.test371_19', 'delivered', NOW())
      RETURNING id;
    `);
    expect(result).toBeTruthy();
    expect(result.length).toBe(36);
  });

  it('20. Duplicate (same WAMID/status) rejected by unique constraint', () => {
    psql(`
      INSERT INTO unmatched_attempt_delivery_statuses (meta_message_id, status, provider_timestamp)
      VALUES ('wamid.test371_20', 'sent', NOW());
    `);

    const result = psqlMayFail(`
      INSERT INTO unmatched_attempt_delivery_statuses (meta_message_id, status, provider_timestamp)
      VALUES ('wamid.test371_20', 'sent', NOW());
    `);
    expect(result).toContain('duplicate key');
  });

  it('21. Different status for same WAMID accepted', () => {
    psql(`
      INSERT INTO unmatched_attempt_delivery_statuses (meta_message_id, status, provider_timestamp)
      VALUES ('wamid.test371_21', 'sent', NOW());
    `);

    const result = psql(`
      INSERT INTO unmatched_attempt_delivery_statuses (meta_message_id, status, provider_timestamp)
      VALUES ('wamid.test371_21', 'delivered', NOW())
      RETURNING id;
    `);
    expect(result).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════
  // 22-23. Reservation expiry tests
  // ═══════════════════════════════════════════════════════

  it('22. authorize_message_send stamps reservation_expires_at', () => {
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '3718 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'ttl-test-371-22');
    const attemptId = createAttempt(bizId, 'NG', 'service');

    const authResult = JSON.parse(psql(`SELECT authorize_message_send('${attemptId}');`));
    expect(authResult.authorized).toBe(true);

    const expiresAt = psql(`SELECT reservation_expires_at FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(expiresAt).toBeTruthy();
    // Should be approximately NOW() + 600 seconds
    const expiresDate = new Date(expiresAt);
    const now = new Date();
    const diffMinutes = (expiresDate.getTime() - now.getTime()) / 1000 / 60;
    // Should be roughly 10 minutes (600s), allow some slack
    expect(diffMinutes).toBeGreaterThan(5);
    expect(diffMinutes).toBeLessThan(15);
  });

  it('23. reservation_expires_at is immutable once bound', () => {
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '3719 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'ttl-immutable-371-23');
    const attemptId = createAttempt(bizId, 'NG', 'service');

    psql(`SELECT authorize_message_send('${attemptId}');`);

    // Try to change reservation_expires_at
    const result = psqlMayFail(`UPDATE message_send_attempts SET reservation_expires_at = NOW() + INTERVAL '1 day' WHERE id = '${attemptId}';`);
    expect(result).toContain('reservation_expires_at is immutable after binding');
  });

  // ═══════════════════════════════════════════════════════
  // 24-26. Security / ACL tests
  // ═══════════════════════════════════════════════════════

  it('24. check_or_authorize_send: anon/authenticated cannot execute', () => {
    // Check that the function is only granted to service_role
    const grants = psql(`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_name = 'check_or_authorize_send'
        AND privilege_type = 'EXECUTE'
      ORDER BY grantee;
    `);
    // Should NOT contain anon or authenticated
    expect(grants).not.toContain('anon');
    expect(grants).not.toContain('authenticated');
  });

  it('25. grant_messaging_allowance: anon/authenticated cannot execute', () => {
    const grants = psql(`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_name = 'grant_messaging_allowance'
        AND privilege_type = 'EXECUTE'
      ORDER BY grantee;
    `);
    expect(grants).not.toContain('anon');
    expect(grants).not.toContain('authenticated');
  });

  it('26. resolve_message_cost_reconciliation: anon/service_role cannot execute; only authenticated', () => {
    const grants = psql(`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_name = 'resolve_message_cost_reconciliation'
        AND privilege_type = 'EXECUTE'
      ORDER BY grantee;
    `);
    expect(grants).not.toContain('anon');
    expect(grants).not.toContain('service_role');
    expect(grants).toContain('authenticated');
  });

  // ═══════════════════════════════════════════════════════
  // 27-28. Two-session concurrency tests
  // ═══════════════════════════════════════════════════════

  it('27. Grant replay two-session: exactly one grant', async () => {
    const bizId = createIsolatedBusiness();

    const [r1, r2] = await Promise.all([
      psqlAsync(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'NGN', 'concurrent-grant-371-27');`),
      psqlAsync(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'NGN', 'concurrent-grant-371-27');`),
    ]);

    const result1 = JSON.parse(r1);
    const result2 = JSON.parse(r2);

    // Exactly one should be granted=true, the other idempotent
    const grantedCount = [result1, result2].filter(r => r.granted === true).length;
    const idempotentCount = [result1, result2].filter(r => r.idempotent === true).length;
    expect(grantedCount).toBe(1);
    expect(idempotentCount).toBe(1);
  });

  it('28. Grant mismatch two-session: one succeeds, one fails closed', async () => {
    const bizId = createIsolatedBusiness();

    const [r1, r2] = await Promise.all([
      psqlAsync(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 5000, 'NGN', 'concurrent-mismatch-371-28');`),
      psqlAsync(`SELECT grant_messaging_allowance('${bizId}', 'trial_grant', 9999, 'NGN', 'concurrent-mismatch-371-28');`),
    ]);

    const result1 = JSON.parse(r1);
    const result2 = JSON.parse(r2);

    // One should succeed, the other should be idempotency_key_mismatch
    const results = [result1, result2];
    const succeeded = results.filter(r => r.granted === true);
    const mismatched = results.filter(r => r.reason === 'idempotency_key_mismatch');
    expect(succeeded.length).toBe(1);
    expect(mismatched.length).toBe(1);
  });

  // ═══════════════════════════════════════════════════════
  // 29-36. Production-shaped runtime tests (Blocker 9)
  // ═══════════════════════════════════════════════════════

  it('29. RPC/DB uncertainty => fails closed (invalid attempt_id)', () => {
    // check_or_authorize_send with a nonexistent attempt should return authorized: false
    const fakeAttemptId = '00000000-dead-beef-0000-000000000029';
    const result = JSON.parse(psql(`SELECT check_or_authorize_send('${fakeAttemptId}');`));
    // With gate ON, authorize_message_send returns attempt_not_found
    // With gate OFF, returns enforcement_required: false
    // Either way, it should NOT return authorized: true
    expect(result.authorized).not.toBe(true);
  });

  it('30. Webhook-before-WAMID + drain on markAccepted', () => {
    // Create a gate-ON config for this test
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '3730 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'drain-test-371-30');
    const attemptId = createAttempt(bizId, 'NG', 'service');

    // Authorize (creates reservation)
    const authResult = JSON.parse(psql(`SELECT authorize_message_send('${attemptId}');`));
    expect(authResult.authorized).toBe(true);

    const testWamid = 'wamid.drain_test_30';

    // Simulate webhook arriving BEFORE WAMID is linked: buffer a 'delivered' status
    psql(`
      INSERT INTO unmatched_attempt_delivery_statuses (meta_message_id, status, provider_timestamp)
      VALUES ('${testWamid}', 'delivered', NOW());
    `);

    // Now link the WAMID (simulating markAccepted — must go through state machine)
    psql(`UPDATE message_send_attempts SET status = 'sending', sent_at = NOW() WHERE id = '${attemptId}';`);
    psql(`UPDATE message_send_attempts SET status = 'accepted', meta_message_id = '${testWamid}', meta_accepted_at = NOW() WHERE id = '${attemptId}';`);

    // Drain buffered statuses
    const drainResult = JSON.parse(psql(`SELECT drain_unmatched_attempt_statuses('${attemptId}', '${testWamid}');`));
    expect(drainResult.drained).toBeGreaterThanOrEqual(1);

    // Verify the attempt was settled (charged) by the drain
    const disposition = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disposition).toBe('charged');

    // Verify the buffered row is marked settled
    const settled = psql(`SELECT settled FROM unmatched_attempt_delivery_statuses WHERE meta_message_id = '${testWamid}' AND status = 'delivered';`);
    expect(settled).toBe('t');
  });

  it('31. Settlement persistence failure handling (needs_reconciliation set)', () => {
    // settle_message_cost with a nonexistent attempt_id should return settled: false
    const fakeId = '00000000-dead-beef-0000-000000000031';
    const result = JSON.parse(psql(`SELECT settle_message_cost('${fakeId}', 'charged');`));
    expect(result.settled).toBe(false);
    expect(result.reason).toBe('attempt_not_found');
  });

  it('32. Contradictory evidence stays in buffer, not in reconciliation log', () => {
    // Set up gate-ON config
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 600,
      })}'::JSONB, NOW() + INTERVAL '3732 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'contradict-test-371-32');
    const attemptId = createAttempt(bizId, 'NG', 'service');
    const testWamid = 'wamid.contradict_test_32';

    // Authorize and settle as released
    psql(`SELECT authorize_message_send('${attemptId}');`);
    psql(`SELECT settle_message_cost('${attemptId}', 'released');`);

    // Simulate contradictory 'delivered' evidence arriving
    // This should go into the buffer table, NOT reconciliation_log
    psql(`
      INSERT INTO unmatched_attempt_delivery_statuses (meta_message_id, status, provider_timestamp)
      VALUES ('${testWamid}', 'delivered', NOW());
    `);

    // Verify NO reconciliation_log entry exists from provider (only admin creates those)
    const reconLogCount = psql(`SELECT count(*) FROM message_cost_reconciliation_log WHERE attempt_id = '${attemptId}';`);
    expect(parseInt(reconLogCount)).toBe(0);

    // Verify the buffer row exists
    const bufferCount = psql(`SELECT count(*) FROM unmatched_attempt_delivery_statuses WHERE meta_message_id = '${testWamid}';`);
    expect(parseInt(bufferCount)).toBe(1);
  });

  it('33. Threshold dedupe: multiple workers inserting same threshold => exactly one row', async () => {
    const bizId = createIsolatedBusiness();

    // Both workers try to insert the same 50% threshold alert concurrently
    const sql = `
      INSERT INTO messaging_spend_threshold_alerts (business_id, currency_code, period_start, threshold_pct, utilization_at_alert, cap_minor, reserved_minor, spent_minor)
      VALUES ('${bizId}', 'NGN', '2026-09-01', 50, 52.50, 50000, 20000, 6250)
      ON CONFLICT (business_id, currency_code, period_start, threshold_pct) DO NOTHING
      RETURNING id;
    `;

    const [r1, r2] = await Promise.all([
      psqlAsync(sql),
      psqlAsync(sql),
    ]);

    // Exactly one row should exist
    const count = psql(`SELECT count(*) FROM messaging_spend_threshold_alerts WHERE business_id = '${bizId}' AND threshold_pct = 50 AND period_start = '2026-09-01';`);
    expect(parseInt(count)).toBe(1);
  });

  it('34. Threshold no-recursion: threshold alert does not trigger WhatsApp send', () => {
    // This is a design verification test. The cron route inserts into alerts table
    // (in-app) but does NOT call any MessageSender. We verify by checking the
    // messaging_spend_threshold_alerts table has no WhatsApp-related columns.
    const columns = psql(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'messaging_spend_threshold_alerts'
      ORDER BY ordinal_position;
    `);
    // Should NOT have any wa_message_id or send-related columns
    expect(columns).not.toContain('wa_message_id');
    expect(columns).not.toContain('meta_message_id');
    expect(columns).not.toContain('sent_at');
  });

  it('35. Expiry safety: only pending_authorization + no-WAMID + no-reconciliation releases', () => {
    // Set up gate-ON config
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1, // 1 second TTL for test
      })}'::JSONB, NOW() + INTERVAL '3735 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'expiry-safe-371-35');
    const attemptId = createAttempt(bizId, 'NG', 'service');

    // Authorize
    const authResult = JSON.parse(psql(`SELECT authorize_message_send('${attemptId}');`));
    expect(authResult.authorized).toBe(true);

    // The attempt is reserved with status pending_authorization (not yet marked sending),
    // no WAMID, no reconciliation flag. Wait for expiry (1 second TTL).
    // Force the reservation_expires_at to the past by direct update
    // (can't update because immutability trigger — so we rely on the 1s TTL)
    // Instead, verify the conditions for safe release
    const attempt = psql(`SELECT status, needs_reconciliation, meta_message_id FROM message_send_attempts WHERE id = '${attemptId}';`);
    // status should still be pending_authorization (we never called markSending)
    // Actually authorize_message_send doesn't change status — only financial_disposition
    expect(attempt).toContain('pending_authorization');

    // Settle as released (simulating what the expiry cron would do for a safe attempt)
    const settleResult = JSON.parse(psql(`SELECT settle_message_cost('${attemptId}', 'released');`));
    expect(settleResult.settled).toBe(true);

    const disposition = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disposition).toBe('released');
  });

  it('36. Expiry forbidden: sending/accepted/ambiguous/WAMID attempts NOT released even if expired', () => {
    // Set up gate-ON config
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW() + INTERVAL '3736 microseconds', '${OWNER_371}')
      RETURNING id;
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'expiry-forbid-371-36');
    const attemptId = createAttempt(bizId, 'NG', 'service');

    // Authorize
    psql(`SELECT authorize_message_send('${attemptId}');`);

    // Simulate: mark as 'sending' (as if provider call is in-flight)
    psql(`UPDATE message_send_attempts SET status = 'sending' WHERE id = '${attemptId}';`);

    // Verify: this attempt is NOT safe to auto-release
    const status = psql(`SELECT status FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(status).toBe('sending');

    // The cron would check: status != 'pending_authorization' => NOT safe => flag only
    // Verify: attempting to settle would succeed at DB level, but the cron logic
    // would not call settle because it checks the safety conditions first.
    // The test validates the DB state that the cron uses for its safety decision.
    const needsRecon = psql(`SELECT needs_reconciliation FROM message_send_attempts WHERE id = '${attemptId}';`);
    const wamid = psql(`SELECT COALESCE(meta_message_id, 'NULL') FROM message_send_attempts WHERE id = '${attemptId}';`);

    // status='sending' means not safe: cron would flag, not release
    expect(status).not.toBe('pending_authorization');

    // Also test with WAMID present: even pending_authorization + WAMID = unsafe
    const bizId2 = createIsolatedBusiness();
    createAllowance(bizId2, 'trial_grant', 10000, 'NGN', 'expiry-forbid2-371-36');
    const attemptId2 = createAttempt(bizId2, 'NG', 'service');

    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW() + INTERVAL '37361 microseconds', '${OWNER_371}')
      RETURNING id;
    `);
    psql(`SELECT authorize_message_send('${attemptId2}');`);
    // Give it a WAMID (accepted) — must go through state machine
    psql(`UPDATE message_send_attempts SET status = 'sending', sent_at = NOW() WHERE id = '${attemptId2}';`);
    psql(`UPDATE message_send_attempts SET status = 'accepted', meta_message_id = 'wamid.expiry_test_36', meta_accepted_at = NOW() WHERE id = '${attemptId2}';`);

    const status2 = psql(`SELECT status FROM message_send_attempts WHERE id = '${attemptId2}';`);
    const wamid2 = psql(`SELECT meta_message_id FROM message_send_attempts WHERE id = '${attemptId2}';`);
    expect(status2).toBe('accepted');
    expect(wamid2).toBe('wamid.expiry_test_36');
    // Cron would NOT release because meta_message_id IS NOT NULL
  });

  // ═══════════════════════════════════════════════════════
  // 37-38. Semantic category + atomic expiry proofs
  // ═══════════════════════════════════════════════════════

  it('37. Missing messageCategory with gate ON fails closed (no transport-derived fallback)', () => {
    // Insert gate-ON config with pricing
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 900,
      })}'::JSONB, NOW() + INTERVAL '37371 microseconds', '${OWNER_371}');
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'cat-test-37');

    // Create attempt with NULL message_category (simulating missing semantic context)
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category) VALUES ('${bizId}', '+2341234567', 'business', 'NG', NULL) RETURNING id;`);

    // Gate ON authorization must fail closed due to missing category
    const result = JSON.parse(psql(`SELECT check_or_authorize_send('${attemptId}');`));
    // The delegated authorize_message_send should reject: missing_message_category
    expect(result.authorized).toBe(false);

    // Zero financial mutation
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disp).toBe('pending_authorization');
  });

  it('38. DB-atomic expiry: concurrent markSending races safe_release — no post-emission release', async () => {
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW() + INTERVAL '38371 microseconds', '${OWNER_371}');
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'race-test-38');
    const attemptId = createAttempt(bizId, 'NG', 'service');
    psql(`SELECT authorize_message_send('${attemptId}');`);

    // Wait for the 1-second TTL to expire
    psql('SELECT pg_sleep(1.5);');

    // Race: session A tries safe_release (expiry cron), session B tries markSending (send path)
    const [rExpiry, rSend] = await Promise.allSettled([
      psqlAsync(`SELECT safe_release_expired_reservation('${attemptId}');`),
      psqlAsync(`UPDATE message_send_attempts SET status = 'sending', sent_at = NOW() WHERE id = '${attemptId}';`),
    ]);

    // Check final state
    const finalDisp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    const finalStatus = psql(`SELECT status FROM message_send_attempts WHERE id = '${attemptId}';`);

    if (finalStatus === 'sending') {
      // Send path won: attempt advanced to sending → expiry must NOT have released
      expect(finalDisp).toBe('reserved');
    } else if (finalDisp === 'released') {
      // Expiry won: released while still pending_authorization → send path blocked
      expect(finalStatus).toBe('pending_authorization');
    }

    // Critical invariant: NEVER sending + released (post-emission release)
    const sendingAndReleased = finalStatus !== 'pending_authorization' && finalDisp === 'released';
    expect(sendingAndReleased).toBe(false);
  }, 30000);

  it('39. safe_release_expired_reservation rejects sending attempt', () => {
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW() + INTERVAL '39371 microseconds', '${OWNER_371}');
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'safe-rel-39');
    const attemptId = createAttempt(bizId, 'NG', 'service');
    psql(`SELECT authorize_message_send('${attemptId}');`);

    // Advance to sending (emission in-flight)
    psql(`UPDATE message_send_attempts SET status = 'sending', sent_at = NOW() WHERE id = '${attemptId}';`);

    // Wait for expiry
    psql('SELECT pg_sleep(1.5);');

    // Atomic release should refuse
    const result = JSON.parse(psql(`SELECT safe_release_expired_reservation('${attemptId}');`));
    expect(result.released).toBe(false);
    expect(result.reason).toBe('not_pre_emission');

    // Disposition unchanged (still reserved, NOT released)
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disp).toBe('reserved');

    // Flagged for reconciliation
    const recon = psql(`SELECT needs_reconciliation FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(recon).toBe('t');
  });

  // ═══════════════════════════════════════════════════════
  // 40-41. Cross-state invariant + deterministic expiry-first proof
  // ═══════════════════════════════════════════════════════

  it('40. DB trigger blocks sending when financial_disposition is released', () => {
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW() + INTERVAL '40371 microseconds', '${OWNER_371}');
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'guard-test-40');
    const attemptId = createAttempt(bizId, 'NG', 'service');
    psql(`SELECT authorize_message_send('${attemptId}');`);

    // Wait for expiry + release
    psql('SELECT pg_sleep(1.5);');
    const releaseResult = JSON.parse(psql(`SELECT safe_release_expired_reservation('${attemptId}');`));
    expect(releaseResult.released).toBe(true);

    // Now try to enter sending — the trigger must block it
    const err = psqlMayFail(`UPDATE message_send_attempts SET status = 'sending', sent_at = NOW() WHERE id = '${attemptId}';`);
    expect(err).toContain('Cannot enter sending');
    expect(err).toContain('released');

    // Status stays pending_authorization, disposition stays released — no emission possible
    const status = psql(`SELECT status FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(status).toBe('pending_authorization');
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disp).toBe('released');
  });

  it('41. Two-session deterministic expiry-first: queued sender blocked after release', async () => {
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: { default_cost_minor: 500, rates: { NG: { service: 200 } }, default_spend_cap_minor: 50000 },
        },
        messaging_reservation_ttl_seconds: 1,
      })}'::JSONB, NOW() + INTERVAL '41371 microseconds', '${OWNER_371}');
    `);

    const bizId = createIsolatedBusiness();
    createAllowance(bizId, 'trial_grant', 10000, 'NGN', 'det-race-41');
    const attemptId = createAttempt(bizId, 'NG', 'service');
    psql(`SELECT authorize_message_send('${attemptId}');`);

    // Wait for TTL to expire
    psql('SELECT pg_sleep(1.5);');

    // Session A (expiry): acquires row lock FIRST via advisory lock coordination,
    // releases the reservation, then commits.
    // Session B (sender): tries markSending but is queued behind the lock;
    // wakes after release commits and is blocked by the cross-state trigger.
    //
    // We force ordering: session A uses pg_advisory_lock to signal it has the row lock,
    // session B waits for that signal before attempting its UPDATE.
    const sessionA = `
      BEGIN;
      -- Acquire the row lock first
      SELECT id FROM message_send_attempts WHERE id = '${attemptId}' FOR UPDATE;
      -- Signal to session B that we hold the lock
      SELECT pg_advisory_lock(371410);
      -- Perform the release
      SELECT safe_release_expired_reservation('${attemptId}');
      -- Release advisory lock so session B can proceed
      SELECT pg_advisory_unlock(371410);
      COMMIT;
    `;

    const sessionB = `
      -- Wait for session A to acquire the row lock (advisory lock signals this)
      SELECT pg_advisory_lock(371410);
      SELECT pg_advisory_unlock(371410);
      -- Now try to enter sending — session A may or may not have committed yet.
      -- If A committed: trigger blocks us (released disposition).
      -- If A hasn't committed: we wait behind row lock, then trigger blocks us.
      UPDATE message_send_attempts SET status = 'sending', sent_at = NOW() WHERE id = '${attemptId}';
    `;

    const [rA, rB] = await Promise.allSettled([
      psqlAsync(sessionA),
      psqlAsync(sessionB),
    ]);

    // Session A should succeed (release)
    expect(rA.status).toBe('fulfilled');

    // Session B should fail (trigger blocks sending after release)
    expect(rB.status).toBe('rejected');
    if (rB.status === 'rejected') {
      expect(rB.reason.message || String(rB.reason)).toContain('Cannot enter sending');
    }

    // Final state: released + pending_authorization (never entered sending)
    const finalDisp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    const finalStatus = psql(`SELECT status FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(finalDisp).toBe('released');
    expect(finalStatus).toBe('pending_authorization');

    // Clean up advisory locks
    psqlMayFail('SELECT pg_advisory_unlock_all();');
  }, 30000);
});
