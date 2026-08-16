/**
 * Migration 320: Drop stale 26-arg book_slot_atomic overload
 *
 * Source verification:
 * 1. Migration 320 drops the exact 26-arg signature
 * 2. Migration 320 verifies exactly 1 overload remains
 * 3. Canonical 27-arg function has p_bot_session_id
 * 4. Public booking omits p_bot_session_id (relies on default)
 * 5. WhatsApp booking explicitly passes p_bot_session_id
 * 6. Canonical function preserves appointment schedule enforcement
 * 7. Canonical function preserves staff availability enforcement
 * 8. Canonical function preserves requires_staff enforcement
 * 9. Manual booking wrapper still calls book_slot_atomic internally
 * 10. Canonical function preserves advisory lock canonicalization (CONFLICT-1)
 *
 * Real PostgreSQL tests (require TEST_DATABASE_URL):
 * DB-1: After migration 320, exactly one book_slot_atomic exists
 * DB-2: Canonical function has p_bot_session_id parameter
 * DB-3: Calling without p_bot_session_id resolves unambiguously
 * DB-4: Appointment schedule enforcement preserved
 * DB-5: Staff availability enforcement preserved
 * DB-6: requires_staff enforcement preserved
 * DB-7: Manual booking wrapper remains functional
 * DB-8: Advisory lock canonicalization remains correct (CONFLICT-1)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// ══════════════════════════════════════════════════════════
// Source Verification
// ══════════════════════════════════════════════════════════

describe('Migration 320: source verification', () => {
  const migration320 = readFileSync('supabase/migrations/320_drop_stale_book_slot_overload.sql', 'utf-8');
  const migration319 = readFileSync('supabase/migrations/319_staff_booking_authority.sql', 'utf-8');
  const publicRoute = readFileSync('app/api/bookings/public/create/route.ts', 'utf-8');
  const schedulingFlow = readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
  const manualRoute = readFileSync('app/api/bookings/create-manual/route.ts', 'utf-8');

  it('1. drops the exact 26-arg signature', () => {
    expect(migration320).toContain('DROP FUNCTION IF EXISTS public.book_slot_atomic(');
    // Must have exactly 26 type args (no p_bot_session_id uuid at the end)
    const dropBlock = migration320.slice(
      migration320.indexOf('DROP FUNCTION'),
      migration320.indexOf(');') + 2,
    );
    // Count the uuid/text/int/date/jsonb type tokens
    const types = dropBlock.match(/\b(uuid|text|integer|date|jsonb)\b/g) || [];
    // 26 input args: uuid x13, text x7, integer x4, date x2 = 26 types
    expect(types.length).toBe(26);
  });

  it('2. verifies exactly 1 overload remains after drop', () => {
    expect(migration320).toContain("'Expected exactly 1 book_slot_atomic after drop, found %'");
    expect(migration320).toContain('v_count != 1');
  });

  it('3. canonical 27-arg function includes p_bot_session_id', () => {
    const bsa319 = migration319.slice(migration319.indexOf('CREATE OR REPLACE FUNCTION public.book_slot_atomic'));
    expect(bsa319).toContain('p_bot_session_id uuid DEFAULT NULL');
  });

  it('4. public booking omits p_bot_session_id (relies on default)', () => {
    const rpcBlock = publicRoute.slice(publicRoute.indexOf("'book_slot_atomic'"));
    expect(rpcBlock).not.toContain('p_bot_session_id');
  });

  it('5. WhatsApp booking explicitly passes p_bot_session_id', () => {
    const rpcBlock = schedulingFlow.slice(schedulingFlow.indexOf("'book_slot_atomic'"));
    expect(rpcBlock).toContain('p_bot_session_id');
  });

  it('6. canonical function preserves appointment schedule enforcement', () => {
    const bsa319 = migration319.slice(migration319.indexOf('CREATE OR REPLACE FUNCTION public.book_slot_atomic'));
    expect(bsa319).toContain('check_appointment_schedule');
  });

  it('7. canonical function preserves staff availability enforcement', () => {
    const bsa319 = migration319.slice(migration319.indexOf('CREATE OR REPLACE FUNCTION public.book_slot_atomic'));
    expect(bsa319).toContain('check_staff_availability');
  });

  it('8. canonical function preserves requires_staff enforcement', () => {
    const bsa319 = migration319.slice(migration319.indexOf('CREATE OR REPLACE FUNCTION public.book_slot_atomic'));
    expect(bsa319).toContain('v_requires_staff');
    expect(bsa319).toContain("FROM appointments a WHERE a.id = p_appointment_id");
    expect(bsa319).toContain("FROM services s WHERE s.id = p_service_id");
  });

  it('9. manual booking wrapper calls book_slot_atomic internally', () => {
    expect(manualRoute).toContain("'book_manual_slot_atomic'");
    // The wrapper SQL (migration 318) delegates to book_slot_atomic
    const migration318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');
    const manualFn = migration318.slice(migration318.indexOf('book_manual_slot_atomic'));
    expect(manualFn).toContain('book_slot_atomic(');
  });

  it('10. canonical function preserves advisory lock canonicalization (CONFLICT-1)', () => {
    const bsa319 = migration319.slice(migration319.indexOf('CREATE OR REPLACE FUNCTION public.book_slot_atomic'));
    // Must canonicalize time via ::time::text for advisory lock
    expect(bsa319).toContain("p_time::time::text");
    expect(bsa319).toContain('pg_advisory_xact_lock');
  });

  it('11. migration 320 does NOT CREATE OR REPLACE the canonical function', () => {
    expect(migration320).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(migration320).not.toContain('CREATE FUNCTION');
  });

  // ── ACL remediation ──
  it('12. migration 320 REVOKEs EXECUTE from PUBLIC on 27-arg', () => {
    // Must appear AFTER the DROP (which targets 26-arg)
    const afterDrop = migration320.slice(migration320.indexOf('ACL remediation'));
    expect(afterDrop).toContain('REVOKE EXECUTE ON FUNCTION public.book_slot_atomic(');
    expect(afterDrop).toContain('FROM PUBLIC');
  });

  it('13. migration 320 REVOKEs EXECUTE from anon on 27-arg', () => {
    const afterDrop = migration320.slice(migration320.indexOf('ACL remediation'));
    expect(afterDrop).toContain('FROM anon');
  });

  it('14. migration 320 REVOKEs EXECUTE from authenticated on 27-arg', () => {
    const afterDrop = migration320.slice(migration320.indexOf('ACL remediation'));
    expect(afterDrop).toContain('FROM authenticated');
  });

  it('15. migration 320 GRANTs EXECUTE to service_role on 27-arg', () => {
    const afterDrop = migration320.slice(migration320.indexOf('ACL remediation'));
    expect(afterDrop).toContain('GRANT EXECUTE');
    expect(afterDrop).toContain('TO service_role');
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

const BIZ = '72aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USR = '72cccccc-cccc-cccc-cccc-cccccccccccc';
const STAFF = '72dddddd-dddd-dddd-dddd-dddddddddddd';
const SVC = '72111111-1111-1111-1111-111111111111';
const SVC_REQ = '72222222-2222-2222-2222-222222222222';
const APPT = '72333333-3333-3333-3333-333333333333';

describe.skipIf(!dbUrl)('Migration 320: real PostgreSQL — stale overload removal', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    // Set up schema and install BOTH overloads (simulating pre-320 state)
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
        is_active BOOLEAN DEFAULT true
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
      CREATE OR REPLACE FUNCTION gen_ref() RETURNS TRIGGER AS $$
      BEGIN NEW.reference_code := 'WA-' || LPAD(FLOOR(RANDOM()*9999)::TEXT, 4, '0'); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS set_ref ON bookings;
      CREATE TRIGGER set_ref BEFORE INSERT ON bookings
        FOR EACH ROW WHEN (NEW.reference_code IS NULL) EXECUTE FUNCTION gen_ref();

      INSERT INTO businesses VALUES ('${BIZ}', gen_random_uuid(), 'Test Biz', 'test-biz') ON CONFLICT DO NOTHING;
      INSERT INTO services VALUES ('${SVC}', '${BIZ}', 'Basic Service', 100, 5, 0, 30, false) ON CONFLICT DO NOTHING;
      INSERT INTO services VALUES ('${SVC_REQ}', '${BIZ}', 'Staff Service', 200, 1, 0, 60, true) ON CONFLICT DO NOTHING;
      INSERT INTO appointments VALUES ('${APPT}', '${BIZ}', 'Test Appt', 'desc', 150, false, 45, 0, 1, 0, false, '{}', false, true,
        ARRAY['monday','tuesday','wednesday','thursday','friday'], '09:00'::time, '17:00'::time, 0, NULL) ON CONFLICT DO NOTHING;
      INSERT INTO business_staff VALUES ('${STAFF}', '${BIZ}', 'Test Staff', true,
        '{"mon":{"start":"09:00","end":"17:00"},"tue":{"start":"09:00","end":"17:00"},"wed":{"start":"09:00","end":"17:00"},"thu":{"start":"09:00","end":"17:00"},"fri":{"start":"09:00","end":"17:00"}}'::jsonb
      ) ON CONFLICT DO NOTHING;
    `);

    // Install canonical functions from migrations 318 + 319
    const m318 = readFileSync('supabase/migrations/318_appointment_buffer_booking_authority.sql', 'utf-8');
    const m319 = readFileSync('supabase/migrations/319_staff_booking_authority.sql', 'utf-8');
    psql(m318);
    psql(m319);

    // Simulate the pre-320 stale state: install the 26-arg overload
    // This is the exact stale body from production (oid 32754)
    psql(`
      CREATE OR REPLACE FUNCTION public.book_slot_atomic(
        p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
        p_date date, p_time text, p_party_size int, p_max_capacity int,
        p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
        p_guest_name text, p_guest_phone text, p_guest_email text,
        p_special_requests text, p_venue_address text, p_end_date date,
        p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
        p_location_id uuid DEFAULT NULL,
        p_appointment_id uuid DEFAULT NULL,
        p_buffer_minutes integer DEFAULT 0,
        p_duration integer DEFAULT 30
      ) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_count int; v_booking_id uuid; v_ref text;
      BEGIN
        SELECT COUNT(*) INTO v_count FROM bookings
        WHERE business_id = p_business_id AND date = p_date AND time = p_time::time
          AND status IN ('confirmed', 'pending', 'in_progress')
          AND (p_staff_id IS NULL OR staff_id = p_staff_id);
        IF v_count >= p_max_capacity THEN
          RETURN QUERY SELECT NULL::uuid, NULL::text, false;
          RETURN;
        END IF;
        INSERT INTO bookings (
          business_id, user_id, service_id, appointment_id, staff_id, staff_name,
          date, time, party_size, flow_type, channel,
          deposit_amount, deposit_status, status,
          guest_name, guest_phone, guest_email,
          special_requests, venue_address, end_date,
          addons_snapshot, promo_code_id, total_amount, quantity,
          location_id
        ) VALUES (
          p_business_id, p_user_id,
          CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END,
          p_appointment_id,
          p_staff_id, p_staff_name,
          p_date, p_time::time, p_party_size,
          p_flow_type::flow_type,
          'whatsapp'::booking_channel,
          p_deposit_amount,
          p_deposit_status::deposit_status,
          p_status::reservation_status,
          p_guest_name, p_guest_phone, p_guest_email,
          p_special_requests, p_venue_address, p_end_date,
          p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size,
          p_location_id
        )
        RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
        RETURN QUERY SELECT v_booking_id, v_ref, true;
      END;
      $$;
    `);

    // Simulate the insecure pre-320 production ACL: grant anon/authenticated
    // EXECUTE on both overloads (as Supabase ALTER DEFAULT PRIVILEGES would)
    psql(`
      GRANT EXECUTE ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,int,int) TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,int,int,uuid) TO anon, authenticated, service_role;
    `);
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`
      DROP FUNCTION IF EXISTS public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,int,int);
      DROP FUNCTION IF EXISTS public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,int,int,uuid);
      DROP FUNCTION IF EXISTS public.book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,int,int,uuid);
      DROP FUNCTION IF EXISTS public.reschedule_booking_atomic(uuid,uuid,date,text,int);
      DROP FUNCTION IF EXISTS public.check_staff_availability(uuid,uuid,date,text,int);
      DROP FUNCTION IF EXISTS public.check_appointment_schedule(uuid,uuid,date,text);
      DROP FUNCTION IF EXISTS public.get_active_appointments_public(uuid);
      DELETE FROM bookings WHERE business_id = '${BIZ}';
      DELETE FROM business_staff WHERE business_id = '${BIZ}';
      DELETE FROM services WHERE business_id = '${BIZ}';
      DELETE FROM appointments WHERE business_id = '${BIZ}';
      DELETE FROM businesses WHERE id = '${BIZ}';
    `);
  });

  it('DB-1: before migration 320, two overloads exist', () => {
    const count = psql(`SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = 'book_slot_atomic' AND n.nspname = 'public';`);
    expect(count).toBe('2');
  });

  it('DB-2: after migration 320, exactly one overload remains', () => {
    const m320 = readFileSync('supabase/migrations/320_drop_stale_book_slot_overload.sql', 'utf-8');
    psql(m320);
    const count = psql(`SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = 'book_slot_atomic' AND n.nspname = 'public';`);
    expect(count).toBe('1');
  });

  it('DB-3: remaining function has p_bot_session_id parameter', () => {
    const args = psql(`SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE p.proname = 'book_slot_atomic' AND n.nspname = 'public';`);
    expect(args).toContain('p_bot_session_id uuid');
  });

  it('DB-4: calling without p_bot_session_id resolves unambiguously (public booking path)', () => {
    // This is the exact call pattern from app/api/bookings/public/create/route.ts
    const result = psqlJson(`
      SELECT row_to_json(r) FROM (
        SELECT * FROM book_slot_atomic(
          '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, NULL::uuid,
          '2026-09-01'::date, '10:00', 1, 5,
          'scheduling', 0, 'none', 'confirmed',
          'Test Guest', '+1234567890', 'test@example.com',
          NULL, NULL, NULL,
          NULL, NULL, 0, NULL,
          NULL, NULL, 0, 30
        )
      ) r;
    `) as Record<string, unknown>;
    expect(result).toBeTruthy();
    expect(result.slot_available).toBe(true);
    expect(result.booking_id).toBeTruthy();
    // Clean up
    psql(`DELETE FROM bookings WHERE business_id = '${BIZ}';`);
  });

  it('DB-5: appointment schedule enforcement preserved (day rejection)', () => {
    // Saturday is not in available_days
    const result = psqlJson(`
      SELECT row_to_json(r) FROM (
        SELECT * FROM book_slot_atomic(
          '${BIZ}'::uuid, '${USR}'::uuid, NULL::uuid, NULL::uuid,
          '2026-09-05'::date, '10:00', 1, 1,
          'scheduling', 0, 'none', 'confirmed',
          'Test Guest', '+1234567890', NULL,
          NULL, NULL, NULL,
          NULL, NULL, 0, NULL,
          NULL, '${APPT}'::uuid, 0, 45
        )
      ) r;
    `) as Record<string, unknown>;
    expect(result.slot_available).toBe(false);
  });

  it('DB-6: staff availability enforcement preserved', () => {
    // 07:00 is before staff start (09:00)
    const result = psqlJson(`
      SELECT row_to_json(r) FROM (
        SELECT * FROM book_slot_atomic(
          '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, '${STAFF}'::uuid,
          '2026-09-01'::date, '07:00', 1, 5,
          'scheduling', 0, 'none', 'confirmed',
          'Test Guest', '+1234567890', NULL,
          NULL, NULL, NULL,
          NULL, NULL, 0, 'Test Staff',
          NULL, NULL, 0, 30
        )
      ) r;
    `) as Record<string, unknown>;
    expect(result.slot_available).toBe(false);
  });

  it('DB-7: requires_staff enforcement preserved (NULL staff rejected)', () => {
    const result = psqlJson(`
      SELECT row_to_json(r) FROM (
        SELECT * FROM book_slot_atomic(
          '${BIZ}'::uuid, '${USR}'::uuid, '${SVC_REQ}'::uuid, NULL::uuid,
          '2026-09-01'::date, '10:00', 1, 1,
          'scheduling', 0, 'none', 'confirmed',
          'Test Guest', '+1234567890', NULL,
          NULL, NULL, NULL,
          NULL, NULL, 0, NULL,
          NULL, NULL, 0, 60
        )
      ) r;
    `) as Record<string, unknown>;
    expect(result.slot_available).toBe(false);
  });

  it('DB-8: manual booking wrapper remains functional', () => {
    const result = psqlJson(`
      SELECT row_to_json(r) FROM (
        SELECT * FROM book_manual_slot_atomic(
          '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, NULL::uuid,
          '2026-09-02'::date, '14:00', 1, 5,
          'Manual Guest', '+1234567890', 'manual@test.com',
          'Test notes', 0, NULL,
          0, 30, NULL
        )
      ) r;
    `) as Record<string, unknown>;
    expect(result).toBeTruthy();
    expect(result.slot_available).toBe(true);
    expect(result.booking_id).toBeTruthy();
    // Verify manual fields
    const booking = psqlJson(`SELECT channel FROM bookings WHERE id = '${result.booking_id}';`) as Record<string, unknown>;
    expect(booking.channel).toBe('dashboard');
    psql(`DELETE FROM bookings WHERE business_id = '${BIZ}';`);
  });

  it('DB-9: advisory lock canonicalization (CONFLICT-1) — function body uses p_time::time::text', () => {
    const src = psql(`
      SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE p.proname = 'book_slot_atomic' AND n.nspname = 'public';
    `);
    expect(src).toContain("p_time::time::text");
    expect(src).toContain('pg_advisory_xact_lock');
  });

  // ── ACL assertions ──

  it('DB-10: anon EXECUTE = false on canonical 27-arg', () => {
    const result = psql(`
      SELECT has_function_privilege('anon',
        'public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,int,int,uuid)',
        'EXECUTE');
    `);
    expect(result).toBe('f');
  });

  it('DB-11: authenticated EXECUTE = false on canonical 27-arg', () => {
    const result = psql(`
      SELECT has_function_privilege('authenticated',
        'public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,int,int,uuid)',
        'EXECUTE');
    `);
    expect(result).toBe('f');
  });

  it('DB-12: service_role EXECUTE = true on canonical 27-arg', () => {
    const result = psql(`
      SELECT has_function_privilege('service_role',
        'public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,int,int,uuid)',
        'EXECUTE');
    `);
    expect(result).toBe('t');
  });
});
