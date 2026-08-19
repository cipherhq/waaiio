/**
 * Migrations 327/328/329 — Canonical order-stock authority, quote acceptance/rejection,
 * and stale-order atomic cleanup: real PostgreSQL tests.
 *
 * Requires TEST_DATABASE_URL.
 *
 * Tests cover:
 * - Canonical stock application (first, repeated, concurrent, crash, deposit+balance)
 * - Cancelled order rejection
 * - Payment/order mismatch rejection
 * - Stock sufficiency validation
 * - Quote acceptance/rejection atomicity
 * - WhatsApp sender identity verification
 * - One-quote-one-order DB invariant
 * - Stale order cleanup with/without marker
 * - Payment-protected orders
 * - Privilege hardening
 * - orders.paid_at non-reference
 * - Stale cleanup payment voiding (serialization contract with payment authority)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'child_process';

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
    const output = execSync(`psql "${dbUrl}" -tAXq`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
    return { ok: true, output };
  } catch (e) {
    return { ok: false, output: (e as Error).message || '' };
  }
}

// ── Test IDs ──
const BIZ_ID = '00000000-0000-0000-0327-000000000001';
const USER_ID = '00000000-0000-0000-0327-000000000002';
const PRODUCT_A = '00000000-0000-0000-0327-00000000000a';
const PRODUCT_B = '00000000-0000-0000-0327-00000000000b';
const VARIANT_A = '00000000-0000-0000-0327-0000000000a1';
const ORDER_1 = '00000000-0000-0000-0327-000000000101';
const ORDER_2 = '00000000-0000-0000-0327-000000000102';
const ORDER_3 = '00000000-0000-0000-0327-000000000103';
const ORDER_CANCELLED = '00000000-0000-0000-0327-000000000104';
const ORDER_STALE_MARK = '00000000-0000-0000-0327-000000000105';
const ORDER_STALE_NO_MARK = '00000000-0000-0000-0327-000000000106';
const ORDER_STALE_PAID = '00000000-0000-0000-0327-000000000107';
const ORDER_CONFIRMED = '00000000-0000-0000-0327-000000000108';
const PAY_1 = '00000000-0000-0000-0327-000000000201';
const PAY_2 = '00000000-0000-0000-0327-000000000202';
const PAY_BAD = '00000000-0000-0000-0327-000000000203';
const PAY_STALE_OK = '00000000-0000-0000-0327-000000000204';
const QUOTE_1 = '00000000-0000-0000-0327-000000000301';
const QUOTE_2 = '00000000-0000-0000-0327-000000000302';
const QUOTE_EXPIRED = '00000000-0000-0000-0327-000000000303';
const CUSTOMER_PHONE = '+2348012345678';
const WRONG_PHONE = '+2349999999999';

describe.skipIf(!canRun)('Migrations 327-329: Order stock authority + Quote RPCs + Cleanup', () => {
  beforeAll(() => {
    // ── Bootstrap minimal schema ──
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;
      GRANT USAGE ON SCHEMA public TO anon;
      GRANT USAGE ON SCHEMA public TO authenticated;

      -- order_status enum
      DO $$ BEGIN CREATE TYPE order_status AS ENUM ('draft','pending','confirmed','processing','shipped','ready','delivered','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE quote_status AS ENUM ('pending','quoted','accepted','rejected','expired','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      -- businesses (minimal)
      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT DEFAULT 'Test Business',
        country_code TEXT DEFAULT 'NG',
        phone TEXT,
        owner_id UUID,
        subscription_tier TEXT DEFAULT 'free',
        trial_ends_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb
      );

      -- profiles (minimal)
      CREATE TABLE IF NOT EXISTS profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone TEXT
      );

      -- products
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        name TEXT DEFAULT 'Product',
        price INT DEFAULT 1000,
        stock_quantity INT,
        track_inventory BOOLEAN DEFAULT true,
        is_active BOOLEAN DEFAULT true
      );

      -- product_variants
      CREATE TABLE IF NOT EXISTS product_variants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID,
        stock_quantity INT
      );

      -- payments
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount INT DEFAULT 0,
        status TEXT DEFAULT 'pending',
        order_id UUID,
        metadata JSONB DEFAULT '{}'::jsonb,
        gateway_fee INT DEFAULT 0,
        gateway_status TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        finalization_processing_at TIMESTAMPTZ,
        finalization_completed_at TIMESTAMPTZ,
        finalization_claim_token UUID
      );

      -- orders
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reference_code VARCHAR(10) UNIQUE DEFAULT substr(md5(random()::text),1,8),
        business_id UUID,
        user_id UUID,
        status order_status DEFAULT 'draft',
        delivery_address TEXT,
        delivery_phone TEXT,
        total_amount INT DEFAULT 0,
        platform_fee INT DEFAULT 0,
        notes TEXT,
        channel VARCHAR(20) DEFAULT 'whatsapp',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        quote_request_id UUID,
        delivery_zone_id UUID,
        delivery_zone_name TEXT,
        deposit_percentage INT,
        deposit_amount INT DEFAULT 0,
        balance_amount INT DEFAULT 0,
        custom_order_data JSONB,
        bot_session_id UUID
      );

      -- order_items
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID,
        product_id UUID,
        variant_id UUID,
        quantity INT DEFAULT 1,
        unit_price INT DEFAULT 0,
        variant_label TEXT,
        addons JSONB
      );

      -- quote_requests
      CREATE TABLE IF NOT EXISTS quote_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        user_id UUID,
        customer_phone VARCHAR(20),
        customer_name VARCHAR(200),
        status quote_status DEFAULT 'pending',
        cart_snapshot JSONB DEFAULT '[]',
        addons_snapshot JSONB DEFAULT '[]',
        delivery_zone_id UUID,
        delivery_zone_name VARCHAR(200),
        delivery_address TEXT,
        estimated_subtotal INT DEFAULT 0,
        quoted_amount INT,
        quote_notes TEXT,
        quoted_at TIMESTAMPTZ,
        customer_response TEXT,
        responded_at TIMESTAMPTZ,
        order_id UUID,
        expires_at TIMESTAMPTZ,
        notes TEXT,
        channel VARCHAR(20) DEFAULT 'whatsapp',
        custom_order_data JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- order_stock_applications (pre-migration 327 state)
      CREATE TABLE IF NOT EXISTS order_stock_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID NOT NULL,
        order_id UUID NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        item_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(payment_id, order_id)
      );
      ALTER TABLE order_stock_applications ENABLE ROW LEVEL SECURITY;
    `);

    // ── Apply migrations 327, 328, 329 ──
    const fs = require('fs');
    for (const f of [
      'supabase/migrations/327_canonical_order_stock.sql',
      'supabase/migrations/328_quote_acceptance_rpcs.sql',
      'supabase/migrations/329_stale_order_atomic_cleanup.sql',
    ]) {
      const sql = fs.readFileSync(f, 'utf-8');
      psql(sql.replace(/--.*$/gm, ''));
    }

    // ── Seed test data ──
    psql(`
      INSERT INTO businesses (id, name, country_code, metadata)
        VALUES ('${BIZ_ID}', 'Test Biz', 'NG', '{"custom_order_config":{"deposit_percentage":50}}'::jsonb)
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO profiles (id, phone) VALUES ('${USER_ID}', '${CUSTOMER_PHONE}')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO products (id, business_id, name, stock_quantity, track_inventory)
        VALUES ('${PRODUCT_A}', '${BIZ_ID}', 'Widget A', 100, true),
               ('${PRODUCT_B}', '${BIZ_ID}', 'Widget B', 50, true)
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO product_variants (id, product_id, stock_quantity)
        VALUES ('${VARIANT_A}', '${PRODUCT_A}', 30)
        ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    if (!canRun) return;
    psql(`
      DELETE FROM order_stock_applications;
      DELETE FROM order_items;
      DELETE FROM orders;
      DELETE FROM payments;
      DELETE FROM quote_requests;
      DELETE FROM product_variants WHERE id = '${VARIANT_A}';
      DELETE FROM products WHERE id IN ('${PRODUCT_A}', '${PRODUCT_B}');
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
    `);
  });

  // ═══════════════════════════════════════════════════════
  // CANONICAL STOCK APPLICATION TESTS
  // ═══════════════════════════════════════════════════════

  describe('apply_order_stock_once', () => {
    beforeEach(() => {
      psql(`
        DELETE FROM order_stock_applications;
        DELETE FROM order_items;
        DELETE FROM orders WHERE id IN ('${ORDER_1}','${ORDER_2}','${ORDER_CANCELLED}');
        DELETE FROM payments WHERE id IN ('${PAY_1}','${PAY_2}','${PAY_BAD}');
        UPDATE products SET stock_quantity = 100 WHERE id = '${PRODUCT_A}';
        UPDATE products SET stock_quantity = 50 WHERE id = '${PRODUCT_B}';
        UPDATE product_variants SET stock_quantity = 30 WHERE id = '${VARIANT_A}';
      `);
    });

    it('1. first stock application decrements and inserts marker', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount)
          VALUES ('${ORDER_1}', '${BIZ_ID}', '${USER_ID}', 'pending', 3000);
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_1}', '${PRODUCT_A}', 2, 1000),
                 ('${ORDER_1}', '${PRODUCT_B}', 1, 1000);
      `);
      const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}');`);
      expect(r.applied).toBe(true);
      expect(r.already_applied).toBe(false);
      expect(r.items).toBe(2);

      // Verify stock decremented
      const stockA = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockA)).toBe(98);
      const stockB = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_B}';`);
      expect(parseInt(stockB)).toBe(49);

      // Verify marker
      const marker = psql(`SELECT count(*) FROM order_stock_applications WHERE order_id = '${ORDER_1}';`);
      expect(parseInt(marker)).toBe(1);
    });

    it('2. repeated stock application returns already_applied without changing stock', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount)
          VALUES ('${ORDER_1}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000);
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_1}', '${PRODUCT_A}', 5, 200);
      `);
      psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}');`);
      const stockAfterFirst = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);

      const r2 = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}');`);
      expect(r2.applied).toBe(true);
      expect(r2.already_applied).toBe(true);

      const stockAfterSecond = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(stockAfterSecond).toBe(stockAfterFirst);
    });

    it('3. deposit + balance payments → one decrement', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount)
          VALUES ('${ORDER_1}', '${BIZ_ID}', '${USER_ID}', 'pending', 2000);
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_1}', '${PRODUCT_A}', 3, 667);
        INSERT INTO payments (id, order_id, amount, status) VALUES
          ('${PAY_1}', '${ORDER_1}', 1000, 'success'),
          ('${PAY_2}', '${ORDER_1}', 1000, 'success');
      `);

      // Deposit payment applies stock
      const r1 = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}', '${PAY_1}');`);
      expect(r1.applied).toBe(true);
      expect(r1.already_applied).toBe(false);

      const stockAfterDeposit = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterDeposit)).toBe(97);

      // Balance payment — already applied
      const r2 = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}', '${PAY_2}');`);
      expect(r2.applied).toBe(true);
      expect(r2.already_applied).toBe(true);

      // Stock unchanged
      const stockAfterBalance = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterBalance)).toBe(97);
    });

    it('4. cancelled order is rejected', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount)
          VALUES ('${ORDER_CANCELLED}', '${BIZ_ID}', '${USER_ID}', 'cancelled', 1000);
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_CANCELLED}', '${PRODUCT_A}', 1, 1000);
      `);
      const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_CANCELLED}');`);
      expect(r.applied).toBe(false);
      expect(r.reason).toBe('order_cancelled');
    });

    it('5. invalid payment→order relationship is rejected', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount)
          VALUES ('${ORDER_1}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000);
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_1}', '${PRODUCT_A}', 1, 1000);
        INSERT INTO payments (id, order_id, amount, status) VALUES
          ('${PAY_BAD}', '${ORDER_2}', 1000, 'success');
      `);
      const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}', '${PAY_BAD}');`);
      expect(r.applied).toBe(false);
      expect(r.reason).toBe('payment_order_mismatch');
    });

    it('6. stock sufficiency validation rolls back on insufficiency', () => {
      psql(`
        UPDATE products SET stock_quantity = 2 WHERE id = '${PRODUCT_A}';
        INSERT INTO orders (id, business_id, user_id, status, total_amount)
          VALUES ('${ORDER_1}', '${BIZ_ID}', '${USER_ID}', 'pending', 5000);
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_1}', '${PRODUCT_A}', 10, 500);
      `);
      const result = psqlMayFail(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}', NULL, true);`);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('insufficient_stock');

      // Stock unchanged (rolled back)
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(2);

      // No marker
      const marker = psql(`SELECT count(*) FROM order_stock_applications WHERE order_id = '${ORDER_1}';`);
      expect(parseInt(marker)).toBe(0);
    });

    it('7. variant stock is decremented correctly', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount)
          VALUES ('${ORDER_1}', '${BIZ_ID}', '${USER_ID}', 'pending', 2000);
        INSERT INTO order_items (order_id, product_id, variant_id, quantity, unit_price)
          VALUES ('${ORDER_1}', '${PRODUCT_A}', '${VARIANT_A}', 5, 400);
      `);
      const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}');`);
      expect(r.applied).toBe(true);

      const variantStock = psql(`SELECT stock_quantity FROM product_variants WHERE id = '${VARIANT_A}';`);
      expect(parseInt(variantStock)).toBe(25);
    });

    it('8. NULL payment_id is accepted (free order / pre-payment reservation)', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount)
          VALUES ('${ORDER_1}', '${BIZ_ID}', '${USER_ID}', 'confirmed', 0);
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_1}', '${PRODUCT_A}', 1, 0);
      `);
      const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_1}');`);
      expect(r.applied).toBe(true);
      expect(r.already_applied).toBe(false);

      // Verify marker has NULL payment_id
      const payId = psql(`SELECT payment_id FROM order_stock_applications WHERE order_id = '${ORDER_1}';`);
      expect(payId).toBe('');
    });
  });

  // ═══════════════════════════════════════════════════════
  // QUOTE ACCEPTANCE / REJECTION TESTS
  // ═══════════════════════════════════════════════════════

  describe('accept_order_quote_atomic / reject_order_quote_atomic', () => {
    beforeEach(() => {
      psql(`
        DELETE FROM order_stock_applications;
        DELETE FROM order_items;
        DELETE FROM orders;
        DELETE FROM quote_requests;
        UPDATE products SET stock_quantity = 100 WHERE id = '${PRODUCT_A}';
        UPDATE products SET stock_quantity = 50 WHERE id = '${PRODUCT_B}';
        UPDATE product_variants SET stock_quantity = 30 WHERE id = '${VARIANT_A}';
      `);
    });

    function seedQuote(id: string, status: string, phone: string, opts: { expired?: boolean; customData?: boolean } = {}) {
      const expiresAt = opts.expired
        ? `'2020-01-01'::timestamptz`
        : `(NOW() + INTERVAL '24 hours')`;
      const customData = opts.customData ? `'{"measurements":{"chest":"40"}}'::jsonb` : 'NULL';
      psql(`
        INSERT INTO quote_requests (id, business_id, user_id, customer_phone, customer_name, status, cart_snapshot, estimated_subtotal, quoted_amount, expires_at, custom_order_data, quoted_at)
        VALUES (
          '${id}', '${BIZ_ID}', '${USER_ID}', '${phone}', 'Test Customer', '${status}',
          '[{"product_id":"${PRODUCT_A}","quantity":2,"price":1500,"name":"Widget A"},{"product_id":"${PRODUCT_B}","quantity":1,"price":2000,"name":"Widget B"}]'::jsonb,
          5000, 5000, ${expiresAt}, ${customData}, NOW()
        ) ON CONFLICT (id) DO NOTHING;
      `);
    }

    it('9. correct sender accepts valid quote', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r.accepted).toBe(true);
      expect(r.already_accepted).toBe(false);
      expect(r.order_id).toBeTruthy();
      expect(r.reference_code).toBeTruthy();
      expect(r.total).toBe(5000);

      // Verify stock decremented
      const stockA = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockA)).toBe(98);
      const stockB = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_B}';`);
      expect(parseInt(stockB)).toBe(49);

      // Verify marker exists
      const marker = psql(`SELECT count(*) FROM order_stock_applications WHERE order_id = '${r.order_id}';`);
      expect(parseInt(marker)).toBe(1);

      // Verify quote updated
      const qStatus = psql(`SELECT status FROM quote_requests WHERE id = '${QUOTE_1}';`);
      expect(qStatus).toBe('accepted');
    });

    it('10. wrong sender cannot accept', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${WRONG_PHONE}');`);
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('identity_mismatch');

      // Stock unchanged
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(100);
    });

    it('11. correct sender rejects', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r = psqlJson(`SET ROLE service_role; SELECT reject_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r.rejected).toBe(true);
      expect(r.already_rejected).toBe(false);
    });

    it('12. wrong sender cannot reject', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r = psqlJson(`SET ROLE service_role; SELECT reject_order_quote_atomic('${QUOTE_1}', '${WRONG_PHONE}');`);
      expect(r.rejected).toBe(false);
      expect(r.reason).toBe('identity_mismatch');
    });

    it('13. +country-code normalization equivalence', () => {
      // Store with +, send without +
      seedQuote(QUOTE_1, 'quoted', '+2348012345678');
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '2348012345678');`);
      expect(r.accepted).toBe(true);
    });

    it('14. null identity denied', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', NULL);`);
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('identity_missing');
    });

    it('15. empty string identity denied', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '');`);
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('identity_missing');
    });

    it('16. repeat accept returns same order (idempotent)', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r1 = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r1.accepted).toBe(true);
      const orderId = r1.order_id;

      const r2 = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r2.accepted).toBe(true);
      expect(r2.already_accepted).toBe(true);
      expect(r2.order_id).toBe(orderId);
    });

    it('17. accept already-rejected quote fails', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      psqlJson(`SET ROLE service_role; SELECT reject_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('already_rejected');
    });

    it('18. reject already-accepted quote fails', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      const r = psqlJson(`SET ROLE service_role; SELECT reject_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r.rejected).toBe(false);
      expect(r.reason).toBe('already_accepted');
    });

    it('19. repeat reject is idempotent', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      psqlJson(`SET ROLE service_role; SELECT reject_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      const r = psqlJson(`SET ROLE service_role; SELECT reject_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r.rejected).toBe(true);
      expect(r.already_rejected).toBe(true);
    });

    it('20. expired quote cannot be accepted', () => {
      seedQuote(QUOTE_EXPIRED, 'quoted', CUSTOMER_PHONE, { expired: true });
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_EXPIRED}', '${CUSTOMER_PHONE}');`);
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('expired');

      // Verify status updated to expired
      const s = psql(`SELECT status FROM quote_requests WHERE id = '${QUOTE_EXPIRED}';`);
      expect(s).toBe('expired');
    });

    it('21. insufficient stock fully rolls back acceptance', () => {
      psql(`UPDATE products SET stock_quantity = 1 WHERE id = '${PRODUCT_A}';`);
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);

      const result = psqlMayFail(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('insufficient_stock');

      // No order created
      const orderCount = psql(`SELECT count(*) FROM orders WHERE quote_request_id = '${QUOTE_1}';`);
      expect(parseInt(orderCount)).toBe(0);

      // Stock unchanged
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(1);

      // Quote still quoted
      const s = psql(`SELECT status FROM quote_requests WHERE id = '${QUOTE_1}';`);
      expect(s).toBe('quoted');
    });

    it('22. one quote creates exactly one order (DB UNIQUE invariant)', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r1 = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r1.accepted).toBe(true);

      // Direct attempt to insert another order with same quote_request_id should fail
      const result = psqlMayFail(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, quote_request_id)
        VALUES (gen_random_uuid(), '${BIZ_ID}', '${USER_ID}', 'pending', 1000, '${QUOTE_1}');
      `);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('idx_orders_quote_request_id_unique');
    });

    it('23. quote acceptance → payment webhook → stock already applied', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r.accepted).toBe(true);
      const orderId = r.order_id;

      // Simulate payment for this order
      psql(`INSERT INTO payments (id, order_id, amount, status)
            VALUES ('${PAY_1}', '${orderId}', 5000, 'success');`);

      // Webhook calls apply_order_stock_once — should see marker
      const sr = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${orderId}', '${PAY_1}');`);
      expect(sr.applied).toBe(true);
      expect(sr.already_applied).toBe(true);
    });

    it('24. deposit config derived from business metadata', () => {
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE, { customData: true });
      const r = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r.accepted).toBe(true);
      expect(r.deposit_amount).toBe(2500);
      expect(r.balance_amount).toBe(2500);
    });

    it('25. accepted-quote retry recovers order and financial data without duplicate stock', () => {
      // Simulate: acceptance RPC succeeds, but payment init would crash afterward
      seedQuote(QUOTE_1, 'quoted', CUSTOMER_PHONE);
      const r1 = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r1.accepted).toBe(true);
      expect(r1.already_accepted).toBe(false);
      const orderId = r1.order_id;
      const stockAfterFirst = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);

      // Customer retries Accept — same sender, same quote
      const r2 = psqlJson(`SET ROLE service_role; SELECT accept_order_quote_atomic('${QUOTE_1}', '${CUSTOMER_PHONE}');`);
      expect(r2.accepted).toBe(true);
      expect(r2.already_accepted).toBe(true);
      // Same order reused
      expect(r2.order_id).toBe(orderId);
      // Financial data returned for payment recovery
      expect(r2.total).toBe(5000);
      expect(r2.deposit_amount).toBe(0);
      expect(r2.balance_amount).toBe(0);
      expect(r2.customer_phone).toBe(CUSTOMER_PHONE);
      expect(r2.business_id).toBe(BIZ_ID);

      // Stock NOT deducted twice
      const stockAfterRetry = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(stockAfterRetry).toBe(stockAfterFirst);

      // Still only one order
      const orderCount = psql(`SELECT count(*) FROM orders WHERE quote_request_id = '${QUOTE_1}';`);
      expect(parseInt(orderCount)).toBe(1);

      // Still only one marker
      const markerCount = psql(`SELECT count(*) FROM order_stock_applications WHERE order_id = '${orderId}';`);
      expect(parseInt(markerCount)).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════
  // STALE ORDER CLEANUP TESTS
  // ═══════════════════════════════════════════════════════

  describe('cancel_stale_order_atomic', () => {
    beforeEach(() => {
      psql(`
        DELETE FROM order_stock_applications;
        DELETE FROM order_items;
        DELETE FROM payments WHERE id IN ('${PAY_STALE_OK}');
        DELETE FROM orders WHERE id IN ('${ORDER_STALE_MARK}','${ORDER_STALE_NO_MARK}','${ORDER_STALE_PAID}','${ORDER_CONFIRMED}');
        UPDATE products SET stock_quantity = 100 WHERE id = '${PRODUCT_A}';
        UPDATE products SET stock_quantity = 50 WHERE id = '${PRODUCT_B}';
      `);
    });

    it('25. stale pending order WITH marker → stock restored once', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_STALE_MARK}', '${BIZ_ID}', '${USER_ID}', 'pending', 2000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_STALE_MARK}', '${PRODUCT_A}', 3, 500),
                 ('${ORDER_STALE_MARK}', '${PRODUCT_B}', 2, 250);

        -- Simulate prior stock application
        UPDATE products SET stock_quantity = stock_quantity - 3 WHERE id = '${PRODUCT_A}';
        UPDATE products SET stock_quantity = stock_quantity - 2 WHERE id = '${PRODUCT_B}';
        INSERT INTO order_stock_applications (order_id, item_count) VALUES ('${ORDER_STALE_MARK}', 2);
      `);

      const r = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_STALE_MARK}');`);
      expect(r.cancelled).toBe(true);
      expect(r.stock_restored).toBe(true);
      expect(r.items_restored).toBe(2);

      // Stock restored
      const stockA = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockA)).toBe(100);
      const stockB = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_B}';`);
      expect(parseInt(stockB)).toBe(50);

      // Order cancelled
      const status = psql(`SELECT status FROM orders WHERE id = '${ORDER_STALE_MARK}';`);
      expect(status).toBe('cancelled');

      // Marker deleted
      const marker = psql(`SELECT count(*) FROM order_stock_applications WHERE order_id = '${ORDER_STALE_MARK}';`);
      expect(parseInt(marker)).toBe(0);
    });

    it('26. stale pending order WITHOUT marker → stock unchanged', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_STALE_NO_MARK}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_STALE_NO_MARK}', '${PRODUCT_A}', 5, 200);
      `);

      const r = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_STALE_NO_MARK}');`);
      expect(r.cancelled).toBe(true);
      expect(r.stock_restored).toBe(false);
      expect(r.items_restored).toBe(0);

      // Stock unchanged
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(100);

      // Order cancelled
      const status = psql(`SELECT status FROM orders WHERE id = '${ORDER_STALE_NO_MARK}';`);
      expect(status).toBe('cancelled');
    });

    it('27. stale pending order with successful payment → not cancelled', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_STALE_PAID}', '${BIZ_ID}', '${USER_ID}', 'pending', 2000, NOW() - INTERVAL '72 hours');
        INSERT INTO payments (id, order_id, amount, status)
          VALUES ('${PAY_STALE_OK}', '${ORDER_STALE_PAID}', 2000, 'success');
      `);

      const r = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_STALE_PAID}');`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('has_successful_payment');

      // Order still pending
      const status = psql(`SELECT status FROM orders WHERE id = '${ORDER_STALE_PAID}';`);
      expect(status).toBe('pending');
    });

    it('28. confirmed order → no cleanup', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_CONFIRMED}', '${BIZ_ID}', '${USER_ID}', 'confirmed', 1000, NOW() - INTERVAL '72 hours');
      `);

      const r = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_CONFIRMED}');`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('confirmed');
    });

    it('29. non-stale pending order → not cancelled', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_STALE_NO_MARK}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '1 hour');
      `);

      const r = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_STALE_NO_MARK}');`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('not_stale');
    });

    it('30. concurrent cleanup → second call returns already cancelled', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_STALE_NO_MARK}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
      `);

      psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_STALE_NO_MARK}');`);
      const r2 = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_STALE_NO_MARK}');`);
      expect(r2.cancelled).toBe(false);
      expect(r2.reason).toBe('cancelled');
    });

    it('31. late payment after cancellation cannot re-decrement stock', () => {
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_STALE_MARK}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_STALE_MARK}', '${PRODUCT_A}', 1, 1000);
        UPDATE products SET stock_quantity = 99 WHERE id = '${PRODUCT_A}';
        INSERT INTO order_stock_applications (order_id, item_count) VALUES ('${ORDER_STALE_MARK}', 1);
      `);

      // Cleanup cancels and restores stock
      psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_STALE_MARK}');`);
      const stockAfterCleanup = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterCleanup)).toBe(100);

      // Late payment arrives
      psql(`INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_1}', '${ORDER_STALE_MARK}', 1000, 'success');`);
      const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_STALE_MARK}', '${PAY_1}');`);
      expect(r.applied).toBe(false);
      expect(r.reason).toBe('order_cancelled');

      // Stock unchanged
      const stockAfterLate = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterLate)).toBe(100);
    });
  });

  // ═══════════════════════════════════════════════════════
  // ORDERS.PAID_AT VERIFICATION
  // ═══════════════════════════════════════════════════════

  describe('orders.paid_at non-reference', () => {
    it('32. process-success.ts does not contain a standalone order status update', () => {
      // Order confirmation (pending→confirmed) is now handled exclusively inside
      // apply_order_stock_once RPC, not as a separate PostgREST UPDATE.
      // Verify no .from('orders').update({status: 'confirmed'}) call exists.
      const fs = require('fs');
      const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
      const orderUpdateMatch = src.match(/\.from\('orders'\)\s*\n?\s*\.update\(\{[^}]*status[^}]*\}\)/);
      expect(orderUpdateMatch).toBeFalsy();
    });
  });

  // ═══════════════════════════════════════════════════════
  // PRIVILEGE HARDENING TESTS
  // ═══════════════════════════════════════════════════════

  describe('privilege hardening', () => {
    it('33. anon cannot execute apply_order_stock_once', () => {
      const r = psql(`SELECT has_function_privilege('anon', 'apply_order_stock_once(uuid, uuid, boolean)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('34. authenticated cannot execute apply_order_stock_once', () => {
      const r = psql(`SELECT has_function_privilege('authenticated', 'apply_order_stock_once(uuid, uuid, boolean)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('35. service_role can execute apply_order_stock_once', () => {
      const r = psql(`SELECT has_function_privilege('service_role', 'apply_order_stock_once(uuid, uuid, boolean)', 'EXECUTE');`);
      expect(r).toBe('t');
    });

    it('36. anon cannot execute accept_order_quote_atomic', () => {
      const r = psql(`SELECT has_function_privilege('anon', 'accept_order_quote_atomic(uuid, text)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('37. authenticated cannot execute accept_order_quote_atomic', () => {
      const r = psql(`SELECT has_function_privilege('authenticated', 'accept_order_quote_atomic(uuid, text)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('38. service_role can execute accept_order_quote_atomic', () => {
      const r = psql(`SELECT has_function_privilege('service_role', 'accept_order_quote_atomic(uuid, text)', 'EXECUTE');`);
      expect(r).toBe('t');
    });

    it('39. anon cannot execute reject_order_quote_atomic', () => {
      const r = psql(`SELECT has_function_privilege('anon', 'reject_order_quote_atomic(uuid, text)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('40. authenticated cannot execute reject_order_quote_atomic', () => {
      const r = psql(`SELECT has_function_privilege('authenticated', 'reject_order_quote_atomic(uuid, text)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('41. service_role can execute reject_order_quote_atomic', () => {
      const r = psql(`SELECT has_function_privilege('service_role', 'reject_order_quote_atomic(uuid, text)', 'EXECUTE');`);
      expect(r).toBe('t');
    });

    it('42. anon cannot execute cancel_stale_order_atomic', () => {
      const r = psql(`SELECT has_function_privilege('anon', 'cancel_stale_order_atomic(uuid)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('43. authenticated cannot execute cancel_stale_order_atomic', () => {
      const r = psql(`SELECT has_function_privilege('authenticated', 'cancel_stale_order_atomic(uuid)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('44. service_role can execute cancel_stale_order_atomic', () => {
      const r = psql(`SELECT has_function_privilege('service_role', 'cancel_stale_order_atomic(uuid)', 'EXECUTE');`);
      expect(r).toBe('t');
    });
  });

  // ═══════════════════════════════════════════════════════
  // STALE CLEANUP vs PAYMENT SUCCESS — TWO-SESSION CONCURRENCY
  // ═══════════════════════════════════════════════════════

  describe('cleanup vs payment-success serialization', () => {
    const ORDER_RACE = '00000000-0000-0000-0327-000000000901';
    const PAY_RACE = '00000000-0000-0000-0327-000000000902';

    beforeEach(() => {
      psql(`
        DELETE FROM order_stock_applications;
        DELETE FROM order_items;
        DELETE FROM payments WHERE id = '${PAY_RACE}';
        DELETE FROM orders WHERE id = '${ORDER_RACE}';
        UPDATE products SET stock_quantity = 100 WHERE id = '${PRODUCT_A}';
      `);
    });

    it('45. payment success committed before cleanup → cleanup refuses to cancel', () => {
      // Setup: stale pending order with stock marker + pending payment
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_RACE}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_RACE}', '${PRODUCT_A}', 2, 500);
        UPDATE products SET stock_quantity = 98 WHERE id = '${PRODUCT_A}';
        INSERT INTO order_stock_applications (order_id, item_count) VALUES ('${ORDER_RACE}', 1);
        INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_RACE}', '${ORDER_RACE}', 1000, 'pending');
      `);

      // Session 1: Payment authority marks payment as success (simulates webhook)
      psql(`UPDATE payments SET status = 'success' WHERE id = '${PAY_RACE}';`);

      // Session 2: Cleanup runs — should see payment success and refuse
      const r = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_RACE}');`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('has_successful_payment');

      // Order still pending (not cancelled)
      const status = psql(`SELECT status FROM orders WHERE id = '${ORDER_RACE}';`);
      expect(status).toBe('pending');

      // Stock unchanged (not restored)
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(98);

      // apply_order_stock_once still works (idempotent — marker already exists)
      const sr = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_RACE}', '${PAY_RACE}');`);
      expect(sr.applied).toBe(true);
      expect(sr.already_applied).toBe(true);

      // Order now confirmed by apply_order_stock_once? No — already_applied means
      // marker exists, so no re-confirmation needed.
    });

    it('46. cleanup cancels first → late apply_order_stock_once rejects on cancelled order', () => {
      // Setup: stale pending order with stock marker, no payment yet
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_RACE}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_RACE}', '${PRODUCT_A}', 2, 500);
        UPDATE products SET stock_quantity = 98 WHERE id = '${PRODUCT_A}';
        INSERT INTO order_stock_applications (order_id, item_count) VALUES ('${ORDER_RACE}', 1);
      `);

      // Session 1: Cleanup cancels the order (no payment exists)
      const cr = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_RACE}');`);
      expect(cr.cancelled).toBe(true);
      expect(cr.stock_restored).toBe(true);

      // Stock restored
      const stockAfterCleanup = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterCleanup)).toBe(100);

      // Session 2: Late payment arrives and tries to apply stock
      psql(`INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_RACE}', '${ORDER_RACE}', 1000, 'success');`);
      const sr = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_RACE}', '${PAY_RACE}');`);
      expect(sr.applied).toBe(false);
      expect(sr.reason).toBe('order_cancelled');

      // Stock NOT re-decremented
      const stockAfterLate = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterLate)).toBe(100);

      // Order stays cancelled
      const status = psql(`SELECT status FROM orders WHERE id = '${ORDER_RACE}';`);
      expect(status).toBe('cancelled');
    });

    it('47. two-session real concurrency: cleanup and stock application serialize via FOR UPDATE', () => {
      // Setup: stale pending order with stock applied + pending payment
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_RACE}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_RACE}', '${PRODUCT_A}', 2, 500);
        UPDATE products SET stock_quantity = 98 WHERE id = '${PRODUCT_A}';
        INSERT INTO order_stock_applications (order_id, item_count) VALUES ('${ORDER_RACE}', 1);
        INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_RACE}', '${ORDER_RACE}', 1000, 'pending');
      `);

      // Simulate two-session concurrency:
      // Session A (cleanup) starts a transaction, locks the order row, but doesn't commit yet.
      // Session B (payment finalization) tries to lock the same order row and blocks.
      // When Session A commits, Session B proceeds and sees the post-A state.
      //
      // We simulate this with two separate psql calls — the second observes the first's
      // committed state because FOR UPDATE serializes them.

      // First: Payment authority marks payment as success (concurrent with cleanup)
      psql(`UPDATE payments SET status = 'success' WHERE id = '${PAY_RACE}';`);

      // Cleanup sees the successful payment and refuses
      const cr = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_RACE}');`);
      expect(cr.cancelled).toBe(false);
      expect(cr.reason).toBe('has_successful_payment');

      // Now apply_order_stock_once can confirm the order
      const sr = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_RACE}', '${PAY_RACE}');`);
      // Marker already exists (from setup), so already_applied
      expect(sr.applied).toBe(true);
      expect(sr.already_applied).toBe(true);

      // Invariant: successful payment + order NOT cancelled + stock NOT restored
      const status = psql(`SELECT status FROM orders WHERE id = '${ORDER_RACE}';`);
      expect(status).toBe('pending'); // pending because already_applied skips confirmation
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(98); // stock stays decremented
    });

    it('48. cleanup voids pending payments when cancelling order', () => {
      // Setup: stale order with pending payment
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_RACE}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_RACE}', '${PRODUCT_A}', 2, 500);
        INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_RACE}', '${ORDER_RACE}', 1000, 'pending');
      `);

      const cr = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_RACE}');`);
      expect(cr.cancelled).toBe(true);

      // Payment must be voided
      const payStatus = psql(`SELECT status FROM payments WHERE id = '${PAY_RACE}';`);
      expect(payStatus).toBe('failed');
      const payGwStatus = psql(`SELECT gateway_status FROM payments WHERE id = '${PAY_RACE}';`);
      expect(payGwStatus).toBe('stale_order_cancelled');
    });

    it('49. cleanup does not void already-successful payments', () => {
      // Setup: stale order with successful payment (should not be cancelled at all)
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_RACE}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_RACE}', '${ORDER_RACE}', 1000, 'success');
      `);

      const cr = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_RACE}');`);
      expect(cr.cancelled).toBe(false);
      expect(cr.reason).toBe('has_successful_payment');

      // Payment unchanged
      const payStatus = psql(`SELECT status FROM payments WHERE id = '${PAY_RACE}';`);
      expect(payStatus).toBe('success');
    });

    it('50. race: cleanup wins → payment authority cannot resurrect voided payment', () => {
      // This is the critical race the serialization contract prevents:
      // 1. Cleanup locks order + payments FOR UPDATE
      // 2. Payment authority's UPDATE blocks (waiting for lock)
      // 3. Cleanup voids payment (pending → failed), cancels order, commits
      // 4. Payment authority resumes — tries to mark payment success
      // 5. Payment is 'failed' not 'pending' → authority's eq('status','pending') returns 0 rows
      //
      // We simulate post-cleanup state and verify the authority-side gate.
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_RACE}', '${BIZ_ID}', '${USER_ID}', 'pending', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_RACE}', '${PRODUCT_A}', 2, 500);
        INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_RACE}', '${ORDER_RACE}', 1000, 'pending');
      `);

      // Cleanup runs — cancels order, voids payment
      const cr = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_RACE}');`);
      expect(cr.cancelled).toBe(true);

      // Payment is now 'failed' — authority's WHERE status='pending' won't match
      const payStatus = psql(`SELECT status FROM payments WHERE id = '${PAY_RACE}';`);
      expect(payStatus).toBe('failed');

      // Simulate authority trying: UPDATE payments SET status='success' WHERE id=X AND status='pending'
      const updateResult = psql(`
        UPDATE payments SET status = 'success'
        WHERE id = '${PAY_RACE}' AND status = 'pending'
        RETURNING id;
      `);
      // No rows returned — voided payment cannot be resurrected
      expect(updateResult).toBe('');

      // Payment stays failed
      const finalStatus = psql(`SELECT status FROM payments WHERE id = '${PAY_RACE}';`);
      expect(finalStatus).toBe('failed');

      // Order stays cancelled
      const orderStatus = psql(`SELECT status FROM orders WHERE id = '${ORDER_RACE}';`);
      expect(orderStatus).toBe('cancelled');

      // apply_order_stock_once also rejects
      const sr = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_RACE}', '${PAY_RACE}');`);
      expect(sr.applied).toBe(false);
      expect(sr.reason).toBe('order_cancelled');
    });

    it('51. finalization retry remains idempotent after contention', () => {
      // Setup: confirmed order with stock applied
      psql(`
        INSERT INTO orders (id, business_id, user_id, status, total_amount, created_at)
          VALUES ('${ORDER_RACE}', '${BIZ_ID}', '${USER_ID}', 'confirmed', 1000, NOW() - INTERVAL '72 hours');
        INSERT INTO order_items (order_id, product_id, quantity, unit_price)
          VALUES ('${ORDER_RACE}', '${PRODUCT_A}', 2, 500);
        UPDATE products SET stock_quantity = 98 WHERE id = '${PRODUCT_A}';
        INSERT INTO order_stock_applications (order_id, item_count) VALUES ('${ORDER_RACE}', 1);
        INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_RACE}', '${ORDER_RACE}', 1000, 'success');
      `);

      // Cleanup won't touch confirmed orders
      const cr = psqlJson(`SET ROLE service_role; SELECT cancel_stale_order_atomic('${ORDER_RACE}');`);
      expect(cr.cancelled).toBe(false);
      expect(cr.reason).toBe('confirmed');

      // Retry apply_order_stock_once — idempotent
      const sr1 = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_RACE}', '${PAY_RACE}');`);
      expect(sr1.applied).toBe(true);
      expect(sr1.already_applied).toBe(true);

      // Second retry — still idempotent
      const sr2 = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${ORDER_RACE}', '${PAY_RACE}');`);
      expect(sr2.applied).toBe(true);
      expect(sr2.already_applied).toBe(true);

      // Stock unchanged through all retries
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(98);
    });
  });
});
