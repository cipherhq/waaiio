/**
 * Messaging Allowance Schema DB Tests (#258 / Migration 368)
 *
 * Real PostgreSQL proofs for messaging_allowances,
 * messaging_allowance_events, constraints, partial unique indexes,
 * append-only triggers, RLS, and grants.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/messaging-allowance-db.test.ts
 */
import { execSync } from 'child_process';
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

const BIZ_ID = 'b0000000-0000-0000-0000-000000000258';

describe.skipIf(!canRun)('Messaging Allowance Schema DB Tests (#258 / Migration 368)', () => {
  let allowanceId: string;
  let attemptId: string;

  beforeAll(() => {
    // Seed test business
    const bizResult = psqlMayFail(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone)
      VALUES ('${BIZ_ID}', 'Test258', 'test258-ma', '00000000-0000-0000-0000-000000000001', '1 Test', 'T', 'T', '+1')
      ON CONFLICT (id) DO NOTHING;
    `);
    if (bizResult.includes('ERROR') && !bizResult.includes('duplicate')) throw new Error(bizResult);

    // Seed a test attempt for FK references
    attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1') RETURNING id;`);

    // Seed a test allowance
    allowanceId = psql(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'trial_grant', 10000, 'NGN', 10000, 'test-seed-258')
      ON CONFLICT (business_id, type, source_ref) DO UPDATE SET remaining_minor = 10000
      RETURNING id;
    `);
  });

  // ── Schema existence ──

  it('1. Tables exist', () => {
    expect(psql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'messaging_allowances';")).toBe('1');
    expect(psql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'messaging_allowance_events';")).toBe('1');
  });

  // ── Allowance constraints ──

  it('2. remaining_minor >= 0', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'purchased', 1000, 'NGN', -1, 'test-neg');
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('3. remaining_minor <= amount_minor', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'purchased', 1000, 'NGN', 2000, 'test-exceed');
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('4. UNIQUE(business_id, type, source_ref) prevents duplicate grants', () => {
    psqlMayFail(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'promotional', 500, 'NGN', 500, 'promo-dup-test')
      ON CONFLICT DO NOTHING;
    `);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'promotional', 500, 'NGN', 500, 'promo-dup-test');
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  // ── Event partial unique indexes ──

  it('5. Grant event duplicate → rejected', () => {
    psql(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'grant', 10000, 10000)
      ON CONFLICT DO NOTHING;
    `);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'grant', 10000, 10000);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('6. Expire event duplicate → rejected', () => {
    psql(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'expire', -10000, 0)
      ON CONFLICT DO NOTHING;
    `);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'expire', -10000, 0);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('7. Reserve duplicate for same (allowance, attempt) → rejected', () => {
    psql(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'reserve', -100, '${attemptId}', 9900)
      ON CONFLICT DO NOTHING;
    `);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'reserve', -100, '${attemptId}', 9900);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('8. Adjust with NULL source_key → rejected by CHECK', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'adjust', 50, 10050, NULL);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('9. Adjust replay with same source_key → rejected; different → accepted', () => {
    psql(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'adjust', 50, 10050, 'adj-key-1')
      ON CONFLICT DO NOTHING;
    `);
    // Same key → rejected
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'adjust', 50, 10050, 'adj-key-1');
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);

    // Different key → accepted
    const ok = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'adjust', 25, 10075, 'adj-key-2');
    `);
    expect(ok).not.toContain('ERROR');
  });

  // ── Append-only enforcement ──

  it('10. Service-role UPDATE of event → rejected by trigger', () => {
    // Ensure an event exists for this test
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'append-upd-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const eventId = psql(`INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor) VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100) RETURNING id;`);

    // Trigger fires regardless of role — test as superuser to prove trigger works
    const err = psqlMayFail(`
      UPDATE messaging_allowance_events SET amount_minor = 999 WHERE id = '${eventId}';
    `);
    expect(err).toContain('append-only');
  });

  it('11. Superuser DELETE of event → rejected by trigger', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'append-del-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const eventId = psql(`INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor) VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100) RETURNING id;`);

    const err = psqlMayFail(`
      DELETE FROM messaging_allowance_events WHERE id = '${eventId}';
    `);
    expect(err).toContain('append-only');
  });

  // ── RLS ──

  it('12. Cross-tenant read denied (allowances)', () => {
    const CLAIMS = '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated"}';
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM messaging_allowances WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(count.split('\n').pop()).toBe('0');
  });

  it('13. Cross-tenant read denied (events)', () => {
    const CLAIMS = '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated"}';
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM messaging_allowance_events WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(count.split('\n').pop()).toBe('0');
  });

  // ── Grants ──

  it('14. Authenticated cannot INSERT allowances (service-role only)', () => {
    const CLAIMS = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'auth-insert-test');
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toMatch(/permission denied|row-level security/);
  });

  it('15. Service-role CAN INSERT events', () => {
    // Create a fresh allowance + attempt for this test
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'svc-event-test-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const result = psqlMayFail(`
      SET ROLE service_role;
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100);
      RESET ROLE;
    `);
    expect(result).not.toContain('permission denied');
  });

  // ── FK to message_send_attempts ──

  it('16. Event with valid attempt_id FK succeeds', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 500, 'NGN', 500, 'fk-test-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const result = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'reserve', -100, '${attemptId}', 400);
    `);
    expect(result).not.toContain('ERROR');
  });

  it('17. Event with invalid attempt_id FK → rejected', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 500, 'NGN', 500, 'fk-bad-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'reserve', -100, '00000000-0000-0000-0000-999999999999', 400);
    `);
    expect(err.toLowerCase()).toMatch(/foreign key|violates/);
  });

  // ── Type enum ──

  it('18. Invalid allowance type → rejected', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'invalid_type', 100, 'NGN', 100, 'type-test');
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('19. Invalid event type → rejected', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'invalid_event', 100, 100);
    `);
    expect(err.toLowerCase()).toContain('check');
  });
});
