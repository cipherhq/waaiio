/**
 * Migration 408 — platform_settings service_role SELECT grant
 *
 * Proves:
 * - service_role has SELECT on platform_settings after all migrations
 * - service_role does NOT have INSERT/UPDATE/DELETE on platform_settings
 *
 * Requires TEST_DATABASE_URL (real PG with all migrations applied).
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const DB_URL = process.env.TEST_DATABASE_URL;
const skipDb = !DB_URL;

function sql(query: string): string {
  return execSync(
    `psql "${DB_URL}" -t -A -v ON_ERROR_STOP=1`,
    { input: query, encoding: 'utf-8', timeout: 10000 },
  ).trim();
}

describe.skipIf(skipDb)('Migration 408 — platform_settings ACL', () => {
  it('service_role has SELECT on platform_settings', () => {
    const result = sql(`
      SELECT has_table_privilege('service_role', 'public.platform_settings', 'SELECT');
    `);
    expect(result).toBe('t');
  });

  it('service_role does NOT have INSERT on platform_settings', () => {
    const result = sql(`
      SELECT has_table_privilege('service_role', 'public.platform_settings', 'INSERT');
    `);
    expect(result).toBe('f');
  });

  it('service_role does NOT have UPDATE on platform_settings', () => {
    const result = sql(`
      SELECT has_table_privilege('service_role', 'public.platform_settings', 'UPDATE');
    `);
    expect(result).toBe('f');
  });

  it('service_role does NOT have DELETE on platform_settings', () => {
    const result = sql(`
      SELECT has_table_privilege('service_role', 'public.platform_settings', 'DELETE');
    `);
    expect(result).toBe('f');
  });
});
