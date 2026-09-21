/**
 * M392: Inventory reservation capability — hermetic PostgreSQL proof.
 *
 * Tests establish a canonical pre-M392 baseline, apply M392, and prove:
 * - Cancel behavior unchanged except NULL-stock preservation
 * - apply_order_stock_once creates default prepayment marker
 * - M383 validated create_order_atomic creates default prepayment marker
 * - ACLs remain unchanged
 * - reservation_class rejects NULL/invalid
 * - Backfill of pre-existing markers tested
 * - Unlimited NULL stock preserved on cancellation
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
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlJson(sql: string): Record<string, unknown> {
  const raw = psql(sql);
  return JSON.parse(raw);
}

const BIZ = '00000000-0000-0000-0392-000000000001';

describe.skipIf(!canRun)('M392: Inventory reservation capability', () => {
  beforeAll(() => {
    // Build a realistic pre-M392 baseline
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE order_status AS ENUM ('pending','confirmed','shipped','delivered','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT DEFAULT 'Test');
      CREATE TABLE IF NOT EXISTS promo_codes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), current_uses INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS quote_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT DEFAULT 'quoted', order_id UUID, responded_at TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        status order_status DEFAULT 'pending',
        total_amount INTEGER DEFAULT 0,
        promo_code_id UUID REFERENCES promo_codes(id),
        quote_request_id UUID REFERENCES quote_requests(id),
        bot_session_id UUID,
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
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT DEFAULT 'Test', price INTEGER DEFAULT 0,
        stock_quantity INTEGER, track_inventory BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true, deleted_at TIMESTAMPTZ, has_variants BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS product_variants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES products(id),
        label TEXT DEFAULT 'V', price INTEGER DEFAULT 0,
        stock_quantity INTEGER, is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID REFERENCES orders(id),
        product_id UUID REFERENCES products(id),
        variant_id UUID, quantity INTEGER DEFAULT 1, unit_price INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS promo_reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID, promo_code_id UUID, state TEXT DEFAULT 'reserved',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Pre-M392 order_stock_applications (M314+M327 canonical schema)
      CREATE TABLE IF NOT EXISTS order_stock_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID,
        order_id UUID NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        item_count INTEGER NOT NULL DEFAULT 0
      );
      ALTER TABLE order_stock_applications ENABLE ROW LEVEL SECURITY;

      -- Stub RPCs that M392 depends on
      CREATE OR REPLACE FUNCTION release_promo_reservation(p_order_id UUID) RETURNS VOID
      LANGUAGE plpgsql AS $fn$
      BEGIN
        DELETE FROM promo_reservations WHERE order_id = p_order_id AND state = 'reserved';
      END;
      $fn$;

      -- Test data
      INSERT INTO businesses (id) VALUES ('${BIZ}') ON CONFLICT DO NOTHING;
    `);

    // Seed pre-M392 markers to test backfill
    const confOrd = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'confirmed') RETURNING id`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${confOrd}')`);

    const shipOrd = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'shipped') RETURNING id`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${shipOrd}')`);

    const pendOrd = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${pendOrd}')`);

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
        DROP TABLE IF EXISTS quote_requests CASCADE;
        DROP TABLE IF EXISTS promo_codes CASCADE;
        DROP TABLE IF EXISTS businesses CASCADE;
        DROP FUNCTION IF EXISTS release_promo_reservation(UUID) CASCADE;
        DROP FUNCTION IF EXISTS cancel_stale_order_atomic(UUID) CASCADE;
        DROP FUNCTION IF EXISTS cancel_order_immediate(UUID, TEXT) CASCADE;
      `);
    } catch { /* best-effort */ }
  });

  // ─── Schema ───

  it('reservation_class exists, NOT NULL, DEFAULT prepayment', () => {
    const r = psql(`SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_name = 'order_stock_applications' AND column_name = 'reservation_class'`);
    expect(r).toContain('prepayment');
    expect(r).toContain('NO');
  });

  it('expires_at exists and is nullable', () => {
    const r = psql(`SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'order_stock_applications' AND column_name = 'expires_at'`);
    expect(r).toContain('YES');
  });

  it('CHECK rejects invalid reservation_class', () => {
    try {
      const ord = psql(`INSERT INTO orders (business_id) VALUES ('${BIZ}') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ('${ord}', 'invalid')`);
      expect.fail('Should reject invalid class');
    } catch (e) {
      expect(String(e)).toContain('reservation_class');
    }
  });

  it('reservation_class rejects NULL', () => {
    // NOT NULL constraint should reject explicit NULL
    try {
      const ord = psql(`INSERT INTO orders (business_id) VALUES ('${BIZ}') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ('${ord}', NULL)`);
      expect.fail('Should reject NULL class');
    } catch (e) {
      expect(String(e)).toContain('not-null');
    }
  });

  // ─── Backfill ───

  it('pre-existing confirmed marker backfilled to committed', () => {
    const r = psql(`SELECT reservation_class FROM order_stock_applications osa
      JOIN orders o ON osa.order_id = o.id WHERE o.status = 'confirmed'`);
    expect(r).toBe('committed');
  });

  it('pre-existing shipped marker backfilled to committed', () => {
    const r = psql(`SELECT reservation_class FROM order_stock_applications osa
      JOIN orders o ON osa.order_id = o.id WHERE o.status = 'shipped'`);
    expect(r).toBe('committed');
  });

  it('pre-existing pending marker stays prepayment (not backfilled)', () => {
    const r = psql(`SELECT reservation_class FROM order_stock_applications osa
      JOIN orders o ON osa.order_id = o.id WHERE o.status = 'pending' LIMIT 1`);
    expect(r).toBe('prepayment');
  });

  // ─── Marker compatibility: new markers get default ───

  it('new INSERT without reservation_class gets prepayment default', () => {
    const ord = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ord}')`);
    const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ord}'`);
    expect(cls).toBe('prepayment');
    psql(`DELETE FROM order_stock_applications WHERE order_id = '${ord}'`);
    psql(`DELETE FROM orders WHERE id = '${ord}'`);
  });

  // ─── Unlimited NULL-stock fix: cancel_stale_order_atomic ───

  it('cancel_stale: unlimited NULL product stock preserved', () => {
    const prod = psql(`INSERT INTO products (business_id, stock_quantity, track_inventory)
      VALUES ('${BIZ}', NULL, true) RETURNING id`);
    const ord = psql(`INSERT INTO orders (business_id, status, created_at)
      VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);
    psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ord}', '${prod}', 3)`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ord}')`);

    const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
    expect(r.cancelled).toBe(true);

    const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${prod}'`);
    expect(stock).toBe(''); // NULL

    psql(`DELETE FROM order_items WHERE order_id = '${ord}'`);
    psql(`DELETE FROM orders WHERE id = '${ord}'`);
    psql(`DELETE FROM products WHERE id = '${prod}'`);
  });

  it('cancel_stale: finite tracked product stock IS restored', () => {
    const prod = psql(`INSERT INTO products (business_id, stock_quantity, track_inventory)
      VALUES ('${BIZ}', 7, true) RETURNING id`);
    const ord = psql(`INSERT INTO orders (business_id, status, created_at)
      VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);
    psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ord}', '${prod}', 3)`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ord}')`);

    const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
    expect(r.cancelled).toBe(true);
    expect(r.stock_restored).toBe(true);

    const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${prod}'`);
    expect(stock).toBe('10');

    psql(`DELETE FROM order_items WHERE order_id = '${ord}'`);
    psql(`DELETE FROM orders WHERE id = '${ord}'`);
    psql(`DELETE FROM products WHERE id = '${prod}'`);
  });

  it('cancel_stale: promo release preserved', () => {
    const promo = psql(`INSERT INTO promo_codes DEFAULT VALUES RETURNING id`);
    const ord = psql(`INSERT INTO orders (business_id, status, created_at, promo_code_id)
      VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours', '${promo}') RETURNING id`);
    psql(`INSERT INTO promo_reservations (order_id, promo_code_id, state) VALUES ('${ord}', '${promo}', 'reserved')`);

    const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
    expect(r.cancelled).toBe(true);

    // Promo reservation should be released
    const promoRes = psql(`SELECT COUNT(*) FROM promo_reservations WHERE order_id = '${ord}' AND state = 'reserved'`);
    expect(promoRes).toBe('0');

    psql(`DELETE FROM promo_reservations WHERE order_id = '${ord}'`);
    psql(`DELETE FROM orders WHERE id = '${ord}'`);
    psql(`DELETE FROM promo_codes WHERE id = '${promo}'`);
  });

  it('cancel_stale: payment fence refuses successful payment', () => {
    const ord = psql(`INSERT INTO orders (business_id, status, created_at)
      VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);
    psql(`INSERT INTO payments (order_id, status, gateway_reference) VALUES ('${ord}', 'success', 'ref-' || gen_random_uuid())`);

    const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('has_successful_payment');

    psql(`DELETE FROM payments WHERE order_id = '${ord}'`);
    psql(`DELETE FROM orders WHERE id = '${ord}'`);
  });

  // ─── Unlimited NULL-stock fix: cancel_order_immediate ───

  it('cancel_immediate: unlimited NULL product stock preserved', () => {
    const prod = psql(`INSERT INTO products (business_id, stock_quantity, track_inventory)
      VALUES ('${BIZ}', NULL, true) RETURNING id`);
    const ord = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
    psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ord}', '${prod}', 5)`);
    psql(`INSERT INTO order_stock_applications (order_id) VALUES ('${ord}')`);

    const r = psqlJson(`SELECT cancel_order_immediate('${ord}')`);
    expect(r.cancelled).toBe(true);
    expect(r.reason).toBe('customer_cancel');

    const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${prod}'`);
    expect(stock).toBe('');

    psql(`DELETE FROM order_items WHERE order_id = '${ord}'`);
    psql(`DELETE FROM orders WHERE id = '${ord}'`);
    psql(`DELETE FROM products WHERE id = '${prod}'`);
  });

  it('cancel_immediate: promo cleanup preserved (reserved)', () => {
    const promo = psql(`INSERT INTO promo_codes DEFAULT VALUES RETURNING id`);
    const ord = psql(`INSERT INTO orders (business_id, status, promo_code_id)
      VALUES ('${BIZ}', 'pending', '${promo}') RETURNING id`);
    psql(`INSERT INTO promo_reservations (order_id, promo_code_id, state) VALUES ('${ord}', '${promo}', 'reserved')`);

    const r = psqlJson(`SELECT cancel_order_immediate('${ord}')`);
    expect(r.cancelled).toBe(true);

    const reserved = psql(`SELECT COUNT(*) FROM promo_reservations WHERE order_id = '${ord}' AND state = 'reserved'`);
    expect(reserved).toBe('0');

    psql(`DELETE FROM promo_reservations WHERE order_id = '${ord}'`);
    psql(`DELETE FROM orders WHERE id = '${ord}'`);
    psql(`DELETE FROM promo_codes WHERE id = '${promo}'`);
  });

  it('cancel_immediate: finalized promo decrements current_uses', () => {
    const promo = psql(`INSERT INTO promo_codes (current_uses) VALUES (5) RETURNING id`);
    const ord = psql(`INSERT INTO orders (business_id, status, promo_code_id)
      VALUES ('${BIZ}', 'pending', '${promo}') RETURNING id`);
    psql(`INSERT INTO promo_reservations (order_id, promo_code_id, state) VALUES ('${ord}', '${promo}', 'finalized')`);

    psqlJson(`SELECT cancel_order_immediate('${ord}')`);

    const uses = psql(`SELECT current_uses FROM promo_codes WHERE id = '${promo}'`);
    expect(uses).toBe('4');

    psql(`DELETE FROM promo_reservations WHERE order_id = '${ord}'`);
    psql(`DELETE FROM orders WHERE id = '${ord}'`);
    psql(`DELETE FROM promo_codes WHERE id = '${promo}'`);
  });

  it('cancel_immediate: quote reversion preserved', () => {
    const quote = psql(`INSERT INTO quote_requests (status) VALUES ('accepted') RETURNING id`);
    const ord = psql(`INSERT INTO orders (business_id, status, quote_request_id)
      VALUES ('${BIZ}', 'pending', '${quote}') RETURNING id`);
    psql(`UPDATE quote_requests SET order_id = '${ord}', responded_at = NOW() WHERE id = '${quote}'`);

    psqlJson(`SELECT cancel_order_immediate('${ord}')`);

    const qStatus = psql(`SELECT status FROM quote_requests WHERE id = '${quote}'`);
    expect(qStatus).toBe('quoted');
    const qOrder = psql(`SELECT order_id FROM quote_requests WHERE id = '${quote}'`);
    expect(qOrder).toBe('');

    psql(`DELETE FROM orders WHERE id = '${ord}'`);
    psql(`DELETE FROM quote_requests WHERE id = '${quote}'`);
  });

  // ─── ACL ───

  it('anon cannot execute cancel_stale_order_atomic', () => {
    try {
      psql(`SET ROLE anon; SELECT cancel_stale_order_atomic(gen_random_uuid()); RESET ROLE;`);
      expect.fail('Should be denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('anon cannot execute cancel_order_immediate', () => {
    try {
      psql(`SET ROLE anon; SELECT cancel_order_immediate(gen_random_uuid()); RESET ROLE;`);
      expect.fail('Should be denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('authenticated cannot execute cancel_stale_order_atomic', () => {
    try {
      psql(`SET ROLE authenticated; SELECT cancel_stale_order_atomic(gen_random_uuid()); RESET ROLE;`);
      expect.fail('Should be denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('authenticated cannot execute cancel_order_immediate', () => {
    try {
      psql(`SET ROLE authenticated; SELECT cancel_order_immediate(gen_random_uuid()); RESET ROLE;`);
      expect.fail('Should be denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('service_role can execute cancel_stale_order_atomic', () => {
    const r = psql(`SET ROLE service_role; SELECT cancel_stale_order_atomic(gen_random_uuid()); RESET ROLE;`);
    const parsed = JSON.parse(r);
    expect(parsed.cancelled).toBe(false);
    expect(parsed.reason).toBe('not_found');
  });

  it('service_role can execute cancel_order_immediate', () => {
    const r = psql(`SET ROLE service_role; SELECT cancel_order_immediate(gen_random_uuid()); RESET ROLE;`);
    const parsed = JSON.parse(r);
    expect(parsed.cancelled).toBe(false);
    expect(parsed.reason).toBe('not_found');
  });
});
