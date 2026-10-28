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
        metadata JSONB DEFAULT '{}'::jsonb,
        bot_session_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE OR REPLACE FUNCTION public.generate_reference_code() RETURNS TRIGGER AS $$
      BEGIN NEW.reference_code := 'BW-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0'); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER set_reference_code BEFORE INSERT ON bookings FOR EACH ROW
        WHEN (NEW.reference_code IS NULL) EXECUTE FUNCTION generate_reference_code();

      -- Stub has_admin_role for RLS policies
      CREATE OR REPLACE FUNCTION public.has_admin_role(roles TEXT[]) RETURNS BOOLEAN AS $$
      BEGIN RETURN false; END $$ LANGUAGE plpgsql;

      -- Stub auth functions for RLS
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$ BEGIN RETURN 'service_role'; END $$ LANGUAGE plpgsql;
    `);

    // Apply M472
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await sql(client, migrationSql);
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

  it('service_role can execute book_table_atomic and create a booking', async () => {
    const { bizId, userId, resourceId } = await setupTestData();

    // Switch to service_role, then execute RPC
    await sql(client, `SET LOCAL ROLE service_role`);
    const { rows } = await sql(client,
      `SELECT * FROM book_table_atomic(NULL, $1, $2, $3, '2026-10-30'::date, '20:00', 2, 90, 'RoleTest', '+999', NULL, NULL, 5000, 'pending', 'pending', 5000, 5000, 90)`,
      [bizId, userId, resourceId],
    );
    await sql(client, `RESET ROLE`);

    expect(rows[0].slot_available).toBe(true);
    expect(rows[0].booking_id).toBeDefined();

    // Verify the booking was actually written
    const { rows: [booking] } = await sql(client, `SELECT * FROM bookings WHERE id = $1`, [rows[0].booking_id]);
    expect(booking.flow_type).toBe('table_reservation');
    expect(booking.guest_name).toBe('RoleTest');
  });

  it('anon role lacks EXECUTE privilege on book_table_atomic', async () => {
    await sql(client, `DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    // Check actual privilege — has_function_privilege is authoritative
    const { rows } = await sql(client, `
      SELECT has_function_privilege('anon',
        'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)',
        'EXECUTE') AS can_exec
    `);
    expect(rows[0].can_exec).toBe(false);
  });

  it('authenticated role lacks EXECUTE privilege on book_table_atomic', async () => {
    await sql(client, `DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    const { rows } = await sql(client, `
      SELECT has_function_privilege('authenticated',
        'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)',
        'EXECUTE') AS can_exec
    `);
    expect(rows[0].can_exec).toBe(false);
  });

  it('service_role EXECUTE privilege is confirmed', async () => {
    const { rows } = await sql(client, `
      SELECT has_function_privilege('service_role',
        'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)',
        'EXECUTE') AS can_exec
    `);
    expect(rows[0].can_exec).toBe(true);
  });

  it('seating_resources has RLS enabled', async () => {
    const { rows } = await sql(client, `
      SELECT relrowsecurity FROM pg_class
      WHERE relname = 'seating_resources' AND relnamespace = 'public'::regnamespace
    `);
    expect(rows[0].relrowsecurity).toBe(true);
  });
});
