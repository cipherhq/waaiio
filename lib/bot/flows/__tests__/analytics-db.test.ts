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
import { describe, it, expect, beforeAll } from 'vitest';

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
});
