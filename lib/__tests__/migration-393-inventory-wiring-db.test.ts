/**
 * M393: Inventory reservation wiring — hermetic PostgreSQL proof.
 *
 * Tests the seven M393 functions against a real PostgreSQL database:
 *   1. create_order_atomic   — delivery-zone server total, zero-floor, marker class
 *   2. apply_order_stock_once — winner conflict/replay, close linked transfers
 *   3. cancel_stale_order_atomic — marker-aware expiry authority
 *   4. cancel_order_immediate — cancel linked pending transfers
 *   5. create_transfer_with_reservation — atomic transfer + marker extension
 *   6. confirm_order_transfer_atomic — bank-transfer winner authority
 *   7. reject_order_transfer_atomic — bank-transfer rejection authority
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const output = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: (e as Error).message || '' };
  }
}

// ── Test IDs (0393 prefix, hex-only) ──
const BIZ       = '00000000-0000-0000-0393-000000000001';
const BIZ_OTHER = '00000000-0000-0000-0393-000000000002';
const PROD_A    = '00000000-0000-0000-0393-00000000000a';
const PROD_B    = '00000000-0000-0000-0393-00000000000b';
const PROD_NULL = '00000000-0000-0000-0393-00000000000c'; // NULL stock (unlimited)
const VARIANT_A = '00000000-0000-0000-0393-0000000000a1';
const ADDON_FIX = '00000000-0000-0000-0393-0000000000f1';
const ADDON_Q   = '00000000-0000-0000-0393-0000000000f2'; // quote price_type
const ZONE_A    = '00000000-0000-0000-0393-000000000da1';
const ZONE_OFF  = '00000000-0000-0000-0393-000000000da2'; // inactive zone
const SESSION_A = '00000000-0000-0000-0393-000000000e01';
const SESSION_B = '00000000-0000-0000-0393-000000000e02';
const SESSION_C = '00000000-0000-0000-0393-000000000e03';
const SESSION_D = '00000000-0000-0000-0393-000000000e04';
const SESSION_E = '00000000-0000-0000-0393-000000000e05';
const SESSION_F = '00000000-0000-0000-0393-000000000e06';
const SESSION_NO_CH = '00000000-0000-0000-0393-000000000e0a'; // no _inbound_channel_id
const CHANNEL_A = '00000000-0000-0000-0393-000000000ca1';
const USER_A    = '00000000-0000-0000-0393-000000000010';
const PAY_A     = '00000000-0000-0000-0393-000000000ba1';
const PAY_B     = '00000000-0000-0000-0393-000000000ba2';

// Cleanup helper: delete test data by business prefix
function cleanup() {
  psql(`
    DELETE FROM promo_reservations WHERE order_id IN (SELECT id FROM orders WHERE business_id IN ('${BIZ}','${BIZ_OTHER}'));
    DELETE FROM order_stock_applications WHERE order_id IN (SELECT id FROM orders WHERE business_id IN ('${BIZ}','${BIZ_OTHER}'));
    DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE business_id IN ('${BIZ}','${BIZ_OTHER}'));
    DELETE FROM pending_transfers WHERE business_id IN ('${BIZ}','${BIZ_OTHER}');
    DELETE FROM payments WHERE business_id IN ('${BIZ}','${BIZ_OTHER}');
    DELETE FROM orders WHERE business_id IN ('${BIZ}','${BIZ_OTHER}');
  `);
}

describe.skipIf(!canRun)('M393: Inventory reservation wiring', () => {
  beforeAll(() => {
    // ── Build full baseline schema + apply M392 + M393 ──
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE order_status AS ENUM ('draft','pending','confirmed','processing','ready','shipped','delivered','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE addon_price_type AS ENUM ('fixed','per_unit','quote'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      -- Core tables
      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT DEFAULT 'Test',
        slug TEXT,
        address TEXT,
        city TEXT,
        neighborhood TEXT,
        phone TEXT,
        country_code TEXT DEFAULT 'NG',
        owner_id UUID,
        status TEXT DEFAULT 'active',
        metadata JSONB DEFAULT '{}',
        assigned_channel_id UUID,
        whatsapp_channel_id UUID
      );

      CREATE TABLE IF NOT EXISTS promo_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        current_uses INTEGER DEFAULT 0,
        max_uses INTEGER
      );

      CREATE TABLE IF NOT EXISTS quote_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        user_id UUID,
        customer_phone TEXT,
        customer_name TEXT,
        status TEXT DEFAULT 'quoted',
        order_id UUID,
        responded_at TIMESTAMPTZ,
        cart_snapshot JSONB DEFAULT '[]',
        estimated_subtotal INTEGER DEFAULT 0,
        quoted_amount INTEGER,
        expires_at TIMESTAMPTZ,
        snapshot_version INTEGER DEFAULT 2,
        quoted_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        user_id UUID,
        status order_status DEFAULT 'pending',
        total_amount INTEGER DEFAULT 0,
        discount_amount INTEGER DEFAULT 0,
        shipping_cost INTEGER DEFAULT 0,
        promo_code_id UUID REFERENCES promo_codes(id),
        quote_request_id UUID,
        bot_session_id UUID,
        channel TEXT DEFAULT 'whatsapp',
        notes TEXT,
        delivery_address TEXT,
        delivery_phone TEXT,
        delivery_zone_id UUID,
        delivery_zone_name TEXT,
        addons_total INTEGER DEFAULT 0,
        volume_discount_amount INTEGER DEFAULT 0,
        pickup_address TEXT,
        dropoff_address TEXT,
        package_description TEXT,
        package_photo_url TEXT,
        referral_id UUID,
        items_fingerprint TEXT,
        reference_code TEXT DEFAULT ('WA-' || upper(substr(md5(random()::text), 1, 6))),
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- R28/B3: Match real production payments schema (no customer_phone/customer_name/reference columns)
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        user_id UUID,
        reservation_id UUID,
        booking_id UUID,
        order_id UUID REFERENCES orders(id),
        invoice_id UUID,
        campaign_id UUID,
        amount INTEGER NOT NULL DEFAULT 0,
        currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
        gateway_reference VARCHAR(100) UNIQUE NOT NULL DEFAULT ('pay-' || substr(md5(random()::text), 1, 8)),
        gateway_status VARCHAR(50) NOT NULL DEFAULT 'pending',
        gateway TEXT DEFAULT 'paystack',
        payment_method VARCHAR(20),
        card_last_four VARCHAR(4),
        card_brand VARCHAR(20),
        status payment_status NOT NULL DEFAULT 'pending',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        paid_at TIMESTAMPTZ,
        gateway_fee INTEGER NOT NULL DEFAULT 0,
        finalization_processing_at TIMESTAMPTZ,
        finalization_completed_at TIMESTAMPTZ,
        finalization_claim_token UUID,
        provider_init_state TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT DEFAULT 'Test',
        price INTEGER DEFAULT 0,
        stock_quantity INTEGER,
        track_inventory BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        deleted_at TIMESTAMPTZ,
        has_variants BOOLEAN DEFAULT false
      );

      CREATE TABLE IF NOT EXISTS product_variants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES products(id),
        label TEXT DEFAULT 'V',
        price INTEGER DEFAULT 0,
        stock_quantity INTEGER,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS product_addons (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        product_id UUID REFERENCES products(id),
        name TEXT DEFAULT 'Addon',
        price INTEGER DEFAULT 0,
        price_type addon_price_type DEFAULT 'fixed',
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID REFERENCES orders(id),
        product_id UUID REFERENCES products(id),
        variant_id UUID,
        variant_label TEXT,
        quantity INTEGER DEFAULT 1,
        unit_price INTEGER DEFAULT 0,
        addons JSONB
      );

      CREATE TABLE IF NOT EXISTS promo_reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID,
        promo_code_id UUID,
        state TEXT DEFAULT 'reserved',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS delivery_zones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        name TEXT DEFAULT 'Zone',
        price INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        session_data JSONB DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS whatsapp_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_type TEXT DEFAULT 'shared',
        business_id UUID,
        is_active BOOLEAN DEFAULT true
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

      -- pending_transfers
      CREATE TABLE IF NOT EXISTS pending_transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id),
        order_id UUID,
        customer_phone VARCHAR(30) NOT NULL,
        customer_name VARCHAR(200),
        expected_amount INTEGER NOT NULL,
        currency VARCHAR(5) NOT NULL DEFAULT 'NGN',
        reference_code VARCHAR(20) NOT NULL UNIQUE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','confirmed','rejected','expired','cancelled')),
        confirmed_by UUID,
        confirmed_at TIMESTAMPTZ,
        rejected_reason TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- Stub RPCs
      CREATE OR REPLACE FUNCTION release_promo_reservation(p_order_id UUID) RETURNS VOID
      LANGUAGE plpgsql AS $fn$
      BEGIN
        DELETE FROM promo_reservations WHERE order_id = p_order_id AND state = 'reserved';
      END;
      $fn$;

      -- Test data: businesses
      INSERT INTO businesses (id, name, country_code) VALUES ('${BIZ}', 'M393 Test Biz', 'NG') ON CONFLICT DO NOTHING;
      INSERT INTO businesses (id, name, country_code) VALUES ('${BIZ_OTHER}', 'M393 Other Biz', 'GH') ON CONFLICT DO NOTHING;

      -- Products
      INSERT INTO products (id, business_id, name, price, stock_quantity, track_inventory, is_active)
        VALUES
          ('${PROD_A}', '${BIZ}', 'Widget A', 1000, 50, true, true),
          ('${PROD_B}', '${BIZ}', 'Widget B', 2000, 30, true, true),
          ('${PROD_NULL}', '${BIZ}', 'Unlimited Widget', 500, NULL, true, true)
        ON CONFLICT (id) DO UPDATE SET
          price = EXCLUDED.price, stock_quantity = EXCLUDED.stock_quantity,
          track_inventory = EXCLUDED.track_inventory, is_active = EXCLUDED.is_active;

      -- Variant
      INSERT INTO product_variants (id, product_id, label, price, stock_quantity, is_active)
        VALUES ('${VARIANT_A}', '${PROD_A}', 'Large', 1200, 15, true)
        ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price, stock_quantity = EXCLUDED.stock_quantity;

      -- Addons
      INSERT INTO product_addons (id, business_id, product_id, name, price, price_type, is_active)
        VALUES
          ('${ADDON_FIX}', '${BIZ}', NULL, 'Gift Wrap', 200, 'fixed', true),
          ('${ADDON_Q}', '${BIZ}', NULL, 'Custom Engraving', 0, 'quote', true)
        ON CONFLICT (id) DO UPDATE SET
          price = EXCLUDED.price, price_type = EXCLUDED.price_type, is_active = EXCLUDED.is_active;

      -- Delivery zones
      INSERT INTO delivery_zones (id, business_id, name, price, is_active)
        VALUES
          ('${ZONE_A}', '${BIZ}', 'Lekki', 500, true),
          ('${ZONE_OFF}', '${BIZ}', 'Inactive Zone', 300, false)
        ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price, is_active = EXCLUDED.is_active;

      -- WhatsApp channel
      INSERT INTO whatsapp_channels (id, channel_type, business_id, is_active)
        VALUES ('${CHANNEL_A}', 'shared', '${BIZ}', true)
        ON CONFLICT (id) DO UPDATE SET is_active = true;

      -- Bot sessions with _inbound_channel_id
      INSERT INTO bot_sessions (id, business_id, session_data)
        VALUES
          ('${SESSION_A}', '${BIZ}', '{"_inbound_channel_id":"${CHANNEL_A}"}'::jsonb),
          ('${SESSION_B}', '${BIZ}', '{"_inbound_channel_id":"${CHANNEL_A}"}'::jsonb),
          ('${SESSION_C}', '${BIZ}', '{"_inbound_channel_id":"${CHANNEL_A}"}'::jsonb),
          ('${SESSION_D}', '${BIZ}', '{"_inbound_channel_id":"${CHANNEL_A}"}'::jsonb),
          ('${SESSION_E}', '${BIZ}', '{"_inbound_channel_id":"${CHANNEL_A}"}'::jsonb),
          ('${SESSION_F}', '${BIZ}', '{"_inbound_channel_id":"${CHANNEL_A}"}'::jsonb),
          ('${SESSION_NO_CH}', '${BIZ}', '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET session_data = EXCLUDED.session_data;
    `);

    // Apply M392 (adds reservation_class, expires_at columns + cancel functions)
    const m392 = readFileSync(
      join(process.cwd(), 'supabase/migrations/392_inventory_reservation_capability.sql'),
      'utf-8',
    );
    psql(m392);

    // Apply M393
    const m393 = readFileSync(
      join(process.cwd(), 'supabase/migrations/393_inventory_reservation_wiring.sql'),
      'utf-8',
    );
    psql(m393);
  });

  afterEach(() => {
    // Clean up test orders between tests
    cleanup();
    // Reset product stock to known values
    psql(`
      UPDATE products SET stock_quantity = 50 WHERE id = '${PROD_A}';
      UPDATE products SET stock_quantity = 30 WHERE id = '${PROD_B}';
      UPDATE products SET stock_quantity = NULL WHERE id = '${PROD_NULL}';
      UPDATE product_variants SET stock_quantity = 15 WHERE id = '${VARIANT_A}';
    `);
  });

  afterAll(() => {
    try {
      cleanup();
      psql(`
        DROP TABLE IF EXISTS pending_transfers CASCADE;
        DROP TABLE IF EXISTS promo_reservations CASCADE;
        DROP TABLE IF EXISTS order_stock_applications CASCADE;
        DROP TABLE IF EXISTS order_items CASCADE;
        DROP TABLE IF EXISTS product_addons CASCADE;
        DROP TABLE IF EXISTS product_variants CASCADE;
        DROP TABLE IF EXISTS products CASCADE;
        DROP TABLE IF EXISTS payments CASCADE;
        DROP TABLE IF EXISTS orders CASCADE;
        DROP TABLE IF EXISTS quote_requests CASCADE;
        DROP TABLE IF EXISTS promo_codes CASCADE;
        DROP TABLE IF EXISTS delivery_zones CASCADE;
        DROP TABLE IF EXISTS bot_sessions CASCADE;
        DROP TABLE IF EXISTS whatsapp_channels CASCADE;
        DROP TABLE IF EXISTS businesses CASCADE;
        DROP FUNCTION IF EXISTS release_promo_reservation(UUID) CASCADE;
        DROP FUNCTION IF EXISTS create_order_atomic CASCADE;
        DROP FUNCTION IF EXISTS apply_order_stock_once CASCADE;
        DROP FUNCTION IF EXISTS cancel_stale_order_atomic CASCADE;
        DROP FUNCTION IF EXISTS cancel_order_immediate CASCADE;
        DROP FUNCTION IF EXISTS create_transfer_with_reservation CASCADE;
        DROP FUNCTION IF EXISTS confirm_order_transfer_atomic CASCADE;
        DROP FUNCTION IF EXISTS reject_order_transfer_atomic CASCADE;
      `);
    } catch { /* best-effort */ }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. create_order_atomic
  // ═══════════════════════════════════════════════════════════════════

  describe('create_order_atomic', () => {
    it('paid order: marker instant, expires ~30min from now', () => {
      const items = JSON.stringify([
        { product_id: PROD_A, quantity: 2, unit_price: 1000 },
      ]);
      // server total: 2 * 1000 = 2000
      const r = psqlJson(`
        SELECT create_order_atomic(
          '${SESSION_A}', '${BIZ}', '${USER_A}',
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL,
          NULL, NULL, 0, 0, NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 2000
        )
      `);
      expect(r.created).toBe(true);
      expect(r.order_id).toBeTruthy();
      expect(r.server_total).toBe(2000);

      // Check marker
      const orderId = r.order_id as string;
      const marker = psql(`SELECT reservation_class, expires_at FROM order_stock_applications WHERE order_id = '${orderId}'`);
      expect(marker).toContain('instant');
      // expires_at should be roughly 30 minutes from now (within 2-minute tolerance)
      const expiresCheck = psql(`
        SELECT expires_at BETWEEN NOW() + INTERVAL '28 minutes' AND NOW() + INTERVAL '32 minutes'
        FROM order_stock_applications WHERE order_id = '${orderId}'
      `);
      expect(expiresCheck).toBe('t');
    });

    it('free order (p_status=confirmed): marker committed, expires_at NULL', () => {
      const items = JSON.stringify([
        { product_id: PROD_A, quantity: 1, unit_price: 1000 },
      ]);
      // server total: 1000, discount=1000 -> zero-floor -> 0
      const r = psqlJson(`
        SELECT create_order_atomic(
          '${SESSION_B}', '${BIZ}', '${USER_A}',
          'confirmed', NULL, NULL, 0, 1000, 0, NULL, 'whatsapp', NULL,
          NULL, NULL, 0, 0, NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 0
        )
      `);
      expect(r.created).toBe(true);

      const orderId = r.order_id as string;
      const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${orderId}'`);
      expect(cls).toBe('committed');

      const exp = psql(`SELECT expires_at FROM order_stock_applications WHERE order_id = '${orderId}'`);
      expect(exp).toBe(''); // NULL
    });

    it('delivery-zone total: server re-reads zone price, not double-counted with shipping', () => {
      const items = JSON.stringify([
        { product_id: PROD_B, quantity: 1, unit_price: 2000 },
      ]);
      // Zone_A price=500. Server total should be: 2000 (product) + 500 (zone) = 2500
      // Even if p_shipping_cost is passed, zone price replaces it
      const r = psqlJson(`
        SELECT create_order_atomic(
          '${SESSION_C}', '${BIZ}', '${USER_A}',
          'pending', NULL, NULL, 0, 0, 999, NULL, 'whatsapp', NULL,
          '${ZONE_A}', 'Lekki', 0, 0, NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 2500
        )
      `);
      expect(r.created).toBe(true);
      expect(r.server_total).toBe(2500);

      // Verify stored total is zone-based, not shipping-based
      const total = psql(`SELECT total_amount FROM orders WHERE id = '${r.order_id}'`);
      expect(total).toBe('2500');
    });

    it('zero/over-discount floor: total never negative', () => {
      const items = JSON.stringify([
        { product_id: PROD_A, quantity: 1, unit_price: 1000 },
      ]);
      // Product price=1000, discount=5000 -> should floor at 0
      const r = psqlJson(`
        SELECT create_order_atomic(
          '${SESSION_D}', '${BIZ}', '${USER_A}',
          'confirmed', NULL, NULL, 0, 5000, 0, NULL, 'whatsapp', NULL,
          NULL, NULL, 0, 0, NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 0
        )
      `);
      expect(r.created).toBe(true);
      expect(r.server_total).toBe(0);

      const total = psql(`SELECT total_amount FROM orders WHERE id = '${r.order_id}'`);
      expect(total).toBe('0');
    });

    it('addon validation: quote price_type rejected on validated path', () => {
      const items = JSON.stringify([
        {
          product_id: PROD_A,
          quantity: 1,
          unit_price: 1000,
          addons: [{ id: ADDON_Q, quantity: 1 }],
        },
      ]);
      const res = psqlMayFail(`
        SELECT create_order_atomic(
          '${SESSION_E}', '${BIZ}', '${USER_A}',
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL,
          NULL, NULL, 0, 0, NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1000
        )
      `);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('addon_quote_price');
    });

    it('addon validation: missing addon id rejected', () => {
      const items = JSON.stringify([
        {
          product_id: PROD_A,
          quantity: 1,
          unit_price: 1000,
          addons: [{ quantity: 1 }],
        },
      ]);
      const res = psqlMayFail(`
        SELECT create_order_atomic(
          '${SESSION_F}', '${BIZ}', '${USER_A}',
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL,
          NULL, NULL, 0, 0, NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1000
        )
      `);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('addon_missing_id');
    });

    it('inactive delivery zone rejected on validated path', () => {
      const items = JSON.stringify([
        { product_id: PROD_A, quantity: 1, unit_price: 1000 },
      ]);
      const res = psqlMayFail(`
        SELECT create_order_atomic(
          '${SESSION_A}', '${BIZ}', '${USER_A}',
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL,
          '${ZONE_OFF}', 'Inactive Zone', 0, 0, NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1300
        )
      `);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('zone_unavailable');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. apply_order_stock_once
  // ═══════════════════════════════════════════════════════════════════

  describe('apply_order_stock_once', () => {
    it('payment success commits marker + closes linked transfers', () => {
      // Create order with instant marker
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'pending', 1000) RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${ord}', '${PROD_A}', 1, 1000)`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${ord}', 'instant', NOW() + INTERVAL '30 minutes')`);
      // Create a pending transfer linked to this order
      psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000001', 100000, 'WA-T001', NOW() + INTERVAL '24 hours')`);
      // Create successful payment
      psql(`INSERT INTO payments (id, business_id, order_id, amount, status, gateway_reference)
        VALUES ('${PAY_A}', '${BIZ}', '${ord}', 1000, 'success', 'ref-pay-a')`);

      const r = psqlJson(`SELECT apply_order_stock_once('${ord}', '${PAY_A}')`);
      expect(r.applied).toBe(true);
      expect(r.order_confirmed).toBe(true);

      // Marker should be committed
      const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ord}'`);
      expect(cls).toBe('committed');

      // Marker payment_id set
      const pid = psql(`SELECT payment_id FROM order_stock_applications WHERE order_id = '${ord}'`);
      expect(pid).toBe(PAY_A);

      // Linked pending transfers should be cancelled
      const tStatus = psql(`SELECT status FROM pending_transfers WHERE order_id = '${ord}'`);
      expect(tStatus).toBe('cancelled');
    });

    it('same payment replay: idempotent', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'pending', 1000) RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${ord}', '${PROD_A}', 1, 1000)`);
      psql(`INSERT INTO payments (id, business_id, order_id, amount, status, gateway_reference)
        VALUES ('${PAY_A}', '${BIZ}', '${ord}', 1000, 'success', 'ref-pay-a2')`);

      // First call
      psqlJson(`SELECT apply_order_stock_once('${ord}', '${PAY_A}')`);

      // Replay
      const r2 = psqlJson(`SELECT apply_order_stock_once('${ord}', '${PAY_A}')`);
      expect(r2.applied).toBe(true);
      expect(r2.already_applied).toBe(true);
    });

    it('different payment on committed marker: conflict', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'pending', 1000) RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${ord}', '${PROD_A}', 1, 1000)`);
      psql(`INSERT INTO payments (id, business_id, order_id, amount, status, gateway_reference)
        VALUES ('${PAY_A}', '${BIZ}', '${ord}', 1000, 'success', 'ref-conflict-a')`);
      psql(`INSERT INTO payments (id, business_id, order_id, amount, status, gateway_reference)
        VALUES ('${PAY_B}', '${BIZ}', '${ord}', 1000, 'success', 'ref-conflict-b')`);

      // First payment wins
      psqlJson(`SELECT apply_order_stock_once('${ord}', '${PAY_A}')`);

      // Second payment: conflict
      const r2 = psqlJson(`SELECT apply_order_stock_once('${ord}', '${PAY_B}')`);
      expect(r2.applied).toBe(false);
      expect(r2.reason).toBe('payment_conflict');
    });

    it('committed + NULL payment: fail closed', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'confirmed', 1000) RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${ord}', '${PROD_A}', 1, 1000)`);
      // Manually insert committed marker with a payment
      psql(`INSERT INTO payments (id, business_id, order_id, amount, status, gateway_reference)
        VALUES ('${PAY_A}', '${BIZ}', '${ord}', 1000, 'success', 'ref-committed-null')`);
      psql(`INSERT INTO order_stock_applications (order_id, payment_id, reservation_class, expires_at)
        VALUES ('${ord}', '${PAY_A}', 'committed', NULL)`);

      const r = psqlJson(`SELECT apply_order_stock_once('${ord}')`);
      expect(r.applied).toBe(false);
      expect(r.reason).toBe('committed_no_winner');
    });

    it('non-committed + payment: upgrade to committed', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'pending', 1000) RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${ord}', '${PROD_A}', 1, 1000)`);
      // Prepayment marker (non-committed)
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${ord}', 'prepayment', NULL)`);
      psql(`INSERT INTO payments (id, business_id, order_id, amount, status, gateway_reference)
        VALUES ('${PAY_A}', '${BIZ}', '${ord}', 1000, 'success', 'ref-upgrade')`);

      const r = psqlJson(`SELECT apply_order_stock_once('${ord}', '${PAY_A}')`);
      expect(r.applied).toBe(true);

      const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ord}'`);
      expect(cls).toBe('committed');
    });

    it('fresh marker with payment: committed + transfers cancelled', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'pending', 1000) RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${ord}', '${PROD_A}', 1, 1000)`);
      psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000002', 100000, 'WA-T002', NOW() + INTERVAL '24 hours')`);
      psql(`INSERT INTO payments (id, business_id, order_id, amount, status, gateway_reference)
        VALUES ('${PAY_A}', '${BIZ}', '${ord}', 1000, 'success', 'ref-fresh-commit')`);

      const r = psqlJson(`SELECT apply_order_stock_once('${ord}', '${PAY_A}')`);
      expect(r.applied).toBe(true);
      expect(r.already_applied).toBe(false);

      const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ord}'`);
      expect(cls).toBe('committed');

      const tStatus = psql(`SELECT status FROM pending_transfers WHERE order_id = '${ord}'`);
      expect(tStatus).toBe('cancelled');
    });

    it('fresh marker without payment: prepayment default', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'pending', 1000) RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ('${ord}', '${PROD_A}', 1, 1000)`);

      const r = psqlJson(`SELECT apply_order_stock_once('${ord}')`);
      expect(r.applied).toBe(true);

      const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ord}'`);
      expect(cls).toBe('prepayment');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. cancel_stale_order_atomic (marker-aware)
  // ═══════════════════════════════════════════════════════════════════

  describe('cancel_stale_order_atomic', () => {
    it('committed marker: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ('${ord}', 'committed')`);

      const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('committed_not_cancellable');
    });

    it('instant not expired: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${ord}', 'instant', NOW() + INTERVAL '20 minutes')`);

      const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('instant_not_expired');
    });

    it('instant expired: cancelled + stock restored', () => {
      const ord = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ord}', '${PROD_A}', 3)`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${ord}', 'instant', NOW() - INTERVAL '1 minute')`);

      const stockBefore = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_A}'`);
      const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
      expect(r.cancelled).toBe(true);
      expect(r.stock_restored).toBe(true);

      const stockAfter = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_A}'`);
      expect(parseInt(stockAfter)).toBe(parseInt(stockBefore) + 3);
    });

    it('bank_transfer expired: cancelled + transfers expired', () => {
      const ord = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ord}', '${PROD_A}', 2)`);
      const deadline = "NOW() - INTERVAL '1 hour'";
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at) VALUES ('${ord}', 'bank_transfer', ${deadline})`);
      psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000003', 200000, 'WA-T003', ${deadline})`);

      const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
      expect(r.cancelled).toBe(true);

      // Transfers should be 'expired' (cancel_stale uses 'expired' status)
      const tStatus = psql(`SELECT status FROM pending_transfers WHERE order_id = '${ord}'`);
      expect(tStatus).toBe('expired');
    });

    it('prepayment <48h: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '24 hours') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ('${ord}', 'prepayment')`);

      const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('prepayment_not_stale');
    });

    it('prepayment >48h: cancelled', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ord}', '${PROD_A}', 1)`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ('${ord}', 'prepayment')`);

      const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
      expect(r.cancelled).toBe(true);
    });

    it('legacy no-marker + <48h: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '12 hours') RETURNING id`);

      const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('legacy_no_marker_not_stale');
    });

    it('legacy no-marker + >48h: cancelled', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, created_at) VALUES ('${BIZ}', 'pending', NOW() - INTERVAL '72 hours') RETURNING id`);

      const r = psqlJson(`SELECT cancel_stale_order_atomic('${ord}')`);
      expect(r.cancelled).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. cancel_order_immediate
  // ═══════════════════════════════════════════════════════════════════

  describe('cancel_order_immediate', () => {
    it('cancels linked pending_transfers', () => {
      const ord = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
      psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000004', 100000, 'WA-T004', NOW() + INTERVAL '24 hours')`);
      psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000005', 100000, 'WA-T005', NOW() + INTERVAL '24 hours')`);

      const r = psqlJson(`SELECT cancel_order_immediate('${ord}')`);
      expect(r.cancelled).toBe(true);
      expect(r.reason).toBe('customer_cancel');

      // Both transfers should be cancelled
      const tCount = psql(`SELECT COUNT(*) FROM pending_transfers WHERE order_id = '${ord}' AND status = 'cancelled'`);
      expect(tCount).toBe('2');
    });

    it('restores stock on cancel', () => {
      const ord = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'pending') RETURNING id`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ord}', '${PROD_A}', 5)`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class) VALUES ('${ord}', 'instant')`);

      const stockBefore = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_A}'`);
      psqlJson(`SELECT cancel_order_immediate('${ord}')`);
      const stockAfter = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_A}'`);
      expect(parseInt(stockAfter)).toBe(parseInt(stockBefore) + 5);
    });

    it('refuses cancel on confirmed order', () => {
      const ord = psql(`INSERT INTO orders (business_id, status) VALUES ('${BIZ}', 'confirmed') RETURNING id`);
      const r = psqlJson(`SELECT cancel_order_immediate('${ord}')`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('confirmed');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. create_transfer_with_reservation
  // ═══════════════════════════════════════════════════════════════════

  describe('create_transfer_with_reservation', () => {
    it('happy path: 5000 total -> 500000 minor, marker instant->bank_transfer', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount, bot_session_id, channel)
        VALUES ('${BIZ}', 'pending', 5000, '${SESSION_A}', 'whatsapp') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'instant', NOW() + INTERVAL '25 minutes')`);

      const r = psqlJson(`
        SELECT create_transfer_with_reservation(
          '${ord}', '${BIZ}', '+2348099990393', 'Test Customer', 'NG', 24, '${SESSION_A}'
        )
      `);
      expect(r.error).toBeUndefined();
      expect(r.transfer_id).toBeTruthy();
      expect(r.expected_amount).toBe(500000); // 5000 * 100
      expect(r.currency).toBe('NGN');

      // Marker should now be bank_transfer
      const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${ord}'`);
      expect(cls).toBe('bank_transfer');

      // Transfer and marker deadlines should match exactly
      const markerExp = psql(`SELECT expires_at FROM order_stock_applications WHERE order_id = '${ord}'`);
      const transferExp = psql(`SELECT expires_at FROM pending_transfers WHERE order_id = '${ord}'`);
      expect(markerExp).toBe(transferExp);
    });

    it('wrong business: rejected', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount, bot_session_id)
        VALUES ('${BIZ}', 'pending', 1000, '${SESSION_A}') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'instant', NOW() + INTERVAL '25 minutes')`);

      const r = psqlJson(`
        SELECT create_transfer_with_reservation(
          '${ord}', '${BIZ_OTHER}', '+2348099990393', 'Test', 'NG', 24, '${SESSION_A}'
        )
      `);
      expect(r.error).toBe(true);
      expect(r.reason).toBe('business_mismatch');
    });

    it('expired marker: rejected', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount, bot_session_id)
        VALUES ('${BIZ}', 'pending', 1000, '${SESSION_A}') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'instant', NOW() - INTERVAL '5 minutes')`);

      const r = psqlJson(`
        SELECT create_transfer_with_reservation(
          '${ord}', '${BIZ}', '+2348099990393', 'Test', 'NG', 24, '${SESSION_B}'
        )
      `);
      expect(r.error).toBe(true);
      expect(r.reason).toBe('marker_expired');
    });

    it('wrong class (committed): rejected', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount, bot_session_id)
        VALUES ('${BIZ}', 'pending', 1000, '${SESSION_A}') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class)
        VALUES ('${ord}', 'committed')`);

      const r = psqlJson(`
        SELECT create_transfer_with_reservation(
          '${ord}', '${BIZ}', '+2348099990393', 'Test', 'NG', 24, '${SESSION_C}'
        )
      `);
      expect(r.error).toBe(true);
      expect(r.reason).toBe('marker_not_instant');
    });

    it('session without _inbound_channel_id: rejected', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount, bot_session_id)
        VALUES ('${BIZ}', 'pending', 1000, '${SESSION_NO_CH}') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'instant', NOW() + INTERVAL '25 minutes')`);

      const r = psqlJson(`
        SELECT create_transfer_with_reservation(
          '${ord}', '${BIZ}', '+2348099990393', 'Test', 'NG', 24, '${SESSION_NO_CH}'
        )
      `);
      expect(r.error).toBe(true);
      expect(r.reason).toBe('no_inbound_channel');
    });

    it('GH country code -> GHS currency', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount, bot_session_id)
        VALUES ('${BIZ}', 'pending', 1000, '${SESSION_A}') RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'instant', NOW() + INTERVAL '25 minutes')`);

      const r = psqlJson(`
        SELECT create_transfer_with_reservation(
          '${ord}', '${BIZ}', '+233200000001', 'Ghana Test', 'GH', 24, '${SESSION_D}'
        )
      `);
      expect(r.currency).toBe('GHS');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. confirm_order_transfer_atomic
  // ═══════════════════════════════════════════════════════════════════

  describe('confirm_order_transfer_atomic', () => {
    function setupTransferOrder(): { orderId: string; transferId: string; deadline: string } {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount)
        VALUES ('${BIZ}', 'pending', 2000) RETURNING id`);
      const deadline = psql(`SELECT (NOW() + INTERVAL '24 hours')::timestamptz`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'bank_transfer', '${deadline}'::timestamptz)`);
      const tid = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, customer_name, expected_amount, currency, reference_code, status, expires_at, metadata)
        VALUES ('${BIZ}', '${ord}', '+234800000006', 'Confirm Test', 200000, 'NGN', 'WA-C' || substr(md5(random()::text),1,3), 'pending', '${deadline}'::timestamptz,
        '{"_inbound_channel_id":"${CHANNEL_A}","_confirmation_origin":"whatsapp"}'::jsonb
        ) RETURNING id`);
      return { orderId: ord, transferId: tid, deadline };
    }

    it('happy path: order confirmed, marker committed, payment created', () => {
      const { orderId, transferId } = setupTransferOrder();

      const r = psqlJson(`
        SELECT confirm_order_transfer_atomic('${transferId}', '${orderId}', '${BIZ}', '${USER_A}')
      `);
      expect(r.confirmed).toBe(true);
      expect(r.payment_id).toBeTruthy();
      expect(r.order_total).toBe(2000);
      expect(r.currency).toBe('NGN');

      // Order should be confirmed
      const status = psql(`SELECT status FROM orders WHERE id = '${orderId}'`);
      expect(status).toBe('confirmed');

      // Marker should be committed
      const cls = psql(`SELECT reservation_class FROM order_stock_applications WHERE order_id = '${orderId}'`);
      expect(cls).toBe('committed');

      // Transfer should be confirmed
      const tStatus = psql(`SELECT status FROM pending_transfers WHERE id = '${transferId}'`);
      expect(tStatus).toBe('confirmed');

      // Payment should be success with bank_transfer method
      const payMethod = psql(`SELECT payment_method FROM payments WHERE id = '${r.payment_id}'`);
      expect(payMethod).toBe('bank_transfer');
    });

    it('online payment already won: refused', () => {
      const { orderId, transferId } = setupTransferOrder();
      // Insert successful online payment
      psql(`INSERT INTO payments (business_id, order_id, amount, status, gateway_reference)
        VALUES ('${BIZ}', '${orderId}', 2000, 'success', 'ref-online-won')`);

      const r = psqlJson(`
        SELECT confirm_order_transfer_atomic('${transferId}', '${orderId}', '${BIZ}', '${USER_A}')
      `);
      expect(r.confirmed).toBe(false);
      expect(r.reason).toBe('online_payment_won');
    });

    it('deadline mismatch: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'pending', 2000) RETURNING id`);
      const deadline1 = psql(`SELECT (NOW() + INTERVAL '24 hours')::timestamptz`);
      const deadline2 = psql(`SELECT (NOW() + INTERVAL '48 hours')::timestamptz`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'bank_transfer', '${deadline1}'::timestamptz)`);
      const tid = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, status, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000007', 200000, 'WA-C' || substr(md5(random()::text),1,3), 'pending', '${deadline2}'::timestamptz
        ) RETURNING id`);

      const r = psqlJson(`
        SELECT confirm_order_transfer_atomic('${tid}', '${ord}', '${BIZ}', '${USER_A}')
      `);
      expect(r.confirmed).toBe(false);
      expect(r.reason).toBe('deadline_mismatch');
    });

    it('marker not bank_transfer: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount) VALUES ('${BIZ}', 'pending', 2000) RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'instant', NOW() + INTERVAL '30 minutes')`);
      const tid = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, status, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000008', 200000, 'WA-C' || substr(md5(random()::text),1,3), 'pending', NOW() + INTERVAL '30 minutes'
        ) RETURNING id`);

      const r = psqlJson(`
        SELECT confirm_order_transfer_atomic('${tid}', '${ord}', '${BIZ}', '${USER_A}')
      `);
      expect(r.confirmed).toBe(false);
      expect(r.reason).toBe('marker_class_instant');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. reject_order_transfer_atomic
  // ═══════════════════════════════════════════════════════════════════

  describe('reject_order_transfer_atomic', () => {
    function setupRejectOrder(): { orderId: string; transferId: string } {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount)
        VALUES ('${BIZ}', 'pending', 3000) RETURNING id`);
      const deadline = psql(`SELECT (NOW() + INTERVAL '24 hours')::timestamptz`);
      psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ord}', '${PROD_A}', 3)`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'bank_transfer', '${deadline}'::timestamptz)`);
      const tid = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, status, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000009', 300000, 'WA-R' || substr(md5(random()::text),1,3), 'pending', '${deadline}'::timestamptz
        ) RETURNING id`);
      return { orderId: ord, transferId: tid };
    }

    it('restores stock once', () => {
      const { orderId, transferId } = setupRejectOrder();
      const stockBefore = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_A}'`);

      const r = psqlJson(`
        SELECT reject_order_transfer_atomic('${transferId}', '${orderId}', '${BIZ}')
      `);
      expect(r.rejected).toBe(true);
      expect(r.stock_restored).toBe(true);
      expect(r.items_restored).toBe(1);

      const stockAfter = psql(`SELECT stock_quantity FROM products WHERE id = '${PROD_A}'`);
      expect(parseInt(stockAfter)).toBe(parseInt(stockBefore) + 3);

      // Order should be cancelled
      const status = psql(`SELECT status FROM orders WHERE id = '${orderId}'`);
      expect(status).toBe('cancelled');

      // Transfer should be rejected
      const tStatus = psql(`SELECT status FROM pending_transfers WHERE id = '${transferId}'`);
      expect(tStatus).toBe('rejected');
    });

    it('deadline mismatch: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount)
        VALUES ('${BIZ}', 'pending', 3000) RETURNING id`);
      const dl1 = psql(`SELECT (NOW() + INTERVAL '12 hours')::timestamptz`);
      const dl2 = psql(`SELECT (NOW() + INTERVAL '24 hours')::timestamptz`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'bank_transfer', '${dl1}'::timestamptz)`);
      const tid = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, status, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000010', 300000, 'WA-R' || substr(md5(random()::text),1,3), 'pending', '${dl2}'::timestamptz
        ) RETURNING id`);

      const r = psqlJson(`
        SELECT reject_order_transfer_atomic('${tid}', '${ord}', '${BIZ}')
      `);
      expect(r.rejected).toBe(false);
      expect(r.reason).toBe('deadline_mismatch');
    });

    it('instant marker: refused (not rejectable)', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount)
        VALUES ('${BIZ}', 'pending', 3000) RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class, expires_at)
        VALUES ('${ord}', 'instant', NOW() + INTERVAL '30 minutes')`);
      const tid = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, status, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000011', 300000, 'WA-R' || substr(md5(random()::text),1,3), 'pending', NOW() + INTERVAL '30 minutes'
        ) RETURNING id`);

      const r = psqlJson(`
        SELECT reject_order_transfer_atomic('${tid}', '${ord}', '${BIZ}')
      `);
      expect(r.rejected).toBe(false);
      expect(r.reason).toBe('instant_not_rejectable');
    });

    it('prepayment marker: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount)
        VALUES ('${BIZ}', 'pending', 3000) RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class)
        VALUES ('${ord}', 'prepayment')`);
      const tid = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, status, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000012', 300000, 'WA-R' || substr(md5(random()::text),1,3), 'pending', NOW() + INTERVAL '24 hours'
        ) RETURNING id`);

      const r = psqlJson(`
        SELECT reject_order_transfer_atomic('${tid}', '${ord}', '${BIZ}')
      `);
      expect(r.rejected).toBe(false);
      expect(r.reason).toBe('prepayment_not_rejectable');
    });

    it('committed marker: refused', () => {
      const ord = psql(`INSERT INTO orders (business_id, status, total_amount)
        VALUES ('${BIZ}', 'pending', 3000) RETURNING id`);
      psql(`INSERT INTO order_stock_applications (order_id, reservation_class)
        VALUES ('${ord}', 'committed')`);
      const tid = psql(`INSERT INTO pending_transfers (business_id, order_id, customer_phone, expected_amount, reference_code, status, expires_at)
        VALUES ('${BIZ}', '${ord}', '+234800000013', 300000, 'WA-R' || substr(md5(random()::text),1,3), 'pending', NOW() + INTERVAL '24 hours'
        ) RETURNING id`);

      const r = psqlJson(`
        SELECT reject_order_transfer_atomic('${tid}', '${ord}', '${BIZ}')
      `);
      expect(r.rejected).toBe(false);
      expect(r.reason).toBe('committed_not_rejectable');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. ACL tests
  // ═══════════════════════════════════════════════════════════════════

  describe('ACL', () => {
    const DUMMY_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    // ── All 7 functions: anon denied ──

    it('anon: create_order_atomic denied', () => {
      const res = psqlMayFail(`SET ROLE anon; SELECT create_order_atomic('${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid); RESET ROLE;`);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('permission denied');
    });

    it('anon: apply_order_stock_once denied', () => {
      const res = psqlMayFail(`SET ROLE anon; SELECT apply_order_stock_once('${DUMMY_UUID}'::uuid); RESET ROLE;`);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('permission denied');
    });

    it('anon: cancel_stale_order_atomic denied', () => {
      const res = psqlMayFail(`SET ROLE anon; SELECT cancel_stale_order_atomic('${DUMMY_UUID}'::uuid); RESET ROLE;`);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('permission denied');
    });

    it('anon: cancel_order_immediate denied', () => {
      const res = psqlMayFail(`SET ROLE anon; SELECT cancel_order_immediate('${DUMMY_UUID}'::uuid); RESET ROLE;`);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('permission denied');
    });

    it('anon: create_transfer_with_reservation denied', () => {
      const res = psqlMayFail(`SET ROLE anon; SELECT create_transfer_with_reservation('${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '+234', 'X', 'NG', 24, '${DUMMY_UUID}'::uuid); RESET ROLE;`);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('permission denied');
    });

    it('anon: confirm_order_transfer_atomic denied', () => {
      const res = psqlMayFail(`SET ROLE anon; SELECT confirm_order_transfer_atomic('${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid); RESET ROLE;`);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('permission denied');
    });

    it('anon: reject_order_transfer_atomic denied', () => {
      const res = psqlMayFail(`SET ROLE anon; SELECT reject_order_transfer_atomic('${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid); RESET ROLE;`);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('permission denied');
    });

    // ── All 7 functions: service_role allowed ──

    it('service_role: cancel_stale_order_atomic allowed', () => {
      const r = psql(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${DUMMY_UUID}'::uuid); RESET ROLE;`);
      const parsed = JSON.parse(r);
      expect(parsed.cancelled).toBe(false);
      expect(parsed.reason).toBe('not_found');
    });

    it('service_role: cancel_order_immediate allowed', () => {
      const r = psql(`SET ROLE service_role; SELECT cancel_order_immediate('${DUMMY_UUID}'::uuid); RESET ROLE;`);
      const parsed = JSON.parse(r);
      expect(parsed.cancelled).toBe(false);
      expect(parsed.reason).toBe('not_found');
    });

    it('service_role: apply_order_stock_once allowed', () => {
      const r = psql(`SET ROLE service_role; SELECT apply_order_stock_once('${DUMMY_UUID}'::uuid); RESET ROLE;`);
      const parsed = JSON.parse(r);
      expect(parsed.applied).toBe(false);
      expect(parsed.reason).toBe('order_not_found');
    });

    it('service_role: create_transfer_with_reservation allowed', () => {
      const r = psql(`SET ROLE service_role; SELECT create_transfer_with_reservation('${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '+234', 'X', 'NG', 24, '${DUMMY_UUID}'::uuid); RESET ROLE;`);
      const parsed = JSON.parse(r);
      expect(parsed.error).toBe(true);
      expect(parsed.reason).toBe('order_not_found');
    });

    it('service_role: confirm_order_transfer_atomic allowed', () => {
      const r = psql(`SET ROLE service_role; SELECT confirm_order_transfer_atomic('${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid); RESET ROLE;`);
      const parsed = JSON.parse(r);
      expect(parsed.confirmed).toBe(false);
      expect(parsed.reason).toBe('order_not_found');
    });

    it('service_role: reject_order_transfer_atomic allowed', () => {
      const r = psql(`SET ROLE service_role; SELECT reject_order_transfer_atomic('${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid, '${DUMMY_UUID}'::uuid); RESET ROLE;`);
      const parsed = JSON.parse(r);
      expect(parsed.rejected).toBe(false);
      expect(parsed.reason).toBe('order_not_found');
    });

    it('service_role: create_order_atomic allowed (creates order)', () => {
      // create_order_atomic with a dummy session won't find an existing order,
      // it will try to create one. We verify permission is granted.
      const r = psql(`SET ROLE service_role; SELECT create_order_atomic('${DUMMY_UUID}'::uuid, '${BIZ}'::uuid, '${DUMMY_UUID}'::uuid); RESET ROLE;`);
      const parsed = JSON.parse(r);
      // Should succeed (create a new order) since session doesn't exist
      expect(parsed.order_id).toBeTruthy();
    });
  });
});
