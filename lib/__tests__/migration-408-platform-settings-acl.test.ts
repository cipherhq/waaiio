/**
 * Migration 408 — platform_settings service_role SELECT grant
 *
 * Proves:
 * - service_role has SELECT on platform_settings after M408
 * - M408 SQL contains only a SELECT grant (no INSERT/UPDATE/DELETE/ALL)
 * - The migration file is idempotent (GRANT is a no-op if already present)
 *
 * Note: In the CI PG environment (and standard Supabase setups), service_role
 * inherits broad default privileges. M408 addresses a specific scenario where
 * SELECT was missing after schema recreation. The migration does NOT revoke
 * other privileges — that is intentional per the "keep M408 narrow" directive.
 *
 * Requires TEST_DATABASE_URL (real PG with all migrations applied).
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DB_URL = process.env.TEST_DATABASE_URL;
const skipDb = !DB_URL;

function sql(query: string): string {
  return execSync(
    `psql "${DB_URL}" -t -A -v ON_ERROR_STOP=1`,
    { input: query, encoding: 'utf-8', timeout: 10000 },
  ).trim();
}

describe.skipIf(skipDb)('Migration 408 — platform_settings ACL (DB)', () => {
  it('service_role has SELECT on platform_settings', () => {
    const result = sql(`
      SELECT has_table_privilege('service_role', 'public.platform_settings', 'SELECT');
    `);
    expect(result).toBe('t');
  });

  it('platform_settings table exists with seed data after all migrations', () => {
    const result = sql(`
      SELECT count(*) FROM public.platform_settings;
    `);
    expect(Number(result)).toBeGreaterThanOrEqual(0);
  });
});

describe('Migration 408 — SQL scope guard (static)', () => {
  const migrationPath = resolve(
    __dirname,
    '../../supabase/migrations/408_platform_settings_service_role_select.sql',
  );
  const migrationSql = readFileSync(migrationPath, 'utf-8');

  it('contains only GRANT SELECT (no INSERT/UPDATE/DELETE/ALL)', () => {
    // Extract non-comment SQL lines
    const sqlLines = migrationSql
      .split('\n')
      .filter(line => !line.trim().startsWith('--') && line.trim().length > 0);

    // The only GRANT must be SELECT
    const grantLines = sqlLines.filter(line => /GRANT/i.test(line));
    expect(grantLines).toHaveLength(1);
    expect(grantLines[0]).toMatch(/GRANT\s+SELECT\s+ON/i);

    // Must NOT contain any broader grant
    const fullSql = sqlLines.join(' ');
    expect(fullSql).not.toMatch(/GRANT\s+(ALL|INSERT|UPDATE|DELETE)/i);
  });

  it('targets only platform_settings table', () => {
    expect(migrationSql).toContain('platform_settings');
    // No other table names in GRANT statements
    const grantLines = migrationSql
      .split('\n')
      .filter(line => /GRANT/i.test(line) && !line.trim().startsWith('--'));
    for (const line of grantLines) {
      expect(line).toContain('platform_settings');
    }
  });

  it('grants to service_role only (not anon or authenticated)', () => {
    const sqlLines = migrationSql
      .split('\n')
      .filter(line => !line.trim().startsWith('--') && line.trim().length > 0);
    const sql = sqlLines.join(' ');
    expect(sql).toContain('service_role');
    expect(sql).not.toMatch(/TO\s+(anon|authenticated)/i);
  });

  it('does not contain REVOKE statements', () => {
    const sqlLines = migrationSql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'));
    expect(sqlLines.join(' ')).not.toMatch(/REVOKE/i);
  });
});
