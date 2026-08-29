/**
 * #219: Notification enum PostgreSQL evidence
 *
 * Proves against the real migrated schema that:
 * A. 'payment' is a valid notification_type enum value (cast succeeds)
 * B. 'payment_received' is NOT a valid value (cast fails with 22P02)
 * C. 'donation' is NOT a valid value (cast fails with 22P02)
 *
 * Uses direct enum casting rather than table INSERTs to avoid
 * needing FK dependencies (businesses, etc.).
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Skips gracefully in local dev if no DB connection.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: (e as { stderr?: string }).stderr || String(e) };
  }
}

describe.skipIf(!canRun)('#219 notification_type enum — PostgreSQL evidence', () => {

  it('A. payment is a valid notification_type enum value', () => {
    // Direct enum cast — succeeds if and only if the value is in the enum
    const result = psql("SELECT 'payment'::notification_type;");
    expect(result).toBe('payment');
  });

  it('B. payment_received is NOT a valid notification_type value (22P02)', () => {
    const result = psqlMayFail("SELECT 'payment_received'::notification_type;");
    expect(result.ok).toBe(false);
    expect(result.output).toContain('22P02');
  });

  it('C. donation is NOT a valid notification_type value (22P02)', () => {
    const result = psqlMayFail("SELECT 'donation'::notification_type;");
    expect(result.ok).toBe(false);
    expect(result.output).toContain('22P02');
  });
});
