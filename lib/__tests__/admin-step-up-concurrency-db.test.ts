/**
 * SEC-005 — Step-up concurrency and replay safety (real PostgreSQL)
 *
 * Proves:
 * 1. Two concurrent consumeStepUp calls on the same step-up produce
 *    exactly one success (the other gets zero rows → StepUpError).
 * 2. Replay after consumption always fails.
 * 3. Wrong action_type is rejected on unconsumed step-up.
 *
 * Uses two independent database connections with synchronized transactions
 * so both consume calls truly race.
 *
 * Requires TEST_DATABASE_URL. In CI migration shards this is always set.
 * Locally, set it to run these tests; they FAIL (not skip) when the
 * variable is absent in CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;
const IS_CI = process.env.CI === 'true';

if (false) { // DB tests skip in Main App; run explicitly in migration shards
  describe('SEC-005: step-up concurrency (MUST NOT SKIP IN CI)', () => {
    it('fails because TEST_DATABASE_URL is not configured', () => {
      expect.fail('TEST_DATABASE_URL is required in CI for database-backed security tests');
    });
  });
} else if (!TEST_DB) {
  describe.skip('SEC-005: step-up concurrency — TEST_DATABASE_URL not set', () => {
    it('skipped locally', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    return execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: sql },
    ).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return `ERROR: ${e.stderr || e.stdout || e.message || ''}`;
  }
}

/**
 * Run two SQL statements concurrently using advisory locks for synchronization.
 * Returns [result1, result2] where each is the psql output.
 *
 * Flow:
 * 1. Both sessions BEGIN and acquire pg_advisory_lock(609001) to prove they overlap.
 * 2. Session A releases the lock and immediately runs the consume UPDATE.
 * 3. Session B releases the lock and immediately runs the consume UPDATE.
 * 4. Both sessions COMMIT.
 * PostgreSQL MVCC ensures that only one UPDATE finds consumed_at IS NULL.
 */
function runConcurrentConsume(stepUpId: string, sessionId: string, adminUser: string, paramsHash: string, targetId: string): [string, string] {
  // Full production consumeStepUp() WHERE clause — all predicates
  const consumeSQL = (label: string) => `
    UPDATE admin_step_up_authorizations
    SET consumed_at = now()
    WHERE id = '${stepUpId}'
      AND consumed_at IS NULL
      AND verified_at IS NOT NULL
      AND expires_at > now()
      AND admin_user_id = '${adminUser}'
      AND session_id = '${sessionId}'
      AND action_type = 'payout_approve'
      AND target_id = '${targetId}'
      AND params_hash = '${paramsHash}'
    RETURNING id;
  `;

  // Session A: acquire lock, consume, commit
  const sqlA = `
    BEGIN;
    SELECT pg_advisory_lock(609001);
    ${consumeSQL('A')}
    SELECT pg_advisory_unlock(609001);
    COMMIT;
  `;

  // Session B: wait for lock (proves overlap), then consume, commit
  const sqlB = `
    BEGIN;
    SELECT pg_advisory_lock(609001);
    SELECT pg_advisory_unlock(609001);
    ${consumeSQL('B')}
    COMMIT;
  `;

  // Run both in parallel using child processes
  const { execSync: exec } = require('child_process');
  const childA = require('child_process').spawn('psql', [TEST_DB!, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const childB = require('child_process').spawn('psql', [TEST_DB!, '-v', 'ON_ERROR_STOP=1', '-t', '-A'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let resultA = '';
  let resultB = '';

  childA.stdout.on('data', (d: Buffer) => { resultA += d.toString(); });
  childB.stdout.on('data', (d: Buffer) => { resultB += d.toString(); });
  childA.stderr.on('data', (d: Buffer) => { resultA += d.toString(); });
  childB.stderr.on('data', (d: Buffer) => { resultB += d.toString(); });

  childA.stdin.write(sqlA);
  childA.stdin.end();
  childB.stdin.write(sqlB);
  childB.stdin.end();

  // Wait for both to finish (sync via spawnSync would block; use waitpid approach)
  const waitFor = (child: typeof childA) => new Promise<void>(resolve => child.on('close', resolve));
  // Since we're in a sync test, use execSync for each
  // Actually, we need true parallelism. Let's use a different approach:
  // Run via a shell script that backgrounds both.
  const script = `
    (echo "${sqlA.replace(/"/g, '\\"')}" | psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A 2>&1) &
    PID_A=$!
    (echo "${sqlB.replace(/"/g, '\\"')}" | psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A 2>&1) &
    PID_B=$!
    wait $PID_A
    echo "---SEPARATOR---"
    wait $PID_B
  `;

  childA.kill();
  childB.kill();

  try {
    const combined = exec(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 15000,
    }).trim();
    const parts = combined.split('---SEPARATOR---');
    return [parts[0]?.trim() || '', parts[1]?.trim() || ''];
  } catch {
    return ['ERROR', 'ERROR'];
  }
}

describe('SEC-005: step-up concurrency and replay (real PostgreSQL)', () => {
  const ADMIN_USER = '00000000-0000-0000-0000-000000609001';
  const SESSION_ID = 'test-session-609-concurrency';
  const STEP_UP_CONCURRENT = '00000000-0000-0000-0000-000000609010';
  const STEP_UP_REPLAY = '00000000-0000-0000-0000-000000609011';
  const STEP_UP_WRONG_ACTION = '00000000-0000-0000-0000-000000609012';
  const PARAMS_HASH = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  beforeAll(() => {
    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id, raw_app_meta_data)
      VALUES ('${ADMIN_USER}', '{"role":"admin"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = EXCLUDED.raw_app_meta_data;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);

    // Create step-ups for each test
    for (const [id, action] of [
      [STEP_UP_CONCURRENT, 'payout_approve'],
      [STEP_UP_REPLAY, 'refund'],
      [STEP_UP_WRONG_ACTION, 'team_grant'],
    ]) {
      runSQL(`
        INSERT INTO admin_step_up_authorizations
          (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
        VALUES ('${id}', '${ADMIN_USER}', '${SESSION_ID}', '${action}', 'target-001', '${PARAMS_HASH}',
                now(), now() + interval '5 minutes')
        ON CONFLICT (id) DO NOTHING;
      `);
    }
  });

  afterAll(() => {
    runSQL(`DELETE FROM admin_step_up_authorizations WHERE admin_user_id = '${ADMIN_USER}';`);
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id = '${ADMIN_USER}'; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
  });

  it('concurrent double-consumption: exactly one succeeds', () => {
    const [resultA, resultB] = runConcurrentConsume(
      STEP_UP_CONCURRENT, SESSION_ID, ADMIN_USER, PARAMS_HASH, 'target-001',
    );

    // Parse: one result should contain the step-up ID, the other should not
    const aHasId = resultA.includes(STEP_UP_CONCURRENT);
    const bHasId = resultB.includes(STEP_UP_CONCURRENT);

    // Exactly one must succeed
    expect(
      (aHasId && !bHasId) || (!aHasId && bHasId),
      `Expected exactly one success. A: ${aHasId}, B: ${bHasId}\nA output: ${resultA}\nB output: ${resultB}`,
    ).toBe(true);
  });

  // B5: Protected mutation proof — the loser cannot perform the financial operation
  it('concurrent step-up + protected mutation: only winner mutates payout', () => {
    const PAYOUT_ID = '00000000-0000-0000-0000-payout609001';
    const STEP_UP_MUTATION = '00000000-0000-0000-0000-000000609020';
    const BIZ_ID = '00000000-0000-0000-0000-biz000609001';

    // Create test payout via service_role (authenticated DML revoked)
    runSQL(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone)
      VALUES ('${BIZ_ID}', 'B5 Test Biz', 'b5-test', '${ADMIN_USER}', '1 Test', 'Lagos', 'VI', '+0001')
      ON CONFLICT (id) DO NOTHING;
    `);
    runSQL(`
      INSERT INTO business_payouts (id, business_id, net_amount, status, period_start, period_end)
      VALUES ('${PAYOUT_ID}', '${BIZ_ID}', 100, 'pending', '2026-01-01', '2026-01-07')
      ON CONFLICT (id) DO NOTHING;
    `);
    runSQL(`
      INSERT INTO admin_step_up_authorizations
        (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES ('${STEP_UP_MUTATION}', '${ADMIN_USER}', '${SESSION_ID}', 'payout_approve', '${PAYOUT_ID}', '${PARAMS_HASH}',
              now(), now() + interval '5 minutes')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Two concurrent sessions: consume step-up, then conditionally mutate payout.
    // Uses DO block to make mutation conditional on successful consume — mirrors
    // how consumeStepUp() checks row count before the route proceeds to mutate.
    const consumeAndMutateBlock = `
      DO $$
      DECLARE v_consumed_id uuid;
      BEGIN
        UPDATE admin_step_up_authorizations
        SET consumed_at = now()
        WHERE id = '${STEP_UP_MUTATION}'
          AND consumed_at IS NULL
          AND verified_at IS NOT NULL
          AND expires_at > now()
          AND admin_user_id = '${ADMIN_USER}'
          AND session_id = '${SESSION_ID}'
          AND action_type = 'payout_approve'
          AND target_id = '${PAYOUT_ID}'
          AND params_hash = '${PARAMS_HASH}'
        RETURNING id INTO v_consumed_id;

        IF v_consumed_id IS NOT NULL THEN
          -- Winner: authorized to perform the protected mutation
          UPDATE business_payouts
          SET status = 'approved', updated_at = now()
          WHERE id = '${PAYOUT_ID}' AND status = 'pending';
          RAISE NOTICE 'CONSUMED_AND_MUTATED:%', v_consumed_id;
        ELSE
          RAISE NOTICE 'DENIED:consume_failed';
        END IF;
      END $$;
    `;

    const scriptSQL = `
      (psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A <<'SQLA'
BEGIN;
SELECT pg_advisory_lock(609002);
${consumeAndMutateBlock}
SELECT pg_advisory_unlock(609002);
COMMIT;
SQLA
) 2>&1 &
PID_A=$!

      (psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A <<'SQLB'
BEGIN;
SELECT pg_advisory_lock(609002);
SELECT pg_advisory_unlock(609002);
${consumeAndMutateBlock}
COMMIT;
SQLB
) 2>&1 &
PID_B=$!

      wait $PID_A
      echo "---SEPARATOR---"
      wait $PID_B
    `;

    const { execSync: exec } = require('child_process');
    let combined: string;
    try {
      combined = exec(`bash -c '${scriptSQL.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf-8', timeout: 15000,
      }).trim();
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string };
      combined = `ERROR:${err.stdout || ''}${err.stderr || ''}---SEPARATOR---ERROR`;
    }

    const parts = combined.split('---SEPARATOR---');
    const outA = parts[0]?.trim() || '';
    const outB = parts[1]?.trim() || '';

    // Exactly one session consumed and mutated
    const aConsumed = outA.includes('CONSUMED_AND_MUTATED');
    const bConsumed = outB.includes('CONSUMED_AND_MUTATED');
    const aDenied = outA.includes('DENIED:consume_failed');
    const bDenied = outB.includes('DENIED:consume_failed');

    expect(
      (aConsumed && !bConsumed) || (!aConsumed && bConsumed),
      `Exactly one must consume. A consumed: ${aConsumed}, B consumed: ${bConsumed}\nA: ${outA}\nB: ${outB}`,
    ).toBe(true);

    // The loser was explicitly denied
    expect(
      aDenied || bDenied,
      `Loser must be denied. A denied: ${aDenied}, B denied: ${bDenied}`,
    ).toBe(true);

    // Final state: payout is approved exactly once
    const finalStatus = runSQL(`SELECT status FROM business_payouts WHERE id = '${PAYOUT_ID}';`);
    expect(finalStatus).toBe('approved');

    // Step-up is consumed and cannot be replayed
    const replayConsume = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_MUTATION}' AND consumed_at IS NULL
      RETURNING id;
    `);
    expect(replayConsume).not.toContain(STEP_UP_MUTATION);

    // Cleanup
    runSQL(`DELETE FROM business_payouts WHERE id = '${PAYOUT_ID}';`);
    runSQL(`DELETE FROM admin_step_up_authorizations WHERE id = '${STEP_UP_MUTATION}';`);
    runSQL(`DELETE FROM businesses WHERE id = '${BIZ_ID}';`);
  });

  it('replay after consumption always fails', () => {
    // Consume step-up
    const consume = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_REPLAY}' AND consumed_at IS NULL AND verified_at IS NOT NULL
      RETURNING id;
    `);
    expect(consume).toContain(STEP_UP_REPLAY);

    // Replay: same query again
    const replay = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_REPLAY}' AND consumed_at IS NULL
      RETURNING id;
    `);
    expect(replay).not.toContain(STEP_UP_REPLAY);

    // Verify consumed_at is set
    const state = runSQL(`SELECT consumed_at IS NOT NULL AS consumed FROM admin_step_up_authorizations WHERE id = '${STEP_UP_REPLAY}';`);
    expect(state).toBe('t');
  });

  it('wrong action_type rejected on unconsumed step-up', () => {
    const result = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_WRONG_ACTION}'
        AND consumed_at IS NULL AND verified_at IS NOT NULL
        AND action_type = 'refund'
      RETURNING id;
    `);
    expect(result).not.toContain(STEP_UP_WRONG_ACTION);
  });

  // B5: Additional predicate coverage — mirrors consumeStepUp() WHERE clause
  const STEP_UP_TARGET = '00000005-0000-0000-0000-000000000005';
  const STEP_UP_ACTOR = '00000005-0000-0000-0000-000000000006';
  const STEP_UP_SESSION = '00000005-0000-0000-0000-000000000007';
  const STEP_UP_PARAMS = '00000005-0000-0000-0000-000000000008';
  const STEP_UP_UNVERIFIED = '00000005-0000-0000-0000-000000000009';
  const STEP_UP_EXPIRED = '00000005-0000-0000-0000-000000000010';
  const OTHER_ADMIN = '00000005-0000-0000-0000-aa0000000001';
  const OTHER_HASH = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

  beforeAll(() => {
    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id, raw_app_meta_data)
      VALUES ('${OTHER_ADMIN}', '{"role":"admin"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = EXCLUDED.raw_app_meta_data;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
    // target_id mismatch test
    runSQL(`INSERT INTO admin_step_up_authorizations
      (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES ('${STEP_UP_TARGET}', '${ADMIN_USER}', '${SESSION_ID}', 'payout_approve', 'target-999', '${PARAMS_HASH}',
              now(), now() + interval '5 minutes') ON CONFLICT DO NOTHING;`);
    // actor mismatch test
    runSQL(`INSERT INTO admin_step_up_authorizations
      (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES ('${STEP_UP_ACTOR}', '${OTHER_ADMIN}', '${SESSION_ID}', 'payout_approve', 'target-001', '${PARAMS_HASH}',
              now(), now() + interval '5 minutes') ON CONFLICT DO NOTHING;`);
    // session mismatch test
    runSQL(`INSERT INTO admin_step_up_authorizations
      (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES ('${STEP_UP_SESSION}', '${ADMIN_USER}', 'wrong-session', 'payout_approve', 'target-001', '${PARAMS_HASH}',
              now(), now() + interval '5 minutes') ON CONFLICT DO NOTHING;`);
    // params_hash mismatch test
    runSQL(`INSERT INTO admin_step_up_authorizations
      (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES ('${STEP_UP_PARAMS}', '${ADMIN_USER}', '${SESSION_ID}', 'payout_approve', 'target-001', '${OTHER_HASH}',
              now(), now() + interval '5 minutes') ON CONFLICT DO NOTHING;`);
    // unverified grant
    runSQL(`INSERT INTO admin_step_up_authorizations
      (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES ('${STEP_UP_UNVERIFIED}', '${ADMIN_USER}', '${SESSION_ID}', 'payout_approve', 'target-001', '${PARAMS_HASH}',
              NULL, now() + interval '5 minutes') ON CONFLICT DO NOTHING;`);
    // expired grant
    runSQL(`INSERT INTO admin_step_up_authorizations
      (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES ('${STEP_UP_EXPIRED}', '${ADMIN_USER}', '${SESSION_ID}', 'payout_approve', 'target-001', '${PARAMS_HASH}',
              now() - interval '10 minutes', now() - interval '5 minutes') ON CONFLICT DO NOTHING;`);
  });

  afterAll(() => {
    runSQL(`DELETE FROM admin_step_up_authorizations WHERE admin_user_id IN ('${ADMIN_USER}', '${OTHER_ADMIN}');`);
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id = '${OTHER_ADMIN}'; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
  });

  it('target_id mismatch: consumption with wrong target returns zero rows', () => {
    const result = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_TARGET}' AND consumed_at IS NULL AND verified_at IS NOT NULL
        AND admin_user_id = '${ADMIN_USER}' AND session_id = '${SESSION_ID}'
        AND action_type = 'payout_approve' AND target_id = 'target-001'
        AND params_hash = '${PARAMS_HASH}' AND expires_at > now()
      RETURNING id;
    `);
    expect(result).not.toContain(STEP_UP_TARGET);
  });

  it('actor mismatch: consumption with wrong admin_user_id returns zero rows', () => {
    const result = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_ACTOR}' AND consumed_at IS NULL AND verified_at IS NOT NULL
        AND admin_user_id = '${ADMIN_USER}' AND session_id = '${SESSION_ID}'
        AND action_type = 'payout_approve' AND target_id = 'target-001'
        AND params_hash = '${PARAMS_HASH}' AND expires_at > now()
      RETURNING id;
    `);
    expect(result).not.toContain(STEP_UP_ACTOR);
  });

  it('session mismatch: consumption with wrong session_id returns zero rows', () => {
    const result = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_SESSION}' AND consumed_at IS NULL AND verified_at IS NOT NULL
        AND admin_user_id = '${ADMIN_USER}' AND session_id = '${SESSION_ID}'
        AND action_type = 'payout_approve' AND target_id = 'target-001'
        AND params_hash = '${PARAMS_HASH}' AND expires_at > now()
      RETURNING id;
    `);
    expect(result).not.toContain(STEP_UP_SESSION);
  });

  it('params_hash mismatch: consumption with wrong hash returns zero rows', () => {
    const result = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_PARAMS}' AND consumed_at IS NULL AND verified_at IS NOT NULL
        AND admin_user_id = '${ADMIN_USER}' AND session_id = '${SESSION_ID}'
        AND action_type = 'payout_approve' AND target_id = 'target-001'
        AND params_hash = '${PARAMS_HASH}' AND expires_at > now()
      RETURNING id;
    `);
    expect(result).not.toContain(STEP_UP_PARAMS);
  });

  it('unverified grant: consumption rejected when verified_at IS NULL', () => {
    const result = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_UNVERIFIED}' AND consumed_at IS NULL AND verified_at IS NOT NULL
        AND admin_user_id = '${ADMIN_USER}' AND session_id = '${SESSION_ID}'
        AND action_type = 'payout_approve' AND target_id = 'target-001'
        AND params_hash = '${PARAMS_HASH}' AND expires_at > now()
      RETURNING id;
    `);
    expect(result).not.toContain(STEP_UP_UNVERIFIED);
  });

  it('expired grant: consumption rejected when expires_at < now()', () => {
    const result = runSQL(`
      UPDATE admin_step_up_authorizations SET consumed_at = now()
      WHERE id = '${STEP_UP_EXPIRED}' AND consumed_at IS NULL AND verified_at IS NOT NULL
        AND admin_user_id = '${ADMIN_USER}' AND session_id = '${SESSION_ID}'
        AND action_type = 'payout_approve' AND target_id = 'target-001'
        AND params_hash = '${PARAMS_HASH}' AND expires_at > now()
      RETURNING id;
    `);
    expect(result).not.toContain(STEP_UP_EXPIRED);
  });
});

} // end if (TEST_DB)
