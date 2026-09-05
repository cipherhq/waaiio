/**
 * Messaging Allowance Schema DB Tests (#258 / Migration 368)
 *
 * Real PostgreSQL proofs for messaging_allowances,
 * messaging_allowance_events, constraints, partial unique indexes,
 * tenant consistency trigger, append-only triggers, RLS, and grants.
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

const BIZ_ID   = 'b0000000-0000-0000-0000-000000000258';
const BIZ_ID_B = 'b0000000-0000-0000-0000-000000000259'; // second tenant
const OWNER_A  = '00000000-0000-0000-0000-000000000001';
const OWNER_B  = '00000000-0000-0000-0000-000000000099';

describe.skipIf(!canRun)('Messaging Allowance Schema DB Tests (#258 / Migration 368)', () => {
  let allowanceId: string;
  let attemptId: string;

  beforeAll(() => {
    // Seed test businesses (two tenants)
    for (const [bizId, name, slug, owner] of [
      [BIZ_ID, 'Test258A', 'test258-ma-a', OWNER_A],
      [BIZ_ID_B, 'Test258B', 'test258-ma-b', OWNER_B],
    ] as const) {
      const r = psqlMayFail(`
        INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone)
        VALUES ('${bizId}', '${name}', '${slug}', '${owner}', '1 Test', 'T', 'T', '+1')
        ON CONFLICT (id) DO NOTHING;
      `);
      if (r.includes('ERROR') && !r.includes('duplicate')) throw new Error(r);
    }

    // Seed a business-scoped test attempt for FK references
    attemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);

    // Seed a test allowance
    allowanceId = psql(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'trial_grant', 10000, 'NGN', 10000, 'test-seed-258')
      ON CONFLICT (business_id, type, source_ref) DO UPDATE SET remaining_minor = 10000
      RETURNING id;
    `);
  });

  // ═══════════════════════════════════════════════════════
  // 1. Schema column/type/FK contract
  // ═══════════════════════════════════════════════════════

  it('1. messaging_allowances schema contract', () => {
    const cols = psql(`
      SELECT column_name || '|' || data_type || '|' || is_nullable
      FROM information_schema.columns
      WHERE table_name = 'messaging_allowances'
      ORDER BY ordinal_position;
    `);
    expect(cols).toContain('id|uuid|NO');
    expect(cols).toContain('business_id|uuid|NO');
    expect(cols).toContain('type|text|NO');
    expect(cols).toContain('amount_minor|integer|NO');
    expect(cols).toContain('currency_code|text|NO');
    expect(cols).toContain('remaining_minor|integer|NO');
    expect(cols).toContain('source_ref|text|NO');
    expect(cols).toContain('config_version_id|uuid|YES');
    expect(cols).toContain('expires_at|timestamp with time zone|YES');
    expect(cols).toContain('created_at|timestamp with time zone|NO');

    // FK: business_id → businesses(id)
    const fks = psql(`
      SELECT ccu.table_name || '.' || ccu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'messaging_allowances' AND tc.constraint_type = 'FOREIGN KEY';
    `);
    expect(fks).toContain('businesses.id');
    expect(fks).toContain('platform_config_versions.id');
  });

  it('2. messaging_allowance_events schema contract', () => {
    const cols = psql(`
      SELECT column_name || '|' || data_type || '|' || is_nullable
      FROM information_schema.columns
      WHERE table_name = 'messaging_allowance_events'
      ORDER BY ordinal_position;
    `);
    expect(cols).toContain('id|uuid|NO');
    expect(cols).toContain('allowance_id|uuid|NO');
    expect(cols).toContain('business_id|uuid|NO');
    expect(cols).toContain('event_type|text|NO');
    expect(cols).toContain('amount_minor|integer|NO');
    expect(cols).toContain('attempt_id|uuid|YES');
    expect(cols).toContain('source_key|text|YES');
    expect(cols).toContain('charge_type|text|YES');
    expect(cols).toContain('balance_after_minor|integer|NO');
    expect(cols).toContain('created_at|timestamp with time zone|NO');

    // FKs: allowance_id → messaging_allowances, business_id → businesses, attempt_id → message_send_attempts
    const fks = psql(`
      SELECT ccu.table_name || '.' || ccu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'messaging_allowance_events' AND tc.constraint_type = 'FOREIGN KEY';
    `);
    expect(fks).toContain('messaging_allowances.id');
    expect(fks).toContain('businesses.id');
    expect(fks).toContain('message_send_attempts.id');
  });

  // ═══════════════════════════════════════════════════════
  // 2. Allowance constraints
  // ═══════════════════════════════════════════════════════

  it('3. remaining_minor >= 0', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'purchased', 1000, 'NGN', -1, 'test-neg');
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('4. remaining_minor <= amount_minor', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'purchased', 1000, 'NGN', 2000, 'test-exceed');
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('5. UNIQUE(business_id, type, source_ref) prevents duplicate grants', () => {
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

  it('6. Invalid allowance type → rejected', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'invalid_type', 100, 'NGN', 100, 'type-test');
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('7. Invalid event type → rejected', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'invalid_event', 100, 100);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  // ═══════════════════════════════════════════════════════
  // 3. Partial unique indexes — idempotency
  // ═══════════════════════════════════════════════════════

  it('8. Grant event duplicate → rejected', () => {
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

  it('9. Expire event duplicate → rejected', () => {
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

  it('10. Reserve duplicate for same (allowance, attempt) → rejected', () => {
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

  it('11. Charge duplicate for same (allowance, attempt) → rejected', () => {
    psql(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'charge', -100, '${attemptId}', 9800)
      ON CONFLICT DO NOTHING;
    `);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'charge', -100, '${attemptId}', 9800);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('12. Release duplicate for same (allowance, attempt) → rejected', () => {
    psql(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'release', 100, '${attemptId}', 9900)
      ON CONFLICT DO NOTHING;
    `);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'release', 100, '${attemptId}', 9900);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  // ═══════════════════════════════════════════════════════
  // 4. attempt_id required for reserve|charge|release
  // ═══════════════════════════════════════════════════════

  it('13. Reserve with NULL attempt_id → rejected by CHECK', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'reserve', -100, 9900);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('14. Charge with NULL attempt_id → rejected by CHECK', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'charge', -100, 9900);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('15. Release with NULL attempt_id → rejected by CHECK', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'release', 100, 10100);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  // ═══════════════════════════════════════════════════════
  // 5. Adjust constraints
  // ═══════════════════════════════════════════════════════

  it('16. Adjust with NULL source_key → rejected by CHECK', () => {
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'adjust', 50, 10050, NULL);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('17. Adjust replay with same source_key → rejected; different → accepted', () => {
    psql(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'adjust', 50, 10050, 'adj-key-1')
      ON CONFLICT DO NOTHING;
    `);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'adjust', 50, 10050, 'adj-key-1');
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);

    const ok = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'adjust', 25, 10075, 'adj-key-2');
    `);
    expect(ok).not.toContain('ERROR');
  });

  // ═══════════════════════════════════════════════════════
  // 6. Tenant consistency enforcement (trigger)
  // ═══════════════════════════════════════════════════════

  it('18. Mismatched event business_id vs allowance business_id → rejected', () => {
    // allowanceId belongs to BIZ_ID; inserting event claiming BIZ_ID_B → rejected
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID_B}', 'grant', 100, 100);
    `);
    expect(err).toContain('does not match allowance business_id');
  });

  it('19. Valid same-business event → accepted', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'tenant-ok-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const result = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100);
    `);
    expect(result).not.toContain('ERROR');
  });

  it('20. Attempt from different business → rejected by tenant trigger', () => {
    // Create an attempt for BIZ_ID_B, try to use it in an event for BIZ_ID allowance
    const otherAttempt = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID_B}', '+1', 'business') RETURNING id;`);
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 200, 'NGN', 200, 'tenant-attempt-mismatch-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'reserve', -100, '${otherAttempt}', 100);
    `);
    expect(err).toContain('attempt business_id');
    expect(err).toContain('does not match event business_id');
  });

  it('21. Platform-scoped attempt → rejected by tenant trigger', () => {
    // Create a platform-scoped attempt
    const platformAttempt = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'platform') RETURNING id;`);
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 200, 'NGN', 200, 'platform-scope-reject-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'reserve', -100, '${platformAttempt}', 100);
    `);
    expect(err).toContain('only business-scoped attempts allowed');
  });

  // ═══════════════════════════════════════════════════════
  // 7. Append-only enforcement
  // ═══════════════════════════════════════════════════════

  it('22. Superuser UPDATE of event → rejected by trigger', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'append-upd-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const eventId = psql(`INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor) VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100) RETURNING id;`);
    const err = psqlMayFail(`
      UPDATE messaging_allowance_events SET amount_minor = 999 WHERE id = '${eventId}';
    `);
    expect(err).toContain('append-only');
  });

  it('23. Superuser DELETE of event → rejected by trigger', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'append-del-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const eventId = psql(`INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor) VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100) RETURNING id;`);
    const err = psqlMayFail(`
      DELETE FROM messaging_allowance_events WHERE id = '${eventId}';
    `);
    expect(err).toContain('append-only');
  });

  it('24. service_role UPDATE of event → rejected by trigger', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'svc-upd-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const eventId = psql(`INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor) VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100) RETURNING id;`);
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE messaging_allowance_events SET amount_minor = 999 WHERE id = '${eventId}';
      RESET ROLE;
    `);
    expect(err).toContain('append-only');
  });

  it('25. service_role DELETE of event → rejected by trigger', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'svc-del-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const eventId = psql(`INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor) VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100) RETURNING id;`);
    const err = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM messaging_allowance_events WHERE id = '${eventId}';
      RESET ROLE;
    `);
    // service_role has no DELETE grant, so either permission denied or trigger fires
    expect(err.toLowerCase()).toMatch(/append-only|permission denied/);
  });

  // ═══════════════════════════════════════════════════════
  // 8. RLS — own-tenant positive + cross-tenant negative
  // ═══════════════════════════════════════════════════════

  it('26. Own-tenant SELECT succeeds (allowances)', () => {
    const CLAIMS = `{"sub":"${OWNER_A}","role":"authenticated"}`;
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM messaging_allowances WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    // OWNER_A owns BIZ_ID, should see rows
    expect(parseInt(count.split('\n').pop()!)).toBeGreaterThan(0);
  });

  it('27. Cross-tenant SELECT denied (allowances)', () => {
    const CLAIMS = `{"sub":"${OWNER_B}","role":"authenticated"}`;
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM messaging_allowances WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(count.split('\n').pop()).toBe('0');
  });

  it('28. Own-tenant SELECT succeeds (events)', () => {
    const CLAIMS = `{"sub":"${OWNER_A}","role":"authenticated"}`;
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM messaging_allowance_events WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(parseInt(count.split('\n').pop()!)).toBeGreaterThan(0);
  });

  it('29. Cross-tenant SELECT denied (events)', () => {
    const CLAIMS = `{"sub":"${OWNER_B}","role":"authenticated"}`;
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM messaging_allowance_events WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(count.split('\n').pop()).toBe('0');
  });

  // ═══════════════════════════════════════════════════════
  // 9. Grants — authenticated mutation denial
  // ═══════════════════════════════════════════════════════

  it('30. Authenticated cannot INSERT allowances', () => {
    const CLAIMS = `{"sub":"${OWNER_A}","role":"authenticated"}`;
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
      VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'auth-insert-test');
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toMatch(/permission denied|row-level security/);
  });

  it('31. Authenticated cannot INSERT events', () => {
    const CLAIMS = `{"sub":"${OWNER_A}","role":"authenticated"}`;
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${allowanceId}', '${BIZ_ID}', 'grant', 100, 100);
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toMatch(/permission denied|row-level security/);
  });

  it('32. Service-role CAN INSERT events', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 100, 'NGN', 100, 'svc-event-test-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const result = psqlMayFail(`
      SET ROLE service_role;
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'grant', 100, 100);
      RESET ROLE;
    `);
    expect(result).not.toContain('permission denied');
  });

  // ═══════════════════════════════════════════════════════
  // 10. Effective ACLs — no DELETE/TRUNCATE path
  // ═══════════════════════════════════════════════════════

  it('33. Effective ACL: no role has DELETE on messaging_allowance_events', () => {
    const deletePrivs = psql(`
      SELECT grantee FROM information_schema.table_privileges
      WHERE table_name = 'messaging_allowance_events' AND privilege_type = 'DELETE'
      AND grantee IN ('authenticated', 'service_role', 'anon');
    `);
    expect(deletePrivs).toBe('');
  });

  it('34. Effective ACL: no application role has TRUNCATE on messaging_allowance_events', () => {
    const truncPrivs = psql(`
      SELECT grantee FROM information_schema.table_privileges
      WHERE table_name = 'messaging_allowance_events' AND privilege_type = 'TRUNCATE'
      AND grantee IN ('authenticated', 'service_role', 'anon');
    `);
    expect(truncPrivs).toBe('');
  });

  it('35. Effective ACL: service_role has only SELECT+INSERT on events', () => {
    const privs = psql(`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_name = 'messaging_allowance_events' AND grantee = 'service_role'
      ORDER BY privilege_type;
    `);
    expect(privs.split('\n').sort()).toEqual(['INSERT', 'SELECT']);
  });

  it('36. Effective ACL: authenticated has only SELECT on events', () => {
    const privs = psql(`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_name = 'messaging_allowance_events' AND grantee = 'authenticated'
      ORDER BY privilege_type;
    `);
    expect(privs).toBe('SELECT');
  });

  it('37. Effective ACL: authenticated has only SELECT on allowances', () => {
    const privs = psql(`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_name = 'messaging_allowances' AND grantee = 'authenticated'
      ORDER BY privilege_type;
    `);
    expect(privs).toBe('SELECT');
  });

  // ═══════════════════════════════════════════════════════
  // 11. FK to message_send_attempts
  // ═══════════════════════════════════════════════════════

  it('38. Event with valid attempt_id FK succeeds', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 500, 'NGN', 500, 'fk-test-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const result = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'reserve', -100, '${attemptId}', 400);
    `);
    expect(result).not.toContain('ERROR');
  });

  it('39. Event with invalid attempt_id FK → rejected', () => {
    const aId = psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${BIZ_ID}', 'purchased', 500, 'NGN', 500, 'fk-bad-' || substr(md5(random()::text),1,8)) RETURNING id;`);
    const err = psqlMayFail(`
      INSERT INTO messaging_allowance_events (allowance_id, business_id, event_type, amount_minor, attempt_id, balance_after_minor)
      VALUES ('${aId}', '${BIZ_ID}', 'reserve', -100, '00000000-0000-0000-0000-999999999999', 400);
    `);
    expect(err.toLowerCase()).toMatch(/foreign key|violates/);
  });
});
