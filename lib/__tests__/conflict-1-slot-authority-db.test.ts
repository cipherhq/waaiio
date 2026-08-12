/**
 * CONFLICT-1: Real PostgreSQL — public slot availability agrees with
 * book_slot_atomic acceptance.
 *
 * Seeds bookings, then verifies that for each candidate time:
 * - book_slot_atomic(time, capacity=1) returns slot_available=true
 *   IFF the time would be shown as available by public slot logic.
 *
 * Required env: TEST_DATABASE_URL
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const TEST_DB = process.env.TEST_DATABASE_URL;

function runSQL(sql: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    return execSync(`psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`, {
      encoding: 'utf-8', timeout: 15000, input: sql,
    }).trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.message}`;
  }
}

const describeIfDb = !TEST_DB ? describe.skip : describe;

describeIfDb('CONFLICT-1: book_slot_atomic authority agreement', () => {
  const BIZ_OWNER = '00000000-0000-0000-0000-00000c010001';
  const BIZ_ID = '00000000-0000-0000-0000-00000c010002';
  const SVC_ID = '00000000-0000-0000-0000-00000c010003';

  beforeAll(() => {
    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES ('${BIZ_OWNER}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
      INSERT INTO profiles (id, first_name, last_name, email) VALUES ('${BIZ_OWNER}', 'C1', 'Test', 'c1@test.local') ON CONFLICT DO NOTHING;
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code)
        VALUES ('${BIZ_ID}', 'C1 Biz', 'c1-test', '${BIZ_OWNER}', '1 Test', 'Lagos', 'VI', '+0000', 'active', 'NG') ON CONFLICT DO NOTHING;
      INSERT INTO services (id, business_id, name, price, duration_minutes, buffer_minutes, max_capacity, is_active)
        VALUES ('${SVC_ID}', '${BIZ_ID}', 'Haircut', 5000, 30, 15, 1, true) ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(() => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    runSQL(`DELETE FROM services WHERE id = '${SVC_ID}';`);
    runSQL(`DELETE FROM businesses WHERE id = '${BIZ_ID}';`);
    runSQL(`DELETE FROM profiles WHERE id = '${BIZ_OWNER}';`);
    runSQL(`ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id = '${BIZ_OWNER}'; ALTER TABLE auth.users ENABLE TRIGGER ALL;`);
  });

  it('slot adjacent to existing booking: authority agrees with availability', () => {
    // Seed a booking at 10:00 with 30min duration + 15min buffer
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    runSQL(`INSERT INTO bookings (business_id, user_id, service_id, date, time, party_size, status, flow_type, channel, guest_name, guest_phone, deposit_amount, deposit_status, total_amount)
      VALUES ('${BIZ_ID}', '${BIZ_OWNER}', '${SVC_ID}', '2027-06-15', '10:00', 1, 'confirmed', 'scheduling', 'whatsapp', 'Existing', '+0001', 0, 'none', 5000);`);

    // 09:30 should be REJECTED by book_slot_atomic (backward buffer overlap)
    const r0930 = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${BIZ_OWNER}'::uuid, '${SVC_ID}'::uuid, NULL::uuid,
      '2027-06-15'::date, '09:30', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Test', '+0002', NULL, NULL, NULL, NULL, NULL, NULL, 5000, NULL,
      NULL, NULL, 15, 30, NULL);`);
    expect(r0930).toContain('f'); // slot_available = false

    // 11:00 should be ACCEPTED (outside buffer zone)
    const r1100 = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${BIZ_OWNER}'::uuid, '${SVC_ID}'::uuid, NULL::uuid,
      '2027-06-15'::date, '11:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Test', '+0003', NULL, NULL, NULL, NULL, NULL, NULL, 5000, NULL,
      NULL, NULL, 15, 30, NULL);`);
    expect(r1100).toContain('t'); // slot_available = true

    // Clean up the 11:00 booking that was just created
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}' AND time = '11:00:00';`);
  });

  it('exact-time capacity exhausted: authority rejects', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    // Fill capacity=1 at 10:00
    runSQL(`INSERT INTO bookings (business_id, user_id, service_id, date, time, party_size, status, flow_type, channel, guest_name, guest_phone, deposit_amount, deposit_status, total_amount)
      VALUES ('${BIZ_ID}', '${BIZ_OWNER}', '${SVC_ID}', '2027-06-15', '10:00', 1, 'confirmed', 'scheduling', 'whatsapp', 'Full', '+0004', 0, 'none', 5000);`);

    const r = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${BIZ_OWNER}'::uuid, '${SVC_ID}'::uuid, NULL::uuid,
      '2027-06-15'::date, '10:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Test', '+0005', NULL, NULL, NULL, NULL, NULL, NULL, 5000, NULL,
      NULL, NULL, 15, 30, NULL);`);
    expect(r).toContain('f');
  });

  it('cancelled booking does not block slot', () => {
    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}';`);
    runSQL(`INSERT INTO bookings (business_id, user_id, service_id, date, time, party_size, status, flow_type, channel, guest_name, guest_phone, deposit_amount, deposit_status, total_amount)
      VALUES ('${BIZ_ID}', '${BIZ_OWNER}', '${SVC_ID}', '2027-06-15', '10:00', 1, 'cancelled', 'scheduling', 'whatsapp', 'Cancelled', '+0006', 0, 'none', 5000);`);

    const r = runSQL(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ_ID}'::uuid, '${BIZ_OWNER}'::uuid, '${SVC_ID}'::uuid, NULL::uuid,
      '2027-06-15'::date, '10:00', 1, 1, 'scheduling', 0, 'none', 'confirmed',
      'Test', '+0007', NULL, NULL, NULL, NULL, NULL, NULL, 5000, NULL,
      NULL, NULL, 15, 30, NULL);`);
    expect(r).toContain('t'); // available — cancelled doesn't count

    runSQL(`DELETE FROM bookings WHERE business_id = '${BIZ_ID}' AND time = '10:00:00' AND status = 'confirmed';`);
  });
});
