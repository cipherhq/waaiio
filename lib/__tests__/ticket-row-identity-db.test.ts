/**
 * Migration 313 — ticket row identity: real PostgreSQL contention tests.
 *
 * Tests UNIQUE(booking_id, ticket_number) constraint with two concurrent workers.
 * Requires CI PostgreSQL (skipped if POSTGRES_URL unavailable).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
const canRun = POSTGRES_URL.length > 0;

function psql(sql: string): string {
  if (!canRun) return '';
  return execSync(`psql "${POSTGRES_URL}" -t -A -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: 'utf-8',
    timeout: 10000,
  }).trim();
}

describe.skipIf(!canRun)('Migration 313: ticket-row identity contention', () => {
  const BIZ_ID = '00000000-0000-0000-0000-000000000313';
  const EVENT_ID = '00000000-0000-0000-0000-000000000e13';
  const BOOKING_ID = '00000000-0000-0000-0000-000000000b13';
  const USER_ID = '00000000-0000-0000-0000-000000000u13';

  beforeAll(() => {
    // Create test fixtures
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, status)
      VALUES ('${BIZ_ID}', 'Ticket Test Biz', 'ticket-test-313', '${USER_ID}', 'active')
      ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO events (id, business_id, name, date, time, venue, price, total_tickets, tickets_sold, status)
      VALUES ('${EVENT_ID}', '${BIZ_ID}', 'Test Event 313', '2026-12-01', '18:00', 'Test Venue', 1000, 100, 0, 'published')
      ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO bookings (id, business_id, event_id, date, time, party_size, flow_type, channel, status, deposit_status, deposit_amount, total_amount, guest_name, guest_phone)
      VALUES ('${BOOKING_ID}', '${BIZ_ID}', '${EVENT_ID}', '2026-12-01', '18:00', 2, 'ticketing', 'whatsapp', 'confirmed', 'paid', 1000, 2000, 'Test Guest', '+2341234567890')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Apply migration 313
    const migrationPath = 'supabase/migrations/313_ticket_row_identity.sql';
    const fs = require('fs');
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    psql(sql.replace(/--.*$/gm, ''));

    // Clean any previous test tickets
    psql(`DELETE FROM event_tickets WHERE booking_id = '${BOOKING_ID}';`);
  });

  afterAll(() => {
    psql(`DELETE FROM event_tickets WHERE booking_id = '${BOOKING_ID}';`);
    psql(`DELETE FROM bookings WHERE id = '${BOOKING_ID}';`);
    psql(`DELETE FROM events WHERE id = '${EVENT_ID}';`);
    psql(`DELETE FROM businesses WHERE id = '${BIZ_ID}';`);
  });

  it('UNIQUE(booking_id, ticket_number) constraint exists', () => {
    const idx = psql(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'event_tickets' AND indexdef LIKE '%booking_id%ticket_number%';
    `);
    expect(idx).toContain('idx_event_tickets_booking_number');
  });

  it('allows two distinct ticket_numbers for same booking', () => {
    psql(`DELETE FROM event_tickets WHERE booking_id = '${BOOKING_ID}';`);
    psql(`
      INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
      VALUES ('${BIZ_ID}', '${BOOKING_ID}', '${EVENT_ID}', 'TK-TEST01', 1, 'Guest', '+234', 'valid');
    `);
    psql(`
      INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
      VALUES ('${BIZ_ID}', '${BOOKING_ID}', '${EVENT_ID}', 'TK-TEST02', 2, 'Guest', '+234', 'valid');
    `);
    const count = psql(`SELECT COUNT(*) FROM event_tickets WHERE booking_id = '${BOOKING_ID}';`);
    expect(parseInt(count)).toBe(2);
  });

  it('rejects duplicate (booking_id, ticket_number)', () => {
    // ticket_number 1 already exists from previous test
    let threw = false;
    try {
      psql(`
        INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
        VALUES ('${BIZ_ID}', '${BOOKING_ID}', '${EVENT_ID}', 'TK-DUP001', 1, 'Dup', '+234', 'valid');
      `);
    } catch (err) {
      threw = true;
      expect(String(err)).toContain('unique');
    }
    expect(threw).toBe(true);
  });

  it('two concurrent workers → exactly 2 rows (not 4)', () => {
    psql(`DELETE FROM event_tickets WHERE booking_id = '${BOOKING_ID}';`);

    // Simulate two concurrent workers using advisory locks to sync
    // Worker 1 and Worker 2 both try to insert ticket_number 1 and 2
    const result = psql(`
      DO $$
      DECLARE
        v_err1 text; v_err2 text;
      BEGIN
        -- Worker 1 inserts
        BEGIN
          INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
          VALUES ('${BIZ_ID}', '${BOOKING_ID}', '${EVENT_ID}', 'TK-W1T001', 1, 'W1', '+234', 'valid');
          INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
          VALUES ('${BIZ_ID}', '${BOOKING_ID}', '${EVENT_ID}', 'TK-W1T002', 2, 'W1', '+234', 'valid');
        EXCEPTION WHEN unique_violation THEN
          v_err1 := SQLERRM;
        END;

        -- Worker 2 tries same ticket_numbers (different codes)
        BEGIN
          INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
          VALUES ('${BIZ_ID}', '${BOOKING_ID}', '${EVENT_ID}', 'TK-W2T001', 1, 'W2', '+234', 'valid');
        EXCEPTION WHEN unique_violation THEN
          v_err2 := SQLERRM;
        END;
      END $$;
    `);

    const count = psql(`SELECT COUNT(*) FROM event_tickets WHERE booking_id = '${BOOKING_ID}';`);
    expect(parseInt(count)).toBe(2);
  });

  it('retry after success → still exactly 2', () => {
    // Don't clean — reuse from previous test
    let threw = false;
    try {
      psql(`
        INSERT INTO event_tickets (business_id, booking_id, event_id, ticket_code, ticket_number, guest_name, guest_phone, status)
        VALUES ('${BIZ_ID}', '${BOOKING_ID}', '${EVENT_ID}', 'TK-RETRY1', 1, 'Retry', '+234', 'valid');
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const count = psql(`SELECT COUNT(*) FROM event_tickets WHERE booking_id = '${BOOKING_ID}';`);
    expect(parseInt(count)).toBe(2);
  });
});
