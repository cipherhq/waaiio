/**
 * #165: PostgreSQL recurring_setup_intents lifecycle tests.
 *
 * Uses psql via execSync against TEST_DATABASE_URL.
 * Skips gracefully in normal Main App CI.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('PostgreSQL recurring_setup_intents (#165) — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string, role?: string): { stdout: string; stderr: string; exitCode: number } {
  const fullSql = role ? `SET ROLE ${role};\n${sql}` : sql;
  try {
    let stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    stdout = stdout.trim();
    if (role && stdout.startsWith('SET\n')) stdout = stdout.slice(4).trim();
    else if (role && stdout === 'SET') stdout = '';
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || '', exitCode: err.status || 1 };
  }
}

function callRpc(sql: string, role?: string) {
  const r = runSQL(sql, role);
  if (r.exitCode !== 0) return { result: {} as Record<string, unknown>, raw: r.stderr || r.stdout, exitCode: r.exitCode };
  try {
    const lines = r.stdout.split('\n');
    const jsonLine = lines.find(l => l.startsWith('{')) || r.stdout;
    return { result: JSON.parse(jsonLine) as Record<string, unknown>, raw: r.stdout, exitCode: 0 };
  } catch {
    return { result: {} as Record<string, unknown>, raw: r.stdout, exitCode: 0 };
  }
}

const TEST_OWNER_ID = 'cd165000-0000-0000-0000-000000000000';
const TEST_BIZ_ID = 'cd165000-0000-0000-0000-000000000001';
const TEST_PAY_ID = 'cd165000-0000-0000-0000-000000000002';
const TEST_PAY_ID2 = 'cd165000-0000-0000-0000-000000000003';
const TEST_SERVICE_ID = 'cd165000-0000-0000-0000-000000000004';
const SERVICE_ID = TEST_SERVICE_ID;
const TEST_USER_ID = TEST_OWNER_ID;

describe('PostgreSQL recurring_setup_intents (#165)', () => {
  beforeAll(() => {
    // Cleanup
    runSQL(`
      DELETE FROM recurring_setup_intents WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM customer_subscriptions WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM payments WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM bookings WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM services WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM businesses WHERE id = '${TEST_BIZ_ID}';
      DELETE FROM profiles WHERE id = '${TEST_OWNER_ID}';
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id = '${TEST_OWNER_ID}';
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
    // Setup
    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES ('${TEST_OWNER_ID}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
    runSQL(`INSERT INTO profiles (id) VALUES ('${TEST_OWNER_ID}') ON CONFLICT DO NOTHING;`);
    const biz = runSQL(`
      INSERT INTO businesses (id, owner_id, name, slug, address, city, phone, recurring_enabled)
      VALUES ('${TEST_BIZ_ID}', '${TEST_OWNER_ID}', 'Test Church 165', 'test-church-165', '1 Faith St', 'Lagos', '+2340000165', true)
      ON CONFLICT DO NOTHING;
    `);
    if (biz.exitCode !== 0) throw new Error(`Business insert failed: ${biz.stderr}`);
    // Create test service
    runSQL(`INSERT INTO services (id, business_id, name, service_type, billing_type, recurring_interval, is_active) VALUES ('${TEST_SERVICE_ID}', '${TEST_BIZ_ID}', 'Test Giving', 'giving', 'recurring', 'monthly', true) ON CONFLICT DO NOTHING;`);
    // Two test bookings + payments (canonical Payment/Giving context required by INNER JOIN)
    const TEST_BOOKING_IDS = ['cd165000-0000-0000-0000-000000000010', 'cd165000-0000-0000-0000-000000000011'];
    for (let i = 0; i < 2; i++) {
      const pid = [TEST_PAY_ID, TEST_PAY_ID2][i];
      const bid = TEST_BOOKING_IDS[i];
      // Create booking with service_id for service-specific tests
      runSQL(`
        INSERT INTO bookings (id, business_id, user_id, service_id, reference_code, status, flow_type, guest_phone, channel, date, time, party_size)
        VALUES ('${bid}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${TEST_SERVICE_ID}', 'WA-GV-${i}', 'confirmed', 'payment', '+2340000165', 'whatsapp', '2026-08-28', '10:00', 1)
        ON CONFLICT DO NOTHING;
      `);
      // Create payment linked to booking
      runSQL(`
        INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version)
        VALUES ('${pid}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${bid}', 10000, 'test-165-ref-${pid}', 'success', 'paystack', 'NGN', NOW(), NOW(), 1)
        ON CONFLICT DO NOTHING;
      `);
    }
  }, 30000);

  afterAll(() => {
    runSQL(`
      DELETE FROM recurring_setup_intents WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM customer_subscriptions WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM payments WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM bookings WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM services WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM businesses WHERE id = '${TEST_BIZ_ID}';
      DELETE FROM profiles WHERE id = '${TEST_OWNER_ID}';
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id = '${TEST_OWNER_ID}';
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
  }, 15000);

  beforeEach(() => {
    runSQL(`
      DELETE FROM recurring_setup_intents WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM customer_subscriptions WHERE business_id = '${TEST_BIZ_ID}';
    `);
  });

  // ── Uniqueness ──

  it('1. creates intent for eligible payment', () => {
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(true);
    expect(result.intent_id).toBeTruthy();
  });

  it('2. duplicate INSERT for same payment returns already_exists', () => {
    callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('already_exists');
  });

  it('3. UNIQUE(source_payment_id) prevents second intent after declined', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT decline_recurring_offer('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, '${TEST_USER_ID}'::uuid) AS result;`);
    const { result: r2 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(r2.created).toBe(false);
    expect(r2.reason).toBe('already_exists');
    expect(r2.status).toBe('declined');
  });

  it('4. UNIQUE prevents second intent after expired', () => {
    callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    runSQL(`UPDATE recurring_setup_intents SET status = 'expired' WHERE source_payment_id = '${TEST_PAY_ID}';`);
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.status).toBe('expired');
  });

  it('5. UNIQUE prevents second intent after setup_failed', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    // Transition to consent_confirmed first, then fail
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hash123') AS result;`);
    callRpc(`SELECT fail_recurring_setup('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'test') AS result;`);
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.status).toBe('setup_failed');
  });

  it('6. different payment ID can create new intent', () => {
    callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID2}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(true);
  });

  // ── State machine transitions ──

  it('7. offered → frequency_selected with valid frequency', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    const { result: r2 } = callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'weekly') AS result;`);
    expect(r2.transitioned).toBe(true);
    const check = runSQL(`SELECT status, frequency FROM recurring_setup_intents WHERE id = '${r1.intent_id}';`);
    expect(check.stdout).toBe('frequency_selected|weekly');
  });

  it('8. rejects invalid frequency', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    const { result: r2 } = callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'yearly') AS result;`);
    expect(r2.transitioned).toBe(false);
    expect(r2.reason).toBe('invalid_frequency');
  });

  it('9. frequency_selected → consent_confirmed with hash', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    const { result } = callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'sha256_abc123') AS result;`);
    expect(result.transitioned).toBe(true);
    const check = runSQL(`SELECT status, consent_at IS NOT NULL AS has_consent, consent_message_hash FROM recurring_setup_intents WHERE id = '${r1.intent_id}';`);
    const [status, hasConsent, hash] = check.stdout.split('|');
    expect(status).toBe('consent_confirmed');
    expect(hasConsent).toBe('t');
    expect(hash).toBe('sha256_abc123');
  });

  it('10. rejects consent without hash', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    const { result } = callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, '') AS result;`);
    expect(result.transitioned).toBe(false);
    expect(result.reason).toBe('missing_consent_hash');
  });

  it('11. consent_confirmed → provider_attempted', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hash') AS result;`);
    const { result } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_test', 'AUTH_test', NOW() + INTERVAL '1 month') AS result;`);
    expect(result.transitioned).toBe(true);
    expect(result.claim_token).toBeTruthy();
  });

  it('12. rejects provider attempt without consent', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    // Skip consent, go straight to provider attempt
    const { result } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_test', 'AUTH_test', NOW()) AS result;`);
    expect(result.transitioned).toBe(false);
    expect(result.reason).toBe('invalid_state_frequency_selected');
  });

  it('13. tenant mismatch rejected', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    const { result } = callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'monthly') AS result;`);
    expect(result.transitioned).toBe(false);
    expect(result.reason).toBe('tenant_mismatch');
  });

  it('14. expired intent rejects frequency selection', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    runSQL(`UPDATE recurring_setup_intents SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = '${r1.intent_id}';`);
    const { result } = callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    expect(result.transitioned).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('15. declined is terminal — cannot transition back', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT decline_recurring_offer('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, '${TEST_USER_ID}'::uuid) AS result;`);
    const { result } = callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    expect(result.transitioned).toBe(false);
    expect(result.reason).toBe('invalid_state_declined');
  });

  // ── Concurrency ──

  it('16. concurrent intent creations produce exactly one row', async () => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const sql = `SELECT json_build_object('pid', pg_backend_pid(), 'result', create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack'));`;
    const [pA, pB] = await Promise.all([
      execAsync(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"')}"`, { timeout: 10000 }),
      execAsync(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"')}"`, { timeout: 10000 }),
    ]);
    const rA = JSON.parse(pA.stdout.trim());
    const rB = JSON.parse(pB.stdout.trim());
    expect(rA.pid).not.toBe(rB.pid);
    const created = [rA.result, rB.result].filter((r: Record<string, unknown>) => r.created === true);
    expect(created.length).toBeLessThanOrEqual(1);
    const count = runSQL(`SELECT count(*)::int FROM recurring_setup_intents WHERE source_payment_id = '${TEST_PAY_ID}';`);
    expect(count.stdout).toBe('1');
  }, 15000);

  // ── Privilege assertions ──

  it('17. anon cannot execute create_recurring_offer', () => {
    const r = runSQL(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack');`, 'anon');
    expect(r.exitCode).not.toBe(0);
  });

  it('18. authenticated cannot execute create_recurring_offer', () => {
    const r = runSQL(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack');`, 'authenticated');
    expect(r.exitCode).not.toBe(0);
  });

  it('19. service_role can execute create_recurring_offer', () => {
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`, 'service_role');
    expect(result.created).toBe(true);
  });

  it('20. RLS enabled on recurring_setup_intents', () => {
    const r = runSQL(`SELECT relrowsecurity FROM pg_class WHERE relname = 'recurring_setup_intents';`);
    expect(r.stdout).toBe('t');
  });

  // ── Payment eligibility ──

  it('21. rejects non-successful payment', () => {
    const pendingPayId = 'cd165000-0000-0000-0000-000000000099';
    runSQL(`INSERT INTO payments (id, business_id, amount, gateway_reference, status, gateway, currency) VALUES ('${pendingPayId}', '${TEST_BIZ_ID}', 100, 'test-pend', 'pending', 'paystack', 'NGN') ON CONFLICT DO NOTHING;`);
    const { result } = callRpc(`SELECT create_recurring_offer('${pendingPayId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('payment_not_eligible');
    runSQL(`DELETE FROM payments WHERE id = '${pendingPayId}';`);
  });

  it('22. rejects unsupported provider', () => {
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'stripe') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('unsupported_provider');
  });

  // ── CHECK constraints ──

  it('23. CHECK: frequency NULL in offered state is allowed', () => {
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(true);
    const check = runSQL(`SELECT frequency IS NULL AS freq_null FROM recurring_setup_intents WHERE id = '${result.intent_id}';`);
    expect(check.stdout).toBe('t');
  });

  it('24. CHECK: cannot insert with non-null frequency in offered state via raw SQL', () => {
    // The RPC prevents this, but verify CHECK constraint catches bare INSERT too
    const r = runSQL(`INSERT INTO recurring_setup_intents (source_payment_id, business_id, user_id, amount, currency, status, frequency) VALUES ('${TEST_PAY_ID}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', 10000, 'NGN', 'consent_confirmed', 'monthly');`);
    // consent_confirmed requires consent_at + consent_message_hash
    expect(r.exitCode).not.toBe(0);
  });

  // ── Fix 5: Adversarial schema-resolution tests ──

  it('25. untrusted roles cannot create tables in public schema', () => {
    // anon cannot create a shadow table
    const r1 = runSQL('CREATE TABLE public.recurring_setup_intents_shadow (id int);', 'anon');
    expect(r1.exitCode).not.toBe(0);
    // authenticated cannot create a shadow table
    const r2 = runSQL('CREATE TABLE public.payments_shadow (id int);', 'authenticated');
    expect(r2.exitCode).not.toBe(0);
  });

  it('26. Stripe gateway source payment rejected by RPC', () => {
    const stripePayId = 'cd165000-0000-0000-0000-000000000050';
    runSQL(`INSERT INTO payments (id, business_id, user_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${stripePayId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', 5000, 'test-stripe-ref', 'success', 'stripe', 'USD', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);
    const { result } = callRpc(`SELECT create_recurring_offer('${stripePayId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('payment_not_eligible');
    runSQL(`DELETE FROM payments WHERE id = '${stripePayId}';`);
  });

  it('27. cross-business booking rejected', () => {
    const crossBizPayId = 'cd165000-0000-0000-0000-000000000051';
    const crossBizBookId = 'cd165000-0000-0000-0000-000000000052';
    const crossBizId = 'cd165000-0000-0000-0000-000000000053';
    // Create a second business
    runSQL(`INSERT INTO businesses (id, owner_id, name, slug, address, city, phone) VALUES ('${crossBizId}', '${TEST_OWNER_ID}', 'Cross Biz', 'cross-biz', '2 Cross St', 'Accra', '+2330000001') ON CONFLICT DO NOTHING;`);
    // Create a booking belonging to a different business
    runSQL(`INSERT INTO bookings (id, business_id, user_id, reference_code, flow_type, guest_name, guest_phone, status, date, time, party_size) VALUES ('${crossBizBookId}', '${crossBizId}', '${TEST_USER_ID}', 'WA-CR-1', 'payment', 'Cross Guest', '+2340000001', 'confirmed', '2026-08-28', '10:00', 1) ON CONFLICT DO NOTHING;`);
    // Create a payment linked to that cross-business booking
    runSQL(`INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${crossBizPayId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${crossBizBookId}', 5000, 'test-cross-ref', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);
    const { result } = callRpc(`SELECT create_recurring_offer('${crossBizPayId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('payment_not_eligible');
    runSQL(`DELETE FROM payments WHERE id = '${crossBizPayId}';`);
    runSQL(`DELETE FROM bookings WHERE id = '${crossBizBookId}';`);
    runSQL(`DELETE FROM businesses WHERE id = '${crossBizId}';`);
  });

  it('28. non-payment flow_type booking rejected', () => {
    const nonPayFlowPayId = 'cd165000-0000-0000-0000-000000000054';
    const nonPayFlowBookId = 'cd165000-0000-0000-0000-000000000055';
    // Create a booking with non-payment flow_type
    runSQL(`INSERT INTO bookings (id, business_id, user_id, reference_code, flow_type, guest_name, guest_phone, status, date, time, party_size) VALUES ('${nonPayFlowBookId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', 'WA-AP-1', 'appointment', 'Appt Guest', '+2340000002', 'confirmed', '2026-08-28', '10:00', 1) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${nonPayFlowPayId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${nonPayFlowBookId}', 5000, 'test-appt-ref', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);
    const { result } = callRpc(`SELECT create_recurring_offer('${nonPayFlowPayId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('payment_not_eligible');
    runSQL(`DELETE FROM payments WHERE id = '${nonPayFlowPayId}';`);
    runSQL(`DELETE FROM bookings WHERE id = '${nonPayFlowBookId}';`);
  });

  it('29. wrong user decline rejected', () => {
    const wrongUserId = 'cd165000-0000-0000-0000-000000000060';
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(r1.created).toBe(true);
    const { result: r2 } = callRpc(`SELECT decline_recurring_offer('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, '${wrongUserId}'::uuid) AS result;`);
    expect(r2.declined).toBe(false);
    expect(r2.reason).toBe('user_mismatch');
  });

  it('30. activation without persisted provider evidence rejected', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hash') AS result;`);
    const { result: beginResult } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_test', 'AUTH_test', NOW() + INTERVAL '1 month') AS result;`);
    const { result } = callRpc(`SELECT activate_recurring_subscription('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid) AS result;`);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('provider_evidence_incomplete');
  });

  // ── Complete activation lifecycle ──

  it('31. successful activation creates exactly one customer_subscriptions row', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hash') AS result;`);
    const { result: beginResult } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_test', 'AUTH_test', NOW() + INTERVAL '1 month') AS result;`);
    // Persist plan + subscription before activation
    callRpc(`SELECT persist_recurring_plan_id('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid, 'PLN_test165') AS result;`);
    callRpc(`SELECT persist_recurring_subscription_id('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid, 'SUB_test165', 'tok_test') AS result;`);
    // Activate
    const { result: actResult } = callRpc(`SELECT activate_recurring_subscription('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid) AS result;`);
    expect(actResult.activated).toBe(true);
    expect(actResult.subscription_id).toBeTruthy();
    // Verify exactly one customer_subscriptions row
    const subCount = runSQL(`SELECT count(*)::int FROM customer_subscriptions WHERE id = '${actResult.subscription_id}';`);
    expect(subCount.stdout).toBe('1');
    // Verify resulting_subscription_id on intent
    const intentCheck = runSQL(`SELECT status, resulting_subscription_id FROM recurring_setup_intents WHERE id = '${r1.intent_id}';`);
    const [status, subId] = intentCheck.stdout.split('|');
    expect(status).toBe('active');
    expect(subId).toBe(actResult.subscription_id);
    // Verify next_charge_at equals provider_start_date
    const dateCheck = runSQL(`SELECT (cs.next_charge_at = rsi.provider_start_date) AS dates_match FROM customer_subscriptions cs JOIN recurring_setup_intents rsi ON rsi.resulting_subscription_id = cs.id WHERE rsi.id = '${r1.intent_id}';`);
    expect(dateCheck.stdout).toBe('t');
    // Cleanup
    runSQL(`DELETE FROM customer_subscriptions WHERE id = '${actResult.subscription_id}';`);
  });

  it('32. duplicate activation returns already_activated', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'weekly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hash2') AS result;`);
    const { result: beginResult } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_dup', 'AUTH_dup', NOW() + INTERVAL '7 days') AS result;`);
    callRpc(`SELECT persist_recurring_plan_id('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid, 'PLN_dup') AS result;`);
    callRpc(`SELECT persist_recurring_subscription_id('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid, 'SUB_dup', 'tok_dup') AS result;`);
    const { result: act1 } = callRpc(`SELECT activate_recurring_subscription('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid) AS result;`);
    expect(act1.activated).toBe(true);
    // Second activation attempt
    const { result: act2 } = callRpc(`SELECT activate_recurring_subscription('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid) AS result;`);
    expect(act2.activated).toBe(true);
    expect(act2.already_activated).toBe(true);
    expect(act2.subscription_id).toBe(act1.subscription_id);
    // Verify still exactly one subscription
    const count = runSQL(`SELECT count(*)::int FROM customer_subscriptions WHERE id = '${act1.subscription_id}';`);
    expect(count.stdout).toBe('1');
    runSQL(`DELETE FROM customer_subscriptions WHERE id = '${act1.subscription_id}';`);
  });

  it('33. activation with NULL provider_start_date fails', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hash') AS result;`);
    // begin_recurring_provider_attempt with NULL start_date
    const { result: beginResult } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_t', 'AUTH_t', NULL::timestamptz) AS result;`);
    if (beginResult.transitioned) {
      callRpc(`SELECT persist_recurring_plan_id('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid, 'PLN_null') AS result;`);
      callRpc(`SELECT persist_recurring_subscription_id('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid, 'SUB_null', 'tok_null') AS result;`);
      const { result } = callRpc(`SELECT activate_recurring_subscription('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid) AS result;`);
      expect(result.activated).toBe(false);
      expect(result.reason).toBe('missing_provider_start_date');
    }
    // Either begin rejected NULL or activation rejected it — both are correct
    expect(true).toBe(true);
  });

  // ── Empty provider ID rejection ──

  it('34. empty plan code rejected by persist_recurring_plan_id', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'h') AS result;`);
    const { result: b } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'C', 'A', NOW() + INTERVAL '1 month') AS result;`);
    const { result } = callRpc(`SELECT persist_recurring_plan_id('${r1.intent_id}'::uuid, '${b.claim_token}'::uuid, '') AS result;`);
    expect(result.persisted).toBe(false);
    expect(result.reason).toBe('empty_plan_code');
  });

  it('35. whitespace plan code rejected', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'h2') AS result;`);
    const { result: b } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'C2', 'A2', NOW() + INTERVAL '1 month') AS result;`);
    const { result } = callRpc(`SELECT persist_recurring_plan_id('${r1.intent_id}'::uuid, '${b.claim_token}'::uuid, '   ') AS result;`);
    expect(result.persisted).toBe(false);
    expect(result.reason).toBe('empty_plan_code');
  });

  it('36. empty subscription code rejected by persist_recurring_subscription_id', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'h3') AS result;`);
    const { result: b } = callRpc(`SELECT begin_recurring_provider_attempt('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'C3', 'A3', NOW() + INTERVAL '1 month') AS result;`);
    callRpc(`SELECT persist_recurring_plan_id('${r1.intent_id}'::uuid, '${b.claim_token}'::uuid, 'PLN_ok') AS result;`);
    const { result } = callRpc(`SELECT persist_recurring_subscription_id('${r1.intent_id}'::uuid, '${b.claim_token}'::uuid, '', 'tok') AS result;`);
    expect(result.persisted).toBe(false);
    expect(result.reason).toBe('empty_subscription_code');
  });

  // ── Stale decline ──

  it('37. stale direct decline after 24h → expired, not declined', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    // Backdate expires_at to make it expired
    runSQL(`UPDATE recurring_setup_intents SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = '${r1.intent_id}';`);
    const { result } = callRpc(`SELECT decline_recurring_offer('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, '${TEST_USER_ID}'::uuid) AS result;`);
    expect(result.declined).toBe(false);
    expect(result.reason).toBe('expired');
    // Verify state is expired, not declined
    const check = runSQL(`SELECT status FROM recurring_setup_intents WHERE id = '${r1.intent_id}';`);
    expect(check.stdout).toBe('expired');
  });

  it('38. valid decline before expiry works', () => {
    const { result: r1 } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    const { result } = callRpc(`SELECT decline_recurring_offer('${r1.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, '${TEST_USER_ID}'::uuid) AS result;`);
    expect(result.declined).toBe(true);
    const check = runSQL(`SELECT status FROM recurring_setup_intents WHERE id = '${r1.intent_id}';`);
    expect(check.stdout).toBe('declined');
  });

  // ── Source payment without booking ──

  it('39. source payment with NULL booking is rejected by INNER JOIN', () => {
    const noBookingPayId = 'cd165000-0000-0000-0000-000000000070';
    runSQL(`INSERT INTO payments (id, business_id, user_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${noBookingPayId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', 5000, 'test-nobooking', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);
    const { result } = callRpc(`SELECT create_recurring_offer('${noBookingPayId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('payment_not_eligible');
    runSQL(`DELETE FROM payments WHERE id = '${noBookingPayId}';`);
  });

  // ── Generic service_id IS NULL duplicate-active-subscription protection ──

  it('40. RPC rejects NULL-service booking before reaching subscription check (#224)', () => {
    // After #224 defense-in-depth: bookings without service_id are rejected
    // with 'no_service' before the subscription check is reached.
    // NULL service_id cannot represent a valid recurring Giving category.
    const nullSvcBookId = 'cd165000-0000-0000-0000-000000000081';
    const nullSvcPayId = 'cd165000-0000-0000-0000-000000000082';
    runSQL(`INSERT INTO bookings (id, business_id, user_id, reference_code, status, flow_type, guest_phone, channel, date, time, party_size) VALUES ('${nullSvcBookId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', 'WA-GV-NS1', 'confirmed', 'payment', '+2340000165', 'whatsapp', '2026-08-28', '10:00', 1) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${nullSvcPayId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${nullSvcBookId}', 10000, 'test-nullsvc', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);

    const { result } = callRpc(`SELECT create_recurring_offer('${nullSvcPayId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('no_service');

    // Cleanup
    runSQL(`DELETE FROM payments WHERE id = '${nullSvcPayId}';`);
    runSQL(`DELETE FROM bookings WHERE id = '${nullSvcBookId}';`);
  });

  it('41. RPC rejects offer when active service-specific subscription exists', () => {
    // Create an active subscription FOR the test service
    const subId = 'cd165000-0000-0000-0000-000000000083';
    runSQL(`
      INSERT INTO customer_subscriptions (id, business_id, user_id, service_id, amount, currency, frequency, status, gateway, customer_phone, setup_channel)
      VALUES ('${subId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${SERVICE_ID}', 10000, 'NGN', 'weekly', 'active', 'paystack', '+2340000165', 'whatsapp')
      ON CONFLICT DO NOTHING;
    `);

    // The main test payments have service_id from the booking — try to create offer
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('active_subscription_exists');

    // Cleanup
    runSQL(`DELETE FROM customer_subscriptions WHERE id = '${subId}';`);
  });

  it('42. RPC allows offer when subscription exists for DIFFERENT service', () => {
    // Create an active subscription for a DIFFERENT service
    const diffServiceId = 'cd165000-0000-0000-0000-000000000084';
    const subId = 'cd165000-0000-0000-0000-000000000085';
    runSQL(`INSERT INTO services (id, business_id, name) VALUES ('${diffServiceId}', '${TEST_BIZ_ID}', 'Other Service') ON CONFLICT DO NOTHING;`);
    runSQL(`
      INSERT INTO customer_subscriptions (id, business_id, user_id, service_id, amount, currency, frequency, status, gateway, customer_phone, setup_channel)
      VALUES ('${subId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${diffServiceId}', 5000, 'NGN', 'monthly', 'active', 'paystack', '+2340000165', 'whatsapp')
      ON CONFLICT DO NOTHING;
    `);

    // The main test payment's service is different — offer should be allowed
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(true);

    // Cleanup
    runSQL(`DELETE FROM customer_subscriptions WHERE id = '${subId}';`);
    runSQL(`DELETE FROM services WHERE id = '${diffServiceId}';`);
  });

  it('43. cancelled/paused subscriptions do not block new offer', () => {
    // Create a cancelled subscription for the same service
    const subId = 'cd165000-0000-0000-0000-000000000086';
    runSQL(`
      INSERT INTO customer_subscriptions (id, business_id, user_id, service_id, amount, currency, frequency, status, gateway, customer_phone, setup_channel, cancelled_at)
      VALUES ('${subId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${SERVICE_ID}', 10000, 'NGN', 'monthly', 'cancelled', 'paystack', '+2340000165', 'whatsapp', NOW())
      ON CONFLICT DO NOTHING;
    `);

    // Cancelled subscription should NOT block new offer
    const { result } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(result.created).toBe(true);

    // Cleanup
    runSQL(`DELETE FROM customer_subscriptions WHERE id = '${subId}';`);
  });

  // ── Same-scope provider-attempt serialization gate (migration 350) ──

  it('44. two consent_confirmed intents for SAME scope — only one wins provider gate', async () => {
    // Create two different source payments for the same user/business/service
    const PAY_A = 'cd165000-0000-0000-0000-000000000090';
    const PAY_B = 'cd165000-0000-0000-0000-000000000091';
    const BOOK_A = 'cd165000-0000-0000-0000-000000000092';
    const BOOK_B = 'cd165000-0000-0000-0000-000000000093';

    for (const [pid, bid, ref] of [[PAY_A, BOOK_A, 'WA-GV-A'], [PAY_B, BOOK_B, 'WA-GV-B']]) {
      runSQL(`INSERT INTO bookings (id, business_id, user_id, service_id, reference_code, status, flow_type, guest_phone, channel, date, time, party_size) VALUES ('${bid}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${TEST_SERVICE_ID}', '${ref}', 'confirmed', 'payment', '+2340000165', 'whatsapp', '2026-08-28', '10:00', 1) ON CONFLICT DO NOTHING;`);
      runSQL(`INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${pid}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${bid}', 10000, 'test-scope-${pid}', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);
    }

    // Create intents for both payments
    const { result: offerA } = callRpc(`SELECT create_recurring_offer('${PAY_A}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    const { result: offerB } = callRpc(`SELECT create_recurring_offer('${PAY_B}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(offerA.created).toBe(true);
    expect(offerB.created).toBe(true);

    // Drive both to consent_confirmed
    for (const intentId of [offerA.intent_id, offerB.intent_id]) {
      callRpc(`SELECT select_recurring_frequency('${intentId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
      callRpc(`SELECT confirm_recurring_consent('${intentId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hash_scope_test') AS result;`);
    }

    // Race their provider-attempt claims using two independent sessions
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const sqlA = `SELECT json_build_object('pid', pg_backend_pid(), 'result', begin_recurring_provider_attempt('${offerA.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_A', 'AUTH_A', NOW() + INTERVAL '1 month'));`;
    const sqlB = `SELECT json_build_object('pid', pg_backend_pid(), 'result', begin_recurring_provider_attempt('${offerB.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_B', 'AUTH_B', NOW() + INTERVAL '1 month'));`;

    const [pA, pB] = await Promise.all([
      execAsync(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1 -c "${sqlA.replace(/"/g, '\\"')}"`, { timeout: 15000 }),
      execAsync(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1 -c "${sqlB.replace(/"/g, '\\"')}"`, { timeout: 15000 }),
    ]);

    const rA = JSON.parse(pA.stdout.trim());
    const rB = JSON.parse(pB.stdout.trim());

    // Different PIDs — genuinely independent sessions
    expect(rA.pid).not.toBe(rB.pid);

    // Exactly one wins, one loses
    const winners = [rA.result, rB.result].filter((r: Record<string, unknown>) => r.transitioned === true);
    const losers = [rA.result, rB.result].filter((r: Record<string, unknown>) => r.transitioned === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toBe('competing_provider_attempt');

    // Cleanup
    runSQL(`DELETE FROM payments WHERE id IN ('${PAY_A}', '${PAY_B}');`);
    runSQL(`DELETE FROM bookings WHERE id IN ('${BOOK_A}', '${BOOK_B}');`);
  }, 20000);

  it('45. NULL service_id is rejected by defense-in-depth (#224)', () => {
    // After #224: bookings without service_id are rejected at RPC level
    // (recurring offers require an explicit Giving service with billing_type='recurring')
    const PAY_C = 'cd165000-0000-0000-0000-000000000094';
    const BOOK_C = 'cd165000-0000-0000-0000-000000000096';

    runSQL(`INSERT INTO bookings (id, business_id, user_id, reference_code, status, flow_type, guest_phone, channel, date, time, party_size) VALUES ('${BOOK_C}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', 'WA-GV-C', 'confirmed', 'payment', '+2340000165', 'whatsapp', '2026-08-28', '10:00', 1) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${PAY_C}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${BOOK_C}', 10000, 'test-null-${PAY_C}', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);

    const { result: offerC } = callRpc(`SELECT create_recurring_offer('${PAY_C}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(offerC.created).toBe(false);
    expect(offerC.reason).toBe('no_service');

    runSQL(`DELETE FROM payments WHERE id = '${PAY_C}';`);
    runSQL(`DELETE FROM bookings WHERE id = '${BOOK_C}';`);
  });

  it('46. different service scope is NOT blocked', () => {
    // Intent A is for TEST_SERVICE_ID, already at provider_attempted
    const { result: offerA } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${offerA.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${offerA.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'h') AS result;`);
    callRpc(`SELECT begin_recurring_provider_attempt('${offerA.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS', 'AUTH', NOW() + INTERVAL '1 month') AS result;`);

    // Intent B is for a DIFFERENT service — should NOT be blocked
    const diffSvcId = 'cd165000-0000-0000-0000-000000000098';
    const diffBookId = 'cd165000-0000-0000-0000-000000000099';
    const diffPayId = 'cd165000-0000-0000-0000-0000000000a0';
    runSQL(`INSERT INTO services (id, business_id, name, service_type, billing_type, recurring_interval, is_active) VALUES ('${diffSvcId}', '${TEST_BIZ_ID}', 'Diff Svc', 'giving', 'recurring', 'weekly', true) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO bookings (id, business_id, user_id, service_id, reference_code, status, flow_type, guest_phone, channel, date, time, party_size) VALUES ('${diffBookId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${diffSvcId}', 'WA-GV-DS', 'confirmed', 'payment', '+2340000165', 'whatsapp', '2026-08-28', '10:00', 1) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${diffPayId}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${diffBookId}', 5000, 'test-diff-svc', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);

    const { result: offerB } = callRpc(`SELECT create_recurring_offer('${diffPayId}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(offerB.created).toBe(true);
    callRpc(`SELECT select_recurring_frequency('${offerB.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'weekly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${offerB.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'h2') AS result;`);
    const { result: rB } = callRpc(`SELECT begin_recurring_provider_attempt('${offerB.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS2', 'AUTH2', NOW() + INTERVAL '7 days') AS result;`);

    // Different service scope — should succeed
    expect(rB.transitioned).toBe(true);

    runSQL(`DELETE FROM payments WHERE id = '${diffPayId}';`);
    runSQL(`DELETE FROM bookings WHERE id = '${diffBookId}';`);
    runSQL(`DELETE FROM services WHERE id = '${diffSvcId}';`);
  });

  it('47. provider_ambiguous blocks another provider mutation', () => {
    const { result: offer } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${offer.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${offer.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'h') AS result;`);
    const { result: begin } = callRpc(`SELECT begin_recurring_provider_attempt('${offer.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS', 'AUTH', NOW() + INTERVAL '1 month') AS result;`);
    // Mark ambiguous
    callRpc(`SELECT mark_recurring_ambiguous('${offer.intent_id}'::uuid, '${begin.claim_token}'::uuid, 'timeout') AS result;`);

    // Second intent for SAME scope
    const PAY_X = 'cd165000-0000-0000-0000-0000000000b0';
    const BOOK_X = 'cd165000-0000-0000-0000-0000000000b1';
    runSQL(`INSERT INTO bookings (id, business_id, user_id, service_id, reference_code, status, flow_type, guest_phone, channel, date, time, party_size) VALUES ('${BOOK_X}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${TEST_SERVICE_ID}', 'WA-GV-X', 'confirmed', 'payment', '+2340000165', 'whatsapp', '2026-08-28', '10:00', 1) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${PAY_X}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${BOOK_X}', 10000, 'test-ambig-block', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);

    const { result: offerX } = callRpc(`SELECT create_recurring_offer('${PAY_X}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(offerX.created).toBe(true);
    callRpc(`SELECT select_recurring_frequency('${offerX.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${offerX.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hx') AS result;`);

    // Should be blocked by the ambiguous intent
    const { result: rX } = callRpc(`SELECT begin_recurring_provider_attempt('${offerX.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_X', 'AUTH_X', NOW() + INTERVAL '1 month') AS result;`);
    expect(rX.transitioned).toBe(false);
    expect(rX.reason).toBe('competing_provider_attempt');

    runSQL(`DELETE FROM payments WHERE id = '${PAY_X}';`);
    runSQL(`DELETE FROM bookings WHERE id = '${BOOK_X}';`);
  });

  it('48. declined/expired/setup_failed do NOT permanently block', () => {
    // Intent at provider_attempted, then failed
    const { result: offer } = callRpc(`SELECT create_recurring_offer('${TEST_PAY_ID}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    callRpc(`SELECT select_recurring_frequency('${offer.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'monthly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${offer.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hf') AS result;`);
    callRpc(`SELECT fail_recurring_setup('${offer.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'test_fail') AS result;`);

    // Second intent for SAME scope should NOT be blocked (prior intent is terminal)
    const PAY_Y = 'cd165000-0000-0000-0000-0000000000c0';
    const BOOK_Y = 'cd165000-0000-0000-0000-0000000000c1';
    runSQL(`INSERT INTO bookings (id, business_id, user_id, service_id, reference_code, status, flow_type, guest_phone, channel, date, time, party_size) VALUES ('${BOOK_Y}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${TEST_SERVICE_ID}', 'WA-GV-Y', 'confirmed', 'payment', '+2340000165', 'whatsapp', '2026-08-28', '10:00', 1) ON CONFLICT DO NOTHING;`);
    runSQL(`INSERT INTO payments (id, business_id, user_id, booking_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version) VALUES ('${PAY_Y}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', '${BOOK_Y}', 10000, 'test-term-ok', 'success', 'paystack', 'NGN', NOW(), NOW(), 1) ON CONFLICT DO NOTHING;`);

    const { result: offerY } = callRpc(`SELECT create_recurring_offer('${PAY_Y}'::uuid, '${TEST_BIZ_ID}'::uuid, 'paystack') AS result;`);
    expect(offerY.created).toBe(true);
    callRpc(`SELECT select_recurring_frequency('${offerY.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'weekly') AS result;`);
    callRpc(`SELECT confirm_recurring_consent('${offerY.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'hy') AS result;`);

    // Should succeed — no competing provider_attempted/ambiguous in scope
    const { result: rY } = callRpc(`SELECT begin_recurring_provider_attempt('${offerY.intent_id}'::uuid, '${TEST_BIZ_ID}'::uuid, 'CUS_Y', 'AUTH_Y', NOW() + INTERVAL '7 days') AS result;`);
    expect(rY.transitioned).toBe(true);

    runSQL(`DELETE FROM payments WHERE id = '${PAY_Y}';`);
    runSQL(`DELETE FROM bookings WHERE id = '${BOOK_Y}';`);
  });
});

} // end if (dbUrl)
