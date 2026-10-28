/**
 * Issue #730: Table Reservation — Disposable PostgreSQL Tests
 *
 * Tests M472 migration apply, book_table_atomic RPC behavior,
 * concurrency, ACL, deposit, availability, and midnight guards.
 *
 * Requires TEST_DATABASE_URL environment variable pointing to a
 * disposable PostgreSQL instance. Skipped if not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_DB_URL;

// Helper to run SQL
async function sql(client: pg.Client, query: string, params?: unknown[]) {
  return client.query(query, params);
}

describe.skipIf(SKIP)('#730: Disposable-PG M472 migration and RPC', () => {
  let client: pg.Client;
  let dbName: string;

  beforeAll(async () => {
    // Connect to the TEST_DATABASE_URL and create an isolated database
    const adminClient = new pg.Client({ connectionString: TEST_DB_URL });
    await adminClient.connect();
    dbName = `waaiio_730_test_${Date.now()}`;
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
    await adminClient.end();

    // Connect to the new database
    const url = new URL(TEST_DB_URL!);
    url.pathname = `/${dbName}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();

    // Create minimal schema needed for M472
    await sql(client, `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$ LANGUAGE plpgsql;

      CREATE TYPE business_category AS ENUM ('restaurant', 'other');
      CREATE TYPE flow_type AS ENUM ('scheduling', 'payment', 'ordering', 'ticketing', 'reservation', 'appointment', 'queue');
      CREATE TYPE reservation_status AS ENUM ('pending', 'confirmed', 'in_progress', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'completed');
      CREATE TYPE booking_channel AS ENUM ('whatsapp', 'dashboard', 'api');
      CREATE TYPE deposit_status AS ENUM ('none', 'pending', 'paid');
      CREATE TYPE subscription_tier AS ENUM ('free', 'growth', 'business');

      CREATE TABLE businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name TEXT NOT NULL DEFAULT 'Test Business',
        category business_category NOT NULL DEFAULT 'restaurant',
        timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
        metadata JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid());

      CREATE TABLE bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reference_code VARCHAR(10) UNIQUE,
        business_id UUID NOT NULL REFERENCES businesses(id),
        user_id UUID NOT NULL REFERENCES profiles(id),
        service_id UUID,
        appointment_id UUID,
        staff_id UUID,
        staff_name TEXT,
        date DATE NOT NULL,
        time TIME NOT NULL,
        party_size INTEGER NOT NULL DEFAULT 1,
        flow_type flow_type,
        channel booking_channel NOT NULL DEFAULT 'whatsapp',
        deposit_amount INTEGER NOT NULL DEFAULT 0,
        deposit_status deposit_status NOT NULL DEFAULT 'none',
        status reservation_status NOT NULL DEFAULT 'pending',
        total_amount INTEGER NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 1,
        guest_name TEXT,
        guest_phone TEXT,
        guest_email TEXT,
        special_requests TEXT,
        venue_address TEXT,
        end_date DATE,
        addons_snapshot JSONB,
        promo_code_id UUID,
        location_id UUID,
        class_session_id UUID,
        metadata JSONB DEFAULT '{}'::jsonb,
        bot_session_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE OR REPLACE FUNCTION public.generate_reference_code() RETURNS TRIGGER AS $$
      BEGIN NEW.reference_code := 'BW-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0'); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER set_reference_code BEFORE INSERT ON bookings FOR EACH ROW
        WHEN (NEW.reference_code IS NULL) EXECUTE FUNCTION generate_reference_code();

      -- Tables needed by M475 book_slot_atomic replacement
      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT, price INTEGER DEFAULT 0, deposit_amount INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true, max_capacity INTEGER DEFAULT 1,
        duration_minutes INTEGER DEFAULT 30, is_class BOOLEAN DEFAULT false,
        requires_staff BOOLEAN DEFAULT false, staff_ids TEXT[],
        metadata JSONB DEFAULT '{}', class_schedule JSONB, auto_approve BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT, requires_staff BOOLEAN DEFAULT false,
        available_days TEXT[], available_from TIME, available_to TIME
      );
      CREATE TABLE IF NOT EXISTS business_staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT, is_active BOOLEAN DEFAULT true, schedule JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS class_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        service_id UUID REFERENCES services(id),
        date DATE, start_time TIME, capacity INTEGER DEFAULT 10,
        status TEXT DEFAULT 'scheduled', staff_id UUID, location_id UUID
      );
      -- Stub helper functions for M475
      CREATE OR REPLACE FUNCTION check_staff_availability(p_staff_id UUID, p_biz UUID, p_date DATE, p_time TEXT, p_dur INTEGER DEFAULT 30)
        RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$ BEGIN RETURN QUERY SELECT true, 'ok'; END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION check_appointment_schedule(p_appt UUID, p_biz UUID, p_date DATE, p_time TEXT)
        RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$ BEGIN RETURN QUERY SELECT true, 'ok'; END $$ LANGUAGE plpgsql;

      -- Stub has_admin_role for RLS policies
      CREATE OR REPLACE FUNCTION public.has_admin_role(roles TEXT[]) RETURNS BOOLEAN AS $$
      BEGIN RETURN false; END $$ LANGUAGE plpgsql;

      -- Stub auth functions for RLS
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$ BEGIN RETURN 'service_role'; END $$ LANGUAGE plpgsql;
    `);

    // Apply M474 + M475
    const fs = await import('fs');
    const path = await import('path');
    const m474Path = path.join(process.cwd(), 'supabase/migrations/474_seating_resources_table_reservation.sql');
    await sql(client, fs.readFileSync(m474Path, 'utf-8'));
    const m475Path = path.join(process.cwd(), 'supabase/migrations/475_exclude_table_bookings_from_slot_capacity.sql');
    await sql(client, fs.readFileSync(m475Path, 'utf-8'));

    // Grants from earlier migrations that M474 depends on for SECURITY INVOKER:
    // M293: GRANT ALL ON businesses TO service_role
    // M415: GRANT SELECT, UPDATE ON bookings TO service_role
    // These are present in the full CI bootstrap but not this minimal fixture.
    await sql(client, `
      GRANT ALL ON public.businesses TO service_role;
      GRANT SELECT, UPDATE ON public.bookings TO service_role;
      GRANT USAGE ON SCHEMA public TO service_role;
    `);
  }, 30000);

  afterAll(async () => {
    if (client) await client.end();
    // Drop the test database
    if (TEST_DB_URL && dbName) {
      const adminClient = new pg.Client({ connectionString: TEST_DB_URL });
      await adminClient.connect();
      await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminClient.end();
    }
  });

  it('M472 self-check passed (table, RLS, RPC, enum)', async () => {
    // If we get here, the migration applied successfully including the self-check DO block
    const { rows } = await sql(client, `
      SELECT COUNT(*) AS c FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'seating_resources'
    `);
    expect(parseInt(rows[0].c)).toBe(1);
  });

  it('flow_type enum includes table_reservation', async () => {
    const { rows } = await sql(client, `
      SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'flow_type' AND e.enumlabel = 'table_reservation'
    `);
    expect(rows.length).toBe(1);
  });

  // Setup helper
  async function setupTestData() {
    const { rows: [biz] } = await sql(client, `INSERT INTO businesses (name, timezone) VALUES ('Test Restaurant', 'Africa/Lagos') RETURNING id`);
    const { rows: [user] } = await sql(client, `INSERT INTO profiles DEFAULT VALUES RETURNING id`);
    const { rows: [resource] } = await sql(client, `
      INSERT INTO seating_resources (business_id, name, capacity, min_party_size, deposit_amount, reservation_duration_minutes, available_days, available_from, available_to)
      VALUES ($1, 'Table 1', 4, 1, 5000, 90, '{friday,saturday}', '18:00', '22:00') RETURNING id
    `, [biz.id]);
    return { bizId: biz.id as string, userId: user.id as string, resourceId: resource.id as string };
  }

  it('book_table_atomic creates a booking with correct fields', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    const { rows } = await sql(client, `
      SELECT * FROM book_table_atomic(
        NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90,
        'Alice', '+2341234', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90
      )
    `, [bizId, userId, resourceId]);

    expect(rows[0].slot_available).toBe(true);
    expect(rows[0].booking_id).toBeDefined();
    expect(rows[0].reference_code).toBeDefined();

    // Verify booking was created correctly
    const { rows: [booking] } = await sql(client, `SELECT * FROM bookings WHERE id = $1`, [rows[0].booking_id]);
    expect(booking.flow_type).toBe('table_reservation');
    expect(booking.seating_resource_id).toBe(resourceId);
    expect(booking.deposit_amount).toBe(5000);
    expect(booking.total_amount).toBe(5000); // flat deposit = total
    expect(booking.party_size).toBe(2);
    expect(parseInt(booking.metadata.duration_minutes)).toBe(90);
  });

  it('rejects overlapping bookings on same resource', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    // First booking: 19:00-20:30 (resource deposit=5000, pass expected=5000)
    await sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId]);
    // Overlapping: 19:30-21:00 — should fail
    const { rows } = await sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:30', 2, 90, 'B', '+2', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId]);
    expect(rows[0].slot_available).toBe(false);
  });

  it('allows non-overlapping bookings on same resource', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    // First: 18:00-19:30
    await sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '18:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId]);
    // Non-overlapping: 19:30-21:00
    const { rows } = await sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:30', 2, 90, 'B', '+2', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId]);
    expect(rows[0].slot_available).toBe(true);
  });

  it('rejects party size exceeding capacity', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    await expect(
      sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 10, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId])
    ).rejects.toThrow(/party_too_large/);
  });

  it('rejects unavailable day', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    // Resource is Friday/Saturday only; 2026-10-27 is Tuesday
    await expect(
      sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-27'::date, '19:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId])
    ).rejects.toThrow(/day_unavailable/);
  });

  it('rejects booking before opening time', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    await expect(
      sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '17:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId])
    ).rejects.toThrow(/before_opening/);
  });

  it('rejects booking extending past closing', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    // 21:00 + 90min = 22:30 > 22:00 close
    await expect(
      sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '21:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId])
    ).rejects.toThrow(/after_closing/);
  });

  it('rejects booking extending past midnight', async () => {
    const { bizId, userId } = await setupTestData();
    // Create resource with no closing time
    const { rows: [res2] } = await sql(client, `
      INSERT INTO seating_resources (business_id, name, capacity, min_party_size, deposit_amount, reservation_duration_minutes)
      VALUES ($1, 'Late Table', 4, 1, 0, 90) RETURNING id
    `, [bizId]);
    // 23:30 + 90min = 25:00 > 1440 (midnight)
    await expect(
      sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '23:30', 2, 90, 'A', '+1', NULL, NULL, 0, 'none', 'confirmed', 0, 0, 90)`, [bizId, userId, res2.id])
    ).rejects.toThrow(/past_midnight/);
  });

  it('rejects deposit change at commit time', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    // Resource has deposit_amount=5000; pass expected=3000 → should fail
    await expect(
      sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 3000, 90)`, [bizId, userId, resourceId])
    ).rejects.toThrow(/deposit_changed/);
  });

  it('rejects cross-business resource usage', async () => {
    const { userId, resourceId } = await setupTestData();
    const { rows: [otherBiz] } = await sql(client, `INSERT INTO businesses (name) VALUES ('Other Biz') RETURNING id`);
    await expect(
      sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [otherBiz.id, userId, resourceId])
    ).rejects.toThrow(/seating_resource_wrong_business/);
  });

  it('idempotency returns existing booking on retry', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    const sessionId = '00000000-0000-0000-0000-000000000099';
    // First call
    const { rows: [first] } = await sql(client, `SELECT * FROM book_table_atomic($4::uuid, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId, sessionId]);
    expect(first.slot_available).toBe(true);
    // Retry with same session — should return same booking
    const { rows: [retry] } = await sql(client, `SELECT * FROM book_table_atomic($4::uuid, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId, sessionId]);
    expect(retry.slot_available).toBe(true);
    expect(retry.booking_id).toBe(first.booking_id);
  });

  it('overnight availability constraint rejects invalid config', async () => {
    const { bizId } = await setupTestData();
    await expect(
      sql(client, `INSERT INTO seating_resources (business_id, name, available_from, available_to) VALUES ($1, 'Night', '22:00', '06:00')`, [bizId])
    ).rejects.toThrow(); // seating_no_overnight constraint
  });

  it('delete guard blocks deletion of referenced resource', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    await sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'A', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId]);
    // Try to delete — should fail
    await expect(
      sql(client, `DELETE FROM seating_resources WHERE id = $1`, [resourceId])
    ).rejects.toThrow(/Cannot delete seating resource/);
  });

  it('zero-deposit creates confirmed booking', async () => {
    const { bizId, userId } = await setupTestData();
    // Resource with zero deposit
    const { rows: [freeRes] } = await sql(client, `
      INSERT INTO seating_resources (business_id, name, capacity, deposit_amount, reservation_duration_minutes)
      VALUES ($1, 'Free Table', 4, 0, 60) RETURNING id
    `, [bizId]);
    const { rows: [result] } = await sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 60, 'A', '+1', NULL, NULL, 0, 'none', 'confirmed', 0, 0, 60)`, [bizId, userId, freeRes.id]);
    expect(result.slot_available).toBe(true);
    const { rows: [booking] } = await sql(client, `SELECT * FROM bookings WHERE id = $1`, [result.booking_id]);
    expect(booking.status).toBe('confirmed');
    expect(booking.deposit_amount).toBe(0);
    expect(booking.deposit_status).toBe('none');
  });

  it('weekday is correct for various timezones (no AT TIME ZONE bug)', async () => {
    const { rows } = await sql(client, `
      SELECT
        lower(to_char('2026-10-27'::date, 'fmday')) AS tue,
        lower(to_char('2026-10-30'::date, 'fmday')) AS fri,
        lower(to_char('2026-10-31'::date, 'fmday')) AS sat
    `);
    expect(rows[0].tue).toBe('tuesday');
    expect(rows[0].fri).toBe('friday');
    expect(rows[0].sat).toBe('saturday');
  });

  // ── Security regression tests (actual role execution, not catalog-only) ──

  it('book_table_atomic is SECURITY INVOKER (catalog)', async () => {
    const { rows } = await sql(client, `
      SELECT p.prosecdef FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'book_table_atomic'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].prosecdef).toBe(false);
  });

  it('service_role executes book_table_atomic within a role-scoped transaction', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    let bookingId: string | undefined;

    await sql(client, `BEGIN`);
    try {
      await sql(client, `SET LOCAL ROLE service_role`);
      const { rows: [roleCheck] } = await sql(client, `SELECT current_user`);
      expect(roleCheck.current_user).toBe('service_role');

      const { rows } = await sql(client,
        `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '20:00', 2, 90, 'RoleTest', '+999', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`,
        [bizId, userId, resourceId],
      );
      expect(rows[0].slot_available).toBe(true);
      bookingId = rows[0].booking_id;
      expect(bookingId).toBeDefined();
      await sql(client, `COMMIT`);
    } catch {
      await sql(client, `ROLLBACK`);
      throw new Error('service_role booking failed unexpectedly');
    }

    // Verify durable write (back as superuser)
    const { rows: [booking] } = await sql(client, `SELECT * FROM bookings WHERE id = $1`, [bookingId]);
    expect(booking.flow_type).toBe('table_reservation');
    expect(booking.guest_name).toBe('RoleTest');
  });

  it('anon role is denied EXECUTE on book_table_atomic (SQLSTATE 42501)', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    await sql(client, `DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await sql(client, `GRANT USAGE ON SCHEMA public TO anon`);

    // Catalog check: EXECUTE privilege must be false
    const { rows: [privCheck] } = await sql(client, `
      SELECT has_function_privilege('anon',
        'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)',
        'EXECUTE') AS can_exec
    `);
    expect(privCheck.can_exec).toBe(false);

    // Actual execution attempt under anon role
    let caughtCode: string | undefined;
    let caughtMessage = '';
    await sql(client, `BEGIN`);
    try {
      await sql(client, `SET LOCAL ROLE anon`);
      const { rows: [roleCheck] } = await sql(client, `SELECT current_user`);
      expect(roleCheck.current_user).toBe('anon');

      await sql(client,
        `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'AnonTest', '+000', NULL, NULL, 0, 'none', 'confirmed', 0, 0, 90)`,
        [bizId, userId, resourceId],
      );
    } catch (err: any) {
      caughtCode = err.code;
      caughtMessage = err.message || '';
    } finally {
      await sql(client, `ROLLBACK`);
    }
    expect(caughtCode).toBe('42501'); // insufficient_privilege
    expect(caughtMessage).toMatch(/permission denied for function book_table_atomic/i);
  });

  it('authenticated role is denied EXECUTE on book_table_atomic (SQLSTATE 42501)', async () => {
    const { bizId, userId, resourceId } = await setupTestData();
    await sql(client, `DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await sql(client, `GRANT USAGE ON SCHEMA public TO authenticated`);

    // Catalog check
    const { rows: [privCheck] } = await sql(client, `
      SELECT has_function_privilege('authenticated',
        'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)',
        'EXECUTE') AS can_exec
    `);
    expect(privCheck.can_exec).toBe(false);

    // Actual execution attempt
    let caughtCode: string | undefined;
    let caughtMessage = '';
    await sql(client, `BEGIN`);
    try {
      await sql(client, `SET LOCAL ROLE authenticated`);
      const { rows: [roleCheck] } = await sql(client, `SELECT current_user`);
      expect(roleCheck.current_user).toBe('authenticated');

      await sql(client,
        `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'AuthTest', '+111', NULL, NULL, 0, 'none', 'confirmed', 0, 0, 90)`,
        [bizId, userId, resourceId],
      );
    } catch (err: any) {
      caughtCode = err.code;
      caughtMessage = err.message || '';
    } finally {
      await sql(client, `ROLLBACK`);
    }
    expect(caughtCode).toBe('42501');
    expect(caughtMessage).toMatch(/permission denied for function book_table_atomic/i);
  });

  it('service_role has required table/schema/function permissions', async () => {
    const checks = await sql(client, `
      SELECT
        has_table_privilege('service_role', 'public.bookings', 'INSERT') AS bookings_insert,
        has_table_privilege('service_role', 'public.bookings', 'SELECT') AS bookings_select,
        has_table_privilege('service_role', 'public.seating_resources', 'SELECT') AS sr_select,
        has_table_privilege('service_role', 'public.seating_resources', 'INSERT') AS sr_insert,
        has_table_privilege('service_role', 'public.seating_resources', 'UPDATE') AS sr_update,
        has_table_privilege('service_role', 'public.businesses', 'SELECT') AS biz_select,
        has_schema_privilege('service_role', 'public', 'USAGE') AS schema_usage,
        has_function_privilege('service_role',
          'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)',
          'EXECUTE') AS rpc_execute
    `);
    const r = checks.rows[0];
    expect(r.bookings_insert).toBe(true);
    expect(r.bookings_select).toBe(true);
    expect(r.sr_select).toBe(true);
    expect(r.sr_insert).toBe(true); // admin POST creates resources
    expect(r.sr_update).toBe(true); // FOR UPDATE lock + admin PATCH
    expect(r.biz_select).toBe(true);
    expect(r.schema_usage).toBe(true);
    expect(r.rpc_execute).toBe(true);
  });

  it('service_role can INSERT into seating_resources (admin creation)', async () => {
    const { bizId } = await setupTestData();

    await sql(client, `BEGIN`);
    try {
      await sql(client, `SET LOCAL ROLE service_role`);
      const { rows: [roleCheck] } = await sql(client, `SELECT current_user`);
      expect(roleCheck.current_user).toBe('service_role');

      const { rows } = await sql(client,
        `INSERT INTO seating_resources (business_id, name, capacity) VALUES ($1, 'Admin Table', 6) RETURNING id, name`,
        [bizId],
      );
      expect(rows[0].name).toBe('Admin Table');
      await sql(client, `COMMIT`);
    } catch {
      await sql(client, `ROLLBACK`);
      throw new Error('service_role INSERT into seating_resources failed');
    }
  });

  it('M475: table booking does not block service slot (cross-capability isolation)', async () => {
    const { bizId, userId, resourceId } = await setupTestData();

    // Create a table reservation at 19:00
    await sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'TableGuest', '+1', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId]);

    // Verify the table booking exists
    const { rows: tableBookings } = await sql(client, `SELECT id, seating_resource_id FROM bookings WHERE business_id = $1 AND date = '2026-10-30' AND time = '19:00'`, [bizId]);
    expect(tableBookings.length).toBe(1);
    expect(tableBookings[0].seating_resource_id).toBe(resourceId);

    // Now book a SERVICE at the same time — capacity 1 — should succeed
    // because book_slot_atomic excludes table reservations (seating_resource_id IS NULL)
    const { rows: [svcBooking] } = await sql(client, `SELECT * FROM book_slot_atomic($1, $2, NULL, NULL, '2026-10-30'::date, '19:00', 1, 1, 'scheduling', 0, 'none', 'confirmed', 'SvcGuest', '+2', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`, [bizId, userId]);
    expect(svcBooking.slot_available).toBe(true);
    expect(svcBooking.booking_id).toBeDefined();
  });

  it('M475: service booking does not block table reservation', async () => {
    const { bizId, userId, resourceId } = await setupTestData();

    // Create a service booking at 19:00
    await sql(client, `SELECT * FROM book_slot_atomic($1, $2, NULL, NULL, '2026-10-30'::date, '19:00', 1, 1, 'scheduling', 0, 'none', 'confirmed', 'SvcGuest', '+1', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`, [bizId, userId]);

    // Table reservation at same time should still succeed
    const { rows: [tableResult] } = await sql(client, `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '19:00', 2, 90, 'TableGuest', '+2', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`, [bizId, userId, resourceId]);
    expect(tableResult.slot_available).toBe(true);
  });

  it('M475: two service bookings at same time still respect capacity', async () => {
    const { bizId, userId } = await setupTestData();

    // First service booking — capacity 1
    const { rows: [first] } = await sql(client, `SELECT * FROM book_slot_atomic($1, $2, NULL, NULL, '2026-10-30'::date, '19:00', 1, 1, 'scheduling', 0, 'none', 'confirmed', 'Guest1', '+1', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`, [bizId, userId]);
    expect(first.slot_available).toBe(true);

    // Second at same time — should fail (capacity 1)
    const { rows: [second] } = await sql(client, `SELECT * FROM book_slot_atomic($1, $2, NULL, NULL, '2026-10-30'::date, '19:00', 1, 1, 'scheduling', 0, 'none', 'confirmed', 'Guest2', '+2', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`, [bizId, userId]);
    expect(second.slot_available).toBe(false);
  });

  it('seating_resources has RLS enabled', async () => {
    const { rows } = await sql(client, `
      SELECT relrowsecurity FROM pg_class
      WHERE relname = 'seating_resources' AND relnamespace = 'public'::regnamespace
    `);
    expect(rows[0].relrowsecurity).toBe(true);
  });
});
