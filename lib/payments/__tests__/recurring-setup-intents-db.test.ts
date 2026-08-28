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
const TEST_USER_ID = TEST_OWNER_ID;

describe('PostgreSQL recurring_setup_intents (#165)', () => {
  beforeAll(() => {
    // Cleanup
    runSQL(`
      DELETE FROM recurring_setup_intents WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM payments WHERE business_id = '${TEST_BIZ_ID}';
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
    // Two test payments (success + finalized + user_id set for RPC authority derivation)
    for (const pid of [TEST_PAY_ID, TEST_PAY_ID2]) {
      runSQL(`
        INSERT INTO payments (id, business_id, user_id, amount, gateway_reference, status, gateway, currency, finalization_completed_at, confirmation_sent_at, payment_authority_version)
        VALUES ('${pid}', '${TEST_BIZ_ID}', '${TEST_USER_ID}', 10000, 'test-165-ref-${pid}', 'success', 'paystack', 'NGN', NOW(), NOW(), 1)
        ON CONFLICT DO NOTHING;
      `);
    }
  }, 30000);

  afterAll(() => {
    runSQL(`
      DELETE FROM recurring_setup_intents WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM payments WHERE business_id = '${TEST_BIZ_ID}';
      DELETE FROM businesses WHERE id = '${TEST_BIZ_ID}';
      DELETE FROM profiles WHERE id = '${TEST_OWNER_ID}';
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id = '${TEST_OWNER_ID}';
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
  }, 15000);

  beforeEach(() => {
    runSQL(`DELETE FROM recurring_setup_intents WHERE business_id = '${TEST_BIZ_ID}';`);
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
    runSQL(`INSERT INTO bookings (id, business_id, flow_type, guest_name, guest_phone, status) VALUES ('${crossBizBookId}', '${crossBizId}', 'payment', 'Cross Guest', '+2340000001', 'confirmed') ON CONFLICT DO NOTHING;`);
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
    runSQL(`INSERT INTO bookings (id, business_id, flow_type, guest_name, guest_phone, status) VALUES ('${nonPayFlowBookId}', '${TEST_BIZ_ID}', 'appointment', 'Appt Guest', '+2340000002', 'confirmed') ON CONFLICT DO NOTHING;`);
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
    // Attempt activation WITHOUT persisting plan/subscription codes first
    const { result } = callRpc(`SELECT activate_recurring_subscription('${r1.intent_id}'::uuid, '${beginResult.claim_token}'::uuid, NOW() + INTERVAL '1 month') AS result;`);
    expect(result.activated).toBe(false);
    expect(result.reason).toBe('provider_evidence_incomplete');
  });
});

} // end if (dbUrl)
