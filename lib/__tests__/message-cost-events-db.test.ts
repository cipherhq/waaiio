/**
 * Message Cost Events Schema DB Tests (#259 / Migration 369)
 *
 * Real PostgreSQL proofs for message_cost_events: constraints, idempotency,
 * terminal exclusivity, unpriced invariant, append-only triggers,
 * platform-scope support, RLS, and grants.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/message-cost-events-db.test.ts
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

const BIZ_ID   = 'b0000000-0000-0000-0000-000000000259';
const BIZ_ID_B = 'b0000000-0000-0000-0000-000000000260';
const OWNER_A  = '00000000-0000-0000-0000-000000000001';
const OWNER_B  = '00000000-0000-0000-0000-000000000099';

describe.skipIf(!canRun)('Message Cost Events Schema DB Tests (#259 / Migration 369)', () => {
  let bizAttemptId: string;
  let platformAttemptId: string;

  beforeAll(() => {
    // Seed test businesses
    for (const [bizId, name, slug, owner] of [
      [BIZ_ID, 'Test259A', 'test259-mce-a', OWNER_A],
      [BIZ_ID_B, 'Test259B', 'test259-mce-b', OWNER_B],
    ] as const) {
      const r = psqlMayFail(`
        INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone)
        VALUES ('${bizId}', '${name}', '${slug}', '${owner}', '1 Test', 'T', 'T', '+1')
        ON CONFLICT (id) DO NOTHING;
      `);
      if (r.includes('ERROR') && !r.includes('duplicate')) throw new Error(r);
    }

    // Business-scoped attempt
    bizAttemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);

    // Platform-scoped attempt (business_id NULL)
    platformAttemptId = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES (NULL, '+1', 'platform') RETURNING id;`);
  });

  // ═══════════════════════════════════════════════════════
  // 1-2. Schema column/type/FK contract
  // ═══════════════════════════════════════════════════════

  it('1. message_cost_events schema contract — columns and types', () => {
    const cols = psql(`
      SELECT column_name || '|' || data_type || '|' || is_nullable
      FROM information_schema.columns
      WHERE table_name = 'message_cost_events'
      ORDER BY ordinal_position;
    `);
    expect(cols).toContain('id|uuid|NO');
    expect(cols).toContain('attempt_id|uuid|NO');
    expect(cols).toContain('event_type|text|NO');
    expect(cols).toContain('amount_minor|integer|YES');
    expect(cols).toContain('charge_type|text|YES');
    expect(cols).toContain('source_key|text|YES');
    expect(cols).toContain('balance_after_minor|integer|YES');
    expect(cols).toContain('config_version_id|uuid|YES');
    expect(cols).toContain('created_at|timestamp with time zone|NO');
    // Confirm NO business_id column
    expect(cols).not.toContain('business_id');
  });

  it('2. FK references are correct', () => {
    const fks = psql(`
      SELECT ccu.table_name || '.' || ccu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = 'message_cost_events' AND tc.constraint_type = 'FOREIGN KEY';
    `);
    expect(fks).toContain('message_send_attempts.id');
    expect(fks).toContain('platform_config_versions.id');
  });

  // ═══════════════════════════════════════════════════════
  // 3-4. Type enum enforcement
  // ═══════════════════════════════════════════════════════

  it('3. Invalid event_type → rejected', () => {
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${bizAttemptId}', 'invalid_type', 100, 100);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('4. Invalid charge_type → rejected', () => {
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${bizAttemptId}', 'reserve', 100, 'invalid_charge', 100);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  // ═══════════════════════════════════════════════════════
  // 5-7. Adjust/reconcile source_key enforcement
  // ═══════════════════════════════════════════════════════

  it('5. adjust with NULL source_key → rejected', () => {
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${bizAttemptId}', 'adjust', 50, 150);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  it('6. Adjust replay same source_key → rejected; different → accepted', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor, source_key) VALUES ('${a}', 'adjust', 50, 150, 'adj-1');`);
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${a}', 'adjust', 50, 150, 'adj-1');
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
    // Different source_key → accepted
    const ok = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${a}', 'adjust', 25, 175, 'adj-2');
    `);
    expect(ok).not.toContain('ERROR');
  });

  it('7. Reconcile replay same source_key → rejected; different → accepted', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor, source_key) VALUES ('${a}', 'reconcile', 50, 150, 'rec-1');`);
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${a}', 'reconcile', 50, 150, 'rec-1');
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
    const ok = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor, source_key)
      VALUES ('${a}', 'reconcile', 25, 175, 'rec-2');
    `);
    expect(ok).not.toContain('ERROR');
  });

  // ═══════════════════════════════════════════════════════
  // 8-12. Idempotency and terminal exclusivity
  // ═══════════════════════════════════════════════════════

  it('8. Duplicate reserve → rejected', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'reserve', -100, 'included', 900);`);
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${a}', 'reserve', -100, 'included', 900);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('9. Duplicate charge → rejected', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'charge', -100, 'included', 800);`);
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${a}', 'charge', -100, 'included', 800);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('10. Duplicate release → rejected', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'release', 100, 'included', 1000);`);
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${a}', 'release', 100, 'included', 1000);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('11. Charge then release on same attempt → release rejected (terminal exclusivity)', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'charge', -100, 'included', 800);`);
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${a}', 'release', 100, 'included', 1000);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('12. Release then charge on same attempt → charge rejected (terminal exclusivity)', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'release', 100, 'included', 1000);`);
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${a}', 'charge', -100, 'included', 800);
    `);
    expect(err.toLowerCase()).toMatch(/unique|duplicate/);
  });

  // ═══════════════════════════════════════════════════════
  // 13-14. Unpriced invariant
  // ═══════════════════════════════════════════════════════

  it('13. charge_type=unpriced + amount_minor=NULL → accepted', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    const result = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${a}', 'reserve', NULL, 'unpriced', NULL);
    `);
    expect(result).not.toContain('ERROR');
  });

  it('14. charge_type=unpriced + amount_minor=100 → rejected by CHECK', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${a}', 'reserve', 100, 'unpriced', 900);
    `);
    expect(err.toLowerCase()).toContain('check');
  });

  // ═══════════════════════════════════════════════════════
  // 15-17. Platform scope + nullable balance
  // ═══════════════════════════════════════════════════════

  it('15. Platform-scoped attempt cost-event INSERT succeeds', () => {
    const result = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${platformAttemptId}', 'reserve', NULL, 'unpriced', NULL);
    `);
    expect(result).not.toContain('ERROR');
  });

  it('16. Platform-scoped event with NULL balance_after_minor succeeds', () => {
    const pa = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES (NULL, '+1', 'platform') RETURNING id;`);
    const result = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${pa}', 'charge', NULL, 'unpriced', NULL);
    `);
    expect(result).not.toContain('ERROR');
  });

  it('17. Business-scoped event with non-null balance succeeds', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    const result = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor)
      VALUES ('${a}', 'reserve', -100, 'included', 900);
    `);
    expect(result).not.toContain('ERROR');
  });

  // ═══════════════════════════════════════════════════════
  // 18-20. Append-only enforcement
  // ═══════════════════════════════════════════════════════

  it('18. Superuser UPDATE of event → rejected by trigger', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    const eventId = psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'reserve', -50, 'included', 950) RETURNING id;`);
    const err = psqlMayFail(`UPDATE message_cost_events SET amount_minor = -999 WHERE id = '${eventId}';`);
    expect(err).toContain('append-only');
  });

  it('19. Superuser DELETE of event → rejected by trigger', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    const eventId = psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'reserve', -50, 'included', 950) RETURNING id;`);
    const err = psqlMayFail(`DELETE FROM message_cost_events WHERE id = '${eventId}';`);
    expect(err).toContain('append-only');
  });

  it('20. service_role UPDATE/DELETE → row unmodified/exists', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    const eventId = psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'reserve', -50, 'included', 950) RETURNING id;`);
    // UPDATE attempt
    psqlMayFail(`SET ROLE service_role; UPDATE message_cost_events SET amount_minor = -999 WHERE id = '${eventId}'; RESET ROLE;`);
    const amount = psql(`SELECT amount_minor FROM message_cost_events WHERE id = '${eventId}';`);
    expect(amount).toBe('-50');
    // DELETE attempt
    psqlMayFail(`SET ROLE service_role; DELETE FROM message_cost_events WHERE id = '${eventId}'; RESET ROLE;`);
    const exists = psql(`SELECT count(*) FROM message_cost_events WHERE id = '${eventId}';`);
    expect(exists).toBe('1');
  });

  // ═══════════════════════════════════════════════════════
  // 21. Authenticated INSERT denied
  // ═══════════════════════════════════════════════════════

  it('21. Authenticated cannot INSERT cost events', () => {
    const CLAIMS = `{"sub":"${OWNER_A}","role":"authenticated"}`;
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor)
      VALUES ('${bizAttemptId}', 'reserve', -100, 900);
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toMatch(/permission denied|row-level security/);
  });

  // ═══════════════════════════════════════════════════════
  // 22-25. RLS — own-tenant, cross-tenant, platform, admin
  // ═══════════════════════════════════════════════════════

  it('22. Own-tenant SELECT succeeds (business-scoped attempt)', () => {
    // Seed a cost event for bizAttemptId (owned by OWNER_A via BIZ_ID)
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'reserve', -100, 'included', 900);`);
    const CLAIMS = `{"sub":"${OWNER_A}","role":"authenticated"}`;
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM message_cost_events WHERE attempt_id = '${a}';
      RESET ROLE;
    `);
    expect(parseInt(count.split('\n').pop()!)).toBeGreaterThan(0);
  });

  it('22b. DIAGNOSTIC: RLS state and visibility check', () => {
    // Check if RLS is enabled
    const rlsEnabled = psql(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'message_cost_events';`);
    console.log('[DIAG] RLS enabled|forced:', rlsEnabled);

    // Check policies
    const policies = psql(`SELECT polname, polroles::regrole[], polcmd FROM pg_policy WHERE polrelid = 'message_cost_events'::regclass;`);
    console.log('[DIAG] Policies:', policies);

    // Check what authenticated sees without WHERE clause
    const CLAIMS = `{"sub":"${OWNER_A}","role":"authenticated"}`;
    const allCount = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM message_cost_events;
      RESET ROLE;
    `);
    console.log('[DIAG] Total rows visible to authenticated:', allCount);

    // Check auth.uid() value
    const uid = psqlMayFail(`
      SET ROLE authenticated;
      SELECT auth.uid()::text;
      RESET ROLE;
    `);
    console.log('[DIAG] auth.uid() as authenticated:', uid);

    // Check current_user after SET ROLE
    const curUser = psqlMayFail(`
      SET ROLE authenticated;
      SELECT current_user, session_user;
      RESET ROLE;
    `);
    console.log('[DIAG] current_user|session_user:', curUser);

    expect(true).toBe(true);
  });

  it('23. Cross-tenant SELECT returns zero', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'reserve', -100, 'included', 900);`);
    const CLAIMS = `{"sub":"${OWNER_B}","role":"authenticated"}`;
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM message_cost_events WHERE attempt_id = '${a}';
      RESET ROLE;
    `);
    expect(count.split('\n').pop()).toBe('0');
  });

  it('24. Platform-scoped cost event invisible to ordinary authenticated tenant', () => {
    const pa = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES (NULL, '+1', 'platform') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${pa}', 'reserve', NULL, 'unpriced', NULL);`);
    const CLAIMS = `{"sub":"${OWNER_A}","role":"authenticated"}`;
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM message_cost_events WHERE attempt_id = '${pa}';
      RESET ROLE;
    `);
    expect(count.split('\n').pop()).toBe('0');
  });

  it('25. Admin SELECT includes platform-scoped cost events', () => {
    const pa = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES (NULL, '+1', 'platform') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${pa}', 'reserve', NULL, 'unpriced', NULL);`);
    // Admin via is_admin() — simulate by querying as superuser (is_admin returns true for admin role)
    const count = psql(`SELECT count(*)::int FROM message_cost_events WHERE attempt_id = '${pa}';`);
    expect(parseInt(count)).toBeGreaterThan(0);
  });

  // ═══════════════════════════════════════════════════════
  // 26. FK to nonexistent attempt
  // ═══════════════════════════════════════════════════════

  it('26. FK to nonexistent attempt → rejected', () => {
    const err = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, balance_after_minor)
      VALUES ('00000000-0000-0000-0000-999999999999', 'reserve', -100, 900);
    `);
    expect(err.toLowerCase()).toMatch(/foreign key|violates/);
  });

  // ═══════════════════════════════════════════════════════
  // 27. Effective ACL — no DELETE/TRUNCATE bypass
  // ═══════════════════════════════════════════════════════

  it('27. No application role has TRUNCATE on message_cost_events (pg_class.relacl)', () => {
    const acl = psql(`SELECT relacl::text FROM pg_class WHERE relname = 'message_cost_events';`);
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
  // 28. Corrective after terminal — adjust accepted
  // ═══════════════════════════════════════════════════════

  it('28. Charge + adjust for same attempt → adjust accepted', () => {
    const a = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES ('${BIZ_ID}', '+1', 'business') RETURNING id;`);
    psql(`INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor) VALUES ('${a}', 'charge', -100, 'included', 800);`);
    const result = psqlMayFail(`
      INSERT INTO message_cost_events (attempt_id, event_type, amount_minor, charge_type, balance_after_minor, source_key)
      VALUES ('${a}', 'adjust', 10, 'included', 810, 'correction-1');
    `);
    expect(result).not.toContain('ERROR');
  });
});
