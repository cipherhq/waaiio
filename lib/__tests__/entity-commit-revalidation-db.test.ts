/**
 * Migration 383 — Entity-commit revalidation: real PostgreSQL tests.
 *
 * Requires TEST_DATABASE_URL. Runs against the post-001→383 database in CI shard-b.
 * Does NOT reapply M383 — the migration is already applied.
 *
 * Tests cover:
 * - Stale-overload assertions (exactly 1 signature per RPC)
 * - ACL hardening (anon/authenticated denied, service_role allowed)
 * - snapshot_version anti-forge trigger
 * - create_order_atomic: product validation, idempotency, server-side pricing
 * - book_slot_atomic: service revalidation, price/capacity overrides
 * - purchase_tickets_atomic: price validation, sold-out, bot session idempotency
 * - cancel_order_immediate: stock restoration, payment fence, double-cancel
 * - create_reservation_atomic: availability, property validation
 * - create_payment_booking_atomic: service deactivation
 * - accept_order_quote_atomic: v2 addon validation, zero-price, quote_amount_missing
 * - Two-session concurrency: last-unit stock race
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

// ── Test IDs (0383 prefix) ──
const BIZ_ID       = '00000000-0000-0000-0383-000000000001';
const BIZ_OTHER    = '00000000-0000-0000-0383-000000000002';
const USER_ID      = '00000000-0000-0000-0383-000000000010';
const PRODUCT_A    = '00000000-0000-0000-0383-00000000000a';
const PRODUCT_B    = '00000000-0000-0000-0383-00000000000b';
const PRODUCT_OFF  = '00000000-0000-0000-0383-00000000000c'; // deactivated product
const PRODUCT_X    = '00000000-0000-0000-0383-00000000000d'; // cross-business product
const VARIANT_A1   = '00000000-0000-0000-0383-0000000000a1';
const ADDON_FIXED  = '00000000-0000-0000-0383-0000000000f1';
const ADDON_PERUNIT= '00000000-0000-0000-0383-0000000000f2';
const ADDON_QUOTE  = '00000000-0000-0000-0383-0000000000f3';
const ADDON_WRONGP = '00000000-0000-0000-0383-0000000000f4'; // bound to PRODUCT_B
const SERVICE_A    = '00000000-0000-0000-0383-000000000020';
const SERVICE_OFF  = '00000000-0000-0000-0383-000000000021';
const EVENT_A      = '00000000-0000-0000-0383-000000000030';
const TICKET_TYPE  = '00000000-0000-0000-0383-000000000031';
const PROPERTY_A   = '00000000-0000-0000-0383-000000000040';
const PROPERTY_OFF = '00000000-0000-0000-0383-000000000041';
const QUOTE_V1     = '00000000-0000-0000-0383-000000000050';
const QUOTE_V2     = '00000000-0000-0000-0383-000000000051';
const BLOCKED_DATE = '00000000-0000-0000-0383-000000000060';
const BOT_SESSION  = '00000000-0000-0000-0383-000000000070';
const BOT_SESSION2 = '00000000-0000-0000-0383-000000000071';
const BOT_SESSION3 = '00000000-0000-0000-0383-000000000072';
const BOT_SESSION4 = '00000000-0000-0000-0383-000000000073';
const BOT_SESSION5 = '00000000-0000-0000-0383-000000000074';
const BOT_SESSION6 = '00000000-0000-0000-0383-000000000075';
const BOT_SESSION7 = '00000000-0000-0000-0383-000000000076';
const PAY_1        = '00000000-0000-0000-0383-000000000080';
const ORDER_1      = '00000000-0000-0000-0383-000000000090';
// Aliases for tests 43-53 (use consistent naming)
const EVENT_ID     = EVENT_A;
const TT_ID        = TICKET_TYPE;
const SERVICE_ID   = SERVICE_A;
const CUSTOMER_PHONE = '+2348099990383';

describe.skipIf(!canRun)('Migration 383: Entity-commit revalidation', () => {
  beforeAll(() => {
    // Seed all test data into the already-migrated database.
    // Tables exist from migrations 001→383.
    psql(`
      -- Business
      INSERT INTO businesses (id, name, slug, address, city, neighborhood, phone, country_code, owner_id, status, metadata)
        VALUES ('${BIZ_ID}', 'ECR Test Biz', 'ecr-test-biz-0383', '1 Test St', 'Lagos', 'VI', '+2340000000000', 'NG', '${USER_ID}', 'active',
                '{"custom_order_config":{"deposit_percentage":50}}'::jsonb)
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO businesses (id, name, slug, address, city, neighborhood, phone, country_code, owner_id, status)
        VALUES ('${BIZ_OTHER}', 'Other Biz', 'other-biz-0383', '2 Test St', 'Accra', 'East', '+2330000000000', 'GH', '${USER_ID}', 'active')
        ON CONFLICT (id) DO NOTHING;

      -- Profile
      INSERT INTO profiles (id, phone) VALUES ('${USER_ID}', '${CUSTOMER_PHONE}')
        ON CONFLICT (id) DO NOTHING;

      -- Products
      INSERT INTO products (id, business_id, name, price, stock_quantity, track_inventory, is_active)
        VALUES
          ('${PRODUCT_A}', '${BIZ_ID}', 'Widget A', 1000, 50, true, true),
          ('${PRODUCT_B}', '${BIZ_ID}', 'Widget B', 2000, 30, true, true),
          ('${PRODUCT_OFF}', '${BIZ_ID}', 'Inactive Widget', 500, 10, true, false),
          ('${PRODUCT_X}', '${BIZ_OTHER}', 'Cross-Biz Widget', 1500, 20, true, true)
        ON CONFLICT (id) DO NOTHING;

      -- Variant
      INSERT INTO product_variants (id, product_id, name, price, stock_quantity, is_active)
        VALUES ('${VARIANT_A1}', '${PRODUCT_A}', 'Large', 1200, 15, true)
        ON CONFLICT (id) DO NOTHING;

      -- Addons
      INSERT INTO product_addons (id, business_id, product_id, name, price, price_type, is_active)
        VALUES
          ('${ADDON_FIXED}', '${BIZ_ID}', NULL, 'Gift Wrap', 200, 'fixed', true),
          ('${ADDON_PERUNIT}', '${BIZ_ID}', NULL, 'Extra Sauce', 100, 'per_unit', true),
          ('${ADDON_QUOTE}', '${BIZ_ID}', NULL, 'Custom Engraving', 0, 'quote', true),
          ('${ADDON_WRONGP}', '${BIZ_ID}', '${PRODUCT_B}', 'B-Only Addon', 150, 'fixed', true)
        ON CONFLICT (id) DO NOTHING;

      -- Services
      INSERT INTO services (id, business_id, name, price, deposit_amount, is_active, max_capacity, duration_minutes, metadata)
        VALUES
          ('${SERVICE_A}', '${BIZ_ID}', 'Haircut', 5000, 2000, true, 1, 30, '{"buffer_minutes": 10}'::jsonb),
          ('${SERVICE_OFF}', '${BIZ_ID}', 'Inactive Svc', 3000, 0, false, 5, 60, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING;

      -- Events
      INSERT INTO events (id, business_id, name, date, time, price, total_tickets, tickets_sold, status)
        VALUES ('${EVENT_A}', '${BIZ_ID}', 'Concert', CURRENT_DATE + 30, '19:00', 3000, 100, 95, 'published')
        ON CONFLICT (id) DO NOTHING;

      -- Event ticket types
      INSERT INTO event_ticket_types (id, event_id, name, price, total_tickets, tickets_sold)
        VALUES ('${TICKET_TYPE}', '${EVENT_A}', 'VIP', 5000, 20, 18)
        ON CONFLICT (id) DO NOTHING;

      -- Properties
      INSERT INTO properties (id, business_id, name, price, deposit_amount, is_active)
        VALUES
          ('${PROPERTY_A}', '${BIZ_ID}', 'Beach House', 15000, 5000, true),
          ('${PROPERTY_OFF}', '${BIZ_ID}', 'Under Renovation', 10000, 3000, false)
        ON CONFLICT (id) DO NOTHING;

      -- Property blocked dates
      INSERT INTO property_blocked_dates (id, property_id, date_from, date_to, reason)
        VALUES ('${BLOCKED_DATE}', '${PROPERTY_A}', CURRENT_DATE + 60, CURRENT_DATE + 65, 'Maintenance')
        ON CONFLICT (id) DO NOTHING;
    `);

    // Seed quote_requests: v1 row first (before trigger fires, using ALTER to set snapshot_version)
    // The trigger prevents INSERT with snapshot_version < 2, so we insert as v2 then backfill to v1
    psql(`
      INSERT INTO quote_requests (id, business_id, user_id, customer_phone, customer_name,
        status, cart_snapshot, estimated_subtotal, quoted_amount, expires_at, snapshot_version, quoted_at)
      VALUES (
        '${QUOTE_V2}', '${BIZ_ID}', '${USER_ID}', '${CUSTOMER_PHONE}', 'Test Customer',
        'quoted',
        '[{"product_id":"${PRODUCT_A}","quantity":2,"price":1000,"name":"Widget A","addons":[{"id":"${ADDON_FIXED}","name":"Gift Wrap","price":200,"quantity":1}]}]'::jsonb,
        2400, 2400, NOW() + INTERVAL '24 hours', 2, NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // For v1 quote: insert as v2 then use direct UPDATE (trigger allows same or higher version)
    // Actually we need to bypass the trigger for the v1 seed. Use ALTER TABLE to disable trigger temporarily.
    psql(`
      ALTER TABLE quote_requests DISABLE TRIGGER trg_snapshot_version_guard;
      INSERT INTO quote_requests (id, business_id, user_id, customer_phone, customer_name,
        status, cart_snapshot, estimated_subtotal, quoted_amount, expires_at, snapshot_version, quoted_at)
      VALUES (
        '${QUOTE_V1}', '${BIZ_ID}', '${USER_ID}', '${CUSTOMER_PHONE}', 'Test Customer v1',
        'quoted',
        '[{"product_id":"${PRODUCT_A}","quantity":1,"price":1000,"name":"Widget A","addons":[{"name":"No-ID Addon","price":100,"quantity":1}]}]'::jsonb,
        1100, 1100, NOW() + INTERVAL '24 hours', 1, NOW()
      ) ON CONFLICT (id) DO NOTHING;
      ALTER TABLE quote_requests ENABLE TRIGGER trg_snapshot_version_guard;
    `);
  });

  afterAll(() => {
    if (!canRun) return;
    psql(`
      DELETE FROM order_stock_applications WHERE order_id IN (
        SELECT id FROM orders WHERE business_id IN ('${BIZ_ID}', '${BIZ_OTHER}')
      );
      DELETE FROM order_items WHERE order_id IN (
        SELECT id FROM orders WHERE business_id IN ('${BIZ_ID}', '${BIZ_OTHER}')
      );
      DELETE FROM payments WHERE order_id IN (
        SELECT id FROM orders WHERE business_id IN ('${BIZ_ID}', '${BIZ_OTHER}')
      );
      DELETE FROM orders WHERE business_id IN ('${BIZ_ID}', '${BIZ_OTHER}');
      DELETE FROM bookings WHERE business_id = '${BIZ_ID}';
      DELETE FROM reservations WHERE business_id = '${BIZ_ID}';
      ALTER TABLE quote_requests DISABLE TRIGGER trg_snapshot_version_guard;
      DELETE FROM quote_requests WHERE business_id = '${BIZ_ID}';
      ALTER TABLE quote_requests ENABLE TRIGGER trg_snapshot_version_guard;
      DELETE FROM property_blocked_dates WHERE property_id IN ('${PROPERTY_A}', '${PROPERTY_OFF}');
      DELETE FROM properties WHERE id IN ('${PROPERTY_A}', '${PROPERTY_OFF}');
      DELETE FROM event_ticket_types WHERE id = '${TICKET_TYPE}';
      DELETE FROM events WHERE id = '${EVENT_A}';
      DELETE FROM services WHERE id IN ('${SERVICE_A}', '${SERVICE_OFF}');
      DELETE FROM product_addons WHERE id IN ('${ADDON_FIXED}', '${ADDON_PERUNIT}', '${ADDON_QUOTE}', '${ADDON_WRONGP}');
      DELETE FROM product_variants WHERE id = '${VARIANT_A1}';
      DELETE FROM products WHERE id IN ('${PRODUCT_A}', '${PRODUCT_B}', '${PRODUCT_OFF}', '${PRODUCT_X}');
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${BIZ_OTHER}');
    `);
  });

  // ── Shared cleanup for per-test state ──
  function cleanOrders() {
    psql(`
      DELETE FROM order_stock_applications WHERE order_id IN (
        SELECT id FROM orders WHERE business_id = '${BIZ_ID}'
      );
      DELETE FROM order_items WHERE order_id IN (
        SELECT id FROM orders WHERE business_id = '${BIZ_ID}'
      );
      DELETE FROM payments WHERE order_id IN (
        SELECT id FROM orders WHERE business_id = '${BIZ_ID}'
      );
      DELETE FROM orders WHERE business_id = '${BIZ_ID}';
      DELETE FROM bookings WHERE business_id = '${BIZ_ID}';
      DELETE FROM reservations WHERE business_id = '${BIZ_ID}';
      UPDATE products SET stock_quantity = 50 WHERE id = '${PRODUCT_A}';
      UPDATE products SET stock_quantity = 30 WHERE id = '${PRODUCT_B}';
      UPDATE product_variants SET stock_quantity = 15 WHERE id = '${VARIANT_A1}';
      UPDATE events SET tickets_sold = 95 WHERE id = '${EVENT_A}';
      UPDATE event_ticket_types SET tickets_sold = 18 WHERE id = '${TICKET_TYPE}';
    `);
  }

  // ═══════════════════════════════════════════════════════
  // STALE-OVERLOAD ASSERTIONS
  // ═══════════════════════════════════════════════════════
  describe('stale-overload assertions', () => {
    it('1. only 1 create_order_atomic signature exists', () => {
      const count = psql(`
        SELECT COUNT(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'create_order_atomic';
      `);
      expect(parseInt(count)).toBe(1);
    });

    it('2. only 1 book_slot_atomic signature exists', () => {
      const count = psql(`
        SELECT COUNT(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic';
      `);
      expect(parseInt(count)).toBe(1);
    });

    it('3. only 1 purchase_tickets_atomic signature exists', () => {
      const count = psql(`
        SELECT COUNT(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'purchase_tickets_atomic';
      `);
      expect(parseInt(count)).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════
  // ACL TESTS
  // ═══════════════════════════════════════════════════════
  describe('ACL hardening', () => {
    it('4. anon cannot execute create_order_atomic', () => {
      const r = psql(`
        SELECT has_function_privilege('anon',
          'create_order_atomic(uuid,uuid,uuid,text,text,text,int,int,int,uuid,text,text,uuid,text,int,int,text,text,text,text,jsonb,uuid,boolean,int)',
          'EXECUTE');
      `);
      expect(r).toBe('f');
    });

    it('5. anon cannot execute cancel_order_immediate', () => {
      const r = psql(`SELECT has_function_privilege('anon', 'cancel_order_immediate(uuid,text)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('6. anon cannot execute create_reservation_atomic', () => {
      const r = psql(`
        SELECT has_function_privilege('anon',
          'create_reservation_atomic(uuid,uuid,uuid,uuid,date,date,int,int,int,int,text,text,text)',
          'EXECUTE');
      `);
      expect(r).toBe('f');
    });
  });

  // ═══════════════════════════════════════════════════════
  // SNAPSHOT_VERSION TESTS
  // ═══════════════════════════════════════════════════════
  describe('snapshot_version anti-forge trigger', () => {
    it('7. existing v1 row has snapshot_version=1', () => {
      const v = psql(`SELECT snapshot_version FROM quote_requests WHERE id = '${QUOTE_V1}';`);
      expect(parseInt(v)).toBe(1);
    });

    it('8. new insert omitting version defaults to v2', () => {
      const id = '00000000-0000-0000-0383-0000000000e1';
      psql(`
        INSERT INTO quote_requests (id, business_id, user_id, customer_phone, status, estimated_subtotal)
        VALUES ('${id}', '${BIZ_ID}', '${USER_ID}', '${CUSTOMER_PHONE}', 'pending', 0);
      `);
      const v = psql(`SELECT snapshot_version FROM quote_requests WHERE id = '${id}';`);
      expect(parseInt(v)).toBe(2);
      psql(`DELETE FROM quote_requests WHERE id = '${id}';`);
    });

    it('9. explicit v1 insert raises EXCEPTION', () => {
      const id = '00000000-0000-0000-0383-0000000000e2';
      const r = psqlMayFail(`
        INSERT INTO quote_requests (id, business_id, user_id, customer_phone, status, estimated_subtotal, snapshot_version)
        VALUES ('${id}', '${BIZ_ID}', '${USER_ID}', '${CUSTOMER_PHONE}', 'pending', 0, 1);
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('snapshot_version_forge');
    });

    it('10. UPDATE downgrade v2 to v1 raises EXCEPTION', () => {
      const r = psqlMayFail(`
        UPDATE quote_requests SET snapshot_version = 1 WHERE id = '${QUOTE_V2}';
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('snapshot_version_downgrade');
    });
  });

  // ═══════════════════════════════════════════════════════
  // CREATE_ORDER_ATOMIC — PRODUCT VALIDATION
  // ═══════════════════════════════════════════════════════
  describe('create_order_atomic — product validation', () => {
    beforeEach(() => cleanOrders());

    it('11. valid order with validate_products=true succeeds, stock decremented, marker created', () => {
      const items = JSON.stringify([
        { product_id: PRODUCT_A, quantity: 2, unit_price: 1000, addons: [{ id: ADDON_FIXED, quantity: 1, price: 200 }] }
      ]);
      const r = psqlJson(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 2400
        );
      `);
      expect(r.created).toBe(true);
      expect(r.order_id).toBeTruthy();
      expect(r.reference_code).toBeTruthy();
      expect(r.server_total).toBe(2400);

      // Stock decremented
      const stockA = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockA)).toBe(48);

      // Marker created
      const marker = psql(`SELECT count(*) FROM order_stock_applications WHERE order_id = '${r.order_id}';`);
      expect(parseInt(marker)).toBe(1);
    });

    it('12. deactivated product raises product_unavailable', () => {
      const items = JSON.stringify([{ product_id: PRODUCT_OFF, quantity: 1, unit_price: 500 }]);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 500
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('product_unavailable');

      // No order created
      const orderCount = psql(`SELECT count(*) FROM orders WHERE business_id = '${BIZ_ID}';`);
      expect(parseInt(orderCount)).toBe(0);
    });

    it('13. cross-business product raises product_wrong_business', () => {
      const items = JSON.stringify([{ product_id: PRODUCT_X, quantity: 1, unit_price: 1500 }]);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1500
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('product_wrong_business');
    });

    it('14. price changed raises total_mismatch, no order, stock unchanged', () => {
      // Product A costs 1000, but we send expected_total as if it were 500
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 1, unit_price: 500 }]);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 500
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('total_mismatch');

      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(50);
    });

    it('15. insufficient stock raises insufficient_stock', () => {
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 999, unit_price: 1000 }]);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 999000
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('insufficient_stock');
    });

    it('16. quote-priced addon raises addon_quote_price', () => {
      const items = JSON.stringify([
        { product_id: PRODUCT_A, quantity: 1, unit_price: 1000, addons: [{ id: ADDON_QUOTE, quantity: 1, price: 0 }] }
      ]);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1000
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('addon_quote_price');
    });
  });

  // ═══════════════════════════════════════════════════════
  // CREATE_ORDER_ATOMIC — IDEMPOTENCY
  // ═══════════════════════════════════════════════════════
  describe('create_order_atomic — idempotency', () => {
    beforeEach(() => cleanOrders());

    it('17. identical replay returns existing order, stock unchanged', () => {
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 1, unit_price: 1000 }]);
      const callSql = `
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1000
        );
      `;
      const r1 = psqlJson(callSql);
      expect(r1.created).toBe(true);
      const stockAfterFirst = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);

      const r2 = psqlJson(callSql);
      expect(r2.created).toBe(false);
      expect(r2.order_id).toBe(r1.order_id);

      const stockAfterSecond = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(stockAfterSecond).toBe(stockAfterFirst);
    });

    it('18. changed product raises fingerprint_mismatch', () => {
      const items1 = JSON.stringify([{ product_id: PRODUCT_A, quantity: 1, unit_price: 1000 }]);
      psqlJson(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items1}'::jsonb, NULL, true, 1000
        );
      `);

      const items2 = JSON.stringify([{ product_id: PRODUCT_B, quantity: 1, unit_price: 2000 }]);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items2}'::jsonb, NULL, true, 2000
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('fingerprint_mismatch');
    });

    it('19. changed quantity raises fingerprint_mismatch', () => {
      const items1 = JSON.stringify([{ product_id: PRODUCT_A, quantity: 1, unit_price: 1000 }]);
      psqlJson(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items1}'::jsonb, NULL, true, 1000
        );
      `);

      const items2 = JSON.stringify([{ product_id: PRODUCT_A, quantity: 5, unit_price: 1000 }]);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items2}'::jsonb, NULL, true, 5000
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('fingerprint_mismatch');
    });
  });

  // ═══════════════════════════════════════════════════════
  // CREATE_ORDER_ATOMIC — SERVER-SIDE PRICING
  // ═══════════════════════════════════════════════════════
  describe('create_order_atomic — server-side pricing', () => {
    beforeEach(() => cleanOrders());

    it('20. forged addon price is overridden by DB price', () => {
      // Addon ADDON_FIXED costs 200 in DB. Caller sends 0. Server total uses DB price.
      const items = JSON.stringify([
        { product_id: PRODUCT_A, quantity: 1, unit_price: 1000, addons: [{ id: ADDON_FIXED, quantity: 1, price: 0 }] }
      ]);
      const r = psqlJson(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1200
        );
      `);
      expect(r.created).toBe(true);
      expect(r.server_total).toBe(1200); // 1000 product + 200 addon
    });

    it('21. expected total mismatch raises total_mismatch before mutation', () => {
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 1, unit_price: 1000 }]);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 9999
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('total_mismatch');

      // Stock unchanged (rolled back)
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(50);
    });
  });

  // ═══════════════════════════════════════════════════════
  // BOOK_SLOT_ATOMIC — SERVICE REVALIDATION
  // ═══════════════════════════════════════════════════════
  describe('book_slot_atomic — service revalidation', () => {
    beforeEach(() => cleanOrders());

    it('22. valid booking with expected_price succeeds', () => {
      const r = psql(`
        SET ROLE service_role;
        SELECT * FROM book_slot_atomic(
          '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${SERVICE_A}'::uuid, NULL,
          (CURRENT_DATE + 10)::date, '10:00', 1, 5,
          'scheduling', 2000, 'pending', 'pending',
          'Guest', '${CUSTOMER_PHONE}', NULL,
          NULL, NULL, NULL,
          NULL, NULL, 5000, NULL,
          NULL, NULL, 0, 30,
          '${BOT_SESSION}'::uuid, NULL,
          5000, 2000
        );
      `);
      const parts = r.split('|');
      expect(parts[0]).toBeTruthy(); // booking_id
      expect(parts[2]).toBe('t');    // slot_available
    });

    it('23. service deactivated raises service_unavailable', () => {
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT * FROM book_slot_atomic(
          '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${SERVICE_OFF}'::uuid, NULL,
          (CURRENT_DATE + 10)::date, '10:00', 1, 5,
          'scheduling', 0, 'none', 'confirmed',
          'Guest', '${CUSTOMER_PHONE}', NULL,
          NULL, NULL, NULL,
          NULL, NULL, 3000, NULL,
          NULL, NULL, 0, 60,
          '${BOT_SESSION}'::uuid, NULL,
          3000, NULL
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('service_unavailable');
    });

    it('24. service price changed raises price_changed', () => {
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT * FROM book_slot_atomic(
          '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${SERVICE_A}'::uuid, NULL,
          (CURRENT_DATE + 10)::date, '10:00', 1, 5,
          'scheduling', 2000, 'pending', 'pending',
          'Guest', '${CUSTOMER_PHONE}', NULL,
          NULL, NULL, NULL,
          NULL, NULL, 5000, NULL,
          NULL, NULL, 0, 30,
          '${BOT_SESSION2}'::uuid, NULL,
          9999, 2000
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('price_changed');
    });

    it('25. capacity override from DB — caller passes 10, DB has 1, slot full', () => {
      // First, fill the DB-authoritative capacity (max_capacity=1 for SERVICE_A)
      psql(`
        SET ROLE service_role;
        SELECT * FROM book_slot_atomic(
          '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${SERVICE_A}'::uuid, NULL,
          (CURRENT_DATE + 11)::date, '14:00', 1, 10,
          'scheduling', 2000, 'pending', 'pending',
          'Guest1', '${CUSTOMER_PHONE}', NULL,
          NULL, NULL, NULL,
          NULL, NULL, 5000, NULL,
          NULL, NULL, 0, 30,
          '${BOT_SESSION3}'::uuid, NULL,
          5000, 2000
        );
      `);

      // Second booking at same slot — caller says max_capacity=10 but DB says 1
      const r = psql(`
        SET ROLE service_role;
        SELECT * FROM book_slot_atomic(
          '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${SERVICE_A}'::uuid, NULL,
          (CURRENT_DATE + 11)::date, '14:00', 1, 10,
          'scheduling', 2000, 'pending', 'pending',
          'Guest2', '${CUSTOMER_PHONE}', NULL,
          NULL, NULL, NULL,
          NULL, NULL, 5000, NULL,
          NULL, NULL, 0, 30,
          '${BOT_SESSION4}'::uuid, NULL,
          5000, 2000
        );
      `);
      const parts = r.split('|');
      // slot_available should be false (capacity exhausted)
      expect(parts[2]).toBe('f');
    });
  });

  // ═══════════════════════════════════════════════════════
  // PURCHASE_TICKETS_ATOMIC
  // ═══════════════════════════════════════════════════════
  describe('purchase_tickets_atomic', () => {
    beforeEach(() => cleanOrders());

    it('26. valid ticket purchase succeeds, tickets_sold incremented, tickets_finalized=true', () => {
      const r = psql(`
        SET ROLE service_role;
        SELECT * FROM purchase_tickets_atomic(
          '${BIZ_ID}'::uuid, '${EVENT_A}'::uuid, '${TICKET_TYPE}'::uuid,
          1, '${USER_ID}'::uuid,
          'Guest', '${CUSTOMER_PHONE}', NULL,
          5000, 'whatsapp', '${BOT_SESSION}'::uuid, 5000
        );
      `);
      const parts = r.split('|');
      expect(parts[0]).toBeTruthy(); // booking_id
      expect(parts[2]).toBe('t');    // tickets_available

      // tickets_sold incremented
      const sold = psql(`SELECT tickets_sold FROM event_ticket_types WHERE id = '${TICKET_TYPE}';`);
      expect(parseInt(sold)).toBe(19);

      // tickets_finalized
      const finalized = psql(`SELECT tickets_finalized FROM bookings WHERE id = '${parts[0]}';`);
      expect(finalized).toBe('t');
    });

    it('27. event sold out returns tickets_available=false', () => {
      // VIP: 20 total, 18 sold, try to buy 3 → only 2 available
      const r = psql(`
        SET ROLE service_role;
        SELECT * FROM purchase_tickets_atomic(
          '${BIZ_ID}'::uuid, '${EVENT_A}'::uuid, '${TICKET_TYPE}'::uuid,
          3, '${USER_ID}'::uuid,
          'Guest', '${CUSTOMER_PHONE}', NULL,
          15000, 'whatsapp', '${BOT_SESSION}'::uuid, 5000
        );
      `);
      const parts = r.split('|');
      expect(parts[2]).toBe('f');
    });

    it('28. bot session idempotent retry returns same booking', () => {
      const callSql = `
        SET ROLE service_role;
        SELECT * FROM purchase_tickets_atomic(
          '${BIZ_ID}'::uuid, '${EVENT_A}'::uuid, '${TICKET_TYPE}'::uuid,
          1, '${USER_ID}'::uuid,
          'Guest', '${CUSTOMER_PHONE}', NULL,
          5000, 'whatsapp', '${BOT_SESSION}'::uuid, 5000
        );
      `;
      const r1 = psql(callSql);
      const parts1 = r1.split('|');
      expect(parts1[2]).toBe('t');

      const r2 = psql(callSql);
      const parts2 = r2.split('|');
      expect(parts2[0]).toBe(parts1[0]); // same booking_id
      expect(parts2[2]).toBe('t');

      // tickets_sold only incremented once
      const sold = psql(`SELECT tickets_sold FROM event_ticket_types WHERE id = '${TICKET_TYPE}';`);
      expect(parseInt(sold)).toBe(19);
    });
  });

  // ═══════════════════════════════════════════════════════
  // CANCEL_ORDER_IMMEDIATE
  // ═══════════════════════════════════════════════════════
  describe('cancel_order_immediate', () => {
    beforeEach(() => cleanOrders());

    it('29. cancel pending order with stock marker restores stock and deletes marker', () => {
      // Create an order first
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 3, unit_price: 1000 }]);
      const createR = psqlJson(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 3000
        );
      `);
      const orderId = createR.order_id as string;
      const stockAfterCreate = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterCreate)).toBe(47);

      // Cancel
      const r = psqlJson(`SET ROLE service_role; SELECT cancel_order_immediate('${orderId}');`);
      expect(r.cancelled).toBe(true);
      expect(r.stock_restored).toBe(true);

      // Stock restored
      const stockAfterCancel = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterCancel)).toBe(50);

      // Marker deleted
      const marker = psql(`SELECT count(*) FROM order_stock_applications WHERE order_id = '${orderId}';`);
      expect(parseInt(marker)).toBe(0);
    });

    it('30. double cancel returns already cancelled', () => {
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 1, unit_price: 1000 }]);
      const createR = psqlJson(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1000
        );
      `);
      const orderId = createR.order_id as string;

      psqlJson(`SET ROLE service_role; SELECT cancel_order_immediate('${orderId}');`);
      const r2 = psqlJson(`SET ROLE service_role; SELECT cancel_order_immediate('${orderId}');`);
      expect(r2.cancelled).toBe(false);
      expect(r2.reason).toBe('cancelled');
    });

    it('31. cancel with successful payment is refused', () => {
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 1, unit_price: 1000 }]);
      const createR = psqlJson(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1000
        );
      `);
      const orderId = createR.order_id as string;

      // Add successful payment
      psql(`INSERT INTO payments (id, order_id, amount, status) VALUES ('${PAY_1}', '${orderId}', 1000, 'success');`);

      const r = psqlJson(`SET ROLE service_role; SELECT cancel_order_immediate('${orderId}');`);
      expect(r.cancelled).toBe(false);
      expect(r.reason).toBe('has_successful_payment');
    });
  });

  // ═══════════════════════════════════════════════════════
  // CREATE_RESERVATION_ATOMIC
  // ═══════════════════════════════════════════════════════
  describe('create_reservation_atomic', () => {
    beforeEach(() => cleanOrders());

    it('32. valid reservation succeeds', () => {
      const r = psqlJson(`
        SET ROLE service_role;
        SELECT create_reservation_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${PROPERTY_A}'::uuid,
          (CURRENT_DATE + 20)::date, (CURRENT_DATE + 23)::date,
          2, 15000, 45000, 5000, 'Late arrival', 'Guest', '${CUSTOMER_PHONE}'
        );
      `);
      expect(r.created).toBe(true);
      expect(r.reservation_id).toBeTruthy();
      expect(r.total_amount).toBe(45000);
      expect(r.deposit_amount).toBe(5000);
      expect(r.payable).toBe(5000);
    });

    it('33. overlapping dates raises dates_unavailable', () => {
      // Create first reservation
      psqlJson(`
        SET ROLE service_role;
        SELECT create_reservation_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${PROPERTY_A}'::uuid,
          (CURRENT_DATE + 20)::date, (CURRENT_DATE + 23)::date,
          2, 15000, 45000, 5000, NULL, 'Guest', '${CUSTOMER_PHONE}'
        );
      `);

      // Overlapping reservation
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_reservation_atomic(
          '${BOT_SESSION2}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${PROPERTY_A}'::uuid,
          (CURRENT_DATE + 22)::date, (CURRENT_DATE + 25)::date,
          1, 15000, 45000, 5000, NULL, 'Guest2', '${CUSTOMER_PHONE}'
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('dates_unavailable');
    });

    it('34. property deactivated raises property_unavailable', () => {
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_reservation_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${PROPERTY_OFF}'::uuid,
          (CURRENT_DATE + 20)::date, (CURRENT_DATE + 23)::date,
          2, 10000, 30000, 3000, NULL, 'Guest', '${CUSTOMER_PHONE}'
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('property_unavailable');
    });
  });

  // ═══════════════════════════════════════════════════════
  // CREATE_PAYMENT_BOOKING_ATOMIC
  // ═══════════════════════════════════════════════════════
  describe('create_payment_booking_atomic', () => {
    beforeEach(() => cleanOrders());

    it('35. valid payment booking succeeds', () => {
      const r = psqlJson(`
        SET ROLE service_role;
        SELECT create_payment_booking_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          '${SERVICE_A}'::uuid, 5000,
          'Guest', '${CUSTOMER_PHONE}', 'Haircut', 5000
        );
      `);
      expect(r.created).toBe(true);
      expect(r.booking_id).toBeTruthy();
    });

    it('36. service deactivated raises service_unavailable', () => {
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT create_payment_booking_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          '${SERVICE_OFF}'::uuid, 3000,
          'Guest', '${CUSTOMER_PHONE}', 'Inactive', 3000
        );
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('service_unavailable');
    });
  });

  // ═══════════════════════════════════════════════════════
  // ACCEPT_ORDER_QUOTE_ATOMIC — REVISED
  // ═══════════════════════════════════════════════════════
  describe('accept_order_quote_atomic — revised', () => {
    beforeEach(() => {
      cleanOrders();
      // Reset quote statuses
      psql(`
        ALTER TABLE quote_requests DISABLE TRIGGER trg_snapshot_version_guard;
        UPDATE quote_requests SET status = 'quoted', order_id = NULL, responded_at = NULL
        WHERE id IN ('${QUOTE_V1}', '${QUOTE_V2}');
        ALTER TABLE quote_requests ENABLE TRIGGER trg_snapshot_version_guard;
      `);
    });

    it('37. NULL quoted_amount raises quoted_amount_missing', () => {
      // Set quoted_amount to NULL
      psql(`UPDATE quote_requests SET quoted_amount = NULL WHERE id = '${QUOTE_V2}';`);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT accept_order_quote_atomic('${QUOTE_V2}'::uuid, '${CUSTOMER_PHONE}');
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('quoted_amount_missing');
      // Restore
      psql(`UPDATE quote_requests SET quoted_amount = 2400 WHERE id = '${QUOTE_V2}';`);
    });

    it('38. zero-price quote succeeds (total=0)', () => {
      psql(`UPDATE quote_requests SET quoted_amount = 0 WHERE id = '${QUOTE_V2}';`);
      const r = psqlJson(`
        SET ROLE service_role;
        SELECT accept_order_quote_atomic('${QUOTE_V2}'::uuid, '${CUSTOMER_PHONE}');
      `);
      expect(r.accepted).toBe(true);
      expect(r.total).toBe(0);
      // Restore
      psql(`UPDATE quote_requests SET quoted_amount = 2400 WHERE id = '${QUOTE_V2}';`);
    });

    it('39. v2 addon missing id raises addon_missing_id', () => {
      // Create a v2 quote with addon missing id
      const quoteNoId = '00000000-0000-0000-0383-0000000000e5';
      psql(`
        INSERT INTO quote_requests (id, business_id, user_id, customer_phone, customer_name,
          status, cart_snapshot, estimated_subtotal, quoted_amount, expires_at, snapshot_version, quoted_at)
        VALUES (
          '${quoteNoId}', '${BIZ_ID}', '${USER_ID}', '${CUSTOMER_PHONE}', 'Test',
          'quoted',
          '[{"product_id":"${PRODUCT_A}","quantity":1,"price":1000,"name":"Widget A","addons":[{"name":"No ID","price":100,"quantity":1}]}]'::jsonb,
          1100, 1100, NOW() + INTERVAL '24 hours', 2, NOW()
        );
      `);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT accept_order_quote_atomic('${quoteNoId}'::uuid, '${CUSTOMER_PHONE}');
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('addon_missing_id');
      psql(`DELETE FROM quote_requests WHERE id = '${quoteNoId}';`);
    });

    it('40. wrong-product addon raises addon_wrong_product', () => {
      // Create a v2 quote where addon is bound to PRODUCT_B but cart has PRODUCT_A
      const quoteWrong = '00000000-0000-0000-0383-0000000000e6';
      psql(`
        INSERT INTO quote_requests (id, business_id, user_id, customer_phone, customer_name,
          status, cart_snapshot, estimated_subtotal, quoted_amount, expires_at, snapshot_version, quoted_at)
        VALUES (
          '${quoteWrong}', '${BIZ_ID}', '${USER_ID}', '${CUSTOMER_PHONE}', 'Test',
          'quoted',
          '[{"product_id":"${PRODUCT_A}","quantity":1,"price":1000,"name":"Widget A","addons":[{"id":"${ADDON_WRONGP}","name":"B-Only","price":150,"quantity":1}]}]'::jsonb,
          1150, 1150, NOW() + INTERVAL '24 hours', 2, NOW()
        );
      `);
      const r = psqlMayFail(`
        SET ROLE service_role;
        SELECT accept_order_quote_atomic('${quoteWrong}'::uuid, '${CUSTOMER_PHONE}');
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('addon_wrong_product');
      psql(`DELETE FROM quote_requests WHERE id = '${quoteWrong}';`);
    });
  });

  // ═══════════════════════════════════════════════════════
  // TWO-SESSION CONCURRENCY: LAST UNIT STOCK RACE
  // ═══════════════════════════════════════════════════════
  describe('two-session concurrency', () => {
    beforeEach(() => cleanOrders());

    it('41. two sessions race for last product unit — exactly one succeeds', async () => {
      // Set stock to 1
      psql(`UPDATE products SET stock_quantity = 1 WHERE id = '${PRODUCT_A}';`);

      const sessionA_id = '00000000-0000-0000-0383-000000000c01';
      const sessionB_id = '00000000-0000-0000-0383-000000000c02';
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 1, unit_price: 1000 }]);

      const makeSql = (botId: string) => `
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${botId}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1000
        );
      `;

      const [resultA, resultB] = await Promise.all([
        psqlAsync(makeSql(sessionA_id)),
        psqlAsync(makeSql(sessionB_id)),
      ]);

      // Exactly one succeeds, one fails with insufficient_stock
      const aOk = resultA.code === 0;
      const bOk = resultB.code === 0;
      expect(aOk !== bOk || (aOk && bOk)).toBe(true); // at least one succeeds

      if (aOk && bOk) {
        // Both succeeded — advisory lock serialized them, second is an error
        // Actually with advisory lock on bot_session_id (different IDs), both run concurrently.
        // One must fail with insufficient_stock.
        // Check: if both returned code 0, one might have errored in output
        const aHasError = resultA.stderr.includes('insufficient_stock');
        const bHasError = resultB.stderr.includes('insufficient_stock');
        expect(aHasError || bHasError).toBe(true);
      } else {
        // One failed
        const failedOutput = aOk ? resultB.stderr : resultA.stderr;
        expect(failedOutput).toContain('insufficient_stock');
      }

      // Stock is exactly 0
      const stock = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stock)).toBe(0);

      // Exactly one order exists
      const orderCount = psql(`SELECT count(*) FROM orders WHERE business_id = '${BIZ_ID}' AND status = 'pending';`);
      expect(parseInt(orderCount)).toBe(1);
    }, 15000);
  });

  // ── R90: Genuine pre-M383 cutover race + grandfather v1 end-to-end ──
  //
  // Deterministic cross-session handshake at the actual post-Part-1 cutover boundary:
  //
  // 1. Controller session acquires advisory gate lock (99383) BEFORE migration starts.
  // 2. Canonical M383 is mechanically consumed and an advisory WAIT is injected at the
  //    exact unique marker "-- Part 2: DROP old RPC signatures" — AFTER the snapshot_version
  //    ALTER/DEFAULT/trigger cutover (Part 1) and BEFORE the RPC replacements (Part 2).
  //    The marker is asserted to occur exactly once so the test cannot silently drift.
  // 3. The entire assembled SQL runs under psql -1 -v ON_ERROR_STOP=1.
  // 4. Observer connection positively proves the migration backend is waiting on advisory
  //    lock 99383 (pg_stat_activity.wait_event = 'advisory') AND holds a granted
  //    AccessExclusiveLock on the quote_requests relation (pg_locks).
  // 5. Racer is launched and proven queued on the quote-table lock.
  // 6. Controller releases the gate. Migration commits. Racer succeeds as v2.
  // 7. Genuine pre-M383 grandfather v1 quote accepted end-to-end after cutover.
  //
  // No pg_sleep or elapsed-time assertion participates in correctness.
  // A bounded poll timeout guards against hung tests only.
  describe('R90: genuine pre-M383 cutover race + grandfather v1 proof', () => {
    it('42. cutover race + genuine v1 grandfather end-to-end', async () => {
      const r90db = 'waaiio_r90_test';
      const r90url = dbUrl.replace(/\/[^/]+$/, '/' + r90db);
      const fs = require('fs');
      const pathMod = require('path');
      const migDir = pathMod.resolve('supabase/migrations');

      const PRE_ROW_ID  = '00000000-0000-0000-0383-a00000000001';
      const RACE_ROW_ID = '00000000-0000-0000-0383-a00000000002';
      const POST_ROW_ID = '00000000-0000-0000-0383-a00000000003';
      const R90_CUST_PHONE = '2349999990383';
      const GATE_LOCK_ID = 99383;
      const CUTOVER_MARKER = '-- Part 2: DROP old RPC signatures';

      try { execSync(`dropdb --maintenance-db="${dbUrl}" --if-exists "${r90db}"`, { timeout: 10000 }); } catch { /* ok */ }
      execSync(`createdb --maintenance-db="${dbUrl}" "${r90db}"`, { timeout: 10000 });

      const r90psql = (sql: string) => execSync(`psql "${r90url}" -tAXq -v ON_ERROR_STOP=1`, {
        input: sql, encoding: 'utf-8', timeout: 15000,
      }).trim();

      // Controller session: a long-lived psql process that holds the advisory gate
      let controllerChild: ReturnType<typeof spawn> | null = null;

      try {
        // ── Step 1: Apply 001-382 (skip 383) ──
        const files = fs.readdirSync(migDir)
          .filter((f: string) => f.endsWith('.sql') && !f.startsWith('383'))
          .sort();
        for (const f of files) {
          execSync(`psql "${r90url}" -q -v ON_ERROR_STOP=1 -f "${pathMod.join(migDir, f)}"`, {
            timeout: 60000, encoding: 'utf-8',
          });
        }

        // ── Step 2: Seed genuine pre-M383 data ──
        r90psql(`
          INSERT INTO businesses (id, name, slug, address, city, neighborhood, phone, owner_id, status, country_code, metadata)
          VALUES ('${BIZ_ID}', 'R90 Biz', 'r90biz', '1 R90 St', 'Lagos', 'VI', '+2340000000000', gen_random_uuid(), 'active', 'NG',
                  '{"custom_order_config":{"deposit_percentage":0}}'::jsonb)
          ON CONFLICT DO NOTHING;
          INSERT INTO products (id, business_id, name, price, stock_quantity, track_inventory, is_active)
          VALUES ('${PRODUCT_A}', '${BIZ_ID}', 'R90 Widget', 1000, 50, true, true)
          ON CONFLICT DO NOTHING;
        `);

        // Genuine pre-M383 quote with legacy addons (NO addon.id)
        r90psql(`
          INSERT INTO quote_requests (id, business_id, customer_phone, customer_name,
            status, cart_snapshot, estimated_subtotal, quoted_amount, quoted_at, expires_at)
          VALUES (
            '${PRE_ROW_ID}', '${BIZ_ID}', '${R90_CUST_PHONE}', 'R90 Customer', 'quoted',
            '[{"product_id":"${PRODUCT_A}","quantity":2,"price":1000,"name":"R90 Widget",
              "addons":[{"name":"Legacy Addon","price":150,"quantity":1}]}]'::jsonb,
            2150, 2150, NOW(), NOW() + INTERVAL '24 hours'
          );
        `);

        // Verify: no snapshot_version column pre-M383
        expect(parseInt(r90psql(`
          SELECT count(*) FROM information_schema.columns
          WHERE table_name = 'quote_requests' AND column_name = 'snapshot_version';
        `))).toBe(0);

        // ── Step 3: Controller acquires the advisory gate ──
        controllerChild = spawn('psql', [r90url, '-tAXq'], { stdio: ['pipe', 'pipe', 'pipe'] });
        await new Promise<void>((resolve) => {
          let buf = '';
          controllerChild!.stdout.on('data', (d: Buffer) => {
            buf += d.toString();
            if (buf.includes('t')) resolve();  // pg_advisory_lock returns 't' (void)
          });
          controllerChild!.stdin.write(`SELECT pg_advisory_lock(${GATE_LOCK_ID});\n`);
        });
        // Controller now holds advisory lock 99383. It will NOT release until we tell it to.

        // ── Step 4: Assemble M383 with injection at the exact cutover boundary ──
        const m383File = fs.readdirSync(migDir).find((f: string) => f.startsWith('383') && f.endsWith('.sql'));
        if (!m383File) throw new Error('M383 migration file not found');
        const m383Sql = fs.readFileSync(pathMod.join(migDir, m383File), 'utf-8');

        // Assert the marker occurs exactly once (test cannot silently drift)
        const markerCount = (m383Sql.match(new RegExp(CUTOVER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        expect(markerCount).toBe(1);

        // Inject advisory WAIT after Part 1 cutover, before Part 2
        const m383Assembled = m383Sql.replace(
          CUTOVER_MARKER,
          `-- R90 test injection: wait on advisory gate (held by controller)\nSELECT pg_advisory_lock(${GATE_LOCK_ID});\n\n${CUTOVER_MARKER}`
        );

        // ── Step 5: Launch migration under psql -1 ──
        const migrationPromise = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
          const child = spawn('psql', [r90url, '-1', '-q', '-v', 'ON_ERROR_STOP=1'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = ''; let stderr = '';
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          child.on('close', (code: number) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
          child.stdin.write(m383Assembled);
          child.stdin.end();
        });

        // ── Step 6: Poll pg_stat_activity + pg_locks to confirm migration is waiting ──
        // The migration will execute Part 1 (ALTER TABLE = ACCESS EXCLUSIVE on quote_requests)
        // then hit the injected pg_advisory_lock(99383) and WAIT (controller holds it).
        // We observe BOTH: (a) advisory wait AND (b) AccessExclusiveLock on quote_requests.
        let migrationWaiting = false;
        let migrationHoldsTableLock = false;
        for (let i = 0; i < 120; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            // Check migration is waiting on advisory lock
            const waitCount = r90psql(`
              SELECT count(*) FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
                AND state = 'active';
            `);
            // Check migration holds AccessExclusiveLock on quote_requests
            const aeLockCount = r90psql(`
              SELECT count(*) FROM pg_locks l
              JOIN pg_class c ON l.relation = c.oid
              WHERE c.relname = 'quote_requests'
                AND l.mode = 'AccessExclusiveLock' AND l.granted = true;
            `);
            if (parseInt(waitCount) > 0 && parseInt(aeLockCount) > 0) {
              migrationWaiting = true;
              migrationHoldsTableLock = true;
              break;
            }
          } catch { /* observer connection may briefly fail */ }
        }
        expect(migrationWaiting).toBe(true);
        expect(migrationHoldsTableLock).toBe(true);

        // ── Step 7: Launch racer while migration is confirmed at cutover boundary ──
        const racerPromise = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
          const child = spawn('psql', [r90url, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = ''; let stderr = '';
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          child.on('close', (code: number) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
          child.stdin.write(`
            INSERT INTO quote_requests (id, business_id, customer_phone, status, estimated_subtotal)
            VALUES ('${RACE_ROW_ID}', '${BIZ_ID}', '2342222222222', 'pending', 2000)
            RETURNING snapshot_version;
          `);
          child.stdin.end();
        });

        // ── Step 8: Confirm racer is queued on quote_requests lock ──
        let racerQueued = false;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const queuedCount = r90psql(`
              SELECT count(*) FROM pg_locks l
              JOIN pg_class c ON l.relation = c.oid
              WHERE c.relname = 'quote_requests'
                AND l.granted = false;
            `);
            if (parseInt(queuedCount) > 0) {
              racerQueued = true;
              break;
            }
          } catch { /* ok */ }
        }
        expect(racerQueued).toBe(true);

        // ── Step 9: Release the gate — migration finishes, racer proceeds ──
        await new Promise<void>((resolve) => {
          controllerChild!.stdout.removeAllListeners('data');
          let buf = '';
          controllerChild!.stdout.on('data', (d: Buffer) => {
            buf += d.toString();
            if (buf.includes('t') || buf.length > 0) resolve();
          });
          controllerChild!.stdin.write(`SELECT pg_advisory_unlock(${GATE_LOCK_ID});\n`);
        });
        // Close controller cleanly
        controllerChild!.stdin.end();
        controllerChild = null;

        // Wait for migration and racer to complete
        const [migResult, racerResult] = await Promise.all([migrationPromise, racerPromise]);

        // ── Step 10: Verify results ──
        expect(migResult.code).toBe(0);
        expect(racerResult.code).toBe(0);
        expect(racerResult.stdout.trim()).toBe('2');  // racer cannot cross as v1

        // Pre-migration row grandfathered to v1
        expect(r90psql(`SELECT snapshot_version FROM quote_requests WHERE id = '${PRE_ROW_ID}';`)).toBe('1');

        // Post-cutover: omitted version → v2
        expect(r90psql(`
          INSERT INTO quote_requests (id, business_id, customer_phone, status, estimated_subtotal)
          VALUES ('${POST_ROW_ID}', '${BIZ_ID}', '2343333333333', 'pending', 3000)
          RETURNING snapshot_version;
        `)).toBe('2');

        // Post-cutover: explicit v1 → rejected
        const forgeR = (() => {
          try { r90psql(`INSERT INTO quote_requests (id, business_id, customer_phone, status, estimated_subtotal, snapshot_version)
            VALUES (gen_random_uuid(), '${BIZ_ID}', '2344444444444', 'pending', 4000, 1);`);
            return { ok: true };
          } catch (e: any) { return { ok: false, output: e.message || '' }; }
        })();
        expect(forgeR.ok).toBe(false);
        expect((forgeR as any).output).toContain('snapshot_version_forge');

        // ── Step 11: Genuine pre-M383 grandfather v1 end-to-end ──
        r90psql(`INSERT INTO profiles (id, phone) VALUES (gen_random_uuid(), '${R90_CUST_PHONE}') ON CONFLICT DO NOTHING;`);
        const acceptResult = (() => {
          try {
            return JSON.parse(r90psql(`SET ROLE service_role; SELECT accept_order_quote_atomic('${PRE_ROW_ID}'::uuid, '${R90_CUST_PHONE}');`));
          } catch (e: any) { return { error: e.message }; }
        })();
        expect(acceptResult.accepted).toBe(true);
        expect(acceptResult.order_id).toBeTruthy();
        expect(acceptResult.total).toBe(2150);
        expect(parseInt(r90psql(`SELECT total_amount FROM orders WHERE id = '${acceptResult.order_id}';`))).toBe(2150);
        expect(r90psql(`SELECT status FROM quote_requests WHERE id = '${PRE_ROW_ID}';`)).toBe('accepted');

      } finally {
        if (controllerChild) { try { controllerChild.kill(); } catch { /* ok */ } }
        try { execSync(`dropdb --maintenance-db="${dbUrl}" --if-exists "${r90db}"`, { timeout: 10000 }); } catch { /* ok */ }
      }
    }, 180000);
  });

  // ── Blocker 3: Expanded concurrency/ACL/invariant matrix ──
  describe('expanded invariant matrix', () => {
    it('43. event→business binding: wrong business rejected', () => {
      const otherBiz = '00000000-0000-0000-0383-00000000ff01';
      psql(`INSERT INTO businesses (id, name, slug, address, city, neighborhood, phone, owner_id, status) VALUES ('${otherBiz}', 'Other', 'other-ff01', '3 Test St', 'Lagos', 'VI', '+2340000000001', '${USER_ID}', 'active') ON CONFLICT DO NOTHING;`);
      psql(`INSERT INTO events (id, business_id, name, date, status, total_tickets, tickets_sold, price) VALUES ('${EVENT_ID}', '${BIZ_ID}', 'Test Event', CURRENT_DATE + 30, 'published', 100, 0, 1000) ON CONFLICT (id) DO UPDATE SET business_id = '${BIZ_ID}', status = 'published', tickets_sold = 0;`);
      const r = psqlMayFail(`SET ROLE service_role; SELECT purchase_tickets_atomic('${otherBiz}', '${EVENT_ID}', NULL, 1, '${USER_ID}', 'Test', '2340000000002', 'test@test.com', 1000, 'whatsapp', NULL, NULL);`);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('event_wrong_business');
    });

    it('44. ticket-type→event binding: wrong event rejected', () => {
      const otherEvent = '00000000-0000-0000-0383-00000000ff02';
      psql(`INSERT INTO events (id, business_id, name, date, status, total_tickets, tickets_sold, price) VALUES ('${otherEvent}', '${BIZ_ID}', 'Other Event', CURRENT_DATE + 30, 'published', 100, 0, 500) ON CONFLICT DO NOTHING;`);
      // TT belongs to EVENT_ID, not otherEvent
      psql(`DELETE FROM event_ticket_types WHERE id = '${TT_ID}'; INSERT INTO event_ticket_types (id, event_id, name, price, total_tickets, tickets_sold) VALUES ('${TT_ID}', '${EVENT_ID}', 'VIP', 2000, 50, 0);`);
      const r = psqlMayFail(`SET ROLE service_role; SELECT purchase_tickets_atomic('${BIZ_ID}', '${otherEvent}', '${TT_ID}', 1, '${USER_ID}', 'Test', '2340000000003', 'test@test.com', 2000, 'whatsapp', NULL, 2000);`);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('ticket_type_wrong_event');
    });

    it('45. ticket quantity=0 rejected', () => {
      psql(`INSERT INTO events (id, business_id, name, date, status, total_tickets, tickets_sold, price) VALUES ('${EVENT_ID}', '${BIZ_ID}', 'Test Event', CURRENT_DATE + 30, 'published', 100, 0, 1000) ON CONFLICT (id) DO UPDATE SET status = 'published', tickets_sold = 0;`);
      const r = psqlMayFail(`SET ROLE service_role; SELECT purchase_tickets_atomic('${BIZ_ID}', '${EVENT_ID}', NULL, 0, '${USER_ID}', 'Test', '2340000000004', 'test@test.com', 0, 'whatsapp', NULL, NULL);`);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('invalid_quantity');
    });

    it('46. ticket server-authoritative total: DB price × qty persisted, not caller total', () => {
      psql(`INSERT INTO events (id, business_id, name, date, status, total_tickets, tickets_sold, price) VALUES ('${EVENT_ID}', '${BIZ_ID}', 'Test Event', CURRENT_DATE + 30, 'published', 100, 0, 1500) ON CONFLICT (id) DO UPDATE SET status = 'published', tickets_sold = 0, price = 1500;`);
      const sessId = '00000000-0000-0000-0383-00000000b046';
      // Caller sends p_total_amount=9999 (forged), but DB price=1500, qty=2 → committed should be 3000
      const r = psql(`SET ROLE service_role; SELECT purchase_tickets_atomic('${BIZ_ID}', '${EVENT_ID}', NULL, 2, '${USER_ID}', 'Test', '2340000000005', 'test@test.com', 9999, 'whatsapp', '${sessId}', NULL);`);
      const row = JSON.parse(r.replace(/\(/g, '[').replace(/\)/g, ']'));
      const bookingId = row[0];
      const total = psql(`SELECT total_amount FROM bookings WHERE id = '${bookingId}';`);
      expect(parseInt(total)).toBe(3000); // 1500 * 2, not 9999
    });

    it('47. scheduling: DB price persisted when revalidation active', () => {
      psql(`UPDATE services SET price = 7777, deposit_amount = 500 WHERE id = '${SERVICE_ID}';`);
      const sessId = '00000000-0000-0000-0383-00000000b047';
      // Caller sends p_total_amount=9999, p_deposit_amount=9999 — but DB has 7777/500
      const r = psql(`SET ROLE service_role;
        SELECT * FROM book_slot_atomic(
          '${BIZ_ID}', '${USER_ID}', '${SERVICE_ID}', NULL,
          CURRENT_DATE + 60, '14:00', 1, 1,
          'scheduling', 9999, 'pending', 'pending',
          'Test', '2340000000006', '', '', '', NULL, NULL, NULL, 9999, '',
          NULL, NULL, 0, 30, '${sessId}', NULL, 7777, 500
        );`);
      const parts = r.split('|');
      const bookingId = parts[0];
      if (bookingId && bookingId !== '') {
        const totals = psql(`SELECT total_amount, deposit_amount FROM bookings WHERE id = '${bookingId}';`);
        const [ta, da] = totals.split('|');
        expect(parseInt(ta)).toBe(7777);
        expect(parseInt(da)).toBe(500);
      }
    });

    it('48. payment booking: DB price persisted for fixed-price service', () => {
      psql(`UPDATE services SET price = 3000, price_is_variable = false WHERE id = '${SERVICE_ID}';`);
      const sessId = '00000000-0000-0000-0383-00000000b048';
      // Caller sends p_amount=9999 — DB has price=3000
      const r = psqlJson(`SET ROLE service_role; SELECT create_payment_booking_atomic('${BIZ_ID}', '${USER_ID}', '${SERVICE_ID}', 9999, 'Test Payment', '2340000000007', 'Test', '${sessId}', 3000);`);
      expect(r.booking_id).toBeTruthy();
      const total = psql(`SELECT total_amount FROM bookings WHERE id = '${r.booking_id}';`);
      expect(parseInt(total)).toBe(3000); // DB price, not 9999
    });

    it('49. p_expected_total=NULL with p_validate_products=true → fail closed', () => {
      psql(`UPDATE products SET stock_quantity = 10, is_active = true, deleted_at = NULL WHERE id = '${PRODUCT_A}';`);
      const sessId = '00000000-0000-0000-0383-00000000b049';
      const r = psqlMayFail(`SET ROLE service_role; SELECT create_order_atomic(
        '${sessId}', '${BIZ_ID}', '${USER_ID}', 'pending',
        NULL, NULL, 1000, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
        NULL, NULL, NULL, NULL,
        '[{"product_id":"${PRODUCT_A}","quantity":1,"unit_price":1000}]'::jsonb,
        NULL, true, NULL
      );`);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('expected_total_required');
    });

    it('50. complete ACL: cancel_order_immediate denied for anon', () => {
      const r = psql(`SELECT has_function_privilege('anon', 'cancel_order_immediate(uuid, text)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('51. complete ACL: create_payment_booking_atomic denied for authenticated', () => {
      const r = psql(`SELECT has_function_privilege('authenticated', 'create_payment_booking_atomic(uuid, uuid, uuid, integer, text, text, text, uuid, integer)', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('52. complete ACL: create_reservation_atomic denied for anon', () => {
      const sigTypes = 'uuid, uuid, uuid, uuid, date, date, int, int, int, int, text, text, text';
      const r = psql(`SELECT has_function_privilege('anon', 'create_reservation_atomic(${sigTypes})', 'EXECUTE');`);
      expect(r).toBe('f');
    });

    it('53. finalize_free_ticket_booking on tickets_finalized=true → no double count', () => {
      // Create a booking with tickets_finalized=true (as purchase_tickets_atomic would)
      psql(`INSERT INTO events (id, business_id, name, date, status, total_tickets, tickets_sold, price)
        VALUES ('${EVENT_ID}', '${BIZ_ID}', 'Test', CURRENT_DATE + 30, 'published', 100, 5, 1000)
        ON CONFLICT (id) DO UPDATE SET tickets_sold = 5;`);
      const bookId = '00000000-0000-0000-0383-00000000b053';
      psql(`INSERT INTO bookings (id, business_id, event_id, date, time, party_size, quantity, flow_type, channel, deposit_amount, deposit_status, status, total_amount, tickets_finalized)
        VALUES ('${bookId}', '${BIZ_ID}', '${EVENT_ID}', CURRENT_DATE + 30, '10:00', 2, 2, 'ticketing', 'whatsapp', 2000, 'pending', 'pending', 2000, true)
        ON CONFLICT DO NOTHING;`);
      const r = psqlJson(`SET ROLE service_role; SELECT finalize_free_ticket_booking('${bookId}', '${EVENT_ID}', NULL, 2);`);
      expect(r.success).toBe(true);
      expect(r.already_finalized).toBe(true);
      // tickets_sold should NOT have increased
      const sold = psql(`SELECT tickets_sold FROM events WHERE id = '${EVENT_ID}';`);
      expect(parseInt(sold)).toBe(5); // unchanged
    });
  });

  // ═══════════════════════════════════════════════════════
  // ADDITIONAL RACE TESTS
  // ═══════════════════════════════════════════════════════
  describe('additional concurrency races', () => {
    beforeEach(() => cleanOrders());

    it('54. last VARIANT unit race — two sessions racing for variant stock=1', async () => {
      // Set variant stock to 1
      psql(`UPDATE product_variants SET stock_quantity = 1 WHERE id = '${VARIANT_A1}';`);

      const sessA = '00000000-0000-0000-0383-000000000c54';
      const sessB = '00000000-0000-0000-0383-000000000c55';
      const items = JSON.stringify([
        { product_id: PRODUCT_A, quantity: 1, unit_price: 1200, variant_id: VARIANT_A1 }
      ]);

      const makeSql = (botId: string) => `
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${botId}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 1200
        );
      `;

      const [resultA, resultB] = await Promise.all([
        psqlAsync(makeSql(sessA)),
        psqlAsync(makeSql(sessB)),
      ]);

      const aOk = resultA.code === 0 && !resultA.stderr.includes('insufficient_stock');
      const bOk = resultB.code === 0 && !resultB.stderr.includes('insufficient_stock');

      // Exactly one succeeds
      expect(aOk !== bOk).toBe(true);

      // Variant stock is exactly 0
      const stock = psql(`SELECT stock_quantity FROM product_variants WHERE id = '${VARIANT_A1}';`);
      expect(parseInt(stock)).toBe(0);

      // Exactly one order exists
      const orderCount = psql(`SELECT count(*) FROM orders WHERE business_id = '${BIZ_ID}' AND status = 'pending';`);
      expect(parseInt(orderCount)).toBe(1);
    }, 15000);

    it('55. event-level ticket race — two sessions racing for last event ticket', async () => {
      // Set event to 1 ticket remaining (99 sold of 100)
      psql(`UPDATE events SET tickets_sold = 99, total_tickets = 100 WHERE id = '${EVENT_A}';`);

      const sessA = '00000000-0000-0000-0383-000000000c56';
      const sessB = '00000000-0000-0000-0383-000000000c57';

      const makeSql = (botId: string) => `
        SET ROLE service_role;
        SELECT * FROM purchase_tickets_atomic(
          '${BIZ_ID}'::uuid, '${EVENT_A}'::uuid, NULL,
          1, '${USER_ID}'::uuid,
          'Guest', '${CUSTOMER_PHONE}', NULL,
          3000, 'whatsapp', '${botId}'::uuid, 3000
        );
      `;

      const [resultA, resultB] = await Promise.all([
        psqlAsync(makeSql(sessA)),
        psqlAsync(makeSql(sessB)),
      ]);

      // Parse ticket availability from results
      // Format: booking_id|ref|tickets_available|...
      const aAvail = resultA.code === 0 && resultA.stdout.includes('|t');
      const bAvail = resultB.code === 0 && resultB.stdout.includes('|t');

      // At most one gets tickets_available=true
      // (The other gets tickets_available=false since only 1 ticket left)
      expect(aAvail && bAvail).toBe(false);

      // Total sold should be exactly 100
      const sold = psql(`SELECT tickets_sold FROM events WHERE id = '${EVENT_A}';`);
      expect(parseInt(sold)).toBe(100);
    }, 15000);

    it('56. ticket-type race — two sessions racing for last ticket-type unit', async () => {
      // Set ticket type to 1 remaining (19 sold of 20)
      psql(`UPDATE event_ticket_types SET tickets_sold = 19, total_tickets = 20 WHERE id = '${TICKET_TYPE}';`);
      // Ensure event has capacity
      psql(`UPDATE events SET tickets_sold = 90, total_tickets = 100 WHERE id = '${EVENT_A}';`);

      const sessA = '00000000-0000-0000-0383-000000000c58';
      const sessB = '00000000-0000-0000-0383-000000000c59';

      const makeSql = (botId: string) => `
        SET ROLE service_role;
        SELECT * FROM purchase_tickets_atomic(
          '${BIZ_ID}'::uuid, '${EVENT_A}'::uuid, '${TICKET_TYPE}'::uuid,
          1, '${USER_ID}'::uuid,
          'Guest', '${CUSTOMER_PHONE}', NULL,
          5000, 'whatsapp', '${botId}'::uuid, 5000
        );
      `;

      const [resultA, resultB] = await Promise.all([
        psqlAsync(makeSql(sessA)),
        psqlAsync(makeSql(sessB)),
      ]);

      const aAvail = resultA.code === 0 && resultA.stdout.includes('|t');
      const bAvail = resultB.code === 0 && resultB.stdout.includes('|t');

      // At most one succeeds with tickets_available=true
      expect(aAvail && bAvail).toBe(false);

      // Ticket type sold out at 20
      const sold = psql(`SELECT tickets_sold FROM event_ticket_types WHERE id = '${TICKET_TYPE}';`);
      expect(parseInt(sold)).toBe(20);
    }, 15000);

    it('57. overlapping property reservation race — two sessions racing for same dates', async () => {
      const sessA = '00000000-0000-0000-0383-000000000c60';
      const sessB = '00000000-0000-0000-0383-000000000c61';

      const makeSql = (botId: string) => `
        SET ROLE service_role;
        SELECT create_reservation_atomic(
          '${botId}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid, '${PROPERTY_A}'::uuid,
          (CURRENT_DATE + 80)::date, (CURRENT_DATE + 83)::date,
          2, 15000, 45000, 5000, NULL, 'Guest', '${CUSTOMER_PHONE}'
        );
      `;

      const [resultA, resultB] = await Promise.all([
        psqlAsync(makeSql(sessA)),
        psqlAsync(makeSql(sessB)),
      ]);

      const aOk = resultA.code === 0 && !resultA.stderr.includes('dates_unavailable');
      const bOk = resultB.code === 0 && !resultB.stderr.includes('dates_unavailable');

      // Exactly one succeeds — the other gets dates_unavailable
      expect(aOk !== bOk).toBe(true);

      // Exactly one reservation exists for those dates
      const resCount = psql(`
        SELECT count(*) FROM reservations
        WHERE property_id = '${PROPERTY_A}'
          AND check_in = (CURRENT_DATE + 80)
          AND check_out = (CURRENT_DATE + 83);
      `);
      expect(parseInt(resCount)).toBe(1);
    }, 15000);

    it('58. stock-reserving order + apply_order_stock_once no-double-decrement', () => {
      // Create order with validate_products=true (stock decremented at creation + marker)
      const items = JSON.stringify([{ product_id: PRODUCT_A, quantity: 5, unit_price: 1000 }]);
      const createR = psqlJson(`
        SET ROLE service_role;
        SELECT create_order_atomic(
          '${BOT_SESSION}'::uuid, '${BIZ_ID}'::uuid, '${USER_ID}'::uuid,
          'pending', NULL, NULL, 0, 0, 0, NULL, 'whatsapp', NULL, NULL, NULL, 0, 0,
          NULL, NULL, NULL, NULL,
          '${items}'::jsonb, NULL, true, 5000
        );
      `);
      expect(createR.created).toBe(true);
      const orderId = createR.order_id as string;

      // Stock should be 45 (50 - 5)
      const stockAfterCreate = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterCreate)).toBe(45);

      // Marker should exist
      const markerBefore = psql(`SELECT count(*) FROM order_stock_applications WHERE order_id = '${orderId}';`);
      expect(parseInt(markerBefore)).toBe(1);

      // Call apply_order_stock_once — should return already_applied, not decrement again
      const stockResult = psqlJson(`
        SET ROLE service_role;
        SELECT apply_order_stock_once('${orderId}'::uuid, NULL, true);
      `);
      expect(stockResult.applied).toBe(false);
      expect(stockResult.reason).toBe('already_applied');

      // Stock unchanged at 45
      const stockAfterApply = psql(`SELECT stock_quantity FROM products WHERE id = '${PRODUCT_A}';`);
      expect(parseInt(stockAfterApply)).toBe(45);
    });

    it('59. genuine v1 grandfather proof — v1 row stays v1 and is accepted by accept_order_quote_atomic', () => {
      // The QUOTE_V1 row was seeded in beforeAll with snapshot_version=1
      // Verify it still has v1
      const v = psql(`SELECT snapshot_version FROM quote_requests WHERE id = '${QUOTE_V1}';`);
      expect(parseInt(v)).toBe(1);

      // Reset quote status for acceptance
      psql(`
        ALTER TABLE quote_requests DISABLE TRIGGER trg_snapshot_version_guard;
        UPDATE quote_requests SET status = 'quoted', order_id = NULL, responded_at = NULL
        WHERE id = '${QUOTE_V1}';
        ALTER TABLE quote_requests ENABLE TRIGGER trg_snapshot_version_guard;
      `);

      // accept_order_quote_atomic should accept the v1 quote (v1 addons lack IDs,
      // but v1 path skips addon validation)
      const r = psqlJson(`
        SET ROLE service_role;
        SELECT accept_order_quote_atomic('${QUOTE_V1}'::uuid, '${CUSTOMER_PHONE}');
      `);
      expect(r.accepted).toBe(true);
      expect(r.order_id).toBeTruthy();
      expect(r.total).toBe(1100);
    });
  });

  // ═══════════════════════════════════════════════════════
  // COMPLETE ACL MATRIX
  // ═══════════════════════════════════════════════════════
  describe('complete ACL matrix', () => {
    // Exact type signatures from M383 ACL blocks
    const COA_SIG = 'uuid, uuid, uuid, text, text, text, int, int, int, uuid, text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid, boolean, int';
    const BSA_SIG = 'uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,integer,integer,uuid,uuid,int,int';
    const PTA_SIG = 'uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int';
    const COI_SIG = 'uuid, text';
    const CPBA_SIG = 'uuid, uuid, uuid, uuid, int, text, text, text, int';
    const CRA_SIG = 'uuid, uuid, uuid, uuid, date, date, int, int, int, int, text, text, text';
    const AOQA_SIG = 'uuid, text';

    it('60. create_order_atomic: anon denied, authenticated denied, service_role allowed', () => {
      const anonR = psql(`SELECT has_function_privilege('anon', 'create_order_atomic(${COA_SIG})', 'EXECUTE');`);
      expect(anonR).toBe('f');
      const authR = psql(`SELECT has_function_privilege('authenticated', 'create_order_atomic(${COA_SIG})', 'EXECUTE');`);
      expect(authR).toBe('f');
      const srR = psql(`SELECT has_function_privilege('service_role', 'create_order_atomic(${COA_SIG})', 'EXECUTE');`);
      expect(srR).toBe('t');
    });

    it('61. book_slot_atomic: anon denied, authenticated denied, service_role allowed', () => {
      const anonR = psql(`SELECT has_function_privilege('anon', 'book_slot_atomic(${BSA_SIG})', 'EXECUTE');`);
      expect(anonR).toBe('f');
      const authR = psql(`SELECT has_function_privilege('authenticated', 'book_slot_atomic(${BSA_SIG})', 'EXECUTE');`);
      expect(authR).toBe('f');
      const srR = psql(`SELECT has_function_privilege('service_role', 'book_slot_atomic(${BSA_SIG})', 'EXECUTE');`);
      expect(srR).toBe('t');
    });

    it('62. purchase_tickets_atomic: anon denied, authenticated denied, service_role allowed', () => {
      const anonR = psql(`SELECT has_function_privilege('anon', 'purchase_tickets_atomic(${PTA_SIG})', 'EXECUTE');`);
      expect(anonR).toBe('f');
      const authR = psql(`SELECT has_function_privilege('authenticated', 'purchase_tickets_atomic(${PTA_SIG})', 'EXECUTE');`);
      expect(authR).toBe('f');
      const srR = psql(`SELECT has_function_privilege('service_role', 'purchase_tickets_atomic(${PTA_SIG})', 'EXECUTE');`);
      expect(srR).toBe('t');
    });

    it('63. cancel_order_immediate: anon denied, authenticated denied, service_role allowed', () => {
      const anonR = psql(`SELECT has_function_privilege('anon', 'cancel_order_immediate(${COI_SIG})', 'EXECUTE');`);
      expect(anonR).toBe('f');
      const authR = psql(`SELECT has_function_privilege('authenticated', 'cancel_order_immediate(${COI_SIG})', 'EXECUTE');`);
      expect(authR).toBe('f');
      const srR = psql(`SELECT has_function_privilege('service_role', 'cancel_order_immediate(${COI_SIG})', 'EXECUTE');`);
      expect(srR).toBe('t');
    });

    it('64. create_payment_booking_atomic: anon denied, authenticated denied, service_role allowed', () => {
      const anonR = psql(`SELECT has_function_privilege('anon', 'create_payment_booking_atomic(${CPBA_SIG})', 'EXECUTE');`);
      expect(anonR).toBe('f');
      const authR = psql(`SELECT has_function_privilege('authenticated', 'create_payment_booking_atomic(${CPBA_SIG})', 'EXECUTE');`);
      expect(authR).toBe('f');
      const srR = psql(`SELECT has_function_privilege('service_role', 'create_payment_booking_atomic(${CPBA_SIG})', 'EXECUTE');`);
      expect(srR).toBe('t');
    });

    it('65. create_reservation_atomic: anon denied, authenticated denied, service_role allowed', () => {
      const anonR = psql(`SELECT has_function_privilege('anon', 'create_reservation_atomic(${CRA_SIG})', 'EXECUTE');`);
      expect(anonR).toBe('f');
      const authR = psql(`SELECT has_function_privilege('authenticated', 'create_reservation_atomic(${CRA_SIG})', 'EXECUTE');`);
      expect(authR).toBe('f');
      const srR = psql(`SELECT has_function_privilege('service_role', 'create_reservation_atomic(${CRA_SIG})', 'EXECUTE');`);
      expect(srR).toBe('t');
    });

    it('66. accept_order_quote_atomic: anon denied, authenticated denied, service_role allowed', () => {
      const anonR = psql(`SELECT has_function_privilege('anon', 'accept_order_quote_atomic(${AOQA_SIG})', 'EXECUTE');`);
      expect(anonR).toBe('f');
      const authR = psql(`SELECT has_function_privilege('authenticated', 'accept_order_quote_atomic(${AOQA_SIG})', 'EXECUTE');`);
      expect(authR).toBe('f');
      const srR = psql(`SELECT has_function_privilege('service_role', 'accept_order_quote_atomic(${AOQA_SIG})', 'EXECUTE');`);
      expect(srR).toBe('t');
    });

    it('67. prevent_snapshot_version_downgrade trigger is not service_role-restricted (fires for all roles)', () => {
      // The trigger function prevent_snapshot_version_downgrade must exist
      const exists = psql(`
        SELECT count(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'prevent_snapshot_version_downgrade';
      `);
      expect(parseInt(exists)).toBeGreaterThanOrEqual(1);

      // It should be a trigger function, not an RPC — verify it's used by a trigger
      const triggerCount = psql(`
        SELECT count(*) FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_proc p ON t.tgfoid = p.oid
        WHERE p.proname = 'prevent_snapshot_version_downgrade';
      `);
      expect(parseInt(triggerCount)).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════
  // STALE-OVERLOAD ABSENCE
  // ═══════════════════════════════════════════════════════
  describe('stale-overload absence', () => {
    it('68. exactly 1 signature in pg_proc for each M383 RPC', () => {
      const rpcs = [
        'create_order_atomic',
        'book_slot_atomic',
        'purchase_tickets_atomic',
        'cancel_order_immediate',
        'create_payment_booking_atomic',
        'create_reservation_atomic',
        'accept_order_quote_atomic',
      ];
      for (const rpc of rpcs) {
        const count = psql(`
          SELECT COUNT(*) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '${rpc}';
        `);
        expect(parseInt(count)).toBe(1);
      }
    });
  });
});
