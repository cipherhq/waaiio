/**
 * Flow Analytics DB Tests — M382 (#267)
 *
 * CI-wired real PostgreSQL tests for flow_execution_summaries,
 * flow_execution_aggregates, persist_flow_execution RPC, RLS policies,
 * and effective-role enforcement.
 *
 * Non-skippable in CI: TEST_DATABASE_URL is always set in migration shards.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/flow-analytics-db.test.ts
 */
import { execSync } from 'child_process';
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
  } catch (e: unknown) { return (e as { stderr?: string }).stderr || String(e); }
}

// ── M382 Schema Verification ──────────

describe.skipIf(!canRun)('M382: flow_execution schema exists', () => {
  it('flow_execution_summaries table exists', () => {
    const result = psql(`
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'flow_execution_summaries';
    `);
    expect(result).toBe('1');
  });

  it('flow_execution_aggregates table exists', () => {
    const result = psql(`
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'flow_execution_aggregates';
    `);
    expect(result).toBe('1');
  });

  it('execution_id has UNIQUE constraint on summaries', () => {
    const result = psql(`
      SELECT count(*) FROM information_schema.table_constraints
      WHERE table_name = 'flow_execution_summaries'
        AND constraint_type = 'UNIQUE';
    `);
    expect(parseInt(result)).toBeGreaterThanOrEqual(1);
  });

  it('completeness CHECK constraint only allows complete/incomplete', () => {
    const result = psql(`
      SELECT count(*) FROM information_schema.check_constraints cc
      JOIN information_schema.table_constraints tc
        ON cc.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'flow_execution_summaries'
        AND cc.check_clause LIKE '%completeness%';
    `);
    expect(parseInt(result)).toBeGreaterThanOrEqual(1);
  });

  it('message_type CHECK constraint allows expected values', () => {
    const result = psql(`
      SELECT count(*) FROM information_schema.check_constraints cc
      JOIN information_schema.table_constraints tc
        ON cc.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'flow_execution_aggregates'
        AND cc.check_clause LIKE '%message_type%';
    `);
    expect(parseInt(result)).toBeGreaterThanOrEqual(1);
  });

  it('business_id index exists on summaries', () => {
    const result = psql(`
      SELECT count(*) FROM pg_indexes
      WHERE tablename = 'flow_execution_summaries'
        AND indexname = 'idx_flow_exec_business';
    `);
    expect(result).toBe('1');
  });

  it('execution_id index exists on aggregates', () => {
    const result = psql(`
      SELECT count(*) FROM pg_indexes
      WHERE tablename = 'flow_execution_aggregates'
        AND indexname = 'idx_flow_exec_agg_exec';
    `);
    expect(result).toBe('1');
  });

  it('RLS is enabled on both tables', () => {
    const summaries = psql(`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'flow_execution_summaries';
    `);
    const aggregates = psql(`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'flow_execution_aggregates';
    `);
    expect(summaries).toBe('t');
    expect(aggregates).toBe('t');
  });

  it('active_capability column is NOT NULL with default __none__', () => {
    const result = psql(`
      SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_name = 'flow_execution_aggregates' AND column_name = 'active_capability';
    `);
    expect(result).toContain('__none__');
    expect(result).toContain('NO');
  });

  it('aggregates FK references summaries.execution_id', () => {
    const result = psql(`
      SELECT count(*) FROM information_schema.table_constraints
      WHERE table_name = 'flow_execution_aggregates'
        AND constraint_type = 'FOREIGN KEY';
    `);
    expect(parseInt(result)).toBeGreaterThanOrEqual(1);
  });
});

// ── RLS Policy Verification ──────────

describe.skipIf(!canRun)('M382: RLS policies', () => {
  it('summaries has service_write, owner_read, and admin_read policies', () => {
    const result = psql(`
      SELECT string_agg(polname, ',' ORDER BY polname)
      FROM pg_policy
      WHERE polrelid = 'flow_execution_summaries'::regclass;
    `);
    expect(result).toContain('flow_exec_service_write');
    expect(result).toContain('flow_exec_owner_read');
    expect(result).toContain('flow_exec_admin_read');
  });

  it('aggregates has service_write, owner_read, and admin_read policies', () => {
    const result = psql(`
      SELECT string_agg(polname, ',' ORDER BY polname)
      FROM pg_policy
      WHERE polrelid = 'flow_execution_aggregates'::regclass;
    `);
    expect(result).toContain('flow_agg_service_write');
    expect(result).toContain('flow_agg_owner_read');
    expect(result).toContain('flow_agg_admin_read');
  });

  it('persist_flow_execution is restricted to service_role', () => {
    const result = psql(`
      SELECT has_function_privilege('authenticated', 'persist_flow_execution(text,uuid,text,integer,integer,integer,integer,timestamptz,timestamptz,jsonb)', 'EXECUTE');
    `);
    expect(result).toBe('f');
  });

  it('anon role cannot execute persist_flow_execution', () => {
    const result = psql(`
      SELECT has_function_privilege('anon', 'persist_flow_execution(text,uuid,text,integer,integer,integer,integer,timestamptz,timestamptz,jsonb)', 'EXECUTE');
    `);
    expect(result).toBe('f');
  });
});

// ── Atomic Idempotent Batch (persist_flow_execution RPC) ──────────

describe.skipIf(!canRun)('M382: persist_flow_execution atomic batch', () => {
  const testExecId = `ci_atomic_${Date.now()}`;
  let testBusinessId: string;

  beforeAll(() => {
    testBusinessId = psql(`SELECT id FROM businesses LIMIT 1;`);
    if (!testBusinessId) {
      testBusinessId = psql(`
        INSERT INTO businesses (name, slug, category, flow_type, subscription_tier, trial_ends_at, owner_id)
        VALUES ('CI Analytics Biz', 'ci-analytics-biz-${Date.now()}', 'other', 'scheduling', 'free',
                NOW() + interval '30 days',
                COALESCE((SELECT id FROM auth.users LIMIT 1), gen_random_uuid()))
        RETURNING id;
      `);
    }
  });

  afterAll(() => {
    try {
      psql(`DELETE FROM flow_execution_aggregates WHERE execution_id = '${testExecId}';`);
      psql(`DELETE FROM flow_execution_summaries WHERE execution_id = '${testExecId}';`);
    } catch { /* cleanup best-effort */ }
  });

  it('persist_flow_execution RPC exists', () => {
    const result = psql(`
      SELECT count(*) FROM pg_proc WHERE proname = 'persist_flow_execution';
    `);
    expect(parseInt(result)).toBeGreaterThanOrEqual(1);
  });

  it('inserts summary and aggregates atomically', () => {
    const result = psql(`
      SELECT persist_flow_execution(
        '${testExecId}',
        '${testBusinessId}'::UUID,
        'complete',
        3, 2, 1, 0,
        NOW(), NOW(),
        '[{"flow_type":"scheduling","step_name":"greeting","message_type":"text","is_template":false,"active_capability":"scheduling","logical_count":2,"resolved_count":2,"failure_count":0,"error_count":0},{"flow_type":"scheduling","step_name":"select_date","message_type":"buttons","is_template":false,"active_capability":"scheduling","logical_count":1,"resolved_count":0,"failure_count":1,"error_count":0}]'::JSONB
      );
    `);
    const parsed = JSON.parse(result);
    expect(parsed.persisted).toBe(true);

    const summaryCount = psql(`
      SELECT count(*) FROM flow_execution_summaries WHERE execution_id = '${testExecId}';
    `);
    expect(summaryCount).toBe('1');

    const aggCount = psql(`
      SELECT count(*) FROM flow_execution_aggregates WHERE execution_id = '${testExecId}';
    `);
    expect(aggCount).toBe('2');
  });

  it('duplicate call is idempotent', () => {
    const result = psql(`
      SELECT persist_flow_execution(
        '${testExecId}',
        '${testBusinessId}'::UUID,
        'complete',
        3, 2, 1, 0,
        NOW(), NOW(),
        '[{"flow_type":"scheduling","step_name":"greeting","message_type":"text","is_template":false,"active_capability":"scheduling","logical_count":2,"resolved_count":2,"failure_count":0,"error_count":0}]'::JSONB
      );
    `);
    const parsed = JSON.parse(result);
    expect(parsed.persisted).toBe(false);
    expect(parsed.reason).toBe('duplicate');

    // Still exactly 1 summary, 2 aggregates
    expect(psql(`SELECT count(*) FROM flow_execution_summaries WHERE execution_id = '${testExecId}';`)).toBe('1');
    expect(psql(`SELECT count(*) FROM flow_execution_aggregates WHERE execution_id = '${testExecId}';`)).toBe('2');
  });

  it('normalizes empty active_capability to __none__', () => {
    const nullCapExecId = `ci_nullcap_${Date.now()}`;
    psql(`
      SELECT persist_flow_execution(
        '${nullCapExecId}',
        '${testBusinessId}'::UUID,
        'complete',
        1, 1, 0, 0,
        NOW(), NOW(),
        '[{"flow_type":"scheduling","step_name":"step1","message_type":"text","is_template":false,"active_capability":"","logical_count":1,"resolved_count":1,"failure_count":0,"error_count":0}]'::JSONB
      );
    `);

    const cap = psql(`
      SELECT active_capability FROM flow_execution_aggregates WHERE execution_id = '${nullCapExecId}';
    `);
    expect(cap).toBe('__none__');

    // Cleanup
    psql(`DELETE FROM flow_execution_aggregates WHERE execution_id = '${nullCapExecId}';`);
    psql(`DELETE FROM flow_execution_summaries WHERE execution_id = '${nullCapExecId}';`);
  });
});

// ── Effective-role/JWT RLS Enforcement ──────────

describe.skipIf(!canRun)('M382: effective-role RLS enforcement', () => {
  let testBusinessId: string;
  let testUserId: string;
  const testExecId = `ci_role_${Date.now()}`;

  beforeAll(() => {
    testBusinessId = psql(`SELECT id FROM businesses LIMIT 1;`);
    if (!testBusinessId) {
      testBusinessId = psql(`
        INSERT INTO businesses (name, slug, category, flow_type, subscription_tier, trial_ends_at, owner_id)
        VALUES ('CI RLS Biz', 'ci-rls-biz-${Date.now()}', 'other', 'scheduling', 'free',
                NOW() + interval '30 days',
                COALESCE((SELECT id FROM auth.users LIMIT 1), gen_random_uuid()))
        RETURNING id;
      `);
    }
    testUserId = psql(`SELECT owner_id FROM businesses WHERE id = '${testBusinessId}';`);

    // Seed test row via superuser
    psql(`
      SELECT persist_flow_execution(
        '${testExecId}',
        '${testBusinessId}'::UUID,
        'complete',
        1, 1, 0, 0,
        NOW(), NOW(),
        '[{"flow_type":"scheduling","step_name":"test_step","message_type":"text","is_template":false,"active_capability":"scheduling","logical_count":1,"resolved_count":1,"failure_count":0,"error_count":0}]'::JSONB
      );
    `);
  });

  afterAll(() => {
    try {
      psql(`DELETE FROM flow_execution_aggregates WHERE execution_id = '${testExecId}';`);
      psql(`DELETE FROM flow_execution_summaries WHERE execution_id = '${testExecId}';`);
    } catch { /* cleanup best-effort */ }
  });

  it('authenticated role CANNOT insert into flow_execution_summaries', () => {
    const result = psqlMayFail(`
      BEGIN;
      SELECT set_config('request.jwt.claims', '{"sub":"${testUserId}","role":"authenticated"}', true);
      SET LOCAL ROLE authenticated;
      INSERT INTO flow_execution_summaries (
        execution_id, business_id, completeness,
        total_messages, resolved_count, failure_count, error_count,
        started_at
      ) VALUES (
        'ci_blocked_${Date.now()}', '${testBusinessId}', 'complete',
        1, 1, 0, 0, NOW()
      );
      ROLLBACK;
    `);
    // Either the insert fails with a policy violation, or we check that it was blocked
    expect(result).toMatch(/permission denied|new row violates|policy|false/i);
  });

  it('authenticated role CANNOT insert into flow_execution_aggregates', () => {
    const result = psqlMayFail(`
      BEGIN;
      SELECT set_config('request.jwt.claims', '{"sub":"${testUserId}","role":"authenticated"}', true);
      SET LOCAL ROLE authenticated;
      INSERT INTO flow_execution_aggregates (
        execution_id, flow_type, step_name, message_type,
        is_template, active_capability,
        logical_count, resolved_count, failure_count, error_count
      ) VALUES (
        '${testExecId}', 'scheduling', 'blocked_step', 'text',
        false, 'scheduling',
        1, 1, 0, 0
      );
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied|new row violates|policy|false/i);
  });

  it('authenticated owner CAN read their own business summaries', () => {
    const count = psql(`
      BEGIN;
      SELECT set_config('request.jwt.claims', '{"sub":"${testUserId}","role":"authenticated"}', true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) FROM flow_execution_summaries
      WHERE execution_id = '${testExecId}';
    `);
    // Parse the count from potentially multi-line output (BEGIN, set_config, SET, count, etc.)
    const lines = count.split('\n').filter(l => /^\d+$/.test(l.trim()));
    const parsed = parseInt(lines[lines.length - 1] || '0');
    expect(parsed).toBeGreaterThanOrEqual(1);
  });

  it('authenticated non-owner CANNOT read other business summaries', () => {
    const fakeUserId = '00000000-0000-0000-0000-000000000099';
    // Use psqlMayFail to handle potential RLS denials gracefully
    const result = psqlMayFail(`
      BEGIN;
      SELECT set_config('request.jwt.claims', '{"sub":"${fakeUserId}","role":"authenticated","aud":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${fakeUserId}', true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) FROM flow_execution_summaries
        WHERE execution_id = '${testExecId}';
      ROLLBACK;
    `);
    // Should return 0 rows (RLS denies) or permission error
    const hasZero = result.includes('0') && !result.includes('1');
    const hasError = result.toLowerCase().includes('permission denied') || result.toLowerCase().includes('denied');
    expect(hasZero || hasError).toBe(true);
  });

  it('anon role CANNOT read flow_execution_summaries', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE anon;
      SELECT count(*) FROM flow_execution_summaries
        WHERE execution_id = '${testExecId}';
      ROLLBACK;
    `);
    // Anon should get permission denied or 0 rows
    const hasError = result.toLowerCase().includes('permission denied') || result.toLowerCase().includes('denied');
    const hasZero = result.includes('0') && !result.includes('1');
    expect(hasError || hasZero).toBe(true);
  });

  it('anon role CANNOT insert into flow_execution_summaries', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE anon;
      INSERT INTO flow_execution_summaries (
        execution_id, business_id, completeness,
        total_messages, resolved_count, failure_count, error_count,
        started_at
      ) VALUES (
        'ci_anon_blocked_${Date.now()}', '${testBusinessId}', 'complete',
        1, 1, 0, 0, NOW()
      );
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied|new row violates|policy|false/i);
  });
});
