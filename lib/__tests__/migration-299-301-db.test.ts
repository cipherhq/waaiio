/**
 * Real PostgreSQL authorization and transaction tests for migrations 299–301.
 *
 * Runs against the CI PostgreSQL 15 service where ALL migrations have been applied.
 * Requires TEST_DATABASE_URL environment variable.
 *
 * CI Step: "Migration 299-301 capability RPC tests"
 * Must run with zero skips.
 *
 * Role accuracy:
 * - Tests labeled "service_role" execute with SET LOCAL ROLE service_role
 * - Tests labeled "authenticated" execute with SET LOCAL ROLE authenticated + JWT claims
 * - Tests labeled "anon" execute with SET LOCAL ROLE anon
 * - No test relies on postgres superuser to prove service_role behavior
 *
 * Concurrency tests use child_process.spawn with two independent psql sessions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('Migration 299-301 DB tests (TEST_DATABASE_URL not set)', () => {
    it('skipped', () => {});
  });
} else {

/**
 * Run SQL as a specific PostgreSQL role.
 * When role is specified, wraps in BEGIN + SET LOCAL ROLE.
 * When role is omitted, runs as postgres (only for fixture setup/teardown).
 */
function runSQL(sql: string, role?: string): { stdout: string; stderr: string; exitCode: number } {
  let fullSql: string;
  if (role) {
    // Wrap in transaction with role switch — SET LOCAL ROLE only affects this transaction
    fullSql = `BEGIN; SET LOCAL ROLE ${role};\n${sql}\nCOMMIT;`;
  } else {
    fullSql = sql;
  }
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { stdout: (e.stdout || '').trim(), stderr: (e.stderr || '').trim(), exitCode: e.status || 1 };
  }
}

/**
 * Run SQL as authenticated user with JWT claims.
 */
function runAsAuthenticated(sql: string, userId: string): { stdout: string; stderr: string; exitCode: number } {
  const claims = JSON.stringify({ sub: userId }).replace(/'/g, "''");
  const fullSql = `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = '${claims}';\n${sql}\nCOMMIT;`;
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { stdout: (e.stdout || '').trim(), stderr: (e.stderr || '').trim(), exitCode: e.status || 1 };
  }
}

/**
 * Run two concurrent psql sessions with controlled transaction ordering.
 * Session A executes sqlA, pauses at pg_advisory_lock. Session B runs sqlB.
 * Then session A is released. Returns both results.
 */
function runTwoSessions(
  sqlA: string,
  sqlB: string,
  opts?: { timeoutMs?: number }
): Promise<{ a: { stdout: string; stderr: string; exitCode: number }; b: { stdout: string; stderr: string; exitCode: number } }> {
  const timeout = opts?.timeoutMs || 15000;

  return new Promise((resolve) => {
    let aStdout = '';
    let aStderr = '';
    let aExitCode = 0;
    let bStdout = '';
    let bStderr = '';
    let bExitCode = 0;

    // Session A — starts first, acquires FOR UPDATE lock
    const procA = spawn('psql', [dbUrl!, '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { timeout });
    procA.stdin.write(sqlA);
    procA.stdin.end();

    procA.stdout.on('data', (d: Buffer) => { aStdout += d.toString(); });
    procA.stderr.on('data', (d: Buffer) => { aStderr += d.toString(); });

    // Give session A 500ms to acquire lock, then start session B
    setTimeout(() => {
      const procB = spawn('psql', [dbUrl!, '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { timeout });
      procB.stdin.write(sqlB);
      procB.stdin.end();

      procB.stdout.on('data', (d: Buffer) => { bStdout += d.toString(); });
      procB.stderr.on('data', (d: Buffer) => { bStderr += d.toString(); });

      procB.on('close', (code: number | null) => {
        bExitCode = code || 0;
      });

      procA.on('close', (code: number | null) => {
        aExitCode = code || 0;
        // Wait for B to also finish
        setTimeout(() => {
          resolve({
            a: { stdout: aStdout.trim(), stderr: aStderr.trim(), exitCode: aExitCode },
            b: { stdout: bStdout.trim(), stderr: bStderr.trim(), exitCode: bExitCode },
          });
        }, 1000);
      });
    }, 500);
  });
}

const TEST_USER_ID = '88aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEST_BIZ_ID = '88bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_USER_ID = '88cccccc-cccc-cccc-cccc-cccccccccccc';

beforeAll(() => {
  // Create test fixtures — disable trigger to avoid handle_new_user phone column issue
  runSQL(`
    ALTER TABLE auth.users DISABLE TRIGGER ALL;
    INSERT INTO auth.users (id, email) VALUES ('${TEST_USER_ID}', 'cap-test@test.local') ON CONFLICT DO NOTHING;
    INSERT INTO auth.users (id, email) VALUES ('${OTHER_USER_ID}', 'cap-other@test.local') ON CONFLICT DO NOTHING;
    ALTER TABLE auth.users ENABLE TRIGGER ALL;
    INSERT INTO profiles (id) VALUES ('${TEST_USER_ID}') ON CONFLICT DO NOTHING;
    INSERT INTO profiles (id) VALUES ('${OTHER_USER_ID}') ON CONFLICT DO NOTHING;
    INSERT INTO businesses (id, name, slug, owner_id, bot_code, city, address, phone, status, wa_method, country_code, category)
    VALUES ('${TEST_BIZ_ID}', 'Cap Test', 'cap-test-299', '${TEST_USER_ID}', 'CAPTEST', 'Lagos', '1 Test', '+2340000', 'active', 'shared', 'NG', 'salon')
    ON CONFLICT DO NOTHING;
  `);
  // Clear test capability rows
  runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
  runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
  runSQL(`DELETE FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}';`);

  // Grant service_role table-level permissions needed for these tests.
  // In production Supabase, service_role has full table grants.
  // The RLS policies (migration 299) use TO service_role for UPDATE/DELETE.
  // We need the base table grant for RLS policies to be evaluable.
  runSQL(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE business_capabilities TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE capability_overrides TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE admin_audit_logs TO service_role;
    GRANT SELECT, UPDATE ON TABLE businesses TO service_role;
  `);

  // Install a test-safe auth.uid() that reads JWT claims
  runSQL(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT COALESCE(
        (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::UUID,
        '00000000-0000-0000-0000-000000000000'::UUID
      );
    $$ LANGUAGE SQL STABLE;
  `);
});

afterAll(() => {
  runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
  runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
  runSQL(`DELETE FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}';`);
  // Restore original auth.uid() stub
  runSQL(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT '00000000-0000-0000-0000-000000000000'::UUID;
    $$ LANGUAGE SQL STABLE;
  `);
});

// ═══════════════════════════════════════
// Migration 299 — RLS authorization
// ═══════════════════════════════════════

describe('Migration 299: business_capabilities RLS', () => {
  beforeAll(() => {
    // Seed a capability row via postgres (fixture setup only)
    runSQL(`
      INSERT INTO business_capabilities (business_id, capability, is_enabled)
      VALUES ('${TEST_BIZ_ID}', 'scheduling', true) ON CONFLICT DO NOTHING;
    `);
  });

  it('assert current_user for service_role', () => {
    const r = runSQL(`SELECT current_user;`, 'service_role');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('service_role');
  });

  it('service_role SELECT is allowed', () => {
    const r = runSQL(`
      SELECT capability FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';
    `, 'service_role');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('scheduling');
  });

  it('owner SELECT is allowed via auth.uid()', () => {
    const r = runAsAuthenticated(
      `SELECT capability FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`,
      TEST_USER_ID,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('scheduling');
  });

  it('unrelated authenticated SELECT is denied', () => {
    const r = runAsAuthenticated(
      `SELECT capability FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`,
      OTHER_USER_ID,
    );
    // Should return no rows (RLS filters) — not an error, just empty
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('scheduling');
  });

  it('owner direct INSERT is denied', () => {
    const r = runAsAuthenticated(
      `INSERT INTO business_capabilities (business_id, capability, is_enabled) VALUES ('${TEST_BIZ_ID}', 'payment', true);`,
      TEST_USER_ID,
    );
    expect(r.exitCode).not.toBe(0);
  });

  it('owner direct UPDATE is denied', () => {
    const r = runAsAuthenticated(
      `UPDATE business_capabilities SET is_enabled = false WHERE business_id = '${TEST_BIZ_ID}';`,
      TEST_USER_ID,
    );
    expect(r.exitCode).not.toBe(0);
  });

  it('owner direct DELETE is denied', () => {
    const r = runAsAuthenticated(
      `DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`,
      TEST_USER_ID,
    );
    expect(r.exitCode).not.toBe(0);
  });

  it('unrelated authenticated writes denied', () => {
    const r = runAsAuthenticated(
      `UPDATE business_capabilities SET is_enabled = false WHERE business_id = '${TEST_BIZ_ID}';`,
      OTHER_USER_ID,
    );
    expect(r.exitCode).not.toBe(0);
  });

  it('service_role mutation succeeds', () => {
    const r = runSQL(`
      UPDATE business_capabilities SET is_enabled = false WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'scheduling';
    `, 'service_role');
    expect(r.exitCode).toBe(0);
    // Restore
    runSQL(`UPDATE business_capabilities SET is_enabled = true WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'scheduling';`);
  });

  it('anon SELECT is denied', () => {
    const r = runSQL(`
      SELECT capability FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';
    `, 'anon');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('scheduling');
  });

  it('no alternate permissive policy grants writes', () => {
    // Attempt UPDATE as anon — must fail
    const r = runSQL(`
      UPDATE business_capabilities SET is_enabled = false WHERE business_id = '${TEST_BIZ_ID}';
    `, 'anon');
    expect(r.exitCode).not.toBe(0);
  });
});

// ═══════════════════════════════════════
// Migration 300 — configure_business_capabilities RPC
// ═══════════════════════════════════════

describe('Migration 300: configure_business_capabilities RPC', () => {
  beforeAll(() => {
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
  });

  it('assert current_user for service_role execution', () => {
    const r = runSQL(`SELECT current_user;`, 'service_role');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('service_role');
  });

  it('service_role can execute the RPC', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','payment'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).toBe(0);
    // Verify state
    const check = runSQL(`SELECT capability, is_enabled, sort_order FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' ORDER BY sort_order;`);
    expect(check.stdout).toContain('scheduling');
    expect(check.stdout).toContain('payment');
  });

  it('duplicate capabilities rejected', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','scheduling'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('duplicate');
  });

  it('empty capabilities rejected', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY[]::TEXT[], ARRAY[]::INT[], NULL, NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
  });

  it('mismatched array lengths rejected', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
  });

  it('negative sort order rejected', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[-1], NULL, NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('sort orders must be between 0 and 9999');
  });

  it('out-of-range sort order rejected', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[10000], NULL, NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
  });

  it('duplicate sort orders rejected', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','payment'], ARRAY[0,0], NULL, NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('duplicate sort orders');
  });

  it('custom_label and config are preserved', () => {
    // Set a custom label
    runSQL(`UPDATE business_capabilities SET custom_label = 'My Custom' WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'scheduling';`);
    // Reconfigure
    runSQL(`SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','chat'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);`, 'service_role');
    // Verify custom_label preserved
    const r = runSQL(`SELECT custom_label FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'scheduling';`);
    expect(r.stdout).toContain('My Custom');
  });

  it('retry is idempotent', () => {
    runSQL(`SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','payment'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);`, 'service_role');
    const first = runSQL(`SELECT capability, sort_order FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND is_enabled = true ORDER BY sort_order;`);
    runSQL(`SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','payment'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);`, 'service_role');
    const second = runSQL(`SELECT capability, sort_order FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND is_enabled = true ORDER BY sort_order;`);
    expect(first.stdout).toBe(second.stdout);
  });

  it('anon cannot execute the RPC', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0], NULL, NULL, NULL, NULL, NULL);
    `, 'anon');
    expect(r.exitCode).not.toBe(0);
  });

  it('authenticated cannot execute the RPC', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0], NULL, NULL, NULL, NULL, NULL);
    `, 'authenticated');
    expect(r.exitCode).not.toBe(0);
  });

  // ── Stale-read snapshot tests ──

  it('stale tier raises configuration_conflict', () => {
    // Current tier is 'free' (from fixture), pass stale 'growth'
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0], 'growth', NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('configuration_conflict: tier changed');
  });

  it('stale status raises configuration_conflict', () => {
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0], NULL, NULL, 'suspended', NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('configuration_conflict: status changed');
  });

  it('stale trial raises configuration_conflict', () => {
    // Business has no trial, pass a non-null trial expectation
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0], NULL, '2025-01-01T00:00:00Z', NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('configuration_conflict: trial changed');
  });

  it('stale selected-capability set raises configuration_conflict', () => {
    // Setup: ensure current selected is [scheduling, payment]
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','payment'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);`, 'service_role');
    // Pass stale expected_selected that includes 'chat' which is not actually selected
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0], NULL, NULL, NULL, ARRAY['scheduling','chat'], NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('configuration_conflict: selected capabilities changed');
  });

  it('stale override set raises configuration_conflict', () => {
    // No overrides exist, pass stale expected that claims one exists
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0], NULL, NULL, NULL, NULL, ARRAY['staff']);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('configuration_conflict: overrides changed');
  });

  it('unchanged snapshot succeeds', () => {
    // Setup known state
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','payment'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);`, 'service_role');
    // Now call with matching snapshot
    const r = runSQL(`
      SELECT configure_business_capabilities(
        '${TEST_BIZ_ID}', ARRAY['scheduling','chat'], ARRAY[0,1],
        'free', NULL, 'active',
        ARRAY['payment','scheduling'], NULL
      );
    `, 'service_role');
    // Note: expected_selected is sorted canonically so order doesn't matter
    expect(r.exitCode).toBe(0);
  });

  // ── Forced rollback test ──

  it('forced failure after disable stage rolls back capability state', () => {
    // Setup: scheduling and payment enabled
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','payment'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);`, 'service_role');

    // Attempt with an invalid capability type to trigger a cast error in the upsert loop
    const r = runSQL(`
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','INVALID_NOT_A_CAP'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);
    `, 'service_role');
    expect(r.exitCode).not.toBe(0);

    // Verify original state is preserved (transaction rolled back)
    const check = runSQL(`SELECT capability, is_enabled FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND is_enabled = true ORDER BY capability;`);
    expect(check.stdout).toContain('payment');
    expect(check.stdout).toContain('scheduling');
  });
});

// ═══════════════════════════════════════
// Migration 300 — Two-session concurrency test
// ═══════════════════════════════════════

describe('Migration 300: two-session concurrency', () => {
  beforeAll(() => {
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    // Setup initial state: [scheduling, staff]
    runSQL(`SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','staff'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);`, 'service_role');
  });

  it('concurrent configurations serialize — second session blocked until first commits', async () => {
    // Session A: configure to [scheduling, payment] — holds FOR UPDATE lock
    const sqlA = `
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','payment'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);
      SELECT pg_sleep(1);
      COMMIT;
    `;
    // Session B: configure to [scheduling, chat] — will be blocked by A's lock
    const sqlB = `
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','chat'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);
      COMMIT;
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB, { timeoutMs: 20000 });
    // Both should succeed (serialized)
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    // Final state is deterministic — last writer wins (B commits after A)
    const check = runSQL(`SELECT capability FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND is_enabled = true ORDER BY capability;`);
    expect(check.stdout).toContain('chat');
    expect(check.stdout).toContain('scheduling');
    expect(check.stdout).not.toContain('payment');
  }, 25000);

  it('stale-read race: request A gets configuration_conflict after request B commits', async () => {
    // Reset state to [scheduling, staff]
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling','staff'], ARRAY[0,1], NULL, NULL, NULL, NULL, NULL);`, 'service_role');

    // Session A: reads [scheduling, staff], sleeps, then tries to configure with stale snapshot
    // Session B: quickly changes to [scheduling] (removes staff), commits before A's RPC
    const sqlB = `
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT configure_business_capabilities('${TEST_BIZ_ID}', ARRAY['scheduling'], ARRAY[0], NULL, NULL, NULL, NULL, NULL);
      COMMIT;
    `;
    // Session A starts after B commits, with stale expected_selected that includes 'staff'
    const sqlA = `
      SELECT pg_sleep(1.5);
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT configure_business_capabilities(
        '${TEST_BIZ_ID}', ARRAY['scheduling','staff','chat'], ARRAY[0,1,2],
        NULL, NULL, NULL,
        ARRAY['scheduling','staff'], NULL
      );
      COMMIT;
    `;

    const { a, b } = await runTwoSessions(sqlB, sqlA, { timeoutMs: 20000 });
    // B succeeds
    expect(b.exitCode).toBe(0);
    // A gets configuration_conflict because staff was removed by B
    expect(a.exitCode).not.toBe(0);
    expect(a.stderr).toContain('configuration_conflict: selected capabilities changed');

    // Staff is NOT silently restored
    const check = runSQL(`SELECT capability FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND is_enabled = true ORDER BY capability;`);
    expect(check.stdout).not.toContain('staff');
    expect(check.stdout).toContain('scheduling');
  }, 25000);
});

// ═══════════════════════════════════════
// Migration 301 — admin grant/revoke RPCs
// ═══════════════════════════════════════

describe('Migration 301: admin grant/revoke RPCs', () => {
  beforeAll(() => {
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}';`);
  });

  it('assert current_user for service_role', () => {
    const r = runSQL(`SELECT current_user;`, 'service_role');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('service_role');
  });

  it('service_role can execute grant', () => {
    const r = runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'staff', '${TEST_USER_ID}', 'service test');`, 'service_role');
    expect(r.exitCode).toBe(0);
  });

  it('grant creates override + capability + audit log', () => {
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}';`);

    const r = runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'staff', '${TEST_USER_ID}', 'test grant');`, 'service_role');
    expect(r.exitCode).toBe(0);
    // Verify override
    const ov = runSQL(`SELECT capability FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    expect(ov.stdout).toContain('staff');
    // Verify capability enabled
    const cap = runSQL(`SELECT is_enabled FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'staff';`);
    expect(cap.stdout).toContain('t');
    // Verify audit
    const audit = runSQL(`SELECT action FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}' AND action = 'grant_capability';`);
    expect(audit.stdout).toContain('grant_capability');
  });

  it('revoke removes override + disables capability + audit log', () => {
    const r = runSQL(`SELECT admin_revoke_capability('${TEST_BIZ_ID}', 'staff', '${TEST_USER_ID}', 'test revoke');`, 'service_role');
    expect(r.exitCode).toBe(0);
    const ov = runSQL(`SELECT COUNT(*) FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'staff';`);
    expect(ov.stdout.trim()).toBe('0');
    const cap = runSQL(`SELECT is_enabled FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'staff';`);
    expect(cap.stdout).toContain('f');
    const audit = runSQL(`SELECT COUNT(*) FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}' AND action = 'revoke_capability';`);
    expect(parseInt(audit.stdout.trim())).toBeGreaterThan(0);
  });

  it('anon cannot execute grant', () => {
    const r = runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'chat', '${TEST_USER_ID}', null);`, 'anon');
    expect(r.exitCode).not.toBe(0);
  });

  it('authenticated cannot execute grant', () => {
    const r = runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'chat', '${TEST_USER_ID}', null);`, 'authenticated');
    expect(r.exitCode).not.toBe(0);
  });

  it('nonexistent business raises error in grant', () => {
    const r = runSQL(`SELECT admin_grant_capability('00000000-0000-0000-0000-000000000000', 'chat', '${TEST_USER_ID}', null);`, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('business_not_found');
  });

  it('nonexistent business raises error in revoke', () => {
    const r = runSQL(`SELECT admin_revoke_capability('00000000-0000-0000-0000-000000000000', 'chat', '${TEST_USER_ID}', null);`, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('business_not_found');
  });

  // ── Dependency enforcement tests ──

  it('grant membership with loyalty absent is rejected', () => {
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    const r = runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'membership', '${TEST_USER_ID}', 'test');`, 'service_role');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('dependency_missing');
  });

  it('grant membership with loyalty present succeeds', () => {
    // First grant loyalty
    runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'loyalty', '${TEST_USER_ID}', 'test');`, 'service_role');
    // Then grant membership
    const r = runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'membership', '${TEST_USER_ID}', 'test');`, 'service_role');
    expect(r.exitCode).toBe(0);
    // Verify both enabled
    const caps = runSQL(`SELECT capability, is_enabled FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND capability IN ('loyalty','membership') ORDER BY capability;`);
    expect(caps.stdout).toContain('loyalty|t');
    expect(caps.stdout).toContain('membership|t');
  });

  it('revoke loyalty cascades to disable membership', () => {
    // membership and loyalty are both enabled from previous test
    const r = runSQL(`SELECT admin_revoke_capability('${TEST_BIZ_ID}', 'loyalty', '${TEST_USER_ID}', 'cascade test');`, 'service_role');
    expect(r.exitCode).toBe(0);
    // Verify membership is disabled
    const mem = runSQL(`SELECT is_enabled FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'membership';`);
    expect(mem.stdout).toContain('f');
    // Verify membership override is removed
    const ov = runSQL(`SELECT COUNT(*) FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'membership';`);
    expect(ov.stdout.trim()).toBe('0');
    // Verify audit log has cascaded revocation
    const audit = runSQL(`SELECT details::text FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}' AND action = 'revoke_capability' ORDER BY created_at DESC LIMIT 2;`);
    expect(audit.stdout).toContain('cascaded');
  });

  it('no final state has enabled membership with disabled loyalty', () => {
    // Grant loyalty, then membership
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'loyalty', '${TEST_USER_ID}', null);`, 'service_role');
    runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'membership', '${TEST_USER_ID}', null);`, 'service_role');
    // Revoke loyalty
    runSQL(`SELECT admin_revoke_capability('${TEST_BIZ_ID}', 'loyalty', '${TEST_USER_ID}', null);`, 'service_role');
    // Assert final state
    const r = runSQL(`
      SELECT COUNT(*) FROM business_capabilities
      WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'membership' AND is_enabled = true
      AND NOT EXISTS (
        SELECT 1 FROM business_capabilities
        WHERE business_id = '${TEST_BIZ_ID}' AND capability = 'loyalty' AND is_enabled = true
      );
    `);
    expect(r.stdout.trim()).toBe('0');
  });

  // ── Forced rollback test ──

  it('forced capability mutation failure rolls back override and audit', () => {
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}';`);

    // Try to grant an invalid capability type — will fail at cast
    const r = runSQL(`SELECT admin_grant_capability('${TEST_BIZ_ID}', 'INVALID_NOT_REAL', '${TEST_USER_ID}', 'test');`, 'service_role');
    expect(r.exitCode).not.toBe(0);

    // Verify no override was created
    const ov = runSQL(`SELECT COUNT(*) FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    expect(ov.stdout.trim()).toBe('0');
    // Verify no audit log created
    const audit = runSQL(`SELECT COUNT(*) FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}';`);
    expect(audit.stdout.trim()).toBe('0');
  });

  // ── Concurrency tests ──

  it('concurrent admin grant/revoke operations serialize', async () => {
    runSQL(`DELETE FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM capability_overrides WHERE business_id = '${TEST_BIZ_ID}';`);
    runSQL(`DELETE FROM admin_audit_logs WHERE entity_id = '${TEST_BIZ_ID}';`);

    // Session A: grant chat (holds lock via FOR UPDATE)
    const sqlA = `
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT admin_grant_capability('${TEST_BIZ_ID}', 'chat', '${TEST_USER_ID}', 'session A');
      SELECT pg_sleep(1);
      COMMIT;
    `;
    // Session B: grant feedback (blocked until A commits)
    const sqlB = `
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT admin_grant_capability('${TEST_BIZ_ID}', 'feedback', '${TEST_USER_ID}', 'session B');
      COMMIT;
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB, { timeoutMs: 20000 });
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    // Final state: both chat and feedback enabled
    const caps = runSQL(`SELECT capability FROM business_capabilities WHERE business_id = '${TEST_BIZ_ID}' AND is_enabled = true ORDER BY capability;`);
    expect(caps.stdout).toContain('chat');
    expect(caps.stdout).toContain('feedback');
  }, 25000);
});

} // end if dbUrl
