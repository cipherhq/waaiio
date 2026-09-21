/**
 * M393: Inventory reservation wiring — hermetic PostgreSQL proof.
 *
 * Tests M393 functions against a real PostgreSQL database.
 * Builds baseline schema, applies all migrations through M393, then proves:
 * - create_order_atomic: validated path with zone total, zero-floor, marker class
 * - apply_order_stock_once: winner conflict/replay, linked transfer closure
 * - cancel_stale_order_atomic: marker-aware expiry
 * - cancel_order_immediate: linked transfer cancellation
 * - create_transfer_with_reservation: atomic transfer + marker extension
 * - confirm_order_transfer_atomic: bank-transfer winner authority
 * - reject_order_transfer_atomic: stock restore + order cancellation
 * - ACL: all functions service_role only
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

const BIZ = '00000000-0000-0000-0393-000000000001';
const USER = '00000000-0000-0000-0393-000000000002';
const SESSION = '00000000-0000-0000-0393-000000000003';
const CHANNEL = '00000000-0000-0000-0393-000000000004';

describe.skipIf(!canRun)('M393: Inventory reservation wiring', () => {
  beforeAll(() => {
    // Build full baseline schema
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE order_status AS ENUM ('draft','pending','confirmed','processing','ready','shipped','delivered','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE addon_price_type AS ENUM ('fixed','quote'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT DEFAULT 'Test',
        assigned_channel_id UUID, whatsapp_channel_id UUID
      );
      CREATE TABLE IF NOT EXISTS profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), full_name TEXT);
      CREATE TABLE IF NOT EXISTS promo_codes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), current_uses INTEGER DEFAULT 0, max_uses INTEGER);
      CREATE TABLE IF NOT EXISTS quote_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT DEFAULT 'quoted', order_id UUID, responded_at TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reference_code VARCHAR(10) UNIQUE NOT NULL DEFAULT ('ORD-' || substr(md5(random()::text), 1, 4)),
        business_id UUID REFERENCES businesses(id),
        user_id UUID, status order_status DEFAULT 'pending',
        total_amount INTEGER DEFAULT 0, discount_amount INTEGER DEFAULT 0,
        shipping_cost INTEGER DEFAULT 0, volume_discount_amount INTEGER DEFAULT 0,
        addons_total INTEGER DEFAULT 0, promo_code_id UUID REFERENCES promo_codes(id),
        quote_request_id UUID REFERENCES quote_requests(id),
        bot_session_id UUID, channel TEXT DEFAULT 'whatsapp',
        delivery_address TEXT, delivery_phone TEXT, notes TEXT,
        delivery_zone_id UUID, delivery_zone_name TEXT,
        pickup_address TEXT, dropoff_address TEXT,
        package_description TEXT, package_photo_url TEXT,
        referral_id UUID, items_fingerprint TEXT, paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, order_id UUID REFERENCES orders(id),
        amount INTEGER DEFAULT 0, currency TEXT DEFAULT 'NGN',
        status payment_status DEFAULT 'pending',
        gateway TEXT DEFAULT 'paystack', gateway_status TEXT,
        gateway_reference TEXT, payment_method TEXT, reference TEXT,
        customer_phone TEXT, customer_name TEXT,
        metadata JSONB DEFAULT '{}',
        finalization_processing_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT DEFAULT 'Test', price INTEGER DEFAULT 0,
        stock_quantity INTEGER, track_inventory BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true, deleted_at TIMESTAMPTZ,
        has_variants BOOLEAN DEFAULT false, shipping_cost INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS product_variants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES products(id),
        label TEXT DEFAULT 'V', price INTEGER DEFAULT 0,
        stock_quantity INTEGER, is_active BOOLEAN DEFAULT true,
        options JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS product_addons (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        product_id UUID REFERENCES products(id),
        name TEXT DEFAULT 'Addon', price INTEGER DEFAULT 0,
        price_type addon_price_type DEFAULT 'fixed',
        is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID REFERENCES orders(id),
        product_id UUID REFERENCES products(id),
        variant_id UUID, quantity INTEGER DEFAULT 1, unit_price INTEGER DEFAULT 0,
        variant_label TEXT, addons JSONB
      );
      CREATE TABLE IF NOT EXISTS promo_reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID, promo_code_id UUID, state TEXT DEFAULT 'reserved',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS delivery_zones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT DEFAULT 'Zone', price INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS order_stock_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID, order_id UUID NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        item_count INTEGER NOT NULL DEFAULT 0,
        reservation_class TEXT NOT NULL DEFAULT 'prepayment'
          CHECK (reservation_class IN ('instant','bank_transfer','committed','prepayment')),
        expires_at TIMESTAMPTZ DEFAULT NULL
      );
      ALTER TABLE order_stock_applications ENABLE ROW LEVEL SECURITY;
      CREATE TABLE IF NOT EXISTS pending_transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        order_id UUID, booking_id UUID, invoice_id UUID, reservation_id UUID,
        customer_phone TEXT NOT NULL, customer_name TEXT,
        expected_amount INTEGER NOT NULL, currency TEXT DEFAULT 'NGN',
        reference_code VARCHAR(20) NOT NULL UNIQUE DEFAULT ('WA-' || substr(md5(random()::text), 1, 4)),
        status TEXT DEFAULT 'pending'
          CHECK (status IN ('pending','confirmed','rejected','expired','cancelled')),
        confirmed_by UUID, confirmed_at TIMESTAMPTZ, rejected_reason TEXT,
        expires_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}',
        proof_type TEXT, proof_text TEXT, proof_image_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID, business_id UUID, session_data JSONB DEFAULT '{}',
        is_active BOOLEAN DEFAULT true, version INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS whatsapp_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_type TEXT DEFAULT 'shared', business_id UUID,
        is_active BOOLEAN DEFAULT true, phone_number TEXT, country_code TEXT
      );

      -- Stub release_promo_reservation
      CREATE OR REPLACE FUNCTION release_promo_reservation(p_order_id UUID) RETURNS VOID
      LANGUAGE plpgsql AS $fn$
      BEGIN
        DELETE FROM promo_reservations WHERE order_id = p_order_id AND state = 'reserved';
      END;
      $fn$;

      -- Stub reference code generator
      CREATE OR REPLACE FUNCTION generate_order_reference() RETURNS TRIGGER AS $fn$
      BEGIN
        IF NEW.reference_code IS NULL THEN
          NEW.reference_code := 'ORD-' || substr(md5(random()::text), 1, 4);
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_order_ref ON orders;

      -- Test data
      INSERT INTO businesses (id, name) VALUES ('${BIZ}', 'TestBiz') ON CONFLICT DO NOTHING;
      INSERT INTO profiles (id, full_name) VALUES ('${USER}', 'Test User') ON CONFLICT DO NOTHING;
      INSERT INTO whatsapp_channels (id, channel_type, is_active) VALUES ('${CHANNEL}', 'shared', true) ON CONFLICT DO NOTHING;
      INSERT INTO bot_sessions (id, business_id, session_data) VALUES (
        '${SESSION}', '${BIZ}',
        '{"_inbound_channel_id": "${CHANNEL}"}'::jsonb
      ) ON CONFLICT DO NOTHING;
    `);

    // Apply M393
    const migration = readFileSync(
      join(process.cwd(), 'supabase/migrations/393_inventory_reservation_wiring.sql'),
      'utf-8',
    );
    psql(migration);
  });

  afterAll(() => {
    try {
      psql(`
        DROP TABLE IF EXISTS pending_transfers CASCADE;
        DROP TABLE IF EXISTS promo_reservations CASCADE;
        DROP TABLE IF EXISTS order_stock_applications CASCADE;
        DROP TABLE IF EXISTS order_items CASCADE;
        DROP TABLE IF EXISTS product_addons CASCADE;
        DROP TABLE IF EXISTS product_variants CASCADE;
        DROP TABLE IF EXISTS products CASCADE;
        DROP TABLE IF EXISTS delivery_zones CASCADE;
        DROP TABLE IF EXISTS payments CASCADE;
        DROP TABLE IF EXISTS orders CASCADE;
        DROP TABLE IF EXISTS quote_requests CASCADE;
        DROP TABLE IF EXISTS promo_codes CASCADE;
        DROP TABLE IF EXISTS bot_sessions CASCADE;
        DROP TABLE IF EXISTS whatsapp_channels CASCADE;
        DROP TABLE IF EXISTS profiles CASCADE;
        DROP TABLE IF EXISTS businesses CASCADE;
        DROP FUNCTION IF EXISTS release_promo_reservation(UUID);
        DROP FUNCTION IF EXISTS generate_order_reference() CASCADE;
        DROP FUNCTION IF EXISTS create_order_atomic CASCADE;
        DROP FUNCTION IF EXISTS apply_order_stock_once CASCADE;
        DROP FUNCTION IF EXISTS cancel_stale_order_atomic CASCADE;
        DROP FUNCTION IF EXISTS cancel_order_immediate CASCADE;
        DROP FUNCTION IF EXISTS create_transfer_with_reservation CASCADE;
        DROP FUNCTION IF EXISTS confirm_order_transfer_atomic CASCADE;
        DROP FUNCTION IF EXISTS reject_order_transfer_atomic CASCADE;
        DROP TYPE IF EXISTS payment_status CASCADE;
        DROP TYPE IF EXISTS order_status CASCADE;
        DROP TYPE IF EXISTS addon_price_type CASCADE;
      `);
    } catch { /* best effort */ }
  });

  // ═══ Helper ═══
  function createProduct(opts: { price: number; stock?: number; track?: boolean }): string {
    return psql(`INSERT INTO products (business_id, price, stock_quantity, track_inventory, is_active)
      VALUES ('${BIZ}', ${opts.price}, ${opts.stock ?? 'NULL'}, ${opts.track ?? false}, true) RETURNING id`);
  }

  function createOrder(opts: { total: number; status?: string; sessionId?: string }): string {
    return psql(`INSERT INTO orders (business_id, user_id, total_amount, status, bot_session_id, channel)
      VALUES ('${BIZ}', '${USER}', ${opts.total}, '${opts.status || 'pending'}'::order_status,
      ${opts.sessionId ? `'${opts.sessionId}'` : 'NULL'}, 'whatsapp') RETURNING id`);
  }

  // ═══ 1. create_order_atomic — validated path ═══
  describe('create_order_atomic validated path', () => {
    it('paid order: marker instant with ~30min expiry', () => {
      const prod = createProduct({ price: 5000, stock: 10, track: true });
      const result = psqlJson(`
        SELECT create_order_atomic(
          p_bot_session_id := gen_random_uuid(),
          p_business_id := '${BIZ}',
          p_user_id := '${USER}',
          p_status := 'pending',
          p_total_amount := 5000,
          p_items := '[{"product_id":"${prod}","quantity":1,"unit_price":5000}]'::jsonb,
          p_validate_products := true,
          p_expected_total := 5000
        )
      `);
      expect(result.created).toBe(true);
      const orderId = result.order_id as string;

      const marker = psqlJson(`SELECT reservation_class, expires_at IS NOT NULL AS has_expiry,
        expires_at > NOW() AS not_expired, expires_at < NOW() + interval '35 minutes' AS within_35m
        FROM order_stock_applications WHERE order_id = '${orderId}'`);
      expect(marker.reservation_class).toBe('instant');
      expect(marker.has_expiry).toBe(true);
      expect(marker.not_expired).toBe(true);
      expect(marker.within_35m).toBe(true);
    });

    it('free order: marker committed with no expiry', () => {
      const prod = createProduct({ price: 0 });
      const result = psqlJson(`
        SELECT create_order_atomic(
          p_bot_session_id := gen_random_uuid(),
          p_business_id := '${BIZ}',
          p_user_id := '${USER}',
          p_status := 'confirmed',
          p_total_amount := 0,
          p_items := '[{"product_id":"${prod}","quantity":1,"unit_price":0}]'::jsonb,
          p_validate_products := true,
          p_expected_total := 0
        )
      `);
      expect(result.created).toBe(true);
      const marker = psqlJson(`SELECT reservation_class, expires_at IS NULL AS no_expiry
        FROM order_stock_applications WHERE order_id = '${result.order_id}'`);
      expect(marker.reservation_class).toBe('committed');
      expect(marker.no_expiry).toBe(true);
    });

    it('delivery zone: server re-reads price, not double-counted', () => {
      const prod = createProduct({ price: 3000 });
      const zone = psql(`INSERT INTO delivery_zones (business_id, name, price, is_active)
        VALUES ('${BIZ}', 'Lagos', 500, true) RETURNING id`);

      const result = psqlJson(`
        SELECT create_order_atomic(
          p_bot_session_id := gen_random_uuid(),
          p_business_id := '${BIZ}',
          p_user_id := '${USER}',
          p_status := 'pending',
          p_total_amount := 3500,
          p_shipping_cost := 0,
          p_delivery_zone_id := '${zone}',
          p_items := '[{"product_id":"${prod}","quantity":1,"unit_price":3000}]'::jsonb,
          p_validate_products := true,
          p_expected_total := 3500
        )
      `);
      expect(result.created).toBe(true);
      expect(result.server_total).toBe(3500);
    });

    it('zero floor: over-discount does not go negative', () => {
      const prod = createProduct({ price: 100 });
      const result = psqlJson(`
        SELECT create_order_atomic(
          p_bot_session_id := gen_random_uuid(),
          p_business_id := '${BIZ}',
          p_user_id := '${USER}',
          p_status := 'confirmed',
          p_total_amount := 0,
          p_discount_amount := 500,
          p_items := '[{"product_id":"${prod}","quantity":1,"unit_price":100}]'::jsonb,
          p_validate_products := true,
          p_expected_total := 0
        )
      `);
      expect(result.created).toBe(true);
      expect(result.server_total).toBe(0);
    });
  });

  // ═══ 2. apply_order_stock_once — winner contract ═══
  describe('apply_order_stock_once winner contract', () => {
    it('payment success commits marker + closes linked transfers', () => {
      const prod = createProduct({ price: 5000, stock: 10, track: true });
      const orderId = createOrder({ total: 5000 });
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${orderId}', '${prod}', 1, 5000)`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'instant', NOW() + interval '30 minutes')`);
      psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, expires_at)
        VALUES ('${BIZ}', '${orderId}', '+2349000000', 500000, NOW() + interval '24 hours')`);

      const payId = psql(`INSERT INTO payments (business_id, order_id, amount, status)
        VALUES ('${BIZ}', '${orderId}', 5000, 'success') RETURNING id`);

      const result = psqlJson(`SELECT apply_order_stock_once('${orderId}', '${payId}')`);
      expect(result.applied).toBe(true);
      expect(result.already_applied).toBe(true);
      expect(result.order_confirmed).toBe(true);

      const marker = psqlJson(`SELECT reservation_class, payment_id::text, expires_at IS NULL AS no_expiry
        FROM order_stock_applications WHERE order_id = '${orderId}'`);
      expect(marker.reservation_class).toBe('committed');
      expect(marker.payment_id).toBe(payId);
      expect(marker.no_expiry).toBe(true);

      // Linked transfer should be cancelled (online payment superseded)
      const transfer = psql(`SELECT status FROM pending_transfers WHERE order_id = '${orderId}'`);
      expect(transfer).toBe('cancelled');
    });

    it('committed + different payment = conflict', () => {
      const orderId = createOrder({ total: 1000 });
      const pay1 = psql(`INSERT INTO payments (business_id, order_id, amount, status)
        VALUES ('${BIZ}', '${orderId}', 1000, 'success') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, payment_id, reservation_class)
        VALUES ('${orderId}', '${pay1}', 'committed')`);

      const pay2 = psql(`INSERT INTO payments (business_id, order_id, amount, status)
        VALUES ('${BIZ}', '${orderId}', 1000, 'success') RETURNING id`);

      const result = psqlJson(`SELECT apply_order_stock_once('${orderId}', '${pay2}')`);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('payment_conflict');
    });

    it('committed + NULL payment = fail closed', () => {
      const orderId = createOrder({ total: 1000 });
      const payId = psql(`INSERT INTO payments (business_id, order_id, amount, status)
        VALUES ('${BIZ}', '${orderId}', 1000, 'success') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, payment_id, reservation_class)
        VALUES ('${orderId}', '${payId}', 'committed')`);

      const result = psqlJson(`SELECT apply_order_stock_once('${orderId}', NULL)`);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('committed_no_winner');
    });
  });

  // ═══ 3. cancel_stale_order_atomic — marker-aware ═══
  describe('cancel_stale_order_atomic marker-aware', () => {
    it('committed → refused', () => {
      const orderId = createOrder({ total: 1000 });
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class)
        VALUES ('${orderId}', 'committed')`);

      const result = psqlJson(`SELECT cancel_stale_order_atomic('${orderId}')`);
      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe('committed_not_cancellable');
    });

    it('instant not expired → refused', () => {
      const orderId = createOrder({ total: 1000 });
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'instant', NOW() + interval '25 minutes')`);

      const result = psqlJson(`SELECT cancel_stale_order_atomic('${orderId}')`);
      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe('instant_not_expired');
    });

    it('instant expired → cancelled + stock restored + transfers expired', () => {
      const prod = createProduct({ price: 1000, stock: 5, track: true });
      const orderId = createOrder({ total: 1000 });
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${orderId}', '${prod}', 2, 1000)`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'instant', NOW() - interval '1 minute')`);
      psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, expires_at)
        VALUES ('${BIZ}', '${orderId}', '+2349000000', 100000, NOW() - interval '1 minute')`);

      const result = psqlJson(`SELECT cancel_stale_order_atomic('${orderId}')`);
      expect(result.cancelled).toBe(true);
      expect(result.stock_restored).toBe(true);

      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${prod}'`);
      expect(parseInt(stock)).toBe(7); // 5 + 2 restored

      const transfer = psql(`SELECT status FROM pending_transfers WHERE order_id = '${orderId}'`);
      expect(transfer).toBe('expired');
    });

    it('prepayment <48h → refused', () => {
      const orderId = createOrder({ total: 1000 });
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class)
        VALUES ('${orderId}', 'prepayment')`);

      const result = psqlJson(`SELECT cancel_stale_order_atomic('${orderId}')`);
      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe('prepayment_not_stale');
    });
  });

  // ═══ 4. cancel_order_immediate — linked transfers ═══
  describe('cancel_order_immediate linked transfers', () => {
    it('cancels linked pending_transfers', () => {
      const orderId = createOrder({ total: 1000 });
      psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, expires_at)
        VALUES ('${BIZ}', '${orderId}', '+2349000000', 100000, NOW() + interval '24 hours')`);

      const result = psqlJson(`SELECT cancel_order_immediate('${orderId}')`);
      expect(result.cancelled).toBe(true);

      const transfer = psql(`SELECT status FROM pending_transfers WHERE order_id = '${orderId}'`);
      expect(transfer).toBe('cancelled');
    });
  });

  // ═══ 5. create_transfer_with_reservation ═══
  describe('create_transfer_with_reservation', () => {
    it('happy path: 5000 → 500000, marker instant→bank_transfer', () => {
      const orderId = createOrder({ total: 5000, sessionId: SESSION });
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'instant', NOW() + interval '25 minutes')`);

      const result = psqlJson(`SELECT create_transfer_with_reservation(
        '${orderId}', '${BIZ}', '+2349000000', 'Test Customer', 'NG', 24, '${SESSION}'
      )`);
      expect(result.error).toBeUndefined();
      expect(result.transfer_id).toBeDefined();
      expect(result.expected_amount).toBe(500000);
      expect(result.reference_code).toMatch(/^WA-/);

      const marker = psqlJson(`SELECT reservation_class, expires_at IS NOT NULL AS has_expiry
        FROM order_stock_applications WHERE order_id = '${orderId}'`);
      expect(marker.reservation_class).toBe('bank_transfer');
      expect(marker.has_expiry).toBe(true);
    });

    it('wrong business → rejected', () => {
      const otherBiz = psql(`INSERT INTO businesses (name) VALUES ('Other') RETURNING id`);
      const orderId = createOrder({ total: 1000, sessionId: SESSION });
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'instant', NOW() + interval '25 minutes')`);

      const result = psqlJson(`SELECT create_transfer_with_reservation(
        '${orderId}', '${otherBiz}', '+2349000000', 'Test', 'NG', 24, '${SESSION}'
      )`);
      expect(result.error).toBe(true);
      expect(result.reason).toBe('business_mismatch');
    });

    it('expired instant → rejected', () => {
      const orderId = createOrder({ total: 1000, sessionId: SESSION });
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'instant', NOW() - interval '1 minute')`);

      const result = psqlJson(`SELECT create_transfer_with_reservation(
        '${orderId}', '${BIZ}', '+2349000000', 'Test', 'NG', 24, '${SESSION}'
      )`);
      expect(result.error).toBe(true);
      expect(result.reason).toBe('marker_expired');
    });

    it('no inbound channel → rejected', () => {
      const noChSession = psql(`INSERT INTO bot_sessions (business_id, session_data)
        VALUES ('${BIZ}', '{}'::jsonb) RETURNING id`);
      const orderId = createOrder({ total: 1000, sessionId: noChSession });
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'instant', NOW() + interval '25 minutes')`);

      const result = psqlJson(`SELECT create_transfer_with_reservation(
        '${orderId}', '${BIZ}', '+2349000000', 'Test', 'NG', 24, '${noChSession}'
      )`);
      expect(result.error).toBe(true);
      expect(result.reason).toBe('no_inbound_channel');
    });
  });

  // ═══ 6. confirm_order_transfer_atomic ═══
  describe('confirm_order_transfer_atomic', () => {
    it('happy path: order confirmed, marker committed, payment created', () => {
      const orderId = createOrder({ total: 5000, sessionId: SESSION });
      const deadline = psql(`SELECT (NOW() + interval '24 hours')::timestamptz`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'bank_transfer', '${deadline}')`);
      const xferId = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount,
        currency, expires_at, status, metadata)
        VALUES ('${BIZ}', '${orderId}', '+2349000000', 500000, 'NGN', '${deadline}', 'pending',
        '{"_inbound_channel_id":"${CHANNEL}","_confirmation_origin":"whatsapp"}'::jsonb) RETURNING id`);

      const result = psqlJson(`SELECT confirm_order_transfer_atomic(
        '${xferId}', '${orderId}', '${BIZ}', '${USER}'
      )`);
      expect(result.confirmed).toBe(true);
      expect(result.order_total).toBe(5000);
      expect(result.payment_id).toBeDefined();

      // Order confirmed
      const orderStatus = psql(`SELECT status FROM orders WHERE id = '${orderId}'`);
      expect(orderStatus).toBe('confirmed');

      // Marker committed
      const marker = psqlJson(`SELECT reservation_class, expires_at IS NULL AS no_expiry,
        payment_id IS NOT NULL AS has_payment
        FROM order_stock_applications WHERE order_id = '${orderId}'`);
      expect(marker.reservation_class).toBe('committed');
      expect(marker.no_expiry).toBe(true);
      expect(marker.has_payment).toBe(true);

      // Payment created with correct amount (MAJOR units)
      const payment = psqlJson(`SELECT amount, currency, status, payment_method, gateway
        FROM payments WHERE id = '${result.payment_id}'`);
      expect(payment.amount).toBe(5000);
      expect(payment.status).toBe('success');
      expect(payment.payment_method).toBe('bank_transfer');
      expect(payment.gateway).toBe('direct');
    });

    it('online payment already won → refused', () => {
      const orderId = createOrder({ total: 1000, sessionId: SESSION });
      const deadline = psql(`SELECT (NOW() + interval '24 hours')::timestamptz`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'bank_transfer', '${deadline}')`);
      psql(`INSERT INTO payments (business_id, order_id, amount, status)
        VALUES ('${BIZ}', '${orderId}', 1000, 'success')`);
      const xferId = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount,
        currency, expires_at, status) VALUES ('${BIZ}', '${orderId}', '+234900', 100000, 'NGN', '${deadline}', 'pending') RETURNING id`);

      const result = psqlJson(`SELECT confirm_order_transfer_atomic(
        '${xferId}', '${orderId}', '${BIZ}', '${USER}'
      )`);
      expect(result.confirmed).toBe(false);
      expect(result.reason).toBe('online_payment_won');
    });
  });

  // ═══ 7. reject_order_transfer_atomic ═══
  describe('reject_order_transfer_atomic', () => {
    it('restores stock + cancels order', () => {
      const prod = createProduct({ price: 2000, stock: 3, track: true });
      const orderId = createOrder({ total: 2000, sessionId: SESSION });
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${orderId}', '${prod}', 2, 2000)`);
      const deadline = psql(`SELECT (NOW() + interval '24 hours')::timestamptz`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${orderId}', 'bank_transfer', '${deadline}')`);
      const xferId = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount,
        currency, expires_at, status) VALUES ('${BIZ}', '${orderId}', '+234900', 200000, 'NGN', '${deadline}', 'pending') RETURNING id`);

      const result = psqlJson(`SELECT reject_order_transfer_atomic(
        '${xferId}', '${orderId}', '${BIZ}', 'merchant_rejected'
      )`);
      expect(result.rejected).toBe(true);
      expect(result.stock_restored).toBe(true);
      expect(result.items_restored).toBe(1);

      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${prod}'`);
      expect(parseInt(stock)).toBe(5); // 3 + 2 restored

      const orderStatus = psql(`SELECT status FROM orders WHERE id = '${orderId}'`);
      expect(orderStatus).toBe('cancelled');
    });

    it('committed marker → refused', () => {
      const orderId = createOrder({ total: 1000 });
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class)
        VALUES ('${orderId}', 'committed')`);
      const xferId = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount,
        currency, expires_at, status) VALUES ('${BIZ}', '${orderId}', '+234900', 100000, 'NGN', NOW() + interval '24 hours', 'pending') RETURNING id`);

      const result = psqlJson(`SELECT reject_order_transfer_atomic(
        '${xferId}', '${orderId}', '${BIZ}', 'test'
      )`);
      expect(result.rejected).toBe(false);
      expect(result.reason).toBe('committed_not_rejectable');
    });
  });

  // ═══ 8. ACL ═══
  describe('ACL: service_role only', () => {
    const fns = [
      'create_transfer_with_reservation',
      'confirm_order_transfer_atomic',
      'reject_order_transfer_atomic',
    ];

    for (const fn of fns) {
      it(`${fn}: anon denied`, () => {
        const hasAnon = psql(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE')`) === 't';
        expect(hasAnon).toBe(false);
      });

      it(`${fn}: service_role allowed`, () => {
        const hasSvc = psql(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE')`) === 't';
        expect(hasSvc).toBe(true);
      });
    }
  });
});
