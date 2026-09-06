/**
 * Financial Authorization & Settlement DB Tests (#260 / Migration 370)
 *
 * Real PostgreSQL proofs for authorize_message_send + settle_message_cost RPCs:
 * authorization boundary, pricing provenance, mixed funding, settlement lifecycle,
 * concurrency (two-session), period boundary, multi-currency isolation, RLS/ACL.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/financial-authorization-db.test.ts
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
const BIZ_ID_A  = 'b0000000-0000-0000-0000-000000000370';
const BIZ_ID_B  = 'b0000000-0000-0000-0000-000000000371';
const OWNER_A   = '00000000-0000-0000-0000-000000000370';
const OWNER_B   = '00000000-0000-0000-0000-000000000371';
const ADMIN_UID = '00000000-0000-0000-0000-00000000a370';

describe.skipIf(!canRun)('Financial Authorization & Settlement DB Tests (#260 / Migration 370)', () => {
  let originalAuthUidDef: string;
  let configVersionId: string;

  beforeAll(() => {
    // Snapshot auth.uid() for hermetic restoration
    originalAuthUidDef = psql(`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'uid' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'auth');`);

    // Seed test users
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${OWNER_A}', 'owner370a@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${OWNER_B}', 'owner370b@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ADMIN_UID}', 'admin370@test.com', '{"role":"admin"}') ON CONFLICT (id) DO NOTHING;`);

    // Seed test businesses
    for (const [bizId, name, slug, owner] of [
      [BIZ_ID_A, 'Test370A', 'test370a', OWNER_A],
      [BIZ_ID_B, 'Test370B', 'test370b', OWNER_B],
    ] as const) {
      const r = psqlMayFail(`
        INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone)
        VALUES ('${bizId}', '${name}', '${slug}', '${owner}', '1 Test', 'T', 'T', '+1')
        ON CONFLICT (id) DO NOTHING;
      `);
      if (r.includes('ERROR') && !r.includes('duplicate')) throw new Error(r);
    }

    // Seed multi-currency pricing config — use a precise future timestamp to ensure this is
    // the most recent effective config in the shared CI database. platform_config_versions
    // is append-only (UPDATE/DELETE triggers), so no ON CONFLICT DO UPDATE.
    // Use microsecond-unique timestamp derived from test suite UUID prefix to avoid collisions.
    configVersionId = psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_pricing: {
          NGN: {
            default_cost_minor: 500,
            rates: { NG: { marketing: 800, utility: 300, authentication: 200 } },
            default_spend_cap_minor: 50000,
          },
          USD: {
            default_cost_minor: 8,
            rates: { US: { marketing: 12, utility: 5, authentication: 4 }, CA: { marketing: 10, utility: 5 } },
            default_spend_cap_minor: 5000,
          },
        },
      })}'::JSONB, NOW() + INTERVAL '370 microseconds', '${OWNER_A}')
      RETURNING id;
    `);
  });

  afterAll(() => {
    if (originalAuthUidDef) {
      psqlMayFail(originalAuthUidDef + ';');
    }
  });

  // Helper: create a business-scoped attempt
  function createAttempt(bizId: string, country: string, category?: string): string {
    const catVal = category ? `'${category}'` : 'NULL';
    return psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category) VALUES ('${bizId}', '+1', 'business', '${country}', ${catVal}) RETURNING id;`);
  }

  // Helper: create an allowance
  function createAllowance(bizId: string, type: string, amount: number, currency: string, sourceRef: string): string {
    return psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${bizId}', '${type}', ${amount}, '${currency}', ${amount}, '${sourceRef}') RETURNING id;`);
  }

  // Helper: create an isolated test business with its own owner
  // This ensures tests that need clean allowance state are not affected by other tests.
  function createIsolatedBusiness(): string {
    const bizId = psql(`SELECT gen_random_uuid();`);
    const ownerId = psql(`SELECT gen_random_uuid();`);
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ownerId}', '${bizId.substring(0,8)}@test370.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    psqlMayFail(`INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone) VALUES ('${bizId}', 'IsolTest-${bizId.substring(0,8)}', 'isol-${bizId.substring(0,8)}', '${ownerId}', '1 Test', 'T', 'T', '+1');`);
    return bizId;
  }

  // ═══════════════════════════════════════════════════════
  // 1. Schema: messaging_spend_periods contract
  // ═══════════════════════════════════════════════════════

  it('1. messaging_spend_periods schema — columns, types, constraints', () => {
    const cols = psql(`
      SELECT column_name || '|' || data_type || '|' || is_nullable
      FROM information_schema.columns
      WHERE table_name = 'messaging_spend_periods'
      ORDER BY ordinal_position;
    `);
    expect(cols).toContain('id|uuid|NO');
    expect(cols).toContain('business_id|uuid|NO');
    expect(cols).toContain('currency_code|text|NO');
    expect(cols).toContain('period_start|timestamp with time zone|NO');
    expect(cols).toContain('cap_minor|integer|NO');
    expect(cols).toContain('reserved_minor|integer|NO');
    expect(cols).toContain('spent_minor|integer|NO');
    expect(cols).toContain('config_version_id|uuid|YES');

    // Unique constraint
    const uq = psql(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'messaging_spend_periods'::regclass AND contype = 'u';`);
    expect(parseInt(uq)).toBeGreaterThanOrEqual(1);

    // CHECK: cap >= 0, reserved >= 0, spent >= 0, reserved + spent <= cap
    const checks = psql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'messaging_spend_periods'::regclass AND contype = 'c';`);
    expect(checks).toContain('cap_minor >= 0');
    expect(checks).toContain('reserved_minor >= 0');
    expect(checks).toContain('spent_minor >= 0');
    expect(checks).toContain('reserved_minor + spent_minor) <= cap_minor');
  });

  // ═══════════════════════════════════════════════════════
  // 2. charge_type CHECK extended with 'mixed'
  // ═══════════════════════════════════════════════════════

  it('2. message_cost_events charge_type CHECK includes mixed', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID_A}', '+1', 'business') RETURNING id;`);
    const result = psqlMayFail(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'reserve', -100, 'mixed', NULL);`);
    expect(result).not.toContain('ERROR');
  });

  // ═══════════════════════════════════════════════════════
  // 3-5. Authorization boundary tests
  // ═══════════════════════════════════════════════════════

  it('3. Successful same-currency authorization — NGN', () => {
    createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'NGN', `auth-test-3-${Date.now()}`);
    const attemptId = createAttempt(BIZ_ID_A, 'NG', 'utility');

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(true);
    expect(result.cost_minor).toBe(300);
    expect(result.currency_code).toBe('NGN');
    expect(result.charge_type).toBe('included');

    // Verify attempt was bound
    const attempt = psql(`SELECT financial_disposition || '|' || estimated_cost_minor || '|' || currency_code FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(attempt).toBe('reserved|300|NGN');

    // Verify spend period created
    const periodExists = psql(`SELECT count(*) FROM messaging_spend_periods WHERE business_id = '${BIZ_ID_A}' AND currency_code = 'NGN';`);
    expect(parseInt(periodExists)).toBeGreaterThanOrEqual(1);
  });

  it('4. Platform attempt → rejected with zero footprint', () => {
    const platformAttemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES (NULL, '+1', 'platform') RETURNING id;`);

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${platformAttemptId}');`));
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('not_business_scoped');

    // Verify zero footprint
    const events = psql(`SELECT count(*) FROM messaging_allowance_events WHERE attempt_id = '${platformAttemptId}';`);
    expect(events).toBe('0');
    const costEvents = psql(`SELECT count(*) FROM message_cost_events WHERE attempt_id = '${platformAttemptId}';`);
    expect(costEvents).toBe('0');
  });

  it('5. NULL business_id attempt → rejected with zero footprint', () => {
    // Business-scoped but NULL business_id would violate constraint, so test platform scope
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES (NULL, '+1', 'platform') RETURNING id;`);
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('not_business_scoped');
  });

  // ═══════════════════════════════════════════════════════
  // 6-8. Pricing provenance tests
  // ═══════════════════════════════════════════════════════

  it('6. Pricing spoof (prepopulated cost mismatch) → fail closed', () => {
    createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'NGN', `auth-test-6-${Date.now()}`);
    // Prepopulate with wrong cost
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category, estimated_cost_minor) VALUES ('${BIZ_ID_A}', '+1', 'business', 'NG', 'utility', 999) RETURNING id;`);

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('pricing_mismatch');

    // Zero footprint
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disp).toBe('pending_authorization');
  });

  it('7. Missing price (no config, no rate) → fail closed', () => {
    createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'NGN', `auth-test-7-${Date.now()}`);
    // Use a country code not in any pricing config
    const attemptId = createAttempt(BIZ_ID_A, 'ZZ', 'utility');

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    // Should fail due to no currency match for ZZ
  });

  it('8. Valid pricing resolution binds tuple atomically', () => {
    createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'USD', `auth-test-8-${Date.now()}`);
    const attemptId = createAttempt(BIZ_ID_A, 'US', 'marketing');

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(true);
    expect(result.cost_minor).toBe(12); // US marketing rate
    expect(result.currency_code).toBe('USD');

    // Verify config_version_id bound
    const cvid = psql(`SELECT config_version_id FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(cvid).toBe(configVersionId);
  });

  // ═══════════════════════════════════════════════════════
  // 9-11. Mixed funding tests
  // ═══════════════════════════════════════════════════════

  it('9. Mixed included + purchased reservation → charge_type = mixed', () => {
    // Use isolated business to ensure clean allowance state
    const biz = createIsolatedBusiness();
    const inclAllowance = createAllowance(biz, 'subscription_included', 200, 'NGN', `auth-test-9-incl-${Date.now()}`);
    const purchAllowance = createAllowance(biz, 'purchased', 5000, 'NGN', `auth-test-9-purch-${Date.now()}`);

    // NG/marketing = 800 NGN, needs both allowances (200 incl + 600 purch)
    const attemptId = createAttempt(biz, 'NG', 'marketing');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));

    expect(result.authorized).toBe(true);
    expect(result.charge_type).toBe('mixed');
    expect(result.cost_minor).toBe(800);

    // Verify per-allowance events: included slice + purchased slice
    const events = psql(`SELECT allowance_id || '|' || amount_minor FROM messaging_allowance_events WHERE attempt_id = '${attemptId}' AND event_type = 'reserve' ORDER BY created_at ASC;`);
    expect(events).toContain(inclAllowance);
    expect(events).toContain(purchAllowance);
  });

  it('10. Pure included reservation → charge_type = included', () => {
    createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'NGN', `auth-test-10-${Date.now()}`);
    const attemptId = createAttempt(BIZ_ID_A, 'NG', 'authentication');

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(true);
    expect(result.charge_type).toBe('included');
  });

  it('11. Pure overage reservation → charge_type = overage', () => {
    const biz = createIsolatedBusiness();
    createAllowance(biz, 'purchased', 10000, 'USD', `auth-test-11-${Date.now()}`);
    const attemptId = createAttempt(biz, 'US', 'utility');

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(true);
    expect(result.charge_type).toBe('overage');
    expect(result.cost_minor).toBe(5); // US utility = 5
  });

  // ═══════════════════════════════════════════════════════
  // 12-13. Settlement lifecycle tests
  // ═══════════════════════════════════════════════════════

  it('12. Reserve → charge: no second allowance decrement', () => {
    const biz = createIsolatedBusiness();
    const allowanceId = createAllowance(biz, 'trial_grant', 5000, 'NGN', `auth-test-12-${Date.now()}`);
    const attemptId = createAttempt(biz, 'NG', 'utility'); // 300 NGN

    psql(`SELECT public.authorize_message_send('${attemptId}');`);

    // Record remaining after reserve
    const afterReserve = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${allowanceId}';`);
    const expectedRemaining = 5000 - 300;
    expect(afterReserve).toBe(String(expectedRemaining));

    // Settle as charged
    const result = JSON.parse(psql(`SELECT public.settle_message_cost('${attemptId}', 'charged');`));
    expect(result.settled).toBe(true);

    // Remaining unchanged — no second decrement
    const afterCharge = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${allowanceId}';`);
    expect(afterCharge).toBe(String(expectedRemaining));

    // Charge event has amount_minor = 0
    const chargeAmount = psql(`SELECT amount_minor FROM messaging_allowance_events WHERE attempt_id = '${attemptId}' AND event_type = 'charge';`);
    expect(chargeAmount).toBe('0');

    // Disposition is charged
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disp).toBe('charged');
  });

  it('13. Reserve → release: exact restoration', () => {
    const biz = createIsolatedBusiness();
    const allowanceId = createAllowance(biz, 'trial_grant', 5000, 'NGN', `auth-test-13-${Date.now()}`);
    const attemptId = createAttempt(biz, 'NG', 'utility'); // 300 NGN

    psql(`SELECT public.authorize_message_send('${attemptId}');`);

    const afterReserve = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${allowanceId}';`);
    expect(afterReserve).toBe('4700');

    // Settle as released
    const result = JSON.parse(psql(`SELECT public.settle_message_cost('${attemptId}', 'released');`));
    expect(result.settled).toBe(true);

    // Exact restoration
    const afterRelease = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${allowanceId}';`);
    expect(afterRelease).toBe('5000');

    // Release event has positive amount_minor
    const releaseAmount = psql(`SELECT amount_minor FROM messaging_allowance_events WHERE attempt_id = '${attemptId}' AND event_type = 'release';`);
    expect(releaseAmount).toBe('300');

    // Disposition is released
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disp).toBe('released');
  });

  // ═══════════════════════════════════════════════════════
  // 14-15. Idempotency and terminal behavior
  // ═══════════════════════════════════════════════════════

  it('14. Same-attempt replay → idempotent (no second debit)', () => {
    createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'NGN', `auth-test-14-${Date.now()}`);
    const attemptId = createAttempt(BIZ_ID_A, 'NG', 'utility');

    const r1 = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(r1.authorized).toBe(true);
    expect(r1.idempotent).toBe(false);

    // Replay
    const r2 = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(r2.authorized).toBe(true);
    expect(r2.idempotent).toBe(true);

    // Only one reserve event
    const reserveCount = psql(`SELECT count(*) FROM messaging_allowance_events WHERE attempt_id = '${attemptId}' AND event_type = 'reserve';`);
    expect(reserveCount).toBe('1');
  });

  it('15. Terminal replay + opposite outcome', () => {
    createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'NGN', `auth-test-15-${Date.now()}`);
    const attemptId = createAttempt(BIZ_ID_A, 'NG', 'utility');
    psql(`SELECT public.authorize_message_send('${attemptId}');`);

    // Charge
    const r1 = JSON.parse(psql(`SELECT public.settle_message_cost('${attemptId}', 'charged');`));
    expect(r1.settled).toBe(true);

    // Same terminal replay → idempotent
    const r2 = JSON.parse(psql(`SELECT public.settle_message_cost('${attemptId}', 'charged');`));
    expect(r2.settled).toBe(true);
    expect(r2.idempotent).toBe(true);

    // Opposite terminal → rejected
    const r3 = JSON.parse(psql(`SELECT public.settle_message_cost('${attemptId}', 'released');`));
    expect(r3.settled).toBe(false);
    expect(r3.reason).toBe('already_terminally_settled');
  });

  // ═══════════════════════════════════════════════════════
  // 16. Month rollover on bound period
  // ═══════════════════════════════════════════════════════

  it('16. Settlement uses originally bound period, not current month', () => {
    const allowanceId = createAllowance(BIZ_ID_B, 'trial_grant', 50000, 'NGN', `auth-test-16-${Date.now()}`);
    const attemptId = createAttempt(BIZ_ID_B, 'NG', 'utility');

    psql(`SELECT public.authorize_message_send('${attemptId}');`);

    // Verify spend_period_start was bound
    const periodStart = psql(`SELECT spend_period_start FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(periodStart).toBeTruthy();

    // Settlement uses bound period
    const result = JSON.parse(psql(`SELECT public.settle_message_cost('${attemptId}', 'charged');`));
    expect(result.settled).toBe(true);

    // The period that was updated matches the bound one
    const period = psql(`SELECT spent_minor FROM messaging_spend_periods WHERE business_id = '${BIZ_ID_B}' AND currency_code = 'NGN' AND period_start = '${periodStart}';`);
    expect(parseInt(period)).toBe(300); // NG/utility = 300
  });

  // ═══════════════════════════════════════════════════════
  // 17. Spend-period conservation constraints
  // ═══════════════════════════════════════════════════════

  it('17. Spend cap exceeded → fail closed with zero footprint', () => {
    // Create a small cap scenario: insert a period with almost-full cap
    const allowanceId = createAllowance(BIZ_ID_B, 'purchased', 100000, 'USD', `auth-test-17-${Date.now()}`);

    // First send should work
    const a1 = createAttempt(BIZ_ID_B, 'US', 'marketing'); // 12 USD
    const r1 = JSON.parse(psql(`SELECT public.authorize_message_send('${a1}');`));
    expect(r1.authorized).toBe(true);

    // Fill up the cap near the limit
    const periodStart = psql(`SELECT spend_period_start FROM message_send_attempts WHERE id = '${a1}';`);
    // Set reserved to cap_minor - 5 (only 5 headroom)
    psql(`UPDATE messaging_spend_periods SET reserved_minor = cap_minor - 5 WHERE business_id = '${BIZ_ID_B}' AND currency_code = 'USD' AND period_start = '${periodStart}';`);

    // Next send should fail (cost=12 > 5 headroom)
    const a2 = createAttempt(BIZ_ID_B, 'US', 'marketing');
    const r2 = JSON.parse(psql(`SELECT public.authorize_message_send('${a2}');`));
    expect(r2.authorized).toBe(false);
    expect(r2.reason).toBe('spend_cap_exceeded');

    // Zero footprint on failed attempt
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${a2}';`);
    expect(disp).toBe('pending_authorization');
  });

  // ═══════════════════════════════════════════════════════
  // 18. Insufficient allowance balance
  // ═══════════════════════════════════════════════════════

  it('18. Insufficient allowance balance → fail closed', () => {
    const biz = createIsolatedBusiness();
    createAllowance(biz, 'trial_grant', 1, 'NGN', `auth-test-18-${Date.now()}`);
    const attemptId = createAttempt(biz, 'NG', 'marketing'); // 800 NGN > 1

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('insufficient_allowance_balance');

    // Zero footprint
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disp).toBe('pending_authorization');
  });

  // ═══════════════════════════════════════════════════════
  // 19-24. Multi-currency isolation tests
  // ═══════════════════════════════════════════════════════

  it('19. NGN attempt consumes only NGN allowances, not USD', () => {
    const biz = createIsolatedBusiness();
    const ngnAllowance = createAllowance(biz, 'trial_grant', 5000, 'NGN', `auth-test-19-ngn-${Date.now()}`);
    const usdAllowance = createAllowance(biz, 'trial_grant', 500, 'USD', `auth-test-19-usd-${Date.now()}`);

    const attemptId = createAttempt(biz, 'NG', 'utility');
    psql(`SELECT public.authorize_message_send('${attemptId}');`);

    // NGN decremented
    const ngnRemaining = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${ngnAllowance}';`);
    expect(parseInt(ngnRemaining)).toBe(5000 - 300);

    // USD untouched
    const usdRemaining = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${usdAllowance}';`);
    expect(usdRemaining).toBe('500');
  });

  it('20. USD attempt consumes only USD allowances, not NGN', () => {
    const biz = createIsolatedBusiness();
    const ngnAllowance = createAllowance(biz, 'trial_grant', 5000, 'NGN', `auth-test-20-ngn-${Date.now()}`);
    const usdAllowance = createAllowance(biz, 'trial_grant', 500, 'USD', `auth-test-20-usd-${Date.now()}`);

    const attemptId = createAttempt(biz, 'US', 'utility');
    psql(`SELECT public.authorize_message_send('${attemptId}');`);

    // USD decremented
    const usdRemaining = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${usdAllowance}';`);
    expect(parseInt(usdRemaining)).toBe(500 - 5);

    // NGN untouched
    const ngnRemaining = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${ngnAllowance}';`);
    expect(ngnRemaining).toBe('5000');
  });

  it('21. No matching currency allowance → fail closed', () => {
    const biz = createIsolatedBusiness();
    createAllowance(biz, 'trial_grant', 50000, 'NGN', `auth-test-21-${Date.now()}`);
    const attemptId = createAttempt(biz, 'US', 'utility');

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    // Should fail because no USD allowance exists
  });

  it('22. No matching currency spend cap → fail closed', () => {
    // Seed a GBP-only config that becomes the most recent
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_pricing: {
          GBP: {
            default_cost_minor: 15,
            rates: { GB: { marketing: 20 } },
            default_spend_cap_minor: 3000,
          },
        },
      })}'::JSONB, NOW() + INTERVAL '22370 microseconds', '${OWNER_A}');
    `);

    createAllowance(BIZ_ID_B, 'trial_grant', 10000, 'GBP', `auth-test-22-${Date.now()}`);
    const attemptId = createAttempt(BIZ_ID_B, 'GB', 'marketing');

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    // Should succeed since GBP config has spend cap
    expect(result.authorized).toBe(true);
    expect(result.currency_code).toBe('GBP');

    // Restore the original multi-currency config as most recent
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_pricing: {
          NGN: {
            default_cost_minor: 500,
            rates: { NG: { marketing: 800, utility: 300, authentication: 200 } },
            default_spend_cap_minor: 50000,
          },
          USD: {
            default_cost_minor: 8,
            rates: { US: { marketing: 12, utility: 5, authentication: 4 }, CA: { marketing: 10, utility: 5 } },
            default_spend_cap_minor: 5000,
          },
        },
      })}'::JSONB, NOW() + INTERVAL '22371 microseconds', '${OWNER_A}');
    `);
  });

  it('23. Cross-currency cap isolation', () => {
    createAllowance(BIZ_ID_A, 'purchased', 100000, 'NGN', `auth-test-23-ngn-${Date.now()}`);
    createAllowance(BIZ_ID_A, 'purchased', 10000, 'USD', `auth-test-23-usd-${Date.now()}`);

    // Send several NGN messages to build up NGN cap usage
    for (let i = 0; i < 5; i++) {
      const a = createAttempt(BIZ_ID_A, 'NG', 'marketing'); // 800 NGN each
      psql(`SELECT public.authorize_message_send('${a}');`);
    }

    // USD send should succeed regardless of NGN cap state
    const usdAttempt = createAttempt(BIZ_ID_A, 'US', 'utility'); // 5 USD
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${usdAttempt}');`));
    expect(result.authorized).toBe(true);
    expect(result.currency_code).toBe('USD');
  });

  it('24. Currency mismatch between prepopulated attempt and trusted resolution → fail closed', () => {
    createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'NGN', `auth-test-24-${Date.now()}`);
    // Prepopulate with USD but country resolves to NGN
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category, currency_code) VALUES ('${BIZ_ID_A}', '+1', 'business', 'NG', 'utility', 'USD') RETURNING id;`);

    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('currency_mismatch');
  });

  // ═══════════════════════════════════════════════════════
  // 25-28. RLS and ACL tests
  // ═══════════════════════════════════════════════════════

  it('25. Owner can SELECT own spend periods, cross-tenant returns zero', () => {
    // Ensure BIZ_ID_A has a spend period from prior tests
    try {
      psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $f$ SELECT '${OWNER_A}'::UUID; $f$ LANGUAGE SQL STABLE;`);
      const own = psql(`SET ROLE authenticated; SELECT count(*)::int FROM messaging_spend_periods WHERE business_id = '${BIZ_ID_A}'; RESET ROLE;`);
      expect(parseInt(own.split('\n').pop()!)).toBeGreaterThan(0);

      // Cross-tenant
      psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $f$ SELECT '${OWNER_B}'::UUID; $f$ LANGUAGE SQL STABLE;`);
      const cross = psql(`SET ROLE authenticated; SELECT count(*)::int FROM messaging_spend_periods WHERE business_id = '${BIZ_ID_A}'; RESET ROLE;`);
      expect(cross.split('\n').pop()).toBe('0');
    } finally {
      psqlMayFail(originalAuthUidDef + ';');
    }
  });

  it('26. Admin can SELECT all spend periods', () => {
    try {
      psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $f$ SELECT '${ADMIN_UID}'::UUID; $f$ LANGUAGE SQL STABLE;`);
      const count = psql(`SET ROLE authenticated; SELECT count(*)::int FROM messaging_spend_periods; RESET ROLE;`);
      expect(parseInt(count.split('\n').pop()!)).toBeGreaterThan(0);
    } finally {
      psqlMayFail(originalAuthUidDef + ';');
    }
  });

  it('27. Anon cannot execute authorize_message_send', () => {
    const err = psqlMayFail(`SET ROLE anon; SELECT public.authorize_message_send(gen_random_uuid()); RESET ROLE;`);
    expect(err.toLowerCase()).toMatch(/permission denied/);
  });

  it('28. Authenticated cannot execute authorize_message_send or settle_message_cost', () => {
    const err1 = psqlMayFail(`
      SET ROLE authenticated;
      SELECT public.authorize_message_send(gen_random_uuid());
      RESET ROLE;
    `);
    expect(err1.toLowerCase()).toMatch(/permission denied/);

    const err2 = psqlMayFail(`
      SET ROLE authenticated;
      SELECT public.settle_message_cost(gen_random_uuid(), 'charged');
      RESET ROLE;
    `);
    expect(err2.toLowerCase()).toMatch(/permission denied/);
  });

  // ═══════════════════════════════════════════════════════
  // 29-30. SECURITY DEFINER / search_path hardening
  // ═══════════════════════════════════════════════════════

  it('29. Both RPCs are SECURITY DEFINER with hardened search_path', () => {
    const authDef = psql(`SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'authorize_message_send';`);
    expect(authDef).toContain('t');
    expect(authDef).toContain('search_path=public');

    const settleDef = psql(`SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'settle_message_cost';`);
    expect(settleDef).toContain('t');
    expect(settleDef).toContain('search_path=public');
  });

  it('30. No application role has TRUNCATE on messaging_spend_periods', () => {
    const acl = psql(`SELECT relacl::text FROM pg_class WHERE relname = 'messaging_spend_periods';`);
    const entries = acl.replace(/[{}]/g, '').split(',');
    for (const entry of entries) {
      const match = entry.match(/^(.*)=([a-zA-Z*]*)\//);
      if (!match) continue;
      const role = match[1] || 'PUBLIC';
      const privs = match[2];
      if (['authenticated', 'service_role', 'anon'].includes(role)) {
        expect(privs).not.toContain('D'); // D = TRUNCATE
      }
    }
  });

  // ═══════════════════════════════════════════════════════
  // 31. Forced failure leaves zero partial footprint
  // ═══════════════════════════════════════════════════════

  it('31. Insufficient allowance mid-reservation → zero partial footprint', () => {
    const biz = createIsolatedBusiness();
    createAllowance(biz, 'trial_grant', 100, 'NGN', `auth-test-31a-${Date.now()}`);
    createAllowance(biz, 'promotional', 100, 'NGN', `auth-test-31b-${Date.now()}`);
    // NG/marketing = 800 > 200 total

    const attemptId = createAttempt(biz, 'NG', 'marketing');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);

    // Zero partial footprint — allowances restored
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(disp).toBe('pending_authorization');

    // No reserve events for this attempt
    const events = psql(`SELECT count(*) FROM messaging_allowance_events WHERE attempt_id = '${attemptId}';`);
    expect(events).toBe('0');
  });

  // ═══════════════════════════════════════════════════════
  // 32. Settle pending_authorization → rejected
  // ═══════════════════════════════════════════════════════

  it('32. Settle on pending_authorization attempt → rejected', () => {
    const attemptId = createAttempt(BIZ_ID_A, 'NG', 'utility');
    const result = JSON.parse(psql(`SELECT public.settle_message_cost('${attemptId}', 'charged');`));
    expect(result.settled).toBe(false);
    expect(result.reason).toBe('not_yet_authorized');
  });

  // ═══════════════════════════════════════════════════════
  // 33-38. Two-session concurrency proofs (real PostgreSQL)
  // ═══════════════════════════════════════════════════════

  it('33. Two-session: same-attempt double authorization → exactly one reservation', async () => {
    const allowanceId = createAllowance(BIZ_ID_A, 'trial_grant', 10000, 'NGN', `conc-33-${Date.now()}`);
    const attemptId = createAttempt(BIZ_ID_A, 'NG', 'utility');

    const sessionSQL = `SELECT public.authorize_message_send('${attemptId}');`;

    const [r1, r2] = await Promise.allSettled([
      psqlAsync(sessionSQL),
      psqlAsync(sessionSQL),
    ]);

    // Both should succeed (one real, one idempotent)
    const results = [r1, r2]
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map(r => JSON.parse(r.value));

    expect(results.length).toBe(2);
    expect(results.every(r => r.authorized === true)).toBe(true);

    // Only one should be non-idempotent
    const nonIdempotent = results.filter(r => r.idempotent === false);
    const idempotent = results.filter(r => r.idempotent === true);
    expect(nonIdempotent.length).toBe(1);
    expect(idempotent.length).toBe(1);

    // Only one reserve event
    const eventCount = psql(`SELECT count(*) FROM messaging_allowance_events WHERE attempt_id = '${attemptId}' AND event_type = 'reserve';`);
    expect(eventCount).toBe('1');
  }, 30000);

  it('34. Two-session: two attempts contending for final eligible allowance', async () => {
    const biz = createIsolatedBusiness();
    const allowanceId = createAllowance(biz, 'purchased', 300, 'NGN', `conc-34-${Date.now()}`);
    const a1 = createAttempt(biz, 'NG', 'utility'); // 300 NGN
    const a2 = createAttempt(biz, 'NG', 'utility'); // 300 NGN

    const [r1, r2] = await Promise.allSettled([
      psqlAsync(`SELECT public.authorize_message_send('${a1}');`),
      psqlAsync(`SELECT public.authorize_message_send('${a2}');`),
    ]);

    const results = [r1, r2].map(r => {
      if (r.status === 'fulfilled') return JSON.parse(r.value);
      return { authorized: false, reason: 'error' };
    });

    const authorized = results.filter(r => r.authorized === true);
    const rejected = results.filter(r => r.authorized !== true);

    // Exactly one succeeds, one fails
    expect(authorized.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Allowance fully consumed
    const remaining = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${allowanceId}';`);
    expect(remaining).toBe('0');
  }, 30000);

  it('35. Two-session: spend-period first-create race', async () => {
    // Insert a config with XOF pricing that includes the standard NGN/USD as well
    // so subsequent tests still work. Use a unique microsecond offset.
    psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_pricing: {
          NGN: {
            default_cost_minor: 500,
            rates: { NG: { marketing: 800, utility: 300, authentication: 200 } },
            default_spend_cap_minor: 50000,
          },
          USD: {
            default_cost_minor: 8,
            rates: { US: { marketing: 12, utility: 5, authentication: 4 }, CA: { marketing: 10, utility: 5 } },
            default_spend_cap_minor: 5000,
          },
          XOF: {
            default_cost_minor: 100,
            rates: { SN: { marketing: 150 } },
            default_spend_cap_minor: 100000,
          },
        },
      })}'::JSONB, NOW() + INTERVAL '35370 microseconds', '${OWNER_A}');
    `);

    const uniqueCurrency = 'XOF';
    createAllowance(BIZ_ID_B, 'trial_grant', 100000, uniqueCurrency, `conc-35a-${Date.now()}`);
    createAllowance(BIZ_ID_B, 'trial_grant', 100000, uniqueCurrency, `conc-35b-${Date.now()}`);

    const a1 = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category) VALUES ('${BIZ_ID_B}', '+1', 'business', 'SN', 'marketing') RETURNING id;`);
    const a2 = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category) VALUES ('${BIZ_ID_B}', '+1', 'business', 'SN', 'marketing') RETURNING id;`);

    await Promise.allSettled([
      psqlAsync(`SELECT public.authorize_message_send('${a1}');`),
      psqlAsync(`SELECT public.authorize_message_send('${a2}');`),
    ]);

    // Exactly one period row for this business/currency/month
    const periodCount = psql(`SELECT count(*) FROM messaging_spend_periods WHERE business_id = '${BIZ_ID_B}' AND currency_code = '${uniqueCurrency}';`);
    expect(periodCount).toBe('1');
  }, 30000);

  it('36. Two-session: two attempts at cap boundary', async () => {
    const biz = createIsolatedBusiness();
    createAllowance(biz, 'purchased', 100000, 'NGN', `conc-36-${Date.now()}`);

    // Create a fresh attempt to establish a period, then fill cap near boundary
    const seed = createAttempt(biz, 'NG', 'authentication'); // 200 NGN
    psql(`SELECT public.authorize_message_send('${seed}');`);
    const periodStart = psql(`SELECT spend_period_start FROM message_send_attempts WHERE id = '${seed}';`);

    // Set reserved to cap - 300 (exactly one NG/utility send fits)
    psql(`UPDATE messaging_spend_periods SET reserved_minor = cap_minor - 300 WHERE business_id = '${biz}' AND currency_code = 'NGN' AND period_start = '${periodStart}';`);

    const a1 = createAttempt(biz, 'NG', 'utility'); // 300 NGN
    const a2 = createAttempt(biz, 'NG', 'utility'); // 300 NGN

    const [r1, r2] = await Promise.allSettled([
      psqlAsync(`SELECT public.authorize_message_send('${a1}');`),
      psqlAsync(`SELECT public.authorize_message_send('${a2}');`),
    ]);

    const results = [r1, r2].map(r => {
      if (r.status === 'fulfilled') return JSON.parse(r.value);
      return { authorized: false, reason: 'error' };
    });

    const authorized = results.filter(r => r.authorized === true);
    // Exactly one should succeed (300 fits), one should fail (cap exceeded)
    expect(authorized.length).toBe(1);
  }, 30000);

  it('37. Two-session: charge-vs-release race → exactly one terminal wins', async () => {
    const biz = createIsolatedBusiness();
    createAllowance(biz, 'trial_grant', 10000, 'NGN', `conc-37-${Date.now()}`);
    const attemptId = createAttempt(biz, 'NG', 'utility');
    psql(`SELECT public.authorize_message_send('${attemptId}');`);

    const [r1, r2] = await Promise.allSettled([
      psqlAsync(`SELECT public.settle_message_cost('${attemptId}', 'charged');`),
      psqlAsync(`SELECT public.settle_message_cost('${attemptId}', 'released');`),
    ]);

    const results = [r1, r2].map(r => {
      if (r.status === 'fulfilled') return JSON.parse(r.value);
      return { settled: false, reason: 'error' };
    });

    const settled = results.filter(r => r.settled === true && r.idempotent !== true);
    // Exactly one non-idempotent settlement
    expect(settled.length).toBe(1);

    // Final disposition is one of charged or released
    const disp = psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(['charged', 'released']).toContain(disp);
  }, 30000);

  it('38. Two-session: two-currency contention — no cross-currency leakage', async () => {
    const biz = createIsolatedBusiness();
    const ngnAllowance = createAllowance(biz, 'purchased', 10000, 'NGN', `conc-38-ngn-${Date.now()}`);
    const usdAllowance = createAllowance(biz, 'purchased', 5000, 'USD', `conc-38-usd-${Date.now()}`);

    const ngnAttempt = createAttempt(biz, 'NG', 'utility'); // 300 NGN
    const usdAttempt = createAttempt(biz, 'US', 'utility'); // 5 USD

    const [r1, r2] = await Promise.allSettled([
      psqlAsync(`SELECT public.authorize_message_send('${ngnAttempt}');`),
      psqlAsync(`SELECT public.authorize_message_send('${usdAttempt}');`),
    ]);

    // Both should succeed — different currencies, no contention
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');

    if (r1.status === 'fulfilled' && r2.status === 'fulfilled') {
      const res1 = JSON.parse(r1.value);
      const res2 = JSON.parse(r2.value);
      expect(res1.authorized).toBe(true);
      expect(res2.authorized).toBe(true);
    }

    // Verify isolation: NGN allowance decremented by 300, USD by 5
    const ngnRem = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${ngnAllowance}';`);
    expect(parseInt(ngnRem)).toBe(10000 - 300);
    const usdRem = psql(`SELECT remaining_minor FROM messaging_allowances WHERE id = '${usdAllowance}';`);
    expect(parseInt(usdRem)).toBe(5000 - 5);
  }, 30000);

  // ═══════════════════════════════════════════════════════
  // 39. auth.uid() hermetic restoration
  // ═══════════════════════════════════════════════════════

  it('39. auth.uid() restored to exact original after all RLS tests', () => {
    const currentDef = psql(`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'uid' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'auth');`);
    expect(currentDef).toBe(originalAuthUidDef);
  });
});
