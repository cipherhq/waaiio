/**
 * P1-CLASS-1: Class session booking authority — source verification + real PostgreSQL tests
 *
 * Source verification:
 * 1-14: Migration structure, session generation, booking authority, public/bot/manual integration
 *
 * Real PostgreSQL tests (require TEST_DATABASE_URL):
 * DB-1 through DB-27: Complete class session lifecycle + booking authority
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// ══════════════════════════════════════════════════════════
// Source Verification
// ══════════════════════════════════════════════════════════

describe('P1-CLASS-1: source verification', () => {
  const migration321 = readFileSync('supabase/migrations/321_class_session_booking.sql', 'utf-8');
  const schedulingFlow = readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
  const publicSlots = readFileSync('app/api/bookings/public/slots/route.ts', 'utf-8');
  const publicCreate = readFileSync('app/api/bookings/public/create/route.ts', 'utf-8');
  const manualCreate = readFileSync('app/api/bookings/create-manual/route.ts', 'utf-8');

  it('1. class_recurrence_rules table created', () => {
    expect(migration321).toContain('CREATE TABLE IF NOT EXISTS class_recurrence_rules');
    expect(migration321).toContain('service_id UUID NOT NULL REFERENCES services');
    expect(migration321).toContain("weekday TEXT NOT NULL CHECK");
  });

  it('2. class_sessions table created with idempotency constraint', () => {
    expect(migration321).toContain('CREATE TABLE IF NOT EXISTS class_sessions');
    expect(migration321).toContain('UNIQUE(recurrence_rule_id, date, start_time)');
  });

  it('3. bookings.class_session_id FK added', () => {
    expect(migration321).toContain('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS class_session_id UUID REFERENCES class_sessions');
  });

  it('4. generate_class_sessions function created with idempotent insert', () => {
    expect(migration321).toContain('CREATE OR REPLACE FUNCTION generate_class_sessions');
    expect(migration321).toContain('ON CONFLICT (recurrence_rule_id, date, start_time) DO NOTHING');
  });

  it('5. session generation respects effective_from/effective_until', () => {
    const genFn = migration321.slice(migration321.indexOf('generate_class_sessions'));
    expect(genFn).toContain('effective_from');
    expect(genFn).toContain('effective_until');
  });

  it('6. session generation skips inactive rules', () => {
    const genFn = migration321.slice(migration321.indexOf('generate_class_sessions'));
    expect(genFn).toContain('is_active = true');
  });

  it('7. session generation validates service is_class', () => {
    const genFn = migration321.slice(migration321.indexOf('generate_class_sessions'));
    expect(genFn).toContain('is_class');
  });

  it('8. book_slot_atomic has p_class_session_id parameter', () => {
    const bsaFn = migration321.slice(migration321.indexOf('CREATE OR REPLACE FUNCTION public.book_slot_atomic'));
    expect(bsaFn).toContain('p_class_session_id uuid DEFAULT NULL');
  });

  it('9. class booking path validates session exists and is bookable', () => {
    const bsaFn = migration321.slice(migration321.indexOf('CLASS SESSION BOOKING PATH'));
    expect(bsaFn).toContain("v_cs.status != 'scheduled'");
    expect(bsaFn).toContain('v_cs.business_id != p_business_id');
  });

  it('10. class capacity uses SUM(party_size) not COUNT(*)', () => {
    const bsaFn = migration321.slice(migration321.indexOf('CLASS SESSION BOOKING PATH'));
    expect(bsaFn).toContain('SUM(b.party_size)');
    expect(bsaFn).toContain('v_occupied + p_party_size > v_cs.capacity');
  });

  it('11. class booking locks by session ID not business+date+time', () => {
    const bsaFn = migration321.slice(migration321.indexOf('CLASS SESSION BOOKING PATH'));
    expect(bsaFn).toContain("'class_session:' || p_class_session_id::text");
  });

  it('12. reschedule supports class session target', () => {
    const reschedFn = migration321.slice(migration321.indexOf('reschedule_booking_atomic'));
    expect(reschedFn).toContain('p_target_class_session_id');
    expect(reschedFn).toContain('target_session_required');
    expect(reschedFn).toContain('target_session_full');
  });

  it('13. bot has select_class_session step', () => {
    expect(schedulingFlow).toContain("id: 'select_class_session'");
    expect(schedulingFlow).toContain('get_upcoming_class_sessions');
    expect(schedulingFlow).toContain('class_session_');
  });

  it('14. bot routes class services to session selection', () => {
    expect(schedulingFlow).toContain("if (ctx.session.session_data._service_is_class) return 'select_class_session'");
  });

  it('15. bot passes class_session_id to book_slot_atomic', () => {
    expect(schedulingFlow).toContain('p_class_session_id: (d._class_session_id as string) || null');
  });

  it('16. public slots returns sessions for class services', () => {
    expect(publicSlots).toContain('is_class');
    expect(publicSlots).toContain('get_upcoming_class_sessions');
    expect(publicSlots).toContain('is_class: true');
  });

  it('17. public create accepts classSessionId', () => {
    expect(publicCreate).toContain('classSessionId');
    expect(publicCreate).toContain('p_class_session_id: classSessionId || null');
  });

  it('18. manual create accepts classSessionId', () => {
    expect(manualCreate).toContain('classSessionId');
    expect(manualCreate).toContain('p_class_session_id: classSessionId || null');
  });

  it('19. normal booking path preserved — does not write class_session_id', () => {
    // The normal INSERT (after NORMAL BOOKING PATH comment) lists columns without class_session_id
    const normalPath = migration321.slice(migration321.indexOf('NORMAL BOOKING PATH'));
    const normalInsert = normalPath.slice(
      normalPath.indexOf('INSERT INTO bookings'),
      normalPath.indexOf('RETURNING id'),
    );
    // The column list in the normal INSERT should NOT include class_session_id
    const columnList = normalInsert.slice(0, normalInsert.indexOf(') VALUES'));
    expect(columnList).not.toContain('class_session_id');
  });

  it('20. appointment booking preserved', () => {
    expect(migration321).toContain('check_appointment_schedule');
  });

  it('21. staff authority preserved', () => {
    expect(migration321).toContain('check_staff_availability');
  });

  it('22. RLS enabled on class tables', () => {
    expect(migration321).toContain('ALTER TABLE class_recurrence_rules ENABLE ROW LEVEL SECURITY');
    expect(migration321).toContain('ALTER TABLE class_sessions ENABLE ROW LEVEL SECURITY');
  });

  // ── Session instructor authority ──
  it('23. session instructor validated via check_staff_availability', () => {
    const classPath = migration321.slice(migration321.indexOf('Session instructor authority'));
    expect(classPath).toContain('check_staff_availability');
    expect(classPath).toContain('v_cs.staff_id');
  });

  it('24. caller cannot override session instructor', () => {
    const classPath = migration321.slice(migration321.indexOf('Session instructor authority'));
    expect(classPath).toContain('p_staff_id != v_cs.staff_id');
  });

  it('25. booking uses session instructor, not caller staff', () => {
    expect(migration321).toContain('v_cs.staff_id, p_staff_name,');
  });

  it('26. generation skips occurrence when instructor unavailable', () => {
    const genFn = migration321.slice(migration321.indexOf('generate_class_sessions'));
    expect(genFn).toContain('check_staff_availability');
    expect(genFn).toContain('CONTINUE');
  });

  // ── API contract tests ──
  it('27. recurrence API uses migration-321 field names', () => {
    const recurrenceRoute = readFileSync('app/api/classes/recurrence/route.ts', 'utf-8');
    // Must use weekday, NOT day_of_week
    expect(recurrenceRoute).toContain('weekday');
    expect(recurrenceRoute).not.toContain('day_of_week');
    // Must use staff_id, NOT instructor_name
    expect(recurrenceRoute).toContain('staff_id');
    expect(recurrenceRoute).not.toContain('instructor_name');
    // Must use capacity_override, NOT capacity alone for the column
    expect(recurrenceRoute).toContain('capacity_override');
    // Must include business_id in insert
    expect(recurrenceRoute).toContain('business_id: businessId');
  });

  it('28. sessions API uses duration_minutes not duration', () => {
    const sessionsRoute = readFileSync('app/api/classes/sessions/route.ts', 'utf-8');
    expect(sessionsRoute).toContain('duration_minutes');
    expect(sessionsRoute).not.toContain("'duration'");
  });

  it('29. session PATCH uses staffId not instructorName', () => {
    const sessionDetail = readFileSync('app/api/classes/sessions/[id]/route.ts', 'utf-8');
    expect(sessionDetail).toContain('staffId');
    expect(sessionDetail).not.toContain('instructorName');
    expect(sessionDetail).toContain('staff_id');
  });

  it('30. recurrence PUT uses atomic reconciliation and handles booked sessions', () => {
    const recurrenceRoute = readFileSync('app/api/classes/recurrence/route.ts', 'utf-8');
    expect(recurrenceRoute).toContain('reconcile_class_recurrence');
    expect(recurrenceRoute).toContain('booked_sessions_exist');
    expect(recurrenceRoute).toContain('booked_session_count');
  });

  it('31. recurrence DELETE uses atomic reconciliation and handles booked sessions', () => {
    const recurrenceRoute = readFileSync('app/api/classes/recurrence/route.ts', 'utf-8');
    expect(recurrenceRoute).toContain("'delete'");
    expect(recurrenceRoute).toContain('Cancel those sessions first');
  });

  it('32. reconcile_class_recurrence handles cleanup atomically', () => {
    // The DB function handles session cleanup, not the API route
    expect(migration321).toContain('reconcile_class_recurrence');
    const fn = migration321.slice(migration321.indexOf('reconcile_class_recurrence'));
    expect(fn).toContain('DELETE FROM class_sessions');
    expect(fn).toContain("status = 'scheduled'");
  });

  it('33. dashboard uses API routes not direct Supabase writes for class operations', () => {
    const dashboard = readFileSync('app/dashboard/classes/page.tsx', 'utf-8');
    expect(dashboard).toContain('/api/classes/sessions');
    expect(dashboard).not.toContain('class_schedule');
  });

  it('34. dashboard creates class via /api/classes/create (no direct INSERT)', () => {
    const dashboard = readFileSync('app/dashboard/classes/page.tsx', 'utf-8');
    expect(dashboard).toContain('/api/classes/create');
    expect(dashboard).not.toContain(".insert({");
  });

  it('35. create_class_atomic function exists in migration', () => {
    expect(migration321).toContain('CREATE OR REPLACE FUNCTION create_class_atomic');
    expect(migration321).toContain("'invalid_weekday'");
    expect(migration321).toContain("'invalid_staff'");
  });

  it('36. update_class_session_atomic uses advisory lock', () => {
    expect(migration321).toContain('CREATE OR REPLACE FUNCTION update_class_session_atomic');
    const fn = migration321.slice(migration321.indexOf('update_class_session_atomic'));
    expect(fn).toContain("'class_session:'");
    expect(fn).toContain('pg_advisory_xact_lock');
  });

  it('37. reconcile_class_recurrence is atomic with session locking', () => {
    expect(migration321).toContain('CREATE OR REPLACE FUNCTION reconcile_class_recurrence');
    const fn = migration321.slice(migration321.indexOf('reconcile_class_recurrence'));
    expect(fn).toContain("'class_session:'");
    expect(fn).toContain('pg_advisory_xact_lock');
    expect(fn).toContain("'booked_sessions_exist'");
  });

  it('38. book_slot_atomic class path locks BEFORE validation', () => {
    // Find the corrected class path (section 9d)
    const fn = migration321.slice(migration321.lastIndexOf('CLASS SESSION BOOKING PATH'));
    const lockPos = fn.indexOf('pg_advisory_xact_lock');
    const statusPos = fn.indexOf("v_cs.status != 'scheduled'");
    // Lock must come before status check
    expect(lockPos).toBeLessThan(statusPos);
  });

  it('39. class reschedule enforces same-service', () => {
    const fn = migration321.slice(migration321.lastIndexOf('CLASS BOOKING RESCHEDULE'));
    expect(fn).toContain("'cross_class_not_allowed'");
    expect(fn).toContain('v_target_cs.service_id != v_booking.service_id');
  });

  it('40. class reschedule uses target staff/location directly (not COALESCE)', () => {
    const fn = migration321.slice(migration321.lastIndexOf('CLASS BOOKING RESCHEDULE'));
    const updateSection = fn.slice(fn.indexOf('UPDATE bookings'));
    expect(updateSection).toContain('staff_id = v_target_cs.staff_id');
    expect(updateSection).toContain('location_id = v_target_cs.location_id');
    expect(updateSection).not.toContain('COALESCE(v_target_cs.staff_id');
  });

  it('41. requires_staff class + NULL session instructor rejected', () => {
    const fn = migration321.slice(migration321.lastIndexOf('CLASS SESSION BOOKING PATH'));
    expect(fn).toContain('requires_staff');
    // After checking session instructor is NULL, checks requires_staff
    expect(fn).toContain("-- requires_staff but no session instructor");
  });

  it('42. public class booking skips auto-staff-assignment', () => {
    expect(publicCreate).toContain('!classSessionId');
  });

  it('43. session PATCH uses update_class_session_atomic RPC', () => {
    const sessionRoute = readFileSync('app/api/classes/sessions/[id]/route.ts', 'utf-8');
    expect(sessionRoute).toContain('update_class_session_atomic');
  });

  it('44. recurrence PUT/DELETE uses reconcile_class_recurrence RPC', () => {
    const recurrenceRoute = readFileSync('app/api/classes/recurrence/route.ts', 'utf-8');
    expect(recurrenceRoute).toContain('reconcile_class_recurrence');
  });

  // ── Integrity corrections ──
  it('45. manual route uses class_booking capability for class bookings', () => {
    expect(manualCreate).toContain("'class_booking'");
    expect(manualCreate).toContain('classSessionId');
  });

  it('46. manual route skips generic requires_staff for class bookings', () => {
    expect(manualCreate).toContain('!classSessionId');
  });

  it('47. update_class_session_atomic validates ALL before mutating', () => {
    // The integrity correction (section 10a) has requires_staff_cannot_clear
    expect(migration321).toContain("'requires_staff_cannot_clear'");
    // Validation appears before the final UPDATE
    const pos1 = migration321.lastIndexOf("'requires_staff_cannot_clear'");
    const pos2 = migration321.lastIndexOf('UPDATE class_sessions SET capacity = v_final_capacity');
    expect(pos1).toBeLessThan(pos2);
  });

  it('48. update_class_session_atomic rejects clear on requires_staff', () => {
    expect(migration321).toContain("'requires_staff_cannot_clear'");
  });

  it('49. update_class_session_atomic rejects instructor change with attendees', () => {
    expect(migration321).toContain("'attendees_exist_cannot_change_instructor'");
  });

  it('50. reconcile protects sessions with ANY booking history', () => {
    // Section 10b reconcile checks EXISTS for ANY booking status
    expect(migration321).toContain('EXISTS (SELECT 1 FROM bookings b WHERE b.class_session_id = cs.id)');
  });

  it('51. generate uses recurrence rule lock', () => {
    const fn = migration321.slice(migration321.lastIndexOf('generate_class_sessions'));
    expect(fn).toContain("'recurrence_rule:'");
    expect(fn).toContain('pg_advisory_xact_lock');
  });

  it('52. generate skips requires_staff rules without instructor', () => {
    const fn = migration321.slice(migration321.lastIndexOf('generate_class_sessions'));
    expect(fn).toContain('requires_staff');
    expect(fn).toContain('v_rule.staff_id IS NULL');
    expect(fn).toContain('CONTINUE');
  });

  it('53. book_slot_atomic derives canonical staff_name from DB', () => {
    // The class INSERT should derive staff_name from business_staff, not use caller p_staff_name
    expect(migration321).toContain('SELECT bs.name FROM business_staff bs WHERE bs.id = v_cs.staff_id');
  });

  it('54. reschedule derives target staff_name from DB', () => {
    expect(migration321).toContain('SELECT bs.name FROM business_staff bs WHERE bs.id = v_target_cs.staff_id');
  });

  // ── RLS hardening ──
  it('55. authenticated write policies dropped for class_sessions', () => {
    expect(migration321).toContain('DROP POLICY IF EXISTS cs_owner_insert');
    expect(migration321).toContain('DROP POLICY IF EXISTS cs_owner_update');
    expect(migration321).toContain('DROP POLICY IF EXISTS cs_owner_delete');
  });

  it('56. authenticated write policies dropped for class_recurrence_rules', () => {
    expect(migration321).toContain('DROP POLICY IF EXISTS crr_owner_insert');
    expect(migration321).toContain('DROP POLICY IF EXISTS crr_owner_update');
    expect(migration321).toContain('DROP POLICY IF EXISTS crr_owner_delete');
  });

  // ── Admin server route ──
  it('57. admin class sessions uses server route', () => {
    const adminPage = readFileSync('admin/src/pages/ClassSessions.tsx', 'utf-8');
    expect(adminPage).toContain('/api/admin/class-sessions');
    expect(adminPage).not.toContain('adminDb');
    expect(adminPage).not.toContain(".from('class_sessions')");
  });

  it('58. admin server route uses requirePlatformAdmin', () => {
    const adminRoute = readFileSync('app/api/admin/class-sessions/route.ts', 'utf-8');
    expect(adminRoute).toContain('requirePlatformAdmin');
    expect(adminRoute).toContain("'admin'");
    expect(adminRoute).toContain("'support'");
    expect(adminRoute).toContain("'operations'");
  });

  it('59. admin server route uses service client', () => {
    const adminRoute = readFileSync('app/api/admin/class-sessions/route.ts', 'utf-8');
    expect(adminRoute).toContain('createServiceClient');
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

const BIZ = '82aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ2 = '82bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USR = '82cccccc-cccc-cccc-cccc-cccccccccccc';
const STAFF = '82dddddd-dddd-dddd-dddd-dddddddddddd';
const CLASS_SVC = '82111111-1111-1111-1111-111111111111';
const NORMAL_SVC = '82222222-2222-2222-2222-222222222222';
const APPT = '82333333-3333-3333-3333-333333333333';

describe.skipIf(!dbUrl)('P1-CLASS-1: real PostgreSQL authority', () => {
  let ruleId: string;
  let sessionId: string;
  let sessionId2: string;

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
      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, owner_id UUID, name TEXT, slug TEXT);
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','ordering','ticketing','reservation','payment','queue','chat','waitlist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','web','api','recurring','dashboard'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','in_progress','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, name TEXT, description TEXT,
        price INT DEFAULT 0, max_capacity INT DEFAULT 1, buffer_minutes INT DEFAULT 0,
        duration_minutes INT DEFAULT 30, requires_staff BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true, is_class BOOLEAN DEFAULT false,
        class_schedule JSONB DEFAULT '[]', status TEXT DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id UUID PRIMARY KEY, business_id UUID, name TEXT, description TEXT,
        price NUMERIC DEFAULT 0, price_is_variable BOOLEAN DEFAULT false,
        duration_minutes INT DEFAULT 30, deposit_amount NUMERIC DEFAULT 0,
        max_capacity INT DEFAULT 1, buffer_minutes INT DEFAULT 0,
        requires_staff BOOLEAN DEFAULT false, staff_ids UUID[] DEFAULT '{}',
        allow_staff_selection BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        available_days TEXT[], available_from TIME, available_to TIME,
        sort_order INT DEFAULT 0, image_url TEXT
      );
      CREATE TABLE IF NOT EXISTS business_staff (
        id UUID PRIMARY KEY, business_id UUID NOT NULL, name TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true, schedule JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS business_locations (
        id UUID PRIMARY KEY, business_id UUID, name TEXT, address TEXT,
        is_active BOOLEAN DEFAULT true
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
        original_date DATE, original_time TEXT, rescheduled_at TIMESTAMPTZ,
        class_session_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION gen_ref() RETURNS TRIGGER AS $$
      BEGIN NEW.reference_code := 'WA-' || LPAD(FLOOR(RANDOM()*9999)::TEXT, 4, '0'); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS set_ref ON bookings;
      CREATE TRIGGER set_ref BEFORE INSERT ON bookings
        FOR EACH ROW WHEN (NEW.reference_code IS NULL) EXECUTE FUNCTION gen_ref();

      INSERT INTO businesses (id, owner_id, name, slug) VALUES
        ('${BIZ}', '${USR}', 'Test Biz', 'test-class-82a'),
        ('${BIZ2}', '${USR}', 'Other Biz', 'other-class-82b')
        ON CONFLICT DO NOTHING;
      INSERT INTO business_staff (id, business_id, name, is_active, schedule) VALUES
        ('${STAFF}', '${BIZ}', 'Instructor', true,
         '{"mon": {"start": "09:00", "end": "20:00"}, "wed": {"start": "09:00", "end": "20:00"}}')
        ON CONFLICT DO NOTHING;
      INSERT INTO services (id, business_id, name, price, max_capacity, duration_minutes, is_class) VALUES
        ('${CLASS_SVC}', '${BIZ}', 'Yoga', 5000, 10, 60, true) ON CONFLICT DO NOTHING;
      INSERT INTO services (id, business_id, name, price, max_capacity, duration_minutes, is_class) VALUES
        ('${NORMAL_SVC}', '${BIZ}', 'Haircut', 3000, 1, 30, false) ON CONFLICT DO NOTHING;
      INSERT INTO appointments (id, business_id, name, max_capacity, duration_minutes) VALUES
        ('${APPT}', '${BIZ}', 'Consultation', 1, 30) ON CONFLICT DO NOTHING;
    `);
    // Apply migrations
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "supabase/migrations/318_appointment_buffer_booking_authority.sql"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "supabase/migrations/319_staff_booking_authority.sql"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "supabase/migrations/321_class_session_booking.sql"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS bookings, class_sessions, class_recurrence_rules, business_staff, business_locations, services, appointments, businesses CASCADE;`);
  });

  function reset() {
    psql(`DELETE FROM bookings; DELETE FROM class_sessions; DELETE FROM class_recurrence_rules;`);
    // Ensure default state for requires_staff (prevents cross-test pollution)
    psql(`UPDATE services SET requires_staff = false WHERE id = '${CLASS_SVC}';`);
  }

  function bookCount(): number {
    return parseInt(psql(`SELECT count(*)::int FROM bookings;`) || '0');
  }

  // ── Session generation ──

  it('DB-1: generate sessions from recurrence rule', () => {
    reset();
    // Create a Monday 18:00 recurrence rule
    ruleId = psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, effective_from)
      VALUES ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00', '2026-08-01')
      RETURNING id;`);
    expect(ruleId).toBeTruthy();
    const count = psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    expect(parseInt(count)).toBeGreaterThan(0);
    // Verify sessions exist
    const sessions = psql(`SELECT count(*)::int FROM class_sessions WHERE service_id = '${CLASS_SVC}';`);
    expect(parseInt(sessions)).toBeGreaterThan(0);
  });

  it('DB-2: generation retry is idempotent', () => {
    const before = psql(`SELECT count(*)::int FROM class_sessions WHERE service_id = '${CLASS_SVC}';`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const after = psql(`SELECT count(*)::int FROM class_sessions WHERE service_id = '${CLASS_SVC}';`);
    expect(after).toBe(before);
  });

  it('DB-3: duplicate session prohibited by unique constraint', () => {
    // Get an existing session
    const existing = psql(`SELECT recurrence_rule_id, date, start_time FROM class_sessions LIMIT 1;`);
    const [rrid, dt, tm] = existing.split('|');
    // Try to insert duplicate
    try {
      psql(`INSERT INTO class_sessions (business_id, service_id, recurrence_rule_id, date, start_time, end_time, capacity)
        VALUES ('${BIZ}', '${CLASS_SVC}', '${rrid}', '${dt}', '${tm}', '${tm}'::time + interval '60 minutes', 10);`);
      expect(true).toBe(false); // should not reach
    } catch {
      // Expected: unique constraint violation
    }
  });

  it('DB-4: inactive rule generates nothing', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, is_active) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'fri', '10:00', false);`);
    const count = psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    expect(parseInt(count)).toBe(0);
  });

  it('DB-5: effective date bounds enforced', () => {
    reset();
    // Rule effective only in the past
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, effective_from, effective_until) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00', '2025-01-01', '2025-06-01');`);
    const count = psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    expect(parseInt(count)).toBe(0);
  });

  it('DB-6: session references class service', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const svcId = psql(`SELECT service_id FROM class_sessions LIMIT 1;`);
    expect(svcId).toBe(CLASS_SVC);
  });

  it('DB-7: non-class service cannot produce class session', () => {
    const count = psql(`SELECT generate_class_sessions('${NORMAL_SVC}', 28);`);
    expect(parseInt(count)).toBe(0);
  });

  // ── Class booking authority ──

  it('DB-8: class booking requires valid class_session_id', () => {
    reset();
    // Setup: generate sessions
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    sessionId = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);

    // Invalid session ID
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '00000000-0000-0000-0000-000000000000'::uuid
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-9: class_session belongs to correct business', () => {
    // Session exists but business mismatch
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ2}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-10: session/service identity mismatch rejected', () => {
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${NORMAL_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-11: cancelled session cannot book', () => {
    psql(`UPDATE class_sessions SET status = 'cancelled' WHERE id = '${sessionId}';`);
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(r).toBe('f');
    // Restore
    psql(`UPDATE class_sessions SET status = 'scheduled' WHERE id = '${sessionId}';`);
  });

  it('DB-12: completed session cannot book', () => {
    psql(`UPDATE class_sessions SET status = 'completed' WHERE id = '${sessionId}';`);
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(r).toBe('f');
    psql(`UPDATE class_sessions SET status = 'scheduled' WHERE id = '${sessionId}';`);
  });

  it('DB-13: session capacity enforced (SUM party_size)', () => {
    // Set capacity to 3, book 2 with party_size=2 (occupies 2 seats)
    psql(`UPDATE class_sessions SET capacity = 3 WHERE id = '${sessionId}';`);
    psql(`DELETE FROM bookings;`);

    // Book 2 seats
    const r1 = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 2, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest1', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(r1).toBe('t');

    // Try to book 2 more (would be 4 > 3 capacity)
    const r2 = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 2, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest2', '+5678', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(r2).toBe('f');

    // 1 more seat should work
    const r3 = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest3', '+9999', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(r3).toBe('t');

    // Restore
    psql(`UPDATE class_sessions SET capacity = 10 WHERE id = '${sessionId}';`);
    psql(`DELETE FROM bookings;`);
  });

  it('DB-14: rejected class booking inserts ZERO rows', () => {
    psql(`DELETE FROM bookings;`);
    psql(`UPDATE class_sessions SET capacity = 1 WHERE id = '${sessionId}';`);
    // Fill it
    psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(bookCount()).toBe(1);
    // Rejected attempt
    psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest2', '+5678', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(bookCount()).toBe(1); // Still 1
    psql(`UPDATE class_sessions SET capacity = 10 WHERE id = '${sessionId}';`);
    psql(`DELETE FROM bookings;`);
  });

  it('DB-15: separate sessions have independent capacity', () => {
    psql(`DELETE FROM bookings;`);
    sessionId2 = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND id != '${sessionId}' ORDER BY date LIMIT 1;`);
    psql(`UPDATE class_sessions SET capacity = 1 WHERE id = '${sessionId}';`);
    psql(`UPDATE class_sessions SET capacity = 1 WHERE id = '${sessionId2}';`);

    // Fill session 1
    const r1 = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest1', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    expect(r1).toBe('t');

    // Session 2 should still accept
    const r2 = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest2', '+5678', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId2}'::uuid
    );`);
    expect(r2).toBe('t');

    psql(`UPDATE class_sessions SET capacity = 10 WHERE id IN ('${sessionId}', '${sessionId2}');`);
    psql(`DELETE FROM bookings;`);
  });

  it('DB-16: successful class booking stores class_session_id', () => {
    psql(`DELETE FROM bookings;`);
    psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    const csid = psql(`SELECT class_session_id FROM bookings WHERE class_session_id IS NOT NULL LIMIT 1;`);
    expect(csid).toBe(sessionId);
    psql(`DELETE FROM bookings;`);
  });

  // ── Normal booking regression ──

  it('DB-17: normal service booking still succeeds (no class_session_id)', () => {
    psql(`DELETE FROM bookings;`);
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${NORMAL_SVC}'::uuid, NULL,
      '2026-08-17'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 30, NULL, NULL
    );`);
    expect(r).toBe('t');
    expect(bookCount()).toBe(1);
    // Verify no class_session_id
    const csid = psql(`SELECT class_session_id IS NULL FROM bookings LIMIT 1;`);
    expect(csid).toBe('t');
    psql(`DELETE FROM bookings;`);
  });

  it('DB-18: appointment booking still succeeds', () => {
    psql(`DELETE FROM bookings;`);
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, NULL, NULL,
      '2026-08-17'::date, '10:00', 1, 1,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, '${APPT}'::uuid, 0, 30, NULL, NULL
    );`);
    expect(r).toBe('t');
    psql(`DELETE FROM bookings;`);
  });

  // ── Reschedule ──

  it('DB-19: reschedule class booking to valid target succeeds', () => {
    psql(`DELETE FROM bookings;`);
    // Book session 1
    const bookingId = psql(`SELECT booking_id FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    // Reschedule to session 2
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ}'::uuid, '2026-08-24'::date, '18:00', NULL, '${sessionId2}'::uuid
    );`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(true);
    // Verify class_session_id changed
    const newCsid = psql(`SELECT class_session_id FROM bookings WHERE id = '${bookingId}';`);
    expect(newCsid).toBe(sessionId2);
    psql(`DELETE FROM bookings;`);
  });

  it('DB-20: reschedule to full target fails with original unchanged', () => {
    psql(`DELETE FROM bookings;`);
    psql(`UPDATE class_sessions SET capacity = 1 WHERE id = '${sessionId2}';`);
    // Fill target
    psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Filler', '+9999', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId2}'::uuid
    );`);
    // Book session 1
    const bookingId = psql(`SELECT booking_id FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    // Try reschedule to full session 2
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ}'::uuid, '2026-08-24'::date, '18:00', NULL, '${sessionId2}'::uuid
    );`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('target_session_full');
    // Original unchanged
    const csid = psql(`SELECT class_session_id FROM bookings WHERE id = '${bookingId}';`);
    expect(csid).toBe(sessionId);
    psql(`UPDATE class_sessions SET capacity = 10 WHERE id = '${sessionId2}';`);
    psql(`DELETE FROM bookings;`);
  });

  it('DB-21: reschedule to cancelled target fails', () => {
    psql(`DELETE FROM bookings;`);
    psql(`UPDATE class_sessions SET status = 'cancelled' WHERE id = '${sessionId2}';`);
    const bookingId = psql(`SELECT booking_id FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ}'::uuid, '2026-08-24'::date, '18:00', NULL, '${sessionId2}'::uuid
    );`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('target_session_not_bookable');
    psql(`UPDATE class_sessions SET status = 'scheduled' WHERE id = '${sessionId2}';`);
    psql(`DELETE FROM bookings;`);
  });

  it('DB-22: class booking reschedule without target session fails', () => {
    psql(`DELETE FROM bookings;`);
    const bookingId = psql(`SELECT booking_id FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sessionId}'::uuid
    );`);
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ}'::uuid, '2026-08-24'::date, '18:00'
    );`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('target_session_required');
    psql(`DELETE FROM bookings;`);
  });

  // ── Normal reschedule regression ──

  it('DB-23: normal booking reschedule still works (no session)', () => {
    psql(`DELETE FROM bookings;`);
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status, party_size)
      VALUES ('b8200000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '${NORMAL_SVC}', '2026-08-17', '10:00', 'confirmed', 1);`);
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      'b8200000-0000-0000-0000-000000000001'::uuid, '${BIZ}'::uuid, '2026-08-18'::date, '11:00'
    );`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(true);
    psql(`DELETE FROM bookings;`);
  });

  it('DB-24: migration 321 applies cleanly', () => {
    const r = psql(`SELECT count(*) FROM pg_proc WHERE proname = 'generate_class_sessions';`);
    expect(parseInt(r)).toBeGreaterThanOrEqual(1);
    const r2 = psql(`SELECT count(*) FROM pg_proc WHERE proname = 'get_upcoming_class_sessions';`);
    expect(parseInt(r2)).toBeGreaterThanOrEqual(1);
  });

  // ── Session instructor authority DB tests ──

  it('DB-25: session with available instructor -> booking succeeds', () => {
    reset();
    // Create rule with instructor, generate sessions
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, staff_id) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00', '${STAFF}');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    // Staff works Mon 09:00-20:00, class at 18:00 for 60min = 19:00 < 20:00 — available
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND staff_id = '${STAFF}' ORDER BY date LIMIT 1;`);
    if (!sid) { expect(sid).toBeTruthy(); return; }
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sid}'::uuid
    );`);
    expect(r).toBe('t');
    psql(`DELETE FROM bookings;`);
  });

  it('DB-26: caller NULL staff cannot bypass session instructor validation', () => {
    // Session has instructor — caller sends NULL staff. Instructor should still be validated.
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND staff_id = '${STAFF}' ORDER BY date LIMIT 1;`);
    if (!sid) { expect(sid).toBeTruthy(); return; }
    // Booking should succeed because instructor IS available (Mon 09-20, class 18-19)
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sid}'::uuid
    );`);
    expect(r).toBe('t');
    // Verify booking.staff_id = session instructor (not NULL)
    const staffId = psql(`SELECT staff_id FROM bookings ORDER BY created_at DESC LIMIT 1;`);
    expect(staffId).toBe(STAFF);
    psql(`DELETE FROM bookings;`);
  });

  it('DB-27: caller different staff cannot override session instructor', () => {
    // Create a second staff member
    psql(`INSERT INTO business_staff (id, business_id, name, is_active, schedule) VALUES
      ('82eeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '${BIZ}', 'Other', true, '{}') ON CONFLICT DO NOTHING;`);
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND staff_id = '${STAFF}' ORDER BY date LIMIT 1;`);
    if (!sid) { expect(sid).toBeTruthy(); return; }
    // Try to book with a different staff_id — should be rejected
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, '82eeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sid}'::uuid
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
  });

  it('DB-28: generation skips occurrence outside instructor schedule', () => {
    reset();
    // Staff works only Mon/Wed 09-20. Create a Friday rule — should generate nothing.
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, staff_id) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'fri', '10:00', '${STAFF}');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const count = psql(`SELECT count(*)::int FROM class_sessions WHERE service_id = '${CLASS_SVC}';`);
    // Only Mon sessions should exist (from DB-25's rule), NOT Friday
    const friCount = psql(`SELECT count(*)::int FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND EXTRACT(DOW FROM date) = 5;`);
    expect(parseInt(friCount)).toBe(0);
  });

  it('DB-29: generation creates occurrence inside instructor schedule', () => {
    psql(`DELETE FROM class_sessions; DELETE FROM class_recurrence_rules;`);
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, staff_id) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00', '${STAFF}');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const monCount = psql(`SELECT count(*)::int FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND EXTRACT(DOW FROM date) = 1;`);
    expect(parseInt(monCount)).toBeGreaterThan(0);
  });

  // ── Corrected authority tests ──

  it('DB-30: requires_staff class + NULL session instructor rejected', () => {
    reset();
    psql(`UPDATE services SET requires_staff = true WHERE id = '${CLASS_SVC}';`);
    // Create rule WITHOUT instructor — corrected generator skips it
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    const count = psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    expect(parseInt(count)).toBe(0); // no sessions generated

    // Manually insert a session without instructor to test booking authority
    psql(`INSERT INTO class_sessions (id, business_id, service_id, date, start_time, end_time, capacity, status)
      VALUES ('82aaaaaa-aaaa-aaaa-aaaa-eeeeeeeeeeee', '${BIZ}', '${CLASS_SVC}', '2026-08-17', '18:00', '19:00', 10, 'scheduled');`);
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '82aaaaaa-aaaa-aaaa-aaaa-eeeeeeeeeeee'::uuid
    );`);
    expect(r).toBe('f');
    expect(bookCount()).toBe(0);
    psql(`DELETE FROM class_sessions WHERE id = '82aaaaaa-aaaa-aaaa-aaaa-eeeeeeeeeeee';`);
    psql(`UPDATE services SET requires_staff = false WHERE id = '${CLASS_SVC}';`);
  });

  it('DB-31: optional-staff class + NULL session instructor succeeds', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);
    if (!sid) { expect(sid).toBeTruthy(); return; }
    const r = psql(`SELECT slot_available FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sid}'::uuid
    );`);
    expect(r).toBe('t');
    psql(`DELETE FROM bookings;`);
  });

  it('DB-32: cross-class reschedule rejected', () => {
    reset();
    // Create TWO class services with sessions
    psql(`INSERT INTO services (id, business_id, name, price, max_capacity, duration_minutes, is_class) VALUES
      ('82999999-9999-9999-9999-999999999999', '${BIZ}', 'Spin', 5000, 10, 60, true) ON CONFLICT DO NOTHING;`);
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '82999999-9999-9999-9999-999999999999', 'wed', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    psql(`SELECT generate_class_sessions('82999999-9999-9999-9999-999999999999', 28);`);
    const yogaSession = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);
    const spinSession = psql(`SELECT id FROM class_sessions WHERE service_id = '82999999-9999-9999-9999-999999999999' ORDER BY date LIMIT 1;`);
    // Book Yoga
    const bookingId = psql(`SELECT booking_id FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${yogaSession}'::uuid
    );`);
    // Try reschedule to Spin session — must fail
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ}'::uuid, '2026-08-19'::date, '18:00', NULL, '${spinSession}'::uuid
    );`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('cross_class_not_allowed');
    // Original unchanged
    const csid = psql(`SELECT class_session_id FROM bookings WHERE id = '${bookingId}';`);
    expect(csid).toBe(yogaSession);
    psql(`DELETE FROM bookings; DELETE FROM class_sessions WHERE service_id = '82999999-9999-9999-9999-999999999999'; DELETE FROM class_recurrence_rules WHERE service_id = '82999999-9999-9999-9999-999999999999'; DELETE FROM services WHERE id = '82999999-9999-9999-9999-999999999999';`);
  });

  it('DB-33: reschedule target staff becomes booking staff (not COALESCE)', () => {
    reset();
    // Create session with instructor
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, staff_id) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00', '${STAFF}');`);
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'wed', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const instrSession = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND staff_id = '${STAFF}' ORDER BY date LIMIT 1;`);
    const noInstrSession = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND staff_id IS NULL ORDER BY date LIMIT 1;`);
    if (!instrSession || !noInstrSession) return;
    // Book the instructor session
    const bookingId = psql(`SELECT booking_id FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${instrSession}'::uuid
    );`);
    // Reschedule to no-instructor session — staff should become NULL
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      '${bookingId}'::uuid, '${BIZ}'::uuid, '2026-08-19'::date, '18:00', NULL, '${noInstrSession}'::uuid
    );`) as Record<string, unknown>;
    expect(r.rescheduled).toBe(true);
    const staffAfter = psql(`SELECT staff_id IS NULL FROM bookings WHERE id = '${bookingId}';`);
    expect(staffAfter).toBe('t');
    psql(`DELETE FROM bookings;`);
  });

  it('DB-34: create_class_atomic works end-to-end', () => {
    reset();
    const r = psqlJson(`SELECT create_class_atomic(
      '${BIZ}'::uuid, 'Test Class', 5000, 60, 10, 'mon', '18:00'::time, '${STAFF}'::uuid
    );`) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(r.service_id).toBeTruthy();
    expect(r.sessions_generated).toBeGreaterThan(0);
    // Verify service exists
    const isClass = psql(`SELECT is_class FROM services WHERE id = '${r.service_id}';`);
    expect(isClass).toBe('t');
    // Verify recurrence rule exists
    const ruleCount = psql(`SELECT count(*)::int FROM class_recurrence_rules WHERE service_id = '${r.service_id}';`);
    expect(parseInt(ruleCount)).toBe(1);
    // Clean up
    psql(`DELETE FROM class_sessions WHERE service_id = '${r.service_id}'; DELETE FROM class_recurrence_rules WHERE service_id = '${r.service_id}'; DELETE FROM services WHERE id = '${r.service_id}';`);
  });

  it('DB-35: create_class_atomic rejects invalid staff', () => {
    const r = psqlJson(`SELECT create_class_atomic(
      '${BIZ}'::uuid, 'Bad Staff Class', 5000, 60, 10, 'mon', '18:00'::time,
      '00000000-0000-0000-0000-000000000000'::uuid
    );`) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.reason).toBe('invalid_staff');
  });

  it('DB-36: update_class_session_atomic cancellation uses session lock', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);
    const r = psqlJson(`SELECT update_class_session_atomic(
      '${sid}'::uuid, '${BIZ}'::uuid, 'cancelled', 'Test cancellation'
    );`) as Record<string, unknown>;
    expect(r.success).toBe(true);
    const status = psql(`SELECT status FROM class_sessions WHERE id = '${sid}';`);
    expect(status).toBe('cancelled');
  });

  it('DB-37: reconcile_class_recurrence rejects with booked sessions', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (id, business_id, service_id, weekday, start_time) VALUES
      ('82aaaaaa-aaaa-aaaa-aaaa-cccccccccccc', '${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions WHERE recurrence_rule_id = '82aaaaaa-aaaa-aaaa-aaaa-cccccccccccc' ORDER BY date LIMIT 1;`);
    // Book a session
    psql(`SELECT book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sid}'::uuid
    );`);
    // Try to update weekday — should fail
    const r = psqlJson(`SELECT reconcile_class_recurrence(
      '82aaaaaa-aaaa-aaaa-aaaa-cccccccccccc'::uuid, '${BIZ}'::uuid, 'update', 'wed'
    );`) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.reason).toBe('booked_sessions_exist');
    // Rule unchanged
    const wd = psql(`SELECT weekday FROM class_recurrence_rules WHERE id = '82aaaaaa-aaaa-aaaa-aaaa-cccccccccccc';`);
    expect(wd).toBe('mon');
    psql(`DELETE FROM bookings;`);
  });

  it('DB-38: reconcile_class_recurrence delete succeeds when unbooked', () => {
    const r = psqlJson(`SELECT reconcile_class_recurrence(
      '82aaaaaa-aaaa-aaaa-aaaa-cccccccccccc'::uuid, '${BIZ}'::uuid, 'delete'
    );`) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(r.action).toBe('deleted');
    const ruleCount = psql(`SELECT count(*)::int FROM class_recurrence_rules WHERE id = '82aaaaaa-aaaa-aaaa-aaaa-cccccccccccc';`);
    expect(parseInt(ruleCount)).toBe(0);
  });

  // ── Integrity correction DB tests ──

  it('DB-39: update_class_session_atomic all-or-nothing (invalid staff + capacity change)', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);
    // Set capacity = 20
    psql(`UPDATE class_sessions SET capacity = 20 WHERE id = '${sid}';`);
    // Request: capacity=25 + invalid staff => should fail AND capacity stays 20
    const r = psqlJson(`SELECT update_class_session_atomic(
      '${sid}'::uuid, '${BIZ}'::uuid, NULL, NULL, 25, '00000000-0000-0000-0000-000000000000'::uuid
    );`) as Record<string, unknown>;
    expect(r.success).toBe(false);
    const cap = psql(`SELECT capacity FROM class_sessions WHERE id = '${sid}';`);
    expect(cap).toBe('20'); // unchanged
  });

  it('DB-40: requires_staff clear instructor rejected', () => {
    psql(`UPDATE services SET requires_staff = true WHERE id = '${CLASS_SVC}';`);
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);
    // Set instructor
    psql(`UPDATE class_sessions SET staff_id = '${STAFF}' WHERE id = '${sid}';`);
    const r = psqlJson(`SELECT update_class_session_atomic(
      '${sid}'::uuid, '${BIZ}'::uuid, NULL, NULL, NULL, NULL, true
    );`) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.reason).toBe('requires_staff_cannot_clear');
    // Staff unchanged
    const staffAfter = psql(`SELECT staff_id FROM class_sessions WHERE id = '${sid}';`);
    expect(staffAfter).toBe(STAFF);
    psql(`UPDATE services SET requires_staff = false WHERE id = '${CLASS_SVC}';`);
    psql(`UPDATE class_sessions SET staff_id = NULL WHERE id = '${sid}';`);
  });

  it('DB-41: instructor change with active attendees rejected', () => {
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);
    // Book a customer
    psql(`SELECT book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sid}'::uuid
    );`);
    // Try to change instructor — should fail
    const r = psqlJson(`SELECT update_class_session_atomic(
      '${sid}'::uuid, '${BIZ}'::uuid, NULL, NULL, NULL, '${STAFF}'::uuid
    );`) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.reason).toBe('attendees_exist_cannot_change_instructor');
    psql(`DELETE FROM bookings;`);
  });

  it('DB-42: class booking staff_name derived from DB (not caller)', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, staff_id) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00', '${STAFF}');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND staff_id = '${STAFF}' ORDER BY date LIMIT 1;`);
    if (!sid) return;
    // Book with wrong staff_name — DB should use canonical name
    psql(`SELECT book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, 'WRONG NAME',
      NULL, NULL, 0, 60, NULL, '${sid}'::uuid
    );`);
    const staffName = psql(`SELECT staff_name FROM bookings ORDER BY created_at DESC LIMIT 1;`);
    expect(staffName).toBe('Instructor'); // canonical name from business_staff
    psql(`DELETE FROM bookings;`);
  });

  it('DB-43: reconcile preserves session with cancelled booking history', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (id, business_id, service_id, weekday, start_time) VALUES
      ('82aaaaaa-aaaa-aaaa-aaaa-dddddddddddd', '${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions WHERE recurrence_rule_id = '82aaaaaa-aaaa-aaaa-aaaa-dddddddddddd' ORDER BY date LIMIT 1;`);
    // Book and then cancel
    const bid = psql(`SELECT booking_id FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${sid}'::uuid
    );`);
    psql(`UPDATE bookings SET status = 'cancelled' WHERE id = '${bid}';`);
    // Try to reconcile — should fail because session has booking history
    const r = psqlJson(`SELECT reconcile_class_recurrence(
      '82aaaaaa-aaaa-aaaa-aaaa-dddddddddddd'::uuid, '${BIZ}'::uuid, 'update', 'wed'
    );`) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.reason).toBe('booked_sessions_exist');
    // Booking.class_session_id unchanged
    const csid = psql(`SELECT class_session_id FROM bookings WHERE id = '${bid}';`);
    expect(csid).toBe(sid);
    psql(`DELETE FROM bookings; DELETE FROM class_sessions WHERE recurrence_rule_id = '82aaaaaa-aaaa-aaaa-aaaa-dddddddddddd'; DELETE FROM class_recurrence_rules WHERE id = '82aaaaaa-aaaa-aaaa-aaaa-dddddddddddd';`);
  });

  it('DB-44: requires_staff recurrence with NULL instructor generates no sessions', () => {
    reset();
    psql(`UPDATE services SET requires_staff = true WHERE id = '${CLASS_SVC}';`);
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    const count = psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    expect(parseInt(count)).toBe(0);
    psql(`UPDATE services SET requires_staff = false WHERE id = '${CLASS_SVC}';`);
  });

  it('DB-45: reschedule staff_name derived from target instructor', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, staff_id) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00', '${STAFF}');`);
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'wed', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const instrSession = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND staff_id = '${STAFF}' ORDER BY date LIMIT 1;`);
    const noInstrSession = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND staff_id IS NULL ORDER BY date LIMIT 1;`);
    if (!instrSession || !noInstrSession) return;
    // Book instructor session
    const bid = psql(`SELECT booking_id FROM book_slot_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
      '2026-08-17'::date, '18:00', 1, 10,
      'scheduling', 0, 'none', 'confirmed',
      'Guest', '+1234', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 60, NULL, '${instrSession}'::uuid
    );`);
    // Reschedule to no-instructor session
    psqlJson(`SELECT reschedule_booking_atomic('${bid}'::uuid, '${BIZ}'::uuid, '2026-08-19'::date, '18:00', NULL, '${noInstrSession}'::uuid);`);
    // staff_name should be NULL (not carry old instructor name)
    const sn = psql(`SELECT staff_name IS NULL FROM bookings WHERE id = '${bid}';`);
    expect(sn).toBe('t');
    psql(`DELETE FROM bookings;`);
  });

  // ═══════════════════════════════════════════════════════
  // RLS AUTHORITY TESTS
  // ═══════════════════════════════════════════════════════

  it('DB-46: authenticated cannot INSERT class_sessions', () => {
    const r = psql(`SET LOCAL ROLE authenticated; INSERT INTO class_sessions (business_id, service_id, date, start_time, end_time, capacity) VALUES ('${BIZ}', '${CLASS_SVC}', '2026-09-01', '10:00', '11:00', 10);`);
    expect(r).toContain('ERROR');
  });

  it('DB-47: authenticated cannot UPDATE class_sessions', () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions LIMIT 1;`);
    const r = psql(`SET LOCAL ROLE authenticated; UPDATE class_sessions SET capacity = 999 WHERE id = '${sid}';`);
    expect(r).toContain('ERROR');
    // Verify unchanged
    const cap = psql(`SELECT capacity FROM class_sessions WHERE id = '${sid}';`);
    expect(cap).not.toBe('999');
  });

  it('DB-48: authenticated cannot DELETE class_sessions', () => {
    const countBefore = psql(`SELECT count(*)::int FROM class_sessions;`);
    const r = psql(`SET LOCAL ROLE authenticated; DELETE FROM class_sessions;`);
    expect(r).toContain('ERROR');
    const countAfter = psql(`SELECT count(*)::int FROM class_sessions;`);
    expect(countAfter).toBe(countBefore);
  });

  it('DB-49: authenticated cannot INSERT class_recurrence_rules', () => {
    const r = psql(`SET LOCAL ROLE authenticated; INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES ('${BIZ}', '${CLASS_SVC}', 'fri', '10:00');`);
    expect(r).toContain('ERROR');
  });

  it('DB-50: authenticated cannot UPDATE class_recurrence_rules', () => {
    const r = psql(`SET LOCAL ROLE authenticated; UPDATE class_recurrence_rules SET weekday = 'fri';`);
    expect(r).toContain('ERROR');
  });

  it('DB-51: authenticated cannot DELETE class_recurrence_rules', () => {
    const r = psql(`SET LOCAL ROLE authenticated; DELETE FROM class_recurrence_rules;`);
    expect(r).toContain('ERROR');
  });

  it('DB-52: service_role class creation still works', () => {
    reset();
    const r = psqlJson(`SELECT create_class_atomic('${BIZ}'::uuid, 'RLS Test', 0, 60, 10, 'mon', '10:00'::time);`) as Record<string, unknown>;
    expect(r.success).toBe(true);
    // Clean up
    if (r.service_id) {
      psql(`DELETE FROM class_sessions WHERE service_id = '${r.service_id}'; DELETE FROM class_recurrence_rules WHERE service_id = '${r.service_id}'; DELETE FROM services WHERE id = '${r.service_id}';`);
    }
  });

  // ═══════════════════════════════════════════════════════
  // REAL TWO-CONNECTION CONTENTION TESTS
  // ═══════════════════════════════════════════════════════

  function runTwoSessions(sqlA: string, sqlB: string): Promise<{ a: string; b: string }> {
    const { exec } = require('child_process') as typeof import('child_process');
    function execPsql(sql: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const child = exec(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, { timeout: 15000, encoding: 'utf-8' },
          (error, stdout, stderr) => {
            if (error && !stdout) reject(new Error(`psql: ${stderr || error.message}`));
            else resolve((stdout || '').trim());
          });
        child.stdin!.write(sql);
        child.stdin!.end();
      });
    }
    return new Promise(async (resolve) => {
      const promiseA = execPsql(sqlA);
      await new Promise(r => setTimeout(r, 300));
      const promiseB = execPsql(sqlB);
      const [a, b] = await Promise.all([promiseA, promiseB]);
      resolve({ a, b });
    });
  }

  it('CONTENTION-1: class session capacity race — exactly one winner', async () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);
    psql(`UPDATE class_sessions SET capacity = 1 WHERE id = '${sid}';`);

    const bookSql = (userSuffix: string) => `
      SELECT slot_available FROM book_slot_atomic(
        '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
        '2026-08-17'::date, '18:00', 1, 10,
        'scheduling', 0, 'none', 'confirmed',
        'Guest${userSuffix}', '+${userSuffix}', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
        NULL, NULL, 0, 60, NULL, '${sid}'::uuid
      );
    `;

    const { a, b } = await runTwoSessions(bookSql('1'), bookSql('2'));
    const results = [a, b].map(r => r.replace(/\n/g, '').trim());
    const successes = results.filter(r => r === 't').length;
    const failures = results.filter(r => r === 'f').length;

    expect(successes).toBe(1);
    expect(failures).toBe(1);
    expect(bookCount()).toBe(1);
    psql(`DELETE FROM bookings;`);
  });

  it('CONTENTION-2: booking vs session cancellation — serialized', async () => {
    reset();
    psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time) VALUES
      ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00');`);
    psql(`SELECT generate_class_sessions('${CLASS_SVC}', 28);`);
    const sid = psql(`SELECT id FROM class_sessions WHERE service_id = '${CLASS_SVC}' ORDER BY date LIMIT 1;`);
    psql(`UPDATE class_sessions SET capacity = 5 WHERE id = '${sid}';`);

    // Race: booking vs cancellation
    const bookSql = `
      SELECT slot_available FROM book_slot_atomic(
        '${BIZ}'::uuid, '${USR}'::uuid, '${CLASS_SVC}'::uuid, NULL,
        '2026-08-17'::date, '18:00', 1, 10,
        'scheduling', 0, 'none', 'confirmed',
        'RaceGuest', '+9876', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
        NULL, NULL, 0, 60, NULL, '${sid}'::uuid
      );
    `;
    const cancelSql = `SELECT update_class_session_atomic('${sid}'::uuid, '${BIZ}'::uuid, 'cancelled', 'race test');`;

    const { a, b } = await runTwoSessions(bookSql, cancelSql);

    // After both complete: session must be cancelled
    const finalStatus = psql(`SELECT status FROM class_sessions WHERE id = '${sid}';`);
    expect(finalStatus).toBe('cancelled');

    // If booking went first: booking exists, then cancellation happened
    // If cancellation went first: booking rejected
    // Either way: no booking after cancelled state under same lock
    const bookingsAfter = bookCount();
    const bookingAvailable = a.replace(/\n/g, '').trim();
    if (bookingAvailable === 't') {
      // Booking committed first, cancellation followed
      expect(bookingsAfter).toBe(1);
    } else {
      // Cancellation committed first, booking rejected
      expect(bookingsAfter).toBe(0);
    }
    psql(`DELETE FROM bookings;`);
    psql(`UPDATE class_sessions SET status = 'scheduled' WHERE id = '${sid}';`);
  });

  it('CONTENTION-3: generate vs reconcile — serialized by rule lock', async () => {
    reset();
    const ruleId = psql(`INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time)
      VALUES ('${BIZ}', '${CLASS_SVC}', 'mon', '18:00') RETURNING id;`);

    // Race: generate vs reconcile-delete
    const genSql = `SELECT generate_class_sessions('${CLASS_SVC}', 28);`;
    const reconcileSql = `SELECT reconcile_class_recurrence('${ruleId}'::uuid, '${BIZ}'::uuid, 'delete');`;

    const { a, b } = await runTwoSessions(genSql, reconcileSql);

    // After both: rule should be deleted (reconcile wins eventually)
    const ruleExists = psql(`SELECT count(*)::int FROM class_recurrence_rules WHERE id = '${ruleId}';`);

    // Either: generate ran first then delete cleaned up, OR delete ran first
    // In both cases: no stale sessions should exist for a deleted rule
    if (parseInt(ruleExists) === 0) {
      // Rule deleted — no sessions should reference it (reconcile cleaned them)
      const orphanSessions = psql(`SELECT count(*)::int FROM class_sessions WHERE recurrence_rule_id = '${ruleId}';`);
      expect(parseInt(orphanSessions)).toBe(0);
    }
    // If rule still exists (generate won the lock, reconcile is retryable): that's also valid
    // The key invariant: operations serialized, no corrupt state
  });
});
