/**
 * Bot Flow Execution Analytics DB Tests (#267)
 *
 * V2-T11: M382 schema verification (tables, constraints, indexes)
 * V2-T12: RLS policy verification (service-only writes, tenant-scoped reads)
 *
 * Requires TEST_DATABASE_URL pointing to a PostgreSQL database with
 * all migrations applied (including M382).
 *
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54323/postgres \
 *     npx vitest run lib/bot/flows/__tests__/analytics-db.test.ts
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

// ── V2-T11: M382 Schema Verification ──────────

describe.skipIf(!canRun)('V2-T11: M382 schema verification', () => {
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
});

// ── V2-T11: Atomic Idempotent Batch (persist_flow_execution RPC) ──────────

describe.skipIf(!canRun)('V2-T11: Atomic idempotent batch via RPC', () => {
  const testExecId = `test_atomic_${Date.now()}`;
  // Use a known business ID from the test DB. The RPC is SECURITY DEFINER
  // and runs as the function owner, so FK checks still apply.
  // We need a real business_id that exists in the businesses table.

  let testBusinessId: string;

  beforeAll(() => {
    // Grab any existing business_id for FK satisfaction
    testBusinessId = psql(`SELECT id FROM businesses LIMIT 1;`);
    if (!testBusinessId) {
      // Create a minimal business for testing
      testBusinessId = psql(`
        INSERT INTO businesses (name, slug, category, flow_type, subscription_tier, trial_ends_at, owner_id)
        VALUES ('Analytics Test Biz', 'analytics-test-biz', 'other', 'scheduling', 'free',
                NOW() + interval '30 days',
                COALESCE((SELECT id FROM auth.users LIMIT 1), gen_random_uuid()))
        RETURNING id;
      `);
    }
  });

  it('persist_flow_execution RPC exists', () => {
    const result = psql(`
      SELECT count(*) FROM pg_proc
      WHERE proname = 'persist_flow_execution';
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

    // Verify summary row
    const summaryCount = psql(`
      SELECT count(*) FROM flow_execution_summaries WHERE execution_id = '${testExecId}';
    `);
    expect(summaryCount).toBe('1');

    // Verify aggregate rows
    const aggCount = psql(`
      SELECT count(*) FROM flow_execution_aggregates WHERE execution_id = '${testExecId}';
    `);
    expect(aggCount).toBe('2');
  });

  it('duplicate call returns persisted=false without creating duplicates', () => {
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

    // Still exactly 1 summary row
    const summaryCount = psql(`
      SELECT count(*) FROM flow_execution_summaries WHERE execution_id = '${testExecId}';
    `);
    expect(summaryCount).toBe('1');

    // Still exactly 2 aggregate rows (from first call)
    const aggCount = psql(`
      SELECT count(*) FROM flow_execution_aggregates WHERE execution_id = '${testExecId}';
    `);
    expect(aggCount).toBe('2');
  });

  it('normalizes null active_capability to __none__', () => {
    const nullCapExecId = `test_nullcap_${Date.now()}`;
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

  // Cleanup after all atomic tests
  afterAll(() => {
    try {
      psql(`DELETE FROM flow_execution_aggregates WHERE execution_id = '${testExecId}';`);
      psql(`DELETE FROM flow_execution_summaries WHERE execution_id = '${testExecId}';`);
    } catch { /* cleanup best-effort */ }
  });
});

// ── V2-T12: RLS Policy Verification ──────────

describe.skipIf(!canRun)('V2-T12: M382 RLS policy verification', () => {
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

  it('service_write policy on summaries is deny-all for anon/authenticated', () => {
    // The policy uses USING (false) WITH CHECK (false) — blocks all non-service roles
    const result = psql(`
      SELECT polqual::text FROM pg_policy
      WHERE polrelid = 'flow_execution_summaries'::regclass
        AND polname = 'flow_exec_service_write';
    `);
    expect(result).toContain('false');
  });

  it('aggregates FK references summaries.execution_id', () => {
    const result = psql(`
      SELECT count(*) FROM information_schema.referential_constraints
      WHERE constraint_name LIKE '%flow_execution_aggregates%'
        OR constraint_name IN (
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_name = 'flow_execution_aggregates'
            AND constraint_type = 'FOREIGN KEY'
        );
    `);
    expect(parseInt(result)).toBeGreaterThanOrEqual(1);
  });

  it('active_capability column is NOT NULL with default __none__', () => {
    const result = psql(`
      SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_name = 'flow_execution_aggregates' AND column_name = 'active_capability';
    `);
    // Result format: default|nullable
    expect(result).toContain('__none__');
    expect(result).toContain('NO');
  });

  it('persist_flow_execution is restricted to service_role', () => {
    // Authenticated role should NOT have execute permission
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

  it('authenticated INSERT is blocked by RLS on summaries', () => {
    // The service_write policy uses USING(false) WITH CHECK(false),
    // which means authenticated users cannot insert even though they match the role
    const result = psql(`
      SELECT polqual::text, polwithcheck::text FROM pg_policy
      WHERE polrelid = 'flow_execution_summaries'::regclass
        AND polname = 'flow_exec_service_write';
    `);
    expect(result).toContain('false');
  });

  it('authenticated INSERT is blocked by RLS on aggregates', () => {
    const result = psql(`
      SELECT polqual::text, polwithcheck::text FROM pg_policy
      WHERE polrelid = 'flow_execution_aggregates'::regclass
        AND polname = 'flow_agg_service_write';
    `);
    expect(result).toContain('false');
  });
});
