/**
 * Migration 313 — ticket row identity: real PostgreSQL tests.
 *
 * Tests UNIQUE(booking_id, ticket_number) with real two-session concurrency.
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

/** Run two concurrent psql sessions. A starts first, B after 500ms delay. */
function runTwoSessions(
  sqlA: string, sqlB: string, opts?: { timeoutMs?: number },
): Promise<{ a: { stdout: string; stderr: string; exitCode: number }; b: { stdout: string; stderr: string; exitCode: number } }> {
  const timeout = opts?.timeoutMs || 15000;
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
    await new Promise(r => setTimeout(r, 500));
    const promiseB = execPsql(sqlB);
    const [a, b] = await Promise.all([promiseA, promiseB]);
    resolve({ a, b });
  });
}

describe.skipIf(!canRun)('Migration 313: ticket-row identity', () => {
  const BIZ = '00000000-0000-0000-0313-000000000b01';
  const EVT = '00000000-0000-0000-0313-000000000e01';
  const BK  = '00000000-0000-0000-0313-0000000000a1';

  const USR = '00000000-0000-0000-0313-000000000001';

  beforeAll(() => {
    psql(`ALTER TABLE auth.users DISABLE TRIGGER ALL; INSERT INTO auth.users (id) VALUES ('${USR}') ON CONFLICT DO NOTHING; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
    psql(`ALTER TABLE profiles DISABLE TRIGGER ALL; INSERT INTO profiles (id) VALUES ('${USR}') ON CONFLICT (id) DO NOTHING; ALTER TABLE profiles ENABLE TRIGGER ALL;`);
    psql(`INSERT INTO businesses (id, name, slug, owner_id, status, address) VALUES ('${BIZ}', 'TicketTest313', 'tt313', '${USR}', 'active', 'Test Address') ON CONFLICT (id) DO NOTHING;`);
    psql(`INSERT INTO events (id, business_id, name, date, time, venue, price, total_tickets, tickets_sold, status) VALUES ('${EVT}', '${BIZ}', 'Evt313', '2027-01-01', '18:00', 'V', 1000, 100, 0, 'published') ON CONFLICT (id) DO NOTHING;`);
    psql(`INSERT INTO bookings (id, business_id, event_id, date, time, party_size, flow_type, channel, status, deposit_status, deposit_amount, total_amount, guest_name, guest_phone) VALUES ('${BK}', '${BIZ}', '${EVT}', '2027-01-01', '18:00', 2, 'ticketing', 'whatsapp', 'confirmed', 'paid', 1000, 2000, 'Guest', '+234') ON CONFLICT (id) DO NOTHING;`);

    // Apply migration 313
    const fs = require('fs');
    const migSql = fs.readFileSync('supabase/migrations/313_ticket_row_identity.sql', 'utf-8');
    psql(migSql.replace(/--.*$/gm, ''));

    psql(`DELETE FROM event_tickets WHERE booking_id = '${BK}';`);
  });

  afterAll(() => {
    psql(`DELETE FROM event_tickets WHERE booking_id = '${BK}';`);
    psql(`DELETE FROM bookings WHERE id = '${BK}';`);
    psql(`DELETE FROM events WHERE id = '${EVT}';`);
    psql(`DELETE FROM businesses WHERE id = '${BIZ}';`);
    psql(`DELETE FROM profiles WHERE id = '${USR}';`);
    psql(`DELETE FROM auth.users WHERE id = '${USR}';`);
  });

  it('UNIQUE index exists', () => {
    const idx = psql(`SELECT indexname FROM pg_indexes WHERE tablename = 'event_tickets' AND indexdef LIKE '%booking_id%ticket_number%';`);
    expect(idx).toContain('idx_event_tickets_booking_number');
  });

  it('allows distinct ticket_numbers for same booking', () => {
    psql(`DELETE FROM event_tickets WHERE booking_id = '${BK}';`);
    psql(`INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status) VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313A01', 1, 'G', '+234', 'valid');`);
    psql(`INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status) VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313A02', 2, 'G', '+234', 'valid');`);
    expect(parseInt(psql(`SELECT COUNT(*) FROM event_tickets WHERE booking_id = '${BK}';`))).toBe(2);
  });

  it('rejects duplicate (booking_id, ticket_number)', () => {
    let threw = false;
    try {
      psql(`INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status) VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313DUP', 1, 'G', '+234', 'valid');`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('real two-session concurrency: quantity 2 → exactly 2 rows', async () => {
    psql(`DELETE FROM event_tickets WHERE booking_id = '${BK}';`);

    // Worker A: inserts ticket_number 1 and 2 (holds a brief advisory lock to create overlap window)
    const sqlA = `
      BEGIN;
      SELECT pg_advisory_lock(313313);
      INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
        VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313W1A', 1, 'WorkerA', '+234', 'valid');
      INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
        VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313W1B', 2, 'WorkerA', '+234', 'valid');
      SELECT pg_advisory_unlock(313313);
      SELECT 'workerA_done';
      COMMIT;
    `;

    // Worker B: attempts same ticket_numbers with different codes
    const sqlB = `
      BEGIN;
      SELECT pg_sleep(0.3);
      INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
        VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313W2A', 1, 'WorkerB', '+234', 'valid');
      INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
        VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313W2B', 2, 'WorkerB', '+234', 'valid');
      SELECT 'workerB_done';
      COMMIT;
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB);

    // Worker A should succeed
    expect(a.stdout).toContain('workerA_done');

    // Worker B should fail with unique violation
    expect(b.exitCode).not.toBe(0);
    expect(b.stderr).toMatch(/unique|duplicate/i);

    // Final state: exactly 2 rows, both from Worker A
    const count = parseInt(psql(`SELECT COUNT(*) FROM event_tickets WHERE booking_id = '${BK}';`));
    expect(count).toBe(2);

    const numbers = psql(`SELECT ticket_number FROM event_tickets WHERE booking_id = '${BK}' ORDER BY ticket_number;`);
    expect(numbers).toBe('1\n2');
  }, 20000);

  it('retry after success → still exactly 2', () => {
    let threw = false;
    try {
      psql(`INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status) VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313RET', 1, 'Retry', '+234', 'valid');`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(parseInt(psql(`SELECT COUNT(*) FROM event_tickets WHERE booking_id = '${BK}';`))).toBe(2);
  });

  it('partial state repair: only ticket 1 exists → insert ticket 2 succeeds', () => {
    psql(`DELETE FROM event_tickets WHERE booking_id = '${BK}';`);
    psql(`INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status) VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313P01', 1, 'G', '+234', 'valid');`);
    // Insert only missing ticket 2
    psql(`INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status) VALUES ('${BIZ}', '${BK}', '${EVT}', 'TK-313P02', 2, 'G', '+234', 'valid');`);
    const count = parseInt(psql(`SELECT COUNT(*) FROM event_tickets WHERE booking_id = '${BK}';`));
    expect(count).toBe(2);
    const numbers = psql(`SELECT ticket_number FROM event_tickets WHERE booking_id = '${BK}' ORDER BY ticket_number;`);
    expect(numbers).toBe('1\n2');
  });
});
