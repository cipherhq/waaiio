/**
 * P1-STAFF-1: Staff booking authority — source verification + real PostgreSQL tests
 *
 * Tests:
 * Source verification:
 * 1-3: check_staff_availability function correctness
 * 4-6: book_slot_atomic staff integration
 * 7-9: reschedule staff integration
 * 10-11: bot day-key compatibility
 * 12-14: manual booking staff validation
 * 15-16: public booking requires_staff handling
 *
 * Real PostgreSQL tests (require TEST_DATABASE_URL):
 * DB-1: short key "mon" works for Monday
 * DB-2: short-key off-day rejected
 * DB-3: long-form legacy key works
 * DB-4: NULL schedule unrestricted
 * DB-5: empty schedule unrestricted
 * DB-6: time before staff start rejected
 * DB-7: exact staff start allowed
 * DB-8: booking ending exactly at staff end allowed
 * DB-9: booking extending past staff end rejected
 * DB-10: inactive staff rejected
 * DB-11: cross-business staff rejected
 * DB-12: optional-staff + NULL staff allowed
 * DB-13: requires_staff + NULL staff rejected
 * DB-14: supplied available staff can book
 * DB-15: failed authority creates ZERO booking rows
 * DB-16: reschedule to staff off-hours rejected with booking unchanged
 * DB-17: valid staff reschedule succeeds
 * DB-18: existing appointment booking still works
 * DB-19: existing appointment schedule rejection still works
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// ══════════════════════════════════════════════════════════
// Source Verification
// ══════════════════════════════════════════════════════════

describe('P1-STAFF-1: source verification', () => {
  const migration319 = readFileSync('supabase/migrations/319_staff_booking_authority.sql', 'utf-8');
  const schedulingFlow = readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
  const manualRoute = readFileSync('app/api/bookings/create-manual/route.ts', 'utf-8');
  const publicRoute = readFileSync('app/api/bookings/public/create/route.ts', 'utf-8');
  const constants = readFileSync('lib/constants.ts', 'utf-8');

  // ── check_staff_availability helper ──
  it('1. check_staff_availability validates staff existence', () => {
    expect(migration319).toContain("'staff_not_found'");
  });

  it('2. check_staff_availability validates business ownership', () => {
    expect(migration319).toContain("'staff_business_mismatch'");
  });

  it('3. check_staff_availability validates active status', () => {
    expect(migration319).toContain("'staff_inactive'");
  });

  it('4. check_staff_availability supports short day keys (mon,tue,...)', () => {
    expect(migration319).toContain("WHEN 1 THEN 'mon'");
    expect(migration319).toContain("WHEN 5 THEN 'fri'");
  });

  it('5. check_staff_availability supports long day keys (monday,...) as fallback', () => {
    expect(migration319).toContain("WHEN 1 THEN 'monday'");
    // COALESCE tries short first, then long
    expect(migration319).toContain('v_staff.schedule -> v_short_key');
    expect(migration319).toContain('v_staff.schedule -> v_long_key');
  });

  it('6. check_staff_availability validates duration does not exceed staff end', () => {
    expect(migration319).toContain("'staff_past_end'");
    expect(migration319).toContain('v_booking_end > v_end');
  });

  it('7. NULL schedule treated as unrestricted', () => {
    expect(migration319).toContain('v_staff.schedule IS NULL');
    // Should return true when null
    const nullBlock = migration319.slice(
      migration319.indexOf('v_staff.schedule IS NULL'),
      migration319.indexOf("'staff_day_unavailable'"),
    );
    expect(nullBlock).toContain('SELECT true');
  });

  it('8. empty schedule treated as unrestricted', () => {
    expect(migration319).toContain("v_staff.schedule = '{}'::jsonb");
  });

  // ── book_slot_atomic integration ──
  it('9. book_slot_atomic calls check_staff_availability when staff_id provided', () => {
    const bsaBlock = migration319.slice(migration319.indexOf('book_slot_atomic'));
    expect(bsaBlock).toContain('check_staff_availability(p_staff_id, p_business_id, p_date, p_time');
  });

  it('10. book_slot_atomic resolves requires_staff from authoritative record', () => {
    const bsaBlock = migration319.slice(migration319.indexOf('book_slot_atomic'));
    expect(bsaBlock).toContain('requires_staff');
    expect(bsaBlock).toContain("FROM appointments a WHERE a.id = p_appointment_id");
    expect(bsaBlock).toContain("FROM services s WHERE s.id = p_service_id");
  });

  it('11. book_slot_atomic rejects NULL staff for requires_staff items', () => {
    const bsaBlock = migration319.slice(migration319.indexOf('book_slot_atomic'));
    expect(bsaBlock).toContain('v_requires_staff');
    // After resolving requires_staff=true and staff_id=NULL, should return false
    const requiresBlock = bsaBlock.slice(bsaBlock.indexOf('v_requires_staff'));
    expect(requiresBlock).toContain('RETURN QUERY SELECT NULL::uuid');
  });

  it('12. book_slot_atomic preserves appointment schedule check', () => {
    const bsaBlock = migration319.slice(migration319.indexOf('book_slot_atomic'));
    expect(bsaBlock).toContain('check_appointment_schedule');
  });

  it('13. book_slot_atomic preserves idempotency ordering (retry before validation)', () => {
    // Find the book_slot_atomic function body (after CREATE OR REPLACE)
    const fnStart = migration319.indexOf('CREATE OR REPLACE FUNCTION public.book_slot_atomic');
    const bsaBlock = migration319.slice(fnStart);
    const idempPos = bsaBlock.indexOf('p_bot_session_id IS NOT NULL');
    const staffPos = bsaBlock.indexOf('check_staff_availability');
    expect(idempPos).toBeLessThan(staffPos);
  });

  // ── reschedule integration ──
  it('14. reschedule_booking_atomic validates staff availability at new time', () => {
    const reschedBlock = migration319.slice(migration319.indexOf('reschedule_booking_atomic'));
    expect(reschedBlock).toContain('check_staff_availability(v_booking.staff_id');
  });

  it('15. reschedule preserves appointment schedule check', () => {
    const reschedBlock = migration319.slice(migration319.indexOf('reschedule_booking_atomic'));
    expect(reschedBlock).toContain('check_appointment_schedule');
  });

  // ── Bot day-key compatibility ──
  it('16. bot imports getStaffDaySchedule utility', () => {
    expect(schedulingFlow).toContain('getStaffDaySchedule');
  });

  it('17. bot uses getStaffDaySchedule for staff schedule lookup (not raw dayOfWeek key)', () => {
    // The staff schedule filter section should use getStaffDaySchedule
    const filterStart = schedulingFlow.indexOf('Filter by staff schedule');
    // Find the next "if (staff.length" AFTER the filter section
    const filterEnd = schedulingFlow.indexOf('if (staff.length === 0)', filterStart + 10);
    const staffSection = schedulingFlow.slice(filterStart, filterEnd);
    expect(staffSection).not.toContain("s.schedule[dayOfWeek]");
    expect(staffSection).toContain('getStaffDaySchedule');
  });

  it('18. constants exports short-key utility functions', () => {
    expect(constants).toContain('export function getStaffDaySchedule');
    expect(constants).toContain('export function isStaffAvailable');
    expect(constants).toContain('SHORT_DAY_KEYS');
  });

  it('19. bot blocks booking when requires_staff and no staff available', () => {
    // Must NOT return true when requires_staff and staff.length === 0
    const staffSkipSection = schedulingFlow.slice(
      schedulingFlow.indexOf("id: 'select_staff'"),
      schedulingFlow.indexOf("id: 'select_date'"),
    );
    expect(staffSkipSection).toContain('_staff_unavailable');
    expect(staffSkipSection).toContain('_service_requires_staff');
  });

  it('20. bot staff-unavailable prompt offers date change or cancel', () => {
    expect(schedulingFlow).toContain('pick_another_date_staff');
    expect(schedulingFlow).toContain('cancel_staff');
    expect(schedulingFlow).toContain('no staff members are available');
  });

  it('21. bot narrows time slots by staff schedule when staff assigned', () => {
    const timeSection = schedulingFlow.slice(
      schedulingFlow.indexOf("id: 'select_time'"),
      schedulingFlow.indexOf("id: 'select_addons'"),
    );
    expect(timeSection).toContain('getStaffDaySchedule');
    expect(timeSection).toContain('staffOpen');
    expect(timeSection).toContain('staffClose');
  });

  // ── Manual booking validation ──
  it('22. manual route validates staff belongs to business', () => {
    expect(manualRoute).toContain(".eq('business_id', businessId)");
    // Should be in the staff lookup section
    const staffSection = manualRoute.slice(
      manualRoute.indexOf('Look up and validate staff'),
      manualRoute.indexOf('Resolve customer identity'),
    );
    expect(staffSection).toContain("eq('business_id', businessId)");
  });

  it('23. manual route validates staff is active', () => {
    expect(manualRoute).toContain('is_active');
    expect(manualRoute).toContain('Staff member is no longer active');
  });

  it('24. manual route resolves requires_staff from item lookup and rejects without staffId', () => {
    expect(manualRoute).toContain('requires_staff');
    expect(manualRoute).toContain('This service requires a staff member to be assigned');
    // requires_staff is included in the item SELECT, not a separate query
    expect(manualRoute).toContain("'name, price, duration_minutes, max_capacity, buffer_minutes, requires_staff'");
  });

  it('25. manual route no direct INSERT into bookings', () => {
    expect(manualRoute).not.toContain(".from('bookings').insert(");
  });

  // ── Public booking validation ──
  it('26. public route handles requires_staff items', () => {
    expect(publicRoute).toContain('itemRequiresStaff');
    expect(publicRoute).toContain('requires_staff');
  });

  it('27. public route auto-assigns staff for requires_staff items', () => {
    expect(publicRoute).toContain('autoStaffId');
    expect(publicRoute).toContain('autoStaffName');
  });

  it('28. public route rejects when no staff available for requires_staff', () => {
    expect(publicRoute).toContain('No staff members are available');
  });

  it('29. public route passes autoStaffId to book_slot_atomic', () => {
    expect(publicRoute).toContain('p_staff_id: autoStaffId');
    expect(publicRoute).toContain('p_staff_name: autoStaffName');
  });

  it('30. public route checks staff availability with isStaffAvailable', () => {
    expect(publicRoute).toContain('isStaffAvailable');
  });

  // ── Regression guards ──
  it('31. MK-3: manual route still uses createWhatsAppUser', () => {
    expect(manualRoute).toContain('createWhatsAppUser');
  });

  it('32. MK-3: manual route still calls book_manual_slot_atomic', () => {
    expect(manualRoute).toContain("rpc('book_manual_slot_atomic'");
  });

  it('33. CONFLICT-1: public slot route still uses cross-service capacity', () => {
    const slotRoute = readFileSync('app/api/bookings/public/slots/route.ts', 'utf-8');
    const bookingsSection = slotRoute.slice(slotRoute.indexOf("from('bookings')"));
    const nextFrom = bookingsSection.indexOf('.from(', 1);
    const bookingsQuery = nextFrom > 0 ? bookingsSection.slice(0, nextFrom) : bookingsSection.slice(0, 200);
    expect(bookingsQuery).not.toContain("'service_id'");
  });

  it('34. appointment schedule authority preserved in book_slot_atomic', () => {
    expect(migration319).toContain('check_appointment_schedule(p_appointment_id');
  });

  // ── Reschedule requires_staff null-staff bypass ──
  it('35. reschedule rejects legacy null-staff booking for requires_staff item', () => {
    const reschedBlock = migration319.slice(migration319.indexOf('reschedule_booking_atomic'));
    expect(reschedBlock).toContain("'staff_required'");
    expect(reschedBlock).toContain('v_req_staff');
  });

  // ── Public slot staff-aware discovery ──
  it('36. public slots route imports isStaffAvailable', () => {
    const slotsRoute = readFileSync('app/api/bookings/public/slots/route.ts', 'utf-8');
    expect(slotsRoute).toContain('isStaffAvailable');
  });

  it('37. public slots route fetches requires_staff and staff_ids', () => {
    const slotsRoute = readFileSync('app/api/bookings/public/slots/route.ts', 'utf-8');
    expect(slotsRoute).toContain('itemRequiresStaff');
    expect(slotsRoute).toContain('itemStaffIds');
    expect(slotsRoute).toContain('requires_staff');
  });

  it('38. public slots route filters by staff availability for requires_staff', () => {
    const slotsRoute = readFileSync('app/api/bookings/public/slots/route.ts', 'utf-8');
    expect(slotsRoute).toContain('hasEligibleStaff');
    expect(slotsRoute).toContain('isStaffAvailable(sched, dayIdx, slotTime, candidateDuration)');
  });

  it('39. public slots returns empty when requires_staff and no eligible staff', () => {
    const slotsRoute = readFileSync('app/api/bookings/public/slots/route.ts', 'utf-8');
    // When staffSchedules.length === 0 and requires_staff, return empty
    expect(slotsRoute).toContain('No eligible staff');
  });

  // ── Bot slot duration vs staff end ──
  it('40. bot filters slots where duration extends past staff end', () => {
    expect(schedulingFlow).toContain('staffDayForDuration');
    expect(schedulingFlow).toContain('slotStart + serviceDuration <= staffEndMin');
  });

  // ── CI step ──
  it('41. CI has P1-STAFF-1 DB test step', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf-8');
    expect(ci).toContain('P1-STAFF-1 staff booking authority DB tests');
    expect(ci).toContain('p1-staff-booking-authority.test.ts');
    expect(ci).toContain('P1-STAFF-1 DB tests had');
  });
});


// ══════════════════════════════════════════════════════════
// Real PostgreSQL Tests
// ══════════════════════════════════════════════════════════

const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 15000 });
  return raw.split('\n').filter(l => { const t = l.trim(); return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t); }).join('\n').trim();
}
function psqlJson(sql: string): unknown { const r = psql(sql); return r ? JSON.parse(r) : null; }

const BIZ = '71aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ2 = '71bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USR = '71cccccc-cccc-cccc-cccc-cccccccccccc';
const STAFF = '71dddddd-dddd-dddd-dddd-dddddddddddd';
const STAFF_X = '71eeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; // cross-business
const STAFF_INACTIVE = '71ffffff-ffff-ffff-ffff-ffffffffffff';
const SVC = '71111111-1111-1111-1111-111111111111';
const SVC_REQ = '71222222-2222-2222-2222-222222222222'; // requires_staff
const APPT = '71333333-3333-3333-3333-333333333333';
const APPT_SCHED = '71444444-4444-4444-4444-444444444444'; // with schedule

describe.skipIf(!dbUrl)('P1-STAFF-1: real PostgreSQL authority', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT gen_random_uuid(); $$;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT current_setting('role', true); $$;
      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, owner_id UUID);
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','ordering','ticketing','reservation','payment','queue','chat','waitlist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','web','api','recurring','dashboard'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','in_progress','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY, business_id UUID, max_capacity INT DEFAULT 1,
        buffer_minutes INT DEFAULT 0, duration_minutes INT DEFAULT 30,
        requires_staff BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id UUID PRIMARY KEY, business_id UUID, max_capacity INT DEFAULT 1,
        duration_minutes INT DEFAULT 30, buffer_minutes INT DEFAULT 0,
        requires_staff BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true,
        available_days TEXT[], available_from TIME, available_to TIME
      );
      CREATE TABLE IF NOT EXISTS business_staff (
        id UUID PRIMARY KEY, business_id UUID NOT NULL, name TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true, schedule JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference_code TEXT,
        business_id UUID, user_id UUID, service_id UUID, appointment_id UUID,
        staff_id UUID, staff_name TEXT, date DATE, time TIME,
        party_size INT DEFAULT 1, flow_type flow_type DEFAULT 'scheduling',
        channel booking_channel DEFAULT 'whatsapp', deposit_amount NUMERIC(12,2) DEFAULT 0,
        deposit_status deposit_status DEFAULT 'none', status reservation_status DEFAULT 'pending',
        total_amount NUMERIC(12,2) DEFAULT 0, quantity INT DEFAULT 1,
        guest_name TEXT, guest_phone TEXT, guest_email TEXT,
        special_requests TEXT, venue_address TEXT, end_date DATE,
        addons_snapshot JSONB, promo_code_id UUID, location_id UUID,
        bot_session_id UUID, cancelled_at TIMESTAMPTZ, cancelled_by TEXT,
        original_date DATE, original_time TEXT, rescheduled_at TIMESTAMPTZ
      );
      -- Reference code trigger
      CREATE OR REPLACE FUNCTION gen_ref() RETURNS TRIGGER AS $$
      BEGIN NEW.reference_code := 'WA-' || LPAD(FLOOR(RANDOM()*9999)::TEXT, 4, '0'); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS set_ref ON bookings;
      CREATE TRIGGER set_ref BEFORE INSERT ON bookings
        FOR EACH ROW WHEN (NEW.reference_code IS NULL) EXECUTE FUNCTION gen_ref();

      INSERT INTO businesses (id) VALUES ('${BIZ}'), ('${BIZ2}') ON CONFLICT DO NOTHING;
      -- Staff: works Mon 09:00-17:00 and Wed 10:00-18:00 (short keys)
      INSERT INTO business_staff (id, business_id, name, is_active, schedule) VALUES
        ('${STAFF}', '${BIZ}', 'Sarah', true,
         '{"mon": {"start": "09:00", "end": "17:00"}, "wed": {"start": "10:00", "end": "18:00"}}')
        ON CONFLICT DO NOTHING;
      -- Cross-business staff
      INSERT INTO business_staff (id, business_id, name, is_active, schedule) VALUES
        ('${STAFF_X}', '${BIZ2}', 'Other Biz Staff', true, '{}')
        ON CONFLICT DO NOTHING;
      -- Inactive staff
      INSERT INTO business_staff (id, business_id, name, is_active, schedule) VALUES
        ('${STAFF_INACTIVE}', '${BIZ}', 'Inactive', false, '{}')
        ON CONFLICT DO NOTHING;
      -- Services
      INSERT INTO services (id, business_id, max_capacity, requires_staff) VALUES
        ('${SVC}', '${BIZ}', 1, false) ON CONFLICT DO NOTHING;
      INSERT INTO services (id, business_id, max_capacity, requires_staff) VALUES
        ('${SVC_REQ}', '${BIZ}', 1, true) ON CONFLICT DO NOTHING;
      -- Appointments
      INSERT INTO appointments (id, business_id, max_capacity, duration_minutes, requires_staff) VALUES
        ('${APPT}', '${BIZ}', 1, 30, false) ON CONFLICT DO NOTHING;
      INSERT INTO appointments (id, business_id, max_capacity, duration_minutes, requires_staff, available_days, available_from, available_to) VALUES
        ('${APPT_SCHED}', '${BIZ}', 1, 30, false, '{monday}', '09:00', '17:00') ON CONFLICT DO NOTHING;
    `);
    // Apply migrations in order
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "supabase/migrations/318_appointment_buffer_booking_authority.sql"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "supabase/migrations/319_staff_booking_authority.sql"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS bookings, business_staff, services, appointments, businesses CASCADE;`);
  });

  function reset() {
    psql(`DELETE FROM bookings;`);
  }

  function bookCount(): number {
    return parseInt(psql(`SELECT count(*)::int FROM bookings;`) || '0');
  }

  // ── check_staff_availability direct tests ──

  it('DB-1: short key "mon" works for Monday (2026-08-17 is Monday)', () => {
    // 2026-08-17 is a Monday — EXTRACT(DOW) = 1
    const r = psql(`SELECT allowed FROM check_staff_availability('${STAFF}'::uuid, '${BIZ}'::uuid, '2026-08-17'::date, '10:00', 30);`);
    expect(r).toBe('t');
  });

  it('DB-2: short-key configured off-day rejected (Tuesday not in schedule)', () => {
    // 2026-08-18 is Tuesday — staff has no "tue" entry
    const r = psql(`SELECT allowed, reason FROM check_staff_availability('${STAFF}'::uuid, '${BIZ}'::uuid, '2026-08-18'::date, '10:00', 30);`);
    expect(r).toContain('f');
    expect(r).toContain('staff_day_unavailable');
  });

  it('DB-3: long-form legacy key works if stored that way', () => {
    // Insert a staff with long-form key
    psql(`INSERT INTO business_staff (id, business_id, name, is_active, schedule) VALUES
      ('71aaaaaa-aaaa-aaaa-aaaa-111111111111', '${BIZ}', 'Legacy', true,
       '{"monday": {"start": "08:00", "end": "16:00"}}') ON CONFLICT DO NOTHING;`);
    const r = psql(`SELECT allowed FROM check_staff_availability('71aaaaaa-aaaa-aaaa-aaaa-111111111111'::uuid, '${BIZ}'::uuid, '2026-08-17'::date, '10:00', 30);`);
    expect(r).toBe('t');
    psql(`DELETE FROM business_staff WHERE id = '71aaaaaa-aaaa-aaaa-aaaa-111111111111';`);
  });

  it('DB-4: NULL schedule unrestricted', () => {
    psql(`INSERT INTO business_staff (id, business_id, name, is_active, schedule) VALUES
      ('71aaaaaa-aaaa-aaaa-aaaa-222222222222', '${BIZ}', 'NullSched', true, NULL) ON CONFLICT DO NOTHING;`);
    const r = psql(`SELECT allowed FROM check_staff_availability('71aaaaaa-aaaa-aaaa-aaaa-222222222222'::uuid, '${BIZ}'::uuid, '2026-08-18'::date, '10:00', 30);`);
    expect(r).toBe('t');
    psql(`DELETE FROM business_staff WHERE id = '71aaaaaa-aaaa-aaaa-aaaa-222222222222';`);
  });

  it('DB-5: empty schedule unrestricted', () => {
    psql(`INSERT INTO business_staff (id, business_id, name, is_active, schedule) VALUES
      ('71aaaaaa-aaaa-aaaa-aaaa-333333333333', '${BIZ}', 'EmptySched', true, '{}') ON CONFLICT DO NOTHING;`);
    const r = psql(`SELECT allowed FROM check_staff_availability('71aaaaaa-aaaa-aaaa-aaaa-333333333333'::uuid, '${BIZ}'::uuid, '2026-08-18'::date, '10:00', 30);`);
    expect(r).toBe('t');
    psql(`DELETE FROM business_staff WHERE id = '71aaaaaa-aaaa-aaaa-aaaa-333333333333';`);
  });

  it('DB-6: time before staff start rejected', () => {
    // Staff works Mon 09:00-17:00, booking at 08:00
    const r = psql(`SELECT allowed, reason FROM check_staff_availability('${STAFF}'::uuid, '${BIZ}'::uuid, '2026-08-17'::date, '08:00', 30);`);
    expect(r).toContain('f');
    expect(r).toContain('staff_before_start');
  });

  it('DB-7: exact staff start allowed', () => {
    const r = psql(`SELECT allowed FROM check_staff_availability('${STAFF}'::uuid, '${BIZ}'::uuid, '2026-08-17'::date, '09:00', 30);`);
    expect(r).toBe('t');
  });

  it('DB-8: booking ending exactly at staff end allowed', () => {
    // Staff ends at 17:00, booking at 16:30 for 30 min = ends exactly 17:00
    const r = psql(`SELECT allowed FROM check_staff_availability('${STAFF}'::uuid, '${BIZ}'::uuid, '2026-08-17'::date, '16:30', 30);`);
    expect(r).toBe('t');
  });

  it('DB-9: booking extending past staff end rejected', () => {
    // Staff ends at 17:00, booking at 16:30 for 60 min = ends 17:30
    const r = psql(`SELECT allowed, reason FROM check_staff_availability('${STAFF}'::uuid, '${BIZ}'::uuid, '2026-08-17'::date, '16:30', 60);`);
    expect(r).toContain('f');
    expect(r).toContain('staff_past_end');
  });

  it('DB-10: inactive staff rejected', () => {
    const r = psql(`SELECT allowed, reason FROM check_staff_availability('${STAFF_INACTIVE}'::uuid, '${BIZ}'::uuid, '2026-08-17'::date, '10:00', 30);`);
    expect(r).toContain('f');
    expect(r).toContain('staff_inactive');
  });

  it('DB-11: cross-business staff rejected', () => {
    const r = psql(`SELECT allowed, reason FROM check_staff_availability('${STAFF_X}'::uuid, '${BIZ}'::uuid, '2026-08-17'::date, '10:00', 30);`);
    expect(r).toContain('f');
    expect(r).toContain('staff_business_mismatch');
  });

  // ── book_slot_atomic integration ──

  it('DB-12: optional-staff service + NULL staff remains allowed', () => {
    reset();
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, NULL,
      '2026-08-17'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 30, NULL
    );`);
    expect(r).toBe('t');
    expect(bookCount()).toBe(1);
  });

  it('DB-13: requires_staff + NULL staff cannot INSERT', () => {
    reset();
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${SVC_REQ}'::uuid, NULL,
      '2026-08-17'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 30, NULL
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-14: supplied available staff can book', () => {
    reset();
    // Monday 10:00 — staff works Mon 09:00-17:00
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, '${STAFF}'::uuid,
      '2026-08-17'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, 'Sarah',
      NULL, NULL, 0, 30, NULL
    );`);
    expect(r).toBe('t');
    expect(bookCount()).toBe(1);
  });

  it('DB-15: supplied unavailable staff cannot book + ZERO rows created', () => {
    reset();
    // Tuesday — staff has no Tuesday schedule
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, '${STAFF}'::uuid,
      '2026-08-18'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, 'Sarah',
      NULL, NULL, 0, 30, NULL
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-16: staff before-start time rejected + ZERO rows', () => {
    reset();
    // Monday 08:00 — staff starts at 09:00
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, '${STAFF}'::uuid,
      '2026-08-17'::date, '08:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, 'Sarah',
      NULL, NULL, 0, 30, NULL
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-17: staff past-end (duration extends) rejected + ZERO rows', () => {
    reset();
    // Monday 16:30, 60 min duration → ends 17:30, staff ends 17:00
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, '${STAFF}'::uuid,
      '2026-08-17'::date, '16:30', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, 'Sarah',
      NULL, NULL, 0, 60, NULL
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  // ── Reschedule integration ──

  it('DB-18: reschedule to staff off-hours rejected with booking unchanged', () => {
    reset();
    // Create booking on Monday 10:00 (valid)
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, staff_id, date, time, status, party_size)
      VALUES ('b7100000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '${SVC}', '${STAFF}', '2026-08-17', '10:00', 'confirmed', 1);`);
    // Try reschedule to Tuesday (staff unavailable)
    const r = psqlJson(`SELECT reschedule_booking_atomic('b7100000-0000-0000-0000-000000000001'::uuid, '${BIZ}'::uuid, '2026-08-18'::date, '10:00');`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toContain('staff');
    // Booking unchanged
    const booking = psql(`SELECT date, time FROM bookings WHERE id = 'b7100000-0000-0000-0000-000000000001';`);
    expect(booking).toContain('2026-08-17');
    expect(booking).toContain('10:00');
  });

  it('DB-19: valid staff reschedule succeeds', () => {
    reset();
    // Create booking on Monday 10:00 (valid)
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, staff_id, date, time, status, party_size)
      VALUES ('b7100000-0000-0000-0000-000000000002', '${BIZ}', '${USR}', '${SVC}', '${STAFF}', '2026-08-17', '10:00', 'confirmed', 1);`);
    // Reschedule to Wednesday 11:00 (staff works Wed 10:00-18:00)
    const r = psqlJson(`SELECT reschedule_booking_atomic('b7100000-0000-0000-0000-000000000002'::uuid, '${BIZ}'::uuid, '2026-08-19'::date, '11:00');`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(true);
    const booking = psql(`SELECT date, time FROM bookings WHERE id = 'b7100000-0000-0000-0000-000000000002';`);
    expect(booking).toContain('2026-08-19');
    expect(booking).toContain('11:00');
  });

  // ── Appointment regression ──

  it('DB-20: existing appointment booking still works (no staff)', () => {
    reset();
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, NULL, NULL,
      '2026-08-17'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, '${APPT}'::uuid, 0, 30, NULL
    );`);
    expect(r).toBe('t');
  });

  it('DB-21: appointment schedule rejection still works', () => {
    reset();
    // APPT_SCHED only allows Monday, try Sunday (2026-08-16)
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, NULL, NULL,
      '2026-08-16'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, '${APPT_SCHED}'::uuid, 0, 30, NULL
    );`);
    expect(r).toBe('f');
  });

  it('DB-22: cross-business staff rejected by book_slot_atomic', () => {
    reset();
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, '${STAFF_X}'::uuid,
      '2026-08-17'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, 'Other',
      NULL, NULL, 0, 30, NULL
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-23: inactive staff rejected by book_slot_atomic', () => {
    reset();
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, '${STAFF_INACTIVE}'::uuid,
      '2026-08-17'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, 'Inactive',
      NULL, NULL, 0, 30, NULL
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-24: migration 319 applies cleanly', () => {
    // If we got here, migrations applied in beforeAll. Just verify the function exists.
    const r = psql(`SELECT count(*) FROM pg_proc WHERE proname = 'check_staff_availability';`);
    expect(parseInt(r)).toBeGreaterThanOrEqual(1);
  });

  // ── Reschedule requires_staff null-staff bypass ──

  it('DB-25: legacy null-staff requires_staff booking cannot reschedule', () => {
    reset();
    // Create a legacy booking with staff_id=NULL for a requires_staff service
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, staff_id, date, time, status, party_size)
      VALUES ('b7100000-0000-0000-0000-000000000025', '${BIZ}', '${USR}', '${SVC_REQ}', NULL, '2026-08-17', '10:00', 'confirmed', 1);`);
    const r = psqlJson(`SELECT reschedule_booking_atomic('b7100000-0000-0000-0000-000000000025'::uuid, '${BIZ}'::uuid, '2026-08-19'::date, '11:00');`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('staff_required');
    // Original booking unchanged
    const booking = psql(`SELECT date, time FROM bookings WHERE id = 'b7100000-0000-0000-0000-000000000025';`);
    expect(booking).toContain('2026-08-17');
    expect(booking).toContain('10:00');
  });

  it('DB-26: null-staff optional service can still reschedule', () => {
    reset();
    // Non-requires_staff service with null staff — should still work
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, staff_id, date, time, status, party_size)
      VALUES ('b7100000-0000-0000-0000-000000000026', '${BIZ}', '${USR}', '${SVC}', NULL, '2026-08-17', '10:00', 'confirmed', 1);`);
    const r = psqlJson(`SELECT reschedule_booking_atomic('b7100000-0000-0000-0000-000000000026'::uuid, '${BIZ}'::uuid, '2026-08-19'::date, '11:00');`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(true);
  });
});
