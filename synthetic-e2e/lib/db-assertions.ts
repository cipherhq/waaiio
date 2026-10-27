/**
 * Database assertion helpers for synthetic E2E tests.
 *
 * Provides read-only verification of staging database state
 * after synthetic actions. Uses the staging Supabase client.
 *
 * Issue #728: Prove merchant status and capabilities through
 * read-only staging DB checks.
 */

import type { AuditLogger } from './audit-logger';

// ── Types ──

export interface DbAssertionResult {
  table: string;
  column: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  query: string;
}

export interface DbClient {
  from(table: string): {
    select(columns?: string): {
      eq(column: string, value: unknown): {
        single(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
        limit(n: number): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
      };
      in(column: string, values: unknown[]): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
    };
  };
}

// ── Assertions ──

/**
 * Assert that a row exists in a table with the expected value.
 */
export async function assertRowValue(
  db: DbClient,
  params: {
    table: string;
    pkColumn: string;
    pkValue: unknown;
    column: string;
    expected: unknown;
  },
  logger?: AuditLogger,
  journeyId?: string,
  stepIndex?: number,
): Promise<DbAssertionResult> {
  const query = `SELECT ${params.column} FROM ${params.table} WHERE ${params.pkColumn} = '${String(params.pkValue)}'`;

  const { data, error } = await db
    .from(params.table)
    .select(params.column)
    .eq(params.pkColumn, params.pkValue)
    .single();

  const actual = error ? `ERROR: ${JSON.stringify(error)}` : data?.[params.column];
  const passed = !error && actual === params.expected;

  const result: DbAssertionResult = {
    table: params.table,
    column: params.column,
    expected: params.expected,
    actual,
    passed,
    query,
  };

  logger?.log({
    runId: logger?.['runId'] || '',
    journeyId: journeyId || '',
    stepIndex: stepIndex || 0,
    eventType: 'db_assertion',
    data: {
      table: params.table,
      column: params.column,
      expected: params.expected,
      actual,
      pkColumn: params.pkColumn,
      pkValue: params.pkValue,
    },
    outcome: passed ? 'PASS' : 'FAIL',
  });

  return result;
}

/**
 * Assert that a row exists in a table.
 */
export async function assertRowExists(
  db: DbClient,
  params: {
    table: string;
    pkColumn: string;
    pkValue: unknown;
  },
  logger?: AuditLogger,
  journeyId?: string,
  stepIndex?: number,
): Promise<DbAssertionResult> {
  const { data, error } = await db
    .from(params.table)
    .select(params.pkColumn)
    .eq(params.pkColumn, params.pkValue)
    .single();

  const passed = !error && data !== null;

  const result: DbAssertionResult = {
    table: params.table,
    column: params.pkColumn,
    expected: 'exists',
    actual: passed ? 'exists' : (error ? `ERROR: ${JSON.stringify(error)}` : 'not found'),
    passed,
    query: `SELECT ${params.pkColumn} FROM ${params.table} WHERE ${params.pkColumn} = '${String(params.pkValue)}'`,
  };

  logger?.log({
    runId: logger?.['runId'] || '',
    journeyId: journeyId || '',
    stepIndex: stepIndex || 0,
    eventType: 'db_assertion',
    data: {
      table: params.table,
      assertionType: 'exists',
      pkColumn: params.pkColumn,
      pkValue: params.pkValue,
      found: passed,
    },
    outcome: passed ? 'PASS' : 'FAIL',
  });

  return result;
}

/**
 * Assert that NO rows exist matching the given criteria.
 * Used to verify cleanup completed.
 */
export async function assertNoRows(
  db: DbClient,
  params: {
    table: string;
    column: string;
    values: unknown[];
  },
  logger?: AuditLogger,
  journeyId?: string,
  stepIndex?: number,
): Promise<DbAssertionResult> {
  const { data, error } = await db
    .from(params.table)
    .select(params.column)
    .in(params.column, params.values);

  const rowCount = data?.length ?? 0;
  const passed = !error && rowCount === 0;

  const result: DbAssertionResult = {
    table: params.table,
    column: params.column,
    expected: '0 rows',
    actual: error ? `ERROR: ${JSON.stringify(error)}` : `${rowCount} rows`,
    passed,
    query: `SELECT ${params.column} FROM ${params.table} WHERE ${params.column} IN (${params.values.map(v => `'${String(v)}'`).join(', ')})`,
  };

  logger?.log({
    runId: logger?.['runId'] || '',
    journeyId: journeyId || '',
    stepIndex: stepIndex || 0,
    eventType: 'db_assertion',
    data: {
      table: params.table,
      assertionType: 'no_rows',
      column: params.column,
      valueCount: params.values.length,
      foundRows: rowCount,
    },
    outcome: passed ? 'PASS' : 'FAIL',
  });

  return result;
}
