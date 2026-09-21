/**
 * M392: Inventory reservation capability — hermetic PostgreSQL proof.
 *
 * Covers:
 * - reservation_class + expires_at columns exist
 * - backfill: terminal markers become committed
 * - default prepayment for new unclassified markers
 * - unlimited NULL-stock restoration fix in cancel_stale_order_atomic
 * - unlimited NULL-stock restoration fix in cancel_order_immediate
 * - CHECK constraint enforces valid reservation_class values
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

const BIZ = '00000000-0000-0000-0392-0000000b0001';
const ORDER_CONFIRMED = '00000000-0000-0000-0392-000000010001';
const ORDER_PENDING = '00000000-0000-0000-0392-000000010002';
const ORDER_UNLIMITED = '00000000-0000-0000-0392-000000010003';
const PROD_TRACKED = '00000000-0000-0000-0392-aaa000000001';
const PROD_UNLIMITED = '00000000-0000-0000-0392-aaa000000002';
const VARIANT_TRACKED = '00000000-0000-0000-0392-bbb000000001';
const VARIANT_UNLIMITED = '00000000-0000-0000-0392-bbb000000002';
const PAYMENT_SUCCESS = '00000000-0000-0000-0392-ccc000000001';

describe.skipIf(!canRun)('M392: Inventory reservation capability DB tests', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE order_status AS ENUM ('pending','confirmed','shipped','delivered','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT DEFAULT 'Test'
      );
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        status order_status DEFAULT 'pending',
        total_amount INTEGER DEFAULT 0,
        reference_code TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        order_id UUID REFERENCES orders(id),
        amount INTEGER DEFAULT 0,
        status payment_status DEFAULT 'pending',
        gateway TEXT DEFAULT 'paystack',
        gateway_status TEXT,
        gateway_reference TEXT,
        payment_method TEXT,
        metadata JSONB DEFAULT '{}',
        finalization_processing_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT DEFAULT 'Test',
        price INTEGER DEFAULT 0,
        stock_quantity INTEGER,
        track_inventory BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS product_variants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES products(id),
        label TEXT DEFAULT 'Test',
        price INTEGER DEFAULT 0,
        stock_quantity INTEGER,
        is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID REFERENCES orders(id),
        product_id UUID REFERENCES products(id),
        variant_id UUID,
        quantity INTEGER DEFAULT 1,
        unit_price INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS order_stock_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID,
        order_id UUID NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        item_count INTEGER NOT NULL DEFAULT 0
      );
      ALTER TABLE order_stock_applications ENABLE ROW LEVEL SECURITY;

      CREATE TABLE IF NOT EXISTS promo_reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID,
        state TEXT DEFAULT 'reserved',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Test data
      INSERT INTO businesses (id) VALUES ('${BIZ}') ON CONFLICT DO NOTHING;
      INSERT INTO products (id, business_id, stock_quantity, track_inventory)
        VALUES ('${PROD_TRACKED}', '${BIZ}', 10, true) ON CONFLICT DO NOTHING;
      INSERT INTO products (id, business_id, stock_quantity, track_inventory)
        VALUES ('${PROD_UNLIMITED}', '${BIZ}', NULL, true) ON CONFLICT DO NOTHING;
      INSERT INTO product_variants (id, product_id, stock_quantity)
        VALUES ('${VARIANT_TRACKED}', '${PROD_TRACKED}', 5) ON CONFLICT DO NOTHING;
      INSERT INTO product_variants (id, product_id, stock_quantity)
        VALUES ('${VARIANT_UNLIMITED}', '${PROD_UNLIMITED}', NULL) ON CONFLICT DO NOTHING;
    `);

    // Apply M392
    const migration = readFileSync(
      join(process.cwd(), 'supabase/migrations/392_inventory_reservation_capability.sql'),
      'utf-8',
    );
    psql(migration);
  });

  afterAll(() => {
    try {
      psql(`
        DROP TABLE IF EXISTS promo_reservations CASCADE;
        DROP TABLE IF EXISTS order_stock_applications CASCADE;
        DROP TABLE IF EXISTS order_items CASCADE;
        DROP TABLE IF EXISTS product_variants CASCADE;
        DROP TABLE IF EXISTS products CASCADE;
        DROP TABLE IF EXISTS payments CASCADE;
        DROP TABLE IF EXISTS orders CASCADE;
        DROP TABLE IF EXISTS businesses CASCADE;
        DROP FUNCTION IF EXISTS cancel_stale_order_atomic(UUID) CASCADE;
        DROP FUNCTION IF EXISTS cancel_order_immediate(UUID, TEXT) CASCADE;
      `);
    } catch { /* cleanup best-effort */ }
  });

  // ─── Schema ───

  it('reservation_class column exists with NOT NULL DEFAULT prepayment', () => {
    const result = psql(`
      SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_name = 'order_stock_applications' AND column_name = 'reservation_class'
    `);
    expect(result).toContain('prepayment');
    expect(result).toContain('NO');
  });

  it('expires_at column exists and is nullable', () => {
    const result = psql(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'order_stock_applications' AND column_name = 'expires_at'
    `);
    expect(result).toContain('expires_at');
    expect(result).toContain('YES');
  });

  it('CHECK constraint allows valid classes', () => {
    // Insert a marker with each valid class
    psql(`INSERT INTO orders (id, business_id, status) VALUES ('${ORDER_CONFIRMED}', '${BIZ}', 'confirmed') ON CONFLICT DO NOTHING`);
    psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ('${ORDER_CONFIRMED}', 'committed')`);
    const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ORDER_CONFIRMED}'`);
    expect(cls).toBe('committed');
    psql(`DELETE FROM order_stock_applications WHERE order_id = '${ORDER_CONFIRMED}'`);
  });

  it('CHECK constraint rejects invalid class', () => {
    try {
      psql(`INSERT INTO orders (id, business_id) VALUES (gen_random_uuid(), '${BIZ}') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ((SELECT id FROM orders LIMIT 1), 'invalid_class')`);
      expect.fail('Should have rejected invalid class');
    } catch (e) {
      expect(String(e)).toContain('order_stock_applications_reservation_class_check');
    }
  });

  it('new unclassified marker gets prepayment default', () => {
    psql(`INSERT INTO orders (id, business_id, status) VALUES ('${ORDER_PENDING}', '${BIZ}', 'pending') ON CONFLICT DO NOTHING`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ORDER_PENDING}')`);
    const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ORDER_PENDING}'`);
    expect(cls).toBe('prepayment');
    psql(`DELETE FROM order_stock_applications WHERE order_id = '${ORDER_PENDING}'`);
  });

  // ─── Backfill ───

  it('backfill: terminal order markers are committed', () => {
    // Create a confirmed order with a marker
    const ordId = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'confirmed') RETURNING id`);
    psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ('${ordId}', 'prepayment')`);
    // Run the backfill again
    psql(`
      UPDATE order_stock_applications osa
      SET reservation_class = 'committed', expires_at = NULL
      FROM orders o
      WHERE osa.order_id = o.id
        AND o.status IN ('confirmed', 'shipped', 'delivered')
        AND osa.reservation_class = 'prepayment'
    `);
    const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ordId}'`);
    expect(cls).toBe('committed');
    // Cleanup
    psql(`DELETE FROM order_stock_applications WHERE order_id = '${ordId}'`);
    psql(`DELETE FROM orders WHERE id = '${ordId}'`);
  });

  it('backfill: pending order markers remain prepayment', () => {
    psql(`INSERT INTO orders (id, business_id, status) VALUES ('${ORDER_PENDING}', '${BIZ}', 'pending') ON CONFLICT DO NOTHING`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ORDER_PENDING}')`);
    // Run backfill
    psql(`
      UPDATE order_stock_applications osa
      SET reservation_class = 'committed', expires_at = NULL
      FROM orders o
      WHERE osa.order_id = o.id
        AND o.status IN ('confirmed', 'shipped', 'delivered')
        AND osa.reservation_class = 'prepayment'
    `);
    const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ORDER_PENDING}'`);
    expect(cls).toBe('prepayment');
    psql(`DELETE FROM order_stock_applications WHERE order_id = '${ORDER_PENDING}'`);
  });

  // ─── Unlimited NULL-stock fix: cancel_stale_order_atomic ───

  it('cancel_stale: unlimited NULL product stock stays NULL after cancellation', () => {
    // Create old pending order with unlimited product
    const ordId = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);
    psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ordId}', '${PROD_UNLIMITED}', 3)`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ordId}')`);

    // Verify stock is NULL before
    const before = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_UNLIMITED}'`);
    expect(before).toBe('');  // NULL renders as empty string in psql

    // Cancel
    const result = psql(`SELECT cancel_stale_order_atomic('${ordId}')`);
    const parsed = JSON.parse(result);
    expect(parsed.cancelled).toBe(true);

    // Stock MUST still be NULL
    const after = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_UNLIMITED}'`);
    expect(after).toBe('');  // Still NULL

    // Cleanup
    psql(`DELETE FROM order_items WHERE order_id = '${ordId}'`);
    psql(`DELETE FROM orders WHERE id = '${ordId}'`);
  });

  it('cancel_stale: tracked finite product stock IS restored', () => {
    const ordId = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);
    psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ordId}', '${PROD_TRACKED}', 2)`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ordId}')`);

    // Reduce stock first (simulate decrement)
    psql(`UPDATE products SET stock_quantity = 8 WHERE id = '${PROD_TRACKED}'`);

    const result = psql(`SELECT cancel_stale_order_atomic('${ordId}')`);
    const parsed = JSON.parse(result);
    expect(parsed.cancelled).toBe(true);
    expect(parsed.stock_restored).toBe(true);

    // Stock restored: 8 + 2 = 10
    const after = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_TRACKED}'`);
    expect(after).toBe('10');

    psql(`DELETE FROM order_items WHERE order_id = '${ordId}'`);
    psql(`DELETE FROM orders WHERE id = '${ordId}'`);
  });

  // ─── Unlimited NULL-stock fix: cancel_order_immediate ───

  it('cancel_immediate: unlimited NULL product stock stays NULL', () => {
    const ordId = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
    psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ordId}', '${PROD_UNLIMITED}', 5)`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ordId}')`);

    const result = psql(`SELECT cancel_order_immediate('${ordId}')`);
    const parsed = JSON.parse(result);
    expect(parsed.cancelled).toBe(true);

    const after = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_UNLIMITED}'`);
    expect(after).toBe('');  // Still NULL

    psql(`DELETE FROM order_items WHERE order_id = '${ordId}'`);
    psql(`DELETE FROM orders WHERE id = '${ordId}'`);
  });

  it('cancel_immediate: unlimited NULL variant stock stays NULL', () => {
    const ordId = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
    psql(`INSERT INTO order_items (order_id, product_id, variant_id, quantity) VALUES ('${ordId}', '${PROD_UNLIMITED}', '${VARIANT_UNLIMITED}', 3)`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ordId}')`);

    const result = psql(`SELECT cancel_order_immediate('${ordId}')`);
    const parsed = JSON.parse(result);
    expect(parsed.cancelled).toBe(true);

    const after = psql(`SELECT stock_quantity FROM product_variants WHERE id = '${VARIANT_UNLIMITED}'`);
    expect(after).toBe('');

    psql(`DELETE FROM order_items WHERE order_id = '${ordId}'`);
    psql(`DELETE FROM orders WHERE id = '${ordId}'`);
  });

  it('cancel_immediate: tracked finite variant stock IS restored', () => {
    const ordId = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
    psql(`INSERT INTO order_items (order_id, product_id, variant_id, quantity) VALUES ('${ordId}', '${PROD_TRACKED}', '${VARIANT_TRACKED}', 2)`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ordId}')`);

    psql(`UPDATE product_variants SET stock_quantity = 3 WHERE id = '${VARIANT_TRACKED}'`);

    const result = psql(`SELECT cancel_order_immediate('${ordId}')`);
    const parsed = JSON.parse(result);
    expect(parsed.cancelled).toBe(true);

    const after = psql(`SELECT stock_quantity FROM product_variants WHERE id = '${VARIANT_TRACKED}'`);
    expect(after).toBe('5');  // 3 + 2

    psql(`UPDATE product_variants SET stock_quantity = 5 WHERE id = '${VARIANT_TRACKED}'`);
    psql(`DELETE FROM order_items WHERE order_id = '${ordId}'`);
    psql(`DELETE FROM orders WHERE id = '${ordId}'`);
  });

  // ─── Cancel_stale with successful payment fence ───

  it('cancel_stale: refuses when successful payment exists', () => {
    const ordId = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);
    psql(`INSERT INTO payments (id, order_id, status, gateway_reference) VALUES ('${PAYMENT_SUCCESS}', '${ordId}', 'success', 'test-ref-' || gen_random_uuid())`);

    const result = psql(`SELECT cancel_stale_order_atomic('${ordId}')`);
    const parsed = JSON.parse(result);
    expect(parsed.cancelled).toBe(false);
    expect(parsed.reason).toBe('has_successful_payment');

    psql(`DELETE FROM payments WHERE id = '${PAYMENT_SUCCESS}'`);
    psql(`DELETE FROM orders WHERE id = '${ordId}'`);
  });

  // ─── Cancel without marker ───

  it('cancel_stale: no marker → no stock restoration', () => {
    const ordId = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);

    const result = psql(`SELECT cancel_stale_order_atomic('${ordId}')`);
    const parsed = JSON.parse(result);
    expect(parsed.cancelled).toBe(true);
    expect(parsed.stock_restored).toBe(false);

    psql(`DELETE FROM orders WHERE id = '${ordId}'`);
  });
});
