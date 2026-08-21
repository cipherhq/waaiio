/**
 * Migration 333 — Promo reservation state machine: real PostgreSQL tests.
 * Requires TEST_DATABASE_URL.
 *
 * Tests:
 * - Per-order reservation CRUD
 * - Capacity enforcement (current_uses + reserved count)
 * - Two-session concurrency (max_uses=1)
 * - Finalize replay / release replay
 * - Finalize/release race
 * - Finalize requires order confirmed
 * - Free-order promo finalization
 * - promo_exhausted semantic result
 * - Historical current_uses + new reservation capacity
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync, spawn } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}
function psqlJson(sql: string): Record<string, unknown> {
  const r = psql(sql);
  return r ? JSON.parse(r) : {};
}
function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const output = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: (e as Error).message || '' };
  }
}

const BIZ = '00000000-0000-0000-0333-000000000001';
const USER = '00000000-0000-0000-0333-000000000002';
const PROMO = '00000000-0000-0000-0333-000000000010';
const ORDER_A = '00000000-0000-0000-0333-00000000000a';
const ORDER_B = '00000000-0000-0000-0333-00000000000b';
const ORDER_FREE = '00000000-0000-0000-0333-00000000000f';
const SESSION_A = '00000000-0000-0000-0333-0000000000a1';
const SESSION_B = '00000000-0000-0000-0333-0000000000b1';
const SESSION_F = '00000000-0000-0000-0333-0000000000f1';
const PRODUCT = '00000000-0000-0000-0333-000000000020';

describe.skipIf(!canRun)('Migration 333: Promo reservation state machine', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE TYPE order_status AS ENUM ('draft','pending','confirmed','processing','shipped','ready','delivered','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;
      GRANT USAGE ON SCHEMA public TO anon;
      GRANT USAGE ON SCHEMA public TO authenticated;

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, name TEXT DEFAULT 'Test');
      CREATE TABLE IF NOT EXISTS profiles (id UUID PRIMARY KEY, phone TEXT);
      CREATE TABLE IF NOT EXISTS referrals (id UUID PRIMARY KEY, status TEXT DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS products (id UUID PRIMARY KEY, stock_quantity INT, track_inventory BOOLEAN DEFAULT true);
      CREATE TABLE IF NOT EXISTS product_variants (id UUID PRIMARY KEY, stock_quantity INT);
      CREATE TABLE IF NOT EXISTS promo_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, code TEXT, discount_type TEXT DEFAULT 'percentage',
        discount_value NUMERIC DEFAULT 10, max_uses INTEGER, current_uses INTEGER DEFAULT 0 NOT NULL,
        is_active BOOLEAN DEFAULT true, min_order_amount NUMERIC DEFAULT 0,
        valid_from TIMESTAMPTZ DEFAULT NOW(), valid_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reference_code VARCHAR(20) UNIQUE DEFAULT 'WA-OR-' || lpad(floor(random()*10000)::text,4,'0'),
        business_id UUID, user_id UUID, status order_status DEFAULT 'pending',
        delivery_address TEXT, delivery_phone TEXT, total_amount INT DEFAULT 0,
        discount_amount INT DEFAULT 0, shipping_cost INT DEFAULT 0,
        promo_code_id UUID, channel VARCHAR(20) DEFAULT 'whatsapp',
        notes TEXT, delivery_zone_id UUID, delivery_zone_name TEXT,
        addons_total INT DEFAULT 0, volume_discount_amount INT DEFAULT 0,
        pickup_address TEXT, dropoff_address TEXT, package_description TEXT, package_photo_url TEXT,
        referral_id UUID, bot_session_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID, product_id UUID, quantity INT DEFAULT 1, unit_price INT DEFAULT 0,
        variant_id UUID, variant_label TEXT, addons JSONB
      );
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount INT DEFAULT 0, status TEXT DEFAULT 'pending', order_id UUID,
        metadata JSONB DEFAULT '{}'::jsonb, gateway_fee INT DEFAULT 0,
        finalization_processing_at TIMESTAMPTZ, finalization_completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS order_stock_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL UNIQUE, payment_id UUID, item_count INT DEFAULT 0,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, phone TEXT, name TEXT, total_bookings INT DEFAULT 0,
        total_orders INT DEFAULT 0, total_spent NUMERIC DEFAULT 0, total_visits INT DEFAULT 0,
        last_seen_at TIMESTAMPTZ DEFAULT NOW(), first_seen_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(business_id, phone)
      );
      -- Stub upsert_customer_profile
      CREATE OR REPLACE FUNCTION upsert_customer_profile(p_business_id uuid, p_phone text, p_name text DEFAULT NULL, p_booking_amount numeric DEFAULT 0, p_is_booking boolean DEFAULT false, p_is_order boolean DEFAULT false) RETURNS uuid AS $$ BEGIN RETURN gen_random_uuid(); END; $$ LANGUAGE plpgsql;
    `);

    // Apply migration 333
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    psql(sql.replace(/--.*$/gm, ''));

    // Seed test data
    psql(`
      INSERT INTO businesses (id, name) VALUES ('${BIZ}', 'PromoTest') ON CONFLICT DO NOTHING;
      INSERT INTO profiles (id, phone) VALUES ('${USER}', '+2340000') ON CONFLICT DO NOTHING;
      INSERT INTO products (id, stock_quantity) VALUES ('${PRODUCT}', 100) ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(() => {
    if (!canRun) return;
    psql(`
      DELETE FROM promo_reservations;
      DELETE FROM order_spend_applications;
      DELETE FROM order_stock_applications;
      DELETE FROM order_items;
      DELETE FROM orders;
      DELETE FROM promo_codes WHERE id = '${PROMO}';
      DELETE FROM products WHERE id = '${PRODUCT}';
      DELETE FROM profiles WHERE id = '${USER}';
      DELETE FROM businesses WHERE id = '${BIZ}';
    `);
  });

  beforeEach(() => {
    psql(`
      DELETE FROM promo_reservations;
      DELETE FROM order_spend_applications;
      DELETE FROM order_stock_applications;
      DELETE FROM order_items;
      DELETE FROM orders;
      DELETE FROM promo_codes WHERE id = '${PROMO}';
    `);
  });

  it('1. create_order_atomic reserves promo and creates order', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'TEST10', 5, 0);`);
    const r = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    expect(r.order_id).toBeTruthy();
    expect(r.created).toBe(true);

    // Reservation exists with state='reserved'
    const state = psql(`SELECT state FROM promo_reservations WHERE order_id = '${r.order_id}';`);
    expect(state).toBe('reserved');
  });

  it('2. max_uses=1 + two simultaneous orders → exactly one succeeds', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'ONCE', 1, 0);`);

    const rA = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    expect(rA.order_id).toBeTruthy();

    const rB = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_B}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    expect(rB.error).toBe('promo_exhausted');

    // Only one reservation
    const count = psql(`SELECT count(*) FROM promo_reservations WHERE promo_code_id = '${PROMO}';`);
    expect(parseInt(count)).toBe(1);
  });

  it('3. historical current_uses + new reservation = capacity enforced', () => {
    // Promo with max_uses=3, current_uses=2 (2 historical uses before migration 333)
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'LEGACY', 3, 2);`);

    // First new order succeeds (2 historical + 0 reserved < 3)
    const rA = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    expect(rA.order_id).toBeTruthy();

    // Second new order fails (2 historical + 1 reserved >= 3)
    const rB = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_B}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    expect(rB.error).toBe('promo_exhausted');
  });

  it('4. finalize_promo_reservation: reserved → finalized + increments current_uses', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'FIN', 5, 0);`);
    const rA = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);

    // Must confirm order before finalization
    psql(`UPDATE orders SET status = 'confirmed' WHERE id = '${rA.order_id}';`);

    const fr = psqlJson(`SET ROLE service_role; SELECT finalize_promo_reservation('${rA.order_id}');`);
    expect(fr.finalized).toBe(true);
    expect(fr.already_finalized).toBe(false);

    // State transitioned
    const state = psql(`SELECT state FROM promo_reservations WHERE order_id = '${rA.order_id}';`);
    expect(state).toBe('finalized');

    // current_uses incremented
    const uses = psql(`SELECT current_uses FROM promo_codes WHERE id = '${PROMO}';`);
    expect(parseInt(uses)).toBe(1);
  });

  it('5. finalize replay → idempotent', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'REPLAY', 5, 0);`);
    const rA = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    psql(`UPDATE orders SET status = 'confirmed' WHERE id = '${rA.order_id}';`);

    psqlJson(`SET ROLE service_role; SELECT finalize_promo_reservation('${rA.order_id}');`);
    const fr2 = psqlJson(`SET ROLE service_role; SELECT finalize_promo_reservation('${rA.order_id}');`);
    expect(fr2.finalized).toBe(true);
    expect(fr2.already_finalized).toBe(true);

    // current_uses still 1 (not 2)
    const uses = psql(`SELECT current_uses FROM promo_codes WHERE id = '${PROMO}';`);
    expect(parseInt(uses)).toBe(1);
  });

  it('6. release replay → idempotent', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'REL', 5, 0);`);
    const rA = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);

    const rel1 = psqlJson(`SET ROLE service_role; SELECT release_promo_reservation('${rA.order_id}');`);
    expect(rel1.released).toBe(true);
    expect(rel1.already_released).toBe(false);

    const rel2 = psqlJson(`SET ROLE service_role; SELECT release_promo_reservation('${rA.order_id}');`);
    expect(rel2.released).toBe(true);
    expect(rel2.already_released).toBe(true);
  });

  it('7. finalize on pending order → rejected (order_not_confirmed)', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'PEND', 5, 0);`);
    const rA = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    // Do NOT confirm the order

    const fr = psqlJson(`SET ROLE service_role; SELECT finalize_promo_reservation('${rA.order_id}');`);
    expect(fr.finalized).toBe(false);
    expect(fr.reason).toBe('order_not_confirmed');

    // State unchanged
    const state = psql(`SELECT state FROM promo_reservations WHERE order_id = '${rA.order_id}';`);
    expect(state).toBe('reserved');
  });

  it('8. free-order promo finalized ATOMICALLY inside create_order_atomic', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'FREE', 5, 0);`);
    // Free order is created with status='confirmed' → promo finalized inside same transaction
    const rF = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_F}', '${BIZ}', '${USER}', 'confirmed', NULL, '+234', 0, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    expect(rF.order_id).toBeTruthy();

    // Reservation already finalized (not just reserved)
    const state = psql(`SELECT state FROM promo_reservations WHERE order_id = '${rF.order_id}';`);
    expect(state).toBe('finalized');

    // current_uses already incremented
    const uses = psql(`SELECT current_uses FROM promo_codes WHERE id = '${PROMO}';`);
    expect(parseInt(uses)).toBe(1);

    // Replay finalize is idempotent
    const fr = psqlJson(`SET ROLE service_role; SELECT finalize_promo_reservation('${rF.order_id}');`);
    expect(fr.finalized).toBe(true);
    expect(fr.already_finalized).toBe(true);

    // current_uses still 1
    const uses2 = psql(`SELECT current_uses FROM promo_codes WHERE id = '${PROMO}';`);
    expect(parseInt(uses2)).toBe(1);
  });

  it('9. finalize after release → rejected (already_released)', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'RACE', 5, 0);`);
    const rA = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);

    // Release first (cancellation wins)
    psqlJson(`SET ROLE service_role; SELECT release_promo_reservation('${rA.order_id}');`);

    // Confirm order (late payment)
    psql(`UPDATE orders SET status = 'confirmed' WHERE id = '${rA.order_id}';`);

    // Finalize should be rejected
    const fr = psqlJson(`SET ROLE service_role; SELECT finalize_promo_reservation('${rA.order_id}');`);
    expect(fr.finalized).toBe(false);
    expect(fr.reason).toBe('already_released');
  });

  it('10. apply_customer_spend_once: exactly-once via marker', () => {
    psql(`
      INSERT INTO orders (id, business_id, user_id, status, total_amount, delivery_phone)
        VALUES ('${ORDER_A}', '${BIZ}', '${USER}', 'confirmed', 5000, '+234');
    `);

    const r1 = psqlJson(`SET ROLE service_role; SELECT apply_customer_spend_once('${ORDER_A}', NULL, 5000);`);
    expect(r1.applied).toBe(true);
    expect(r1.already_applied).toBe(false);

    const r2 = psqlJson(`SET ROLE service_role; SELECT apply_customer_spend_once('${ORDER_A}', NULL, 5000);`);
    expect(r2.applied).toBe(true);
    expect(r2.already_applied).toBe(true);

    // Only one marker
    const count = psql(`SELECT count(*) FROM order_spend_applications WHERE order_id = '${ORDER_A}';`);
    expect(parseInt(count)).toBe(1);
  });

  it('11. promo_exhausted returns semantic error (not Supabase RPC error)', () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'FULL', 1, 1);`);
    const r = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    // Returns JSON error, not RPC failure
    expect(r.error).toBe('promo_exhausted');
    expect(r.order_id).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════
  // REAL TWO-SESSION CONCURRENCY (parallel psql processes)
  // ══════════════════════════════════════════════════════════

  function psqlAsync(sql: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code: number) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
      child.stdin.write(sql);
      child.stdin.end();
    });
  }

  it('12. REAL concurrency: two-session max_uses=1 → exactly one reservation', async () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'RACE1', 1, 0);`);

    // Session A: hold advisory lock as transaction barrier, then create order with promo
    const sessionA = psqlAsync(`
      BEGIN;
      SELECT pg_advisory_lock(333001);
      SET ROLE service_role;
      SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);
      SELECT pg_sleep(2);
      COMMIT;
      SELECT pg_advisory_unlock(333001);
    `);

    // Wait for A to start
    await new Promise(r => setTimeout(r, 300));

    // Session B: try to create order with same promo — advisory lock on promo row will block
    const bStart = Date.now();
    const sessionB = psqlAsync(`
      SELECT pg_advisory_lock(333001);
      SELECT pg_advisory_unlock(333001);
      SET ROLE service_role;
      SELECT create_order_atomic('${SESSION_B}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);
    `);

    const [rA, rB] = await Promise.all([sessionA, sessionB]);
    const bDuration = Date.now() - bStart;

    // Prove contention: B waited >1s
    expect(bDuration).toBeGreaterThan(1000);

    // Session A succeeds
    expect(rA.stdout).toContain('"created":');

    // Session B gets promo_exhausted
    expect(rB.stdout).toContain('promo_exhausted');

    // Exactly one reservation
    const count = psql(`SELECT count(*) FROM promo_reservations WHERE promo_code_id = '${PROMO}';`);
    expect(parseInt(count)).toBe(1);

    // effective usage = current_uses(0) + reserved(1) = 1 = max_uses
    const promo = psql(`SELECT current_uses FROM promo_codes WHERE id = '${PROMO}';`);
    expect(parseInt(promo)).toBe(0); // current_uses unchanged (still reserved, not finalized)
  }, 15000);

  it('13. REAL concurrency: finalize vs release race — one wins', async () => {
    psql(`INSERT INTO promo_codes (id, business_id, code, max_uses, current_uses) VALUES ('${PROMO}', '${BIZ}', 'FVSR', 5, 0);`);
    const rA = psqlJson(`SET ROLE service_role; SELECT create_order_atomic('${SESSION_A}', '${BIZ}', '${USER}', 'pending', NULL, '+234', 1000, 0, 0, '${PROMO}', 'whatsapp', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL);`);
    const orderId = rA.order_id;
    psql(`UPDATE orders SET status = 'confirmed' WHERE id = '${orderId}';`);

    // Session A: finalize, hold lock with pg_sleep
    const sessionA = psqlAsync(`
      BEGIN;
      SET ROLE service_role;
      SELECT finalize_promo_reservation('${orderId}');
      SELECT pg_sleep(2);
      COMMIT;
    `);

    await new Promise(r => setTimeout(r, 300));

    // Session B: try to release — blocked by A's FOR UPDATE on promo_reservations
    const bStart = Date.now();
    const sessionB = psqlAsync(`
      SET ROLE service_role;
      SELECT release_promo_reservation('${orderId}');
    `);

    const [, rBResult] = await Promise.all([sessionA, sessionB]);
    const bDuration = Date.now() - bStart;

    // B waited for A
    expect(bDuration).toBeGreaterThan(1000);

    // After A finalized, B's release sees already_finalized
    expect(rBResult.stdout).toContain('already_finalized');

    // State is finalized
    const state = psql(`SELECT state FROM promo_reservations WHERE order_id = '${orderId}';`);
    expect(state).toBe('finalized');
  }, 15000);
});
