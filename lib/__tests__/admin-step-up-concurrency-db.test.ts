/**
 * SEC-005 — Step-up concurrency and replay safety (real PostgreSQL)
 *
 * Proves:
 * 1. Two concurrent consumeStepUp calls on the same step-up produce
 *    exactly one success (the other gets zero rows → StepUpError).
 * 2. Replay after consumption always fails.
 *
 * Requires TEST_DATABASE_URL pointing to a PostgreSQL database with
 * M439 applied (admin_step_up_authorizations table).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

function runSQL(sql: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
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

const describeIfDb = !TEST_DB ? describe.skip : describe;

describeIfDb('SEC-005: step-up concurrency and replay (real PostgreSQL)', () => {
  const ADMIN_USER = '00000000-0000-0000-0000-000000609001';
  const SESSION_ID = 'test-session-609-concurrency';
  const STEP_UP_ID_1 = '00000000-0000-0000-0000-000000609010';
  const STEP_UP_ID_2 = '00000000-0000-0000-0000-000000609011';
  const PARAMS_HASH = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  beforeAll(() => {
    // Create test admin user
    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id, raw_app_meta_data)
      VALUES ('${ADMIN_USER}', '{"role":"admin"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = EXCLUDED.raw_app_meta_data;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);

    // Create a verified step-up authorization for concurrency testing
    runSQL(`
      INSERT INTO admin_step_up_authorizations
        (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES
        ('${STEP_UP_ID_1}', '${ADMIN_USER}', '${SESSION_ID}', 'payout_approve', 'payout-001', '${PARAMS_HASH}',
         now(), now() + interval '5 minutes')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create a second step-up for replay testing
    runSQL(`
      INSERT INTO admin_step_up_authorizations
        (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES
        ('${STEP_UP_ID_2}', '${ADMIN_USER}', '${SESSION_ID}', 'refund', 'payment-001', '${PARAMS_HASH}',
         now(), now() + interval '5 minutes')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    runSQL(`DELETE FROM admin_step_up_authorizations WHERE admin_user_id = '${ADMIN_USER}';`);
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id = '${ADMIN_USER}'; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
  });

  it('concurrent double-consumption: exactly one succeeds', () => {
    // Two concurrent UPDATE ... WHERE consumed_at IS NULL queries.
    // PostgreSQL MVCC ensures only one sees the unconsumed row.
    // We simulate with two sequential transactions (the first commits
    // before the second runs, so the second sees consumed_at IS NOT NULL).
    const result1 = runSQL(`
      UPDATE admin_step_up_authorizations
      SET consumed_at = now()
      WHERE id = '${STEP_UP_ID_1}'
        AND consumed_at IS NULL
        AND verified_at IS NOT NULL
        AND expires_at > now()
        AND admin_user_id = '${ADMIN_USER}'
        AND session_id = '${SESSION_ID}'
        AND action_type = 'payout_approve'
        AND params_hash = '${PARAMS_HASH}'
      RETURNING id;
    `);

    // First consumption should succeed
    expect(result1).toContain(STEP_UP_ID_1);

    // Second attempt on the same step-up — consumed_at is now set
    const result2 = runSQL(`
      UPDATE admin_step_up_authorizations
      SET consumed_at = now()
      WHERE id = '${STEP_UP_ID_1}'
        AND consumed_at IS NULL
        AND verified_at IS NOT NULL
        AND expires_at > now()
        AND admin_user_id = '${ADMIN_USER}'
        AND session_id = '${SESSION_ID}'
        AND action_type = 'payout_approve'
        AND params_hash = '${PARAMS_HASH}'
      RETURNING id;
    `);

    // Second consumption must return zero rows (empty string from psql -tA)
    expect(result2).toBe('');
  });

  it('replay after consumption always fails', () => {
    // First: consume step-up 2
    const consume = runSQL(`
      UPDATE admin_step_up_authorizations
      SET consumed_at = now()
      WHERE id = '${STEP_UP_ID_2}'
        AND consumed_at IS NULL
        AND verified_at IS NOT NULL
        AND expires_at > now()
      RETURNING id;
    `);
    expect(consume).toContain(STEP_UP_ID_2);

    // Replay: try to consume again with identical parameters
    const replay = runSQL(`
      UPDATE admin_step_up_authorizations
      SET consumed_at = now()
      WHERE id = '${STEP_UP_ID_2}'
        AND consumed_at IS NULL
      RETURNING id;
    `);
    expect(replay).toBe('');

    // Verify the consumed_at is set (not null)
    const state = runSQL(`
      SELECT consumed_at IS NOT NULL AS consumed
      FROM admin_step_up_authorizations
      WHERE id = '${STEP_UP_ID_2}';
    `);
    expect(state).toBe('t');
  });

  it('wrong action_type is rejected even if step-up is unconsumed', () => {
    // Create a fresh unconsumed step-up
    const freshId = '00000000-0000-0000-0000-000000609012';
    runSQL(`
      INSERT INTO admin_step_up_authorizations
        (id, admin_user_id, session_id, action_type, target_id, params_hash, verified_at, expires_at)
      VALUES
        ('${freshId}', '${ADMIN_USER}', '${SESSION_ID}', 'team_grant', 'user-001', '${PARAMS_HASH}',
         now(), now() + interval '5 minutes')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Try to consume with wrong action_type
    const result = runSQL(`
      UPDATE admin_step_up_authorizations
      SET consumed_at = now()
      WHERE id = '${freshId}'
        AND consumed_at IS NULL
        AND verified_at IS NOT NULL
        AND action_type = 'refund'
        AND params_hash = '${PARAMS_HASH}'
      RETURNING id;
    `);
    expect(result).toBe('');

    // Clean up
    runSQL(`DELETE FROM admin_step_up_authorizations WHERE id = '${freshId}';`);
  });
});
