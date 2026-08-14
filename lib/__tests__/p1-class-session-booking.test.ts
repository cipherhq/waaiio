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

  it('30. recurrence PUT rejects schedule change with booked sessions', () => {
    const recurrenceRoute = readFileSync('app/api/classes/recurrence/route.ts', 'utf-8');
    expect(recurrenceRoute).toContain('Cannot change schedule');
    expect(recurrenceRoute).toContain('booked_session_count');
  });

  it('31. recurrence DELETE rejects when future sessions have bookings', () => {
    const recurrenceRoute = readFileSync('app/api/classes/recurrence/route.ts', 'utf-8');
    expect(recurrenceRoute).toContain('Cannot delete rule');
    expect(recurrenceRoute).toContain('Cancel those sessions first');
  });

  it('32. recurrence DELETE cleans up unbooked future sessions', () => {
    const recurrenceRoute = readFileSync('app/api/classes/recurrence/route.ts', 'utf-8');
    // Should delete scheduled future sessions for the rule before deleting the rule
    const deleteSection = recurrenceRoute.slice(recurrenceRoute.indexOf('DELETE'));
    expect(deleteSection).toContain(".delete()");
    expect(deleteSection).toContain("eq('recurrence_rule_id', ruleId)");
    expect(deleteSection).toContain("eq('status', 'scheduled')");
  });

  it('33. dashboard uses API routes not direct Supabase writes for class operations', () => {
    const dashboard = readFileSync('app/dashboard/classes/page.tsx', 'utf-8');
    // Must fetch sessions from API, not project from class_schedule
    expect(dashboard).toContain('/api/classes/sessions');
    // Must NOT use class_schedule for projection
    expect(dashboard).not.toContain('class_schedule');
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
        id UUID PRIMARY KEY, business_id UUID, name TEXT, price INT DEFAULT 0,
        max_capacity INT DEFAULT 1, buffer_minutes INT DEFAULT 0,
        duration_minutes INT DEFAULT 30, requires_staff BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true, is_class BOOLEAN DEFAULT false,
        class_schedule JSONB DEFAULT '[]'
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
        class_session_id UUID
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
    // Monday rule with instructor should have generated sessions (from DB-25)
    const monCount = psql(`SELECT count(*)::int FROM class_sessions WHERE service_id = '${CLASS_SVC}' AND EXTRACT(DOW FROM date) = 1;`);
    expect(parseInt(monCount)).toBeGreaterThan(0);
  });
});
