/**
 * Ticket check-in race condition — real PostgreSQL concurrency tests.
 *
 * Proves that the conditional UPDATE (WHERE status = 'valid') prevents
 * two concurrent scanners from both succeeding on the same ticket.
 *
 * Requires CI PostgreSQL — uses TEST_DATABASE_URL or POSTGRES_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    encoding: 'utf-8',
    input: sql,
    timeout: 10000,
  }).trim();
}

/** Run two concurrent psql sessions. A starts first, B after a short delay. */
function runTwoSessions(
  sqlA: string, sqlB: string, opts?: { delayMs?: number; timeoutMs?: number },
): Promise<{ a: { stdout: string; stderr: string; exitCode: number }; b: { stdout: string; stderr: string; exitCode: number } }> {
  const timeout = opts?.timeoutMs || 15000;
  const delay = opts?.delayMs || 200;
  const { exec } = require('child_process') as typeof import('child_process');

  function execPsql(sql: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = exec(
        `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
        { timeout, encoding: 'utf-8' },
        (error, stdout, stderr) => {
          resolve({
            stdout: (stdout || '').trim(),
            stderr: (stderr || '').trim(),
            exitCode: error ? (error as { code?: number }).code || 1 : 0,
          });
        },
      );
      child.stdin!.write(sql);
      child.stdin!.end();
    });
  }

  return new Promise(async (resolve) => {
    const promiseA = execPsql(sqlA);
    await new Promise(r => setTimeout(r, delay));
    const promiseB = execPsql(sqlB);
    const [a, b] = await Promise.all([promiseA, promiseB]);
    resolve({ a, b });
  });
}

describe.skipIf(!canRun)('Ticket check-in race condition (real PG)', () => {
  // Deterministic UUIDs scoped to this test (all valid hex)
  const BIZ = '00000000-0000-0000-face-000000000b01';
  const EVT = '00000000-0000-0000-face-000000000e01';
  const BK  = '00000000-0000-0000-face-0000000000a1';
  const TK1 = '00000000-0000-0000-face-000000000001';
  const TK2 = '00000000-0000-0000-face-000000000002';
  const USR = '00000000-0000-0000-face-00000000000a';

  beforeAll(() => {
    // Create test fixtures
    psql(`ALTER TABLE auth.users DISABLE TRIGGER ALL; INSERT INTO auth.users (id) VALUES ('${USR}') ON CONFLICT DO NOTHING; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
    psql(`ALTER TABLE profiles DISABLE TRIGGER ALL; INSERT INTO profiles (id) VALUES ('${USR}') ON CONFLICT (id) DO NOTHING; ALTER TABLE profiles ENABLE TRIGGER ALL;`);
    psql(`ALTER TABLE businesses DISABLE TRIGGER ALL;
      INSERT INTO businesses (id, owner_id, name, slug, status, address, city, phone, email)
      VALUES ('${BIZ}', '${USR}', 'RaceTest', 'racetest', 'active', 'Addr', 'City', '+234race', 'race@test.com')
      ON CONFLICT (id) DO NOTHING;
      ALTER TABLE businesses ENABLE TRIGGER ALL;`);
    psql(`INSERT INTO events (id, business_id, name, date, time, venue, price, total_tickets, tickets_sold, status)
      VALUES ('${EVT}', '${BIZ}', 'RaceEvt', '2027-01-01', '18:00', 'V', 0, 10, 0, 'published')
      ON CONFLICT (id) DO NOTHING;`);
    psql(`INSERT INTO bookings (id, business_id, user_id, event_id, date, time, party_size, flow_type, channel, status, deposit_status, deposit_amount, total_amount, guest_name, guest_phone)
      VALUES ('${BK}', '${BIZ}', '${USR}', '${EVT}', '2027-01-01', '18:00', 2, 'ticketing', 'whatsapp', 'confirmed', 'paid', 0, 0, 'Guest', '+234')
      ON CONFLICT (id) DO NOTHING;`);
  });

  afterAll(() => {
    psql(`DELETE FROM event_tickets WHERE business_id = '${BIZ}';`);
    psql(`DELETE FROM bookings WHERE id = '${BK}';`);
    psql(`DELETE FROM events WHERE id = '${EVT}';`);
    psql(`DELETE FROM businesses WHERE id = '${BIZ}';`);
    psql(`DELETE FROM profiles WHERE id = '${USR}';`);
    psql(`ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id = '${USR}'; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
  });

  function insertTicket(id: string, code: string, num: number) {
    psql(`INSERT INTO event_tickets (id, business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
      VALUES ('${id}', '${BIZ}', '${BK}', '${EVT}', '${code}', ${num}, 'Guest', '+234', 'valid')
      ON CONFLICT (id) DO UPDATE SET status = 'valid', scanned_at = NULL, scanned_by = NULL;`);
  }

  it('concurrent check-in: exactly one scanner succeeds, the other gets zero rows', async () => {
    insertTicket(TK1, 'TK-RACE01', 1);

    // Both sessions attempt the same conditional UPDATE simultaneously.
    // Session A holds the row lock via pg_advisory_xact_lock, does the UPDATE, then sleeps.
    // Session B starts immediately after, attempts the same UPDATE, blocks on the row lock,
    // and when A commits, B's WHERE status='valid' finds status='used' → 0 rows.
    const sqlA = `
      BEGIN;
      UPDATE event_tickets
        SET status = 'used', scanned_at = now(), scanned_by = 'scanner_A'
        WHERE id = '${TK1}' AND status = 'valid';
      SELECT 'A_updated_' || FOUND AS result;
      SELECT pg_sleep(2);
      COMMIT;
    `;

    const sqlB = `
      BEGIN;
      -- Small delay to ensure A's UPDATE runs first and holds the row lock
      SELECT pg_sleep(0.5);
      UPDATE event_tickets
        SET status = 'used', scanned_at = now(), scanned_by = 'scanner_B'
        WHERE id = '${TK1}' AND status = 'valid';
      SELECT 'B_updated_' || FOUND AS result;
      COMMIT;
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB, { delayMs: 50, timeoutMs: 20000 });

    // A should succeed
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toContain('A_updated_true');

    // B should NOT fail (no error), but its UPDATE should affect 0 rows
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toContain('B_updated_false');

    // Final state: ticket was checked in by scanner_A, not scanner_B
    const status = psql(`SELECT status FROM event_tickets WHERE id = '${TK1}';`);
    expect(status).toBe('used');

    const scannedBy = psql(`SELECT scanned_by FROM event_tickets WHERE id = '${TK1}';`);
    expect(scannedBy).toBe('scanner_A');
  }, 25000);

  it('already-checked-in ticket: conditional UPDATE returns zero rows, original untouched', () => {
    insertTicket(TK1, 'TK-RACE01', 1);

    // First check-in succeeds
    const firstResult = psql(`
      UPDATE event_tickets
        SET status = 'used', scanned_at = '2027-01-01T18:00:00Z', scanned_by = 'first_scanner'
        WHERE id = '${TK1}' AND status = 'valid'
      RETURNING id;
    `);
    expect(firstResult).toBe(TK1);

    // Second attempt: conditional UPDATE returns nothing
    const secondResult = psql(`
      UPDATE event_tickets
        SET status = 'used', scanned_at = '2027-01-01T19:00:00Z', scanned_by = 'second_scanner'
        WHERE id = '${TK1}' AND status = 'valid'
      RETURNING id;
    `);
    expect(secondResult).toBe('');

    // Original check-in data preserved
    const scannedBy = psql(`SELECT scanned_by FROM event_tickets WHERE id = '${TK1}';`);
    expect(scannedBy).toBe('first_scanner');

    const scannedAt = psql(`SELECT scanned_at FROM event_tickets WHERE id = '${TK1}';`);
    expect(scannedAt).toContain('2027-01-01');
    expect(scannedAt).not.toContain('19:00');
  });

  it('invalid/unknown ticket code: conditional UPDATE returns zero rows', () => {
    const result = psql(`
      UPDATE event_tickets
        SET status = 'used', scanned_at = now(), scanned_by = 'scanner'
        WHERE ticket_code = 'TK-NOEXIST' AND status = 'valid'
      RETURNING id;
    `);
    expect(result).toBe('');
  });

  it('cancelled ticket: conditional UPDATE returns zero rows', () => {
    insertTicket(TK2, 'TK-RACE02', 2);
    psql(`UPDATE event_tickets SET status = 'cancelled' WHERE id = '${TK2}';`);

    const result = psql(`
      UPDATE event_tickets
        SET status = 'used', scanned_at = now(), scanned_by = 'scanner'
        WHERE id = '${TK2}' AND status = 'valid'
      RETURNING id;
    `);
    expect(result).toBe('');

    // Status remains cancelled, not overwritten to 'used'
    const status = psql(`SELECT status FROM event_tickets WHERE id = '${TK2}';`);
    expect(status).toBe('cancelled');
  });

  it('valid first-time check-in: conditional UPDATE succeeds and sets all fields', () => {
    insertTicket(TK1, 'TK-RACE01', 1);

    const result = psql(`
      UPDATE event_tickets
        SET status = 'used', scanned_at = '2027-01-01T18:30:00Z', scanned_by = 'door_staff'
        WHERE id = '${TK1}' AND status = 'valid'
      RETURNING id, status, scanned_by;
    `);
    expect(result).toContain(TK1);
    expect(result).toContain('used');
    expect(result).toContain('door_staff');

    // Verify all fields set correctly
    const row = psql(`SELECT status, scanned_at, scanned_by FROM event_tickets WHERE id = '${TK1}';`);
    expect(row).toContain('used');
    expect(row).toContain('2027-01-01');
    expect(row).toContain('door_staff');
  });

  it('three-way race: exactly one of three concurrent scanners succeeds', async () => {
    insertTicket(TK1, 'TK-RACE01', 1);

    // Three concurrent sessions all try to check in the same ticket.
    // A holds the lock longest, B and C start shortly after.
    const makeSql = (label: string, sleepBefore: number, sleepAfter: number) => `
      BEGIN;
      SELECT pg_sleep(${sleepBefore});
      UPDATE event_tickets
        SET status = 'used', scanned_at = now(), scanned_by = '${label}'
        WHERE id = '${TK1}' AND status = 'valid';
      SELECT '${label}_updated_' || FOUND AS result;
      SELECT pg_sleep(${sleepAfter});
      COMMIT;
    `;

    const { exec } = require('child_process') as typeof import('child_process');
    function execPsql(sql: string): Promise<{ stdout: string; exitCode: number }> {
      return new Promise((resolve) => {
        const child = exec(
          `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
          { timeout: 20000, encoding: 'utf-8' },
          (error, stdout) => {
            resolve({
              stdout: (stdout || '').trim(),
              exitCode: error ? (error as { code?: number }).code || 1 : 0,
            });
          },
        );
        child.stdin!.write(sql);
        child.stdin!.end();
      });
    }

    const [a, b, c] = await Promise.all([
      execPsql(makeSql('scanner_A', 0, 2)),
      execPsql(makeSql('scanner_B', 0.3, 0)),
      execPsql(makeSql('scanner_C', 0.6, 0)),
    ]);

    // Count how many succeeded
    const successes = [a, b, c].filter(r => r.stdout.includes('_updated_true')).length;
    const failures = [a, b, c].filter(r => r.stdout.includes('_updated_false')).length;

    expect(successes).toBe(1);
    expect(failures).toBe(2);

    // Ticket used exactly once
    const status = psql(`SELECT status FROM event_tickets WHERE id = '${TK1}';`);
    expect(status).toBe('used');
  }, 25000);
});
