/**
 * Messaging Allowance Schema DB Tests (#258 / Migration 368)
 *
 * Real PostgreSQL proofs for business_messaging_accounts,
 * message_cost_reservations, authorize_message_send(),
 * finalize_reservation(), and concurrency safety.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/messaging-allowance-db.test.ts
 */
import { execSync, spawn } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
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

const BIZ_ID = 'b0000000-0000-0000-0000-000000000258';

describe.skipIf(!canRun)('Messaging Allowance DB Tests (#258 / Migration 368)', () => {
  beforeAll(() => {
    // Seed test business
    psqlMayFail(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone)
      VALUES ('${BIZ_ID}', 'Test258', 'test258-allow', '00000000-0000-0000-0000-000000000001', '1 Test', 'T', 'T', '+1')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed messaging account with known balances
    psqlMayFail(`
      INSERT INTO business_messaging_accounts (business_id, free_units_remaining, trial_units_remaining, paid_balance_minor, currency_code)
      VALUES ('${BIZ_ID}', 5, 10, 50000, 'NGN')
      ON CONFLICT (business_id) DO UPDATE SET free_units_remaining = 5, trial_units_remaining = 10, paid_balance_minor = 50000;
    `);
  });

  // ── Schema ──

  it('1. Tables exist', () => {
    expect(psql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'business_messaging_accounts';")).toBe('1');
    expect(psql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'message_cost_reservations';")).toBe('1');
  });

  // ── Reservation transitions ──

  it('2. Valid: reserved → consumed', () => {
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1') RETURNING id;`);
    psql(`INSERT INTO message_cost_reservations (attempt_id, business_id, authorization_source, estimated_cost_minor, currency_code, estimate_provenance)
      VALUES ('${attemptId}', '${BIZ_ID}', 'paid', 100, 'NGN', '{"source":"server_rate_card"}'::jsonb);`);
    psql(`UPDATE message_cost_reservations SET status = 'consumed' WHERE attempt_id = '${attemptId}';`);
    expect(psql(`SELECT status FROM message_cost_reservations WHERE attempt_id = '${attemptId}';`)).toBe('consumed');
  });

  it('3. Valid: reserved → released', () => {
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1') RETURNING id;`);
    psql(`INSERT INTO message_cost_reservations (attempt_id, business_id, authorization_source, estimated_cost_minor, currency_code, estimate_provenance)
      VALUES ('${attemptId}', '${BIZ_ID}', 'trial', 0, 'NGN', '{"source":"server_rate_card"}'::jsonb);`);
    psql(`UPDATE message_cost_reservations SET status = 'released' WHERE attempt_id = '${attemptId}';`);
    expect(psql(`SELECT status FROM message_cost_reservations WHERE attempt_id = '${attemptId}';`)).toBe('released');
  });

  it('4. Invalid: consumed → released (terminal)', () => {
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1') RETURNING id;`);
    psql(`INSERT INTO message_cost_reservations (attempt_id, business_id, authorization_source, estimated_cost_minor, currency_code, estimate_provenance)
      VALUES ('${attemptId}', '${BIZ_ID}', 'free', 0, 'NGN', '{"source":"server_rate_card"}'::jsonb);`);
    psql(`UPDATE message_cost_reservations SET status = 'consumed' WHERE attempt_id = '${attemptId}';`);
    const err = psqlMayFail(`UPDATE message_cost_reservations SET status = 'released' WHERE attempt_id = '${attemptId}';`);
    expect(err).toContain('terminal');
  });

  it('5. One reservation per attempt (UNIQUE)', () => {
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1') RETURNING id;`);
    psql(`INSERT INTO message_cost_reservations (attempt_id, business_id, authorization_source, estimated_cost_minor, currency_code, estimate_provenance)
      VALUES ('${attemptId}', '${BIZ_ID}', 'free', 0, 'NGN', '{"source":"server_rate_card"}'::jsonb);`);
    const err = psqlMayFail(`INSERT INTO message_cost_reservations (attempt_id, business_id, authorization_source, estimated_cost_minor, currency_code, estimate_provenance)
      VALUES ('${attemptId}', '${BIZ_ID}', 'paid', 100, 'NGN', '{"source":"server_rate_card"}'::jsonb);`);
    expect(err.toLowerCase()).toContain('unique');
  });

  // ── authorize_message_send ──

  it('6. Authorized: free units consumed first', () => {
    // Reset account
    psql(`UPDATE business_messaging_accounts SET free_units_remaining = 3, trial_units_remaining = 5, paid_balance_minor = 10000 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);

    const result = psql(`
      SET ROLE service_role;
      SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"server_rate_card","country":"NG"}'::jsonb);
      RESET ROLE;
    `);
    const parsed = JSON.parse(result.split('\n').pop()!);
    expect(parsed.authorized).toBe(true);
    expect(parsed.source).toBe('free');

    // Free units decremented
    const freeRemaining = psql(`SELECT free_units_remaining FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';`);
    expect(freeRemaining).toBe('2');
  });

  it('7. Authorized: trial units after free exhausted', () => {
    psql(`UPDATE business_messaging_accounts SET free_units_remaining = 0, trial_units_remaining = 5 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);

    const result = psql(`
      SET ROLE service_role;
      SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb);
      RESET ROLE;
    `);
    expect(JSON.parse(result.split('\n').pop()!).source).toBe('trial');
    expect(psql(`SELECT trial_units_remaining FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';`)).toBe('4');
  });

  it('8. Authorized: paid after free+trial exhausted', () => {
    psql(`UPDATE business_messaging_accounts SET free_units_remaining = 0, trial_units_remaining = 0, paid_balance_minor = 5000 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);

    const result = psql(`
      SET ROLE service_role;
      SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb);
      RESET ROLE;
    `);
    expect(JSON.parse(result.split('\n').pop()!).source).toBe('paid');
    expect(psql(`SELECT paid_balance_minor FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';`)).toBe('4900');
  });

  it('9. Insufficient allowance → rejected', () => {
    psql(`UPDATE business_messaging_accounts SET free_units_remaining = 0, trial_units_remaining = 0, paid_balance_minor = 50 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);

    const err = psqlMayFail(`
      SET ROLE service_role;
      SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb);
      RESET ROLE;
    `);
    expect(err).toContain('insufficient');
  });

  it('10. Untrusted estimate source → rejected', () => {
    psql(`UPDATE business_messaging_accounts SET free_units_remaining = 5 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);

    const err = psqlMayFail(`
      SET ROLE service_role;
      SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"browser_calc"}'::jsonb);
      RESET ROLE;
    `);
    expect(err).toContain('Untrusted');
  });

  it('11. Missing provenance → rejected', () => {
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);
    const err = psqlMayFail(`
      SET ROLE service_role;
      SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{}'::jsonb);
      RESET ROLE;
    `);
    expect(err).toContain('provenance');
  });

  // ── Idempotency ──

  it('12. Repeated authorization → idempotent (no double reservation)', () => {
    psql(`UPDATE business_messaging_accounts SET free_units_remaining = 5 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);

    psql(`SET ROLE service_role; SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb); RESET ROLE;`);
    const freeAfterFirst = psql(`SELECT free_units_remaining FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';`);

    // Second call — should be idempotent
    const result = psql(`SET ROLE service_role; SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb); RESET ROLE;`);
    const parsed = JSON.parse(result.split('\n').pop()!);
    expect(parsed.idempotent).toBe(true);

    // Balance unchanged
    const freeAfterSecond = psql(`SELECT free_units_remaining FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';`);
    expect(freeAfterSecond).toBe(freeAfterFirst);
  });

  // ── Finalization ──

  it('13. finalize consumed → consumed once', () => {
    psql(`UPDATE business_messaging_accounts SET paid_balance_minor = 5000 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);
    psql(`SET ROLE service_role; SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb); RESET ROLE;`);

    const result = psql(`SET ROLE service_role; SELECT finalize_reservation('${attemptId}'::uuid, 'consumed'); RESET ROLE;`);
    expect(JSON.parse(result.split('\n').pop()!).finalized).toBe(true);
  });

  it('14. finalize released → balance restored', () => {
    psql(`UPDATE business_messaging_accounts SET free_units_remaining = 0, trial_units_remaining = 0, paid_balance_minor = 5000 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);
    psql(`SET ROLE service_role; SELECT authorize_message_send('${attemptId}'::uuid, 200, 'NGN', '{"source":"server_rate_card"}'::jsonb); RESET ROLE;`);
    // Balance should be 4800
    expect(psql(`SELECT paid_balance_minor FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';`)).toBe('4800');

    psql(`SET ROLE service_role; SELECT finalize_reservation('${attemptId}'::uuid, 'released'); RESET ROLE;`);
    // Balance restored to 5000
    expect(psql(`SELECT paid_balance_minor FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';`)).toBe('5000');
  });

  it('15. Repeated finalization → idempotent', () => {
    psql(`UPDATE business_messaging_accounts SET paid_balance_minor = 5000 WHERE business_id = '${BIZ_ID}';`);
    const attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);
    psql(`SET ROLE service_role; SELECT authorize_message_send('${attemptId}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb); RESET ROLE;`);
    psql(`SET ROLE service_role; SELECT finalize_reservation('${attemptId}'::uuid, 'consumed'); RESET ROLE;`);

    const result = psql(`SET ROLE service_role; SELECT finalize_reservation('${attemptId}'::uuid, 'consumed'); RESET ROLE;`);
    expect(JSON.parse(result.split('\n').pop()!).idempotent).toBe(true);
  });

  // ── ACL ──

  it('16. anon cannot EXECUTE authorize_message_send', () => {
    expect(psql("SELECT has_function_privilege('anon', 'authorize_message_send(uuid,integer,text,jsonb)', 'EXECUTE');")).toBe('f');
  });

  it('17. authenticated cannot EXECUTE authorize_message_send', () => {
    expect(psql("SELECT has_function_privilege('authenticated', 'authorize_message_send(uuid,integer,text,jsonb)', 'EXECUTE');")).toBe('f');
  });

  it('18. service_role CAN EXECUTE authorize_message_send', () => {
    expect(psql("SELECT has_function_privilege('service_role', 'authorize_message_send(uuid,integer,text,jsonb)', 'EXECUTE');")).toBe('t');
  });

  // ── Concurrency ──

  it('19. Two-session race on last free unit → only one wins', async () => {
    psql(`UPDATE business_messaging_accounts SET free_units_remaining = 1, trial_units_remaining = 0, paid_balance_minor = 0 WHERE business_id = '${BIZ_ID}';`);
    const a1 = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+1', 'pending_authorization') RETURNING id;`);
    const a2 = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, financial_disposition) VALUES ('${BIZ_ID}', '+2', 'pending_authorization') RETURNING id;`);

    const sessionA = psqlAsync(`
      SET ROLE service_role;
      SELECT authorize_message_send('${a1}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb);
      RESET ROLE;
    `);

    await new Promise(r => setTimeout(r, 50));

    const sessionB = psqlAsync(`
      SET ROLE service_role;
      SELECT authorize_message_send('${a2}'::uuid, 100, 'NGN', '{"source":"server_rate_card"}'::jsonb);
      RESET ROLE;
    `);

    const results = await Promise.allSettled([sessionA, sessionB]);
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    // Exactly one should succeed, one should fail (insufficient)
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(psql(`SELECT free_units_remaining FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';`)).toBe('0');
  }, 15000);

  // ── RLS ──

  it('20. Cross-tenant read denied', () => {
    const CLAIMS = '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated"}';
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM business_messaging_accounts WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(count.split('\n').pop()).toBe('0');
  });
});
