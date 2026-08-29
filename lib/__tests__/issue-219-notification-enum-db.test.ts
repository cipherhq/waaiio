/**
 * #219: Notification enum PostgreSQL evidence
 *
 * Proves against the real migrated schema that:
 * A. 'payment' is a valid notification_type enum value (INSERT succeeds)
 * B. 'payment_received' is NOT a valid value (INSERT fails with 22P02)
 * C. 'donation' is NOT a valid value (INSERT fails with 22P02)
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Skips gracefully in local dev if no DB connection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  let testBusinessId: string;
  const insertedIds: string[] = [];

  beforeAll(() => {
    // Create a minimal business for FK reference (include all NOT NULL columns)
    testBusinessId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, category, address)
      VALUES (gen_random_uuid(), 'test-219-enum', 'test-219-enum-' || gen_random_uuid()::text,
              (SELECT id FROM profiles LIMIT 1),
              'other', 'Test Address')
      RETURNING id;
    `);
  });

  afterAll(() => {
    // Clean up test data
    for (const id of insertedIds) {
      psql(`DELETE FROM notifications WHERE id = '${id}';`);
    }
    if (testBusinessId) {
      psql(`DELETE FROM businesses WHERE id = '${testBusinessId}';`);
    }
  });

  it('A. INSERT with type=payment succeeds', () => {
    const id = psql(`
      INSERT INTO notifications (business_id, type, channel, body, status)
      VALUES ('${testBusinessId}', 'payment', 'whatsapp', '#219 test: valid enum', 'delivered')
      RETURNING id;
    `);
    expect(id).toBeTruthy();
    insertedIds.push(id);
  });

  it('B. INSERT with type=payment_received fails (22P02)', () => {
    const result = psqlMayFail(`
      INSERT INTO notifications (business_id, type, channel, body, status)
      VALUES ('${testBusinessId}', 'payment_received', 'whatsapp', '#219 test: invalid enum', 'delivered')
      RETURNING id;
    `);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('22P02');
  });

  it('C. INSERT with type=donation fails (22P02)', () => {
    const result = psqlMayFail(`
      INSERT INTO notifications (business_id, type, channel, body, status)
      VALUES ('${testBusinessId}', 'donation', 'whatsapp', '#219 test: invalid enum', 'delivered')
      RETURNING id;
    `);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('22P02');
  });
});
