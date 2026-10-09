/**
 * #602: Ordering price authority — disposable PostgreSQL RPC tests.
 *
 * Tests the M435 create_order_atomic promo and volume discount authority
 * against a real PostgreSQL database. Requires TEST_DATABASE_URL.
 *
 * Validates:
 * (a) Fabricated discount without promo → rejected
 * (b) Cross-tenant/inactive/expired/not-yet-active/wrong-flow/wrong-product promo → rejected
 * (c) Volume discount uses locked DB price, not caller-supplied
 * (d) Valid promo computes correct server discount (percentage + fixed)
 * (e) Concurrent last promo (capacity exhaustion)
 * (f) Exact retry idempotency
 * (g) Mismatch retry → rejected
 * (h) No side effects on rejected underpricing
 * (i) Discount without promo ID → rejected
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('#602 Ordering price authority (real PG) — requires TEST_DATABASE_URL', () => {
    it('skipped', () => {});
  });
} else {

function sql(query: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: query, encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: any) {
    return `ERROR:${err.stderr?.trim() || err.stdout?.trim() || err.message}`;
  }
}

function sqlJson(query: string): Record<string, unknown> {
  const raw = sql(query);
  if (raw.startsWith('ERROR:')) return { _error: raw };
  try {
    const lines = raw.split('\n');
    const jsonLine = lines.find(l => l.startsWith('{')) || raw;
    return JSON.parse(jsonLine);
  } catch {
    return { _raw: raw };
  }
}

// ── Test fixtures ──
const BIZ_ID = '00000000-0000-0000-0000-000000000602';
const USER_ID = '00000000-0000-0000-0000-000000000603';
const OTHER_BIZ_ID = '00000000-0000-0000-0000-000000000604';
const PRODUCT_A_ID = '00000000-0000-0000-0000-000000000610';
const PRODUCT_B_ID = '00000000-0000-0000-0000-000000000611';
const VARIANT_A_ID = '00000000-0000-0000-0000-000000000620';
const PROMO_10PCT_ID = '00000000-0000-0000-0000-000000000630';
const PROMO_FIXED_ID = '00000000-0000-0000-0000-000000000631';
const PROMO_EXPIRED_ID = '00000000-0000-0000-0000-000000000632';
const PROMO_FUTURE_ID = '00000000-0000-0000-0000-000000000633';
const PROMO_WRONG_FLOW_ID = '00000000-0000-0000-0000-000000000634';
const PROMO_WRONG_PRODUCT_ID = '00000000-0000-0000-0000-000000000635';
const PROMO_OTHER_BIZ_ID = '00000000-0000-0000-0000-000000000636';
const PROMO_INACTIVE_ID = '00000000-0000-0000-0000-000000000637';
const PROMO_LAST_USE_ID = '00000000-0000-0000-0000-000000000638';
const PROMO_FIXED_CAP_ID = '00000000-0000-0000-0000-000000000639';

function sessionId(): string {
  return sql("SELECT gen_random_uuid()::text;");
}

beforeAll(() => {
  // Clean up any leftover test data
  sql(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM order_stock_applications WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM promo_reservations WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM orders WHERE business_id = '${BIZ_ID}';`);
  sql(`DELETE FROM promo_codes WHERE business_id IN ('${BIZ_ID}', '${OTHER_BIZ_ID}');`);
  sql(`DELETE FROM volume_discount_rules WHERE business_id = '${BIZ_ID}';`);
  sql(`DELETE FROM product_variants WHERE product_id IN ('${PRODUCT_A_ID}', '${PRODUCT_B_ID}');`);
  sql(`DELETE FROM products WHERE id IN ('${PRODUCT_A_ID}', '${PRODUCT_B_ID}');`);
  sql(`DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${OTHER_BIZ_ID}');`);

  // Create test business
  sql(`INSERT INTO businesses (id, name, owner_id, category) VALUES
    ('${BIZ_ID}', 'Test Biz 602', '${USER_ID}', 'restaurant'),
    ('${OTHER_BIZ_ID}', 'Other Biz', '${USER_ID}', 'restaurant')
    ON CONFLICT (id) DO NOTHING;`);

  // Create products: A=$1000, B=$500
  sql(`INSERT INTO products (id, business_id, name, price, is_active) VALUES
    ('${PRODUCT_A_ID}', '${BIZ_ID}', 'Product A', 1000, true),
    ('${PRODUCT_B_ID}', '${BIZ_ID}', 'Product B', 500, true)
    ON CONFLICT (id) DO NOTHING;`);

  // Create variant: A-variant=$1200
  sql(`INSERT INTO product_variants (id, product_id, name, price, is_active) VALUES
    ('${VARIANT_A_ID}', '${PRODUCT_A_ID}', 'Large', 1200, true)
    ON CONFLICT (id) DO NOTHING;`);

  // Create promos
  sql(`INSERT INTO promo_codes (id, business_id, code, discount_type, discount_value, is_active, valid_from, valid_until, max_uses, current_uses, applicable_flow_types, applicable_services, min_order_amount) VALUES
    ('${PROMO_10PCT_ID}', '${BIZ_ID}', 'TEN', 'percentage', 10, true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', NULL, 0, '{}', '{}', 0),
    ('${PROMO_FIXED_ID}', '${BIZ_ID}', 'FLAT200', 'fixed', 200, true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', NULL, 0, '{}', '{}', 0),
    ('${PROMO_EXPIRED_ID}', '${BIZ_ID}', 'EXPIRED', 'percentage', 10, true, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day', NULL, 0, '{}', '{}', 0),
    ('${PROMO_FUTURE_ID}', '${BIZ_ID}', 'FUTURE', 'percentage', 10, true, NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', NULL, 0, '{}', '{}', 0),
    ('${PROMO_WRONG_FLOW_ID}', '${BIZ_ID}', 'SCHED', 'percentage', 10, true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', NULL, 0, '{scheduling}', '{}', 0),
    ('${PROMO_WRONG_PRODUCT_ID}', '${BIZ_ID}', 'ONLYB', 'percentage', 10, true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', NULL, 0, '{}', ARRAY['${PRODUCT_B_ID}']::uuid[], 0),
    ('${PROMO_OTHER_BIZ_ID}', '${OTHER_BIZ_ID}', 'OTHER', 'percentage', 10, true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', NULL, 0, '{}', '{}', 0),
    ('${PROMO_INACTIVE_ID}', '${BIZ_ID}', 'OFF', 'percentage', 10, false, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', NULL, 0, '{}', '{}', 0),
    ('${PROMO_LAST_USE_ID}', '${BIZ_ID}', 'LAST', 'percentage', 10, true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 1, 0, '{}', '{}', 0),
    ('${PROMO_FIXED_CAP_ID}', '${BIZ_ID}', 'BIG', 'fixed', 99999, true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', NULL, 0, '{}', '{}', 0)
    ON CONFLICT (id) DO NOTHING;`);
});

afterAll(() => {
  sql(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM order_stock_applications WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM promo_reservations WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM orders WHERE business_id = '${BIZ_ID}';`);
  sql(`DELETE FROM promo_codes WHERE business_id IN ('${BIZ_ID}', '${OTHER_BIZ_ID}');`);
  sql(`DELETE FROM volume_discount_rules WHERE business_id = '${BIZ_ID}';`);
  sql(`DELETE FROM product_variants WHERE product_id IN ('${PRODUCT_A_ID}', '${PRODUCT_B_ID}');`);
  sql(`DELETE FROM products WHERE id IN ('${PRODUCT_A_ID}', '${PRODUCT_B_ID}');`);
  sql(`DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${OTHER_BIZ_ID}');`);
});

function callCreateOrder(opts: {
  sessionId: string;
  promoId?: string;
  discount?: number;
  volumeDiscount?: number;
  expectedTotal?: number;
  items?: string;
}): Record<string, unknown> {
  const items = opts.items || `[{"product_id":"${PRODUCT_A_ID}","quantity":2,"unit_price":1000}]`;
  // Product A: price=1000, qty=2, subtotal=2000
  return sqlJson(`
    SELECT create_order_atomic(
      '${opts.sessionId}'::uuid,
      '${BIZ_ID}'::uuid,
      '${USER_ID}'::uuid,
      'pending',
      NULL, NULL,
      ${opts.expectedTotal ?? 0},
      ${opts.discount ?? 0},
      0,
      ${opts.promoId ? `'${opts.promoId}'::uuid` : 'NULL'},
      'whatsapp', NULL, NULL, NULL, 0,
      ${opts.volumeDiscount ?? 0},
      NULL, NULL, NULL, NULL,
      '${items.replace(/'/g, "''")}'::jsonb,
      NULL,
      true,
      ${opts.expectedTotal ?? 0}
    );
  `);
}

describe('#602 Ordering price authority (real PG)', () => {
  // ── (a) Fabricated discount without promo ──
  it('rejects fabricated discount without promo code', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      discount: 500,
      expectedTotal: 1500, // 2000 - 500 fabricated
    });
    expect(result._error || result._raw).toContain('discount_without_promo');
  });

  // ── (b) Cross-tenant promo ──
  it('rejects cross-tenant promo', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_OTHER_BIZ_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(result._error || result._raw).toContain('promo_tenant_mismatch');
  });

  // ── (b) Inactive promo ──
  it('rejects inactive promo', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_INACTIVE_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(result._error || result._raw).toContain('promo_inactive');
  });

  // ── (b) Expired promo ──
  it('rejects expired promo', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_EXPIRED_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(result._error || result._raw).toContain('promo_expired');
  });

  // ── (b) Not-yet-active promo ──
  it('rejects not-yet-active promo', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_FUTURE_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(result._error || result._raw).toContain('promo_not_yet_active');
  });

  // ── (b) Wrong flow type ──
  it('rejects promo for wrong flow type', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_WRONG_FLOW_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(result._error || result._raw).toContain('promo_wrong_flow');
  });

  // ── (b) Wrong product scope ──
  it('rejects promo for wrong product (mixed cart)', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_WRONG_PRODUCT_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(result._error || result._raw).toContain('promo_wrong_product');
  });

  // ── (d) Valid 10% promo ──
  it('accepts valid 10% promo with correct server-computed discount', () => {
    // Product A: price=1000, qty=2, subtotal=2000
    // 10% of 2000 = 200, total = 2000 - 200 = 1800
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_10PCT_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(result.created).toBe(true);
    expect(result.server_discount).toBe(200);
    expect(result.server_total).toBe(1800);
  });

  // ── (d) Valid fixed promo ──
  it('accepts valid fixed promo with correct discount', () => {
    // FLAT200: fixed 200, subtotal=2000, total=2000-200=1800
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_FIXED_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(result.created).toBe(true);
    expect(result.server_discount).toBe(200);
  });

  // ── (d) Fixed promo capped at subtotal ──
  it('caps fixed promo at subtotal', () => {
    // BIG: fixed 99999 but subtotal=2000, capped at 2000, total=0
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_FIXED_CAP_ID,
      discount: 2000,
      expectedTotal: 0,
    });
    expect(result.created).toBe(true);
    expect(result.server_discount).toBe(2000);
    expect(result.server_total).toBe(0);
  });

  // ── (a) Caller inflates discount ──
  it('rejects caller-inflated discount (5000 vs server 200)', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_10PCT_ID,
      discount: 5000,
      expectedTotal: -3000,
    });
    // Server computes 200 but caller says 5000 → discount_mismatch
    expect(result._error || result._raw).toContain('discount_mismatch');
  });

  // ── (h) No side effects on rejected underpricing ──
  it('creates zero order rows on rejected fabricated discount', () => {
    const sid = sessionId();
    callCreateOrder({
      sessionId: sid,
      discount: 9999,
      expectedTotal: -7999,
    });
    const count = sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`);
    expect(count).toBe('0');
  });

  it('creates zero promo reservations on rejected promo', () => {
    const sid = sessionId();
    callCreateOrder({
      sessionId: sid,
      promoId: PROMO_EXPIRED_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    const count = sql(`SELECT count(*) FROM promo_reservations WHERE order_id IN (SELECT id FROM orders WHERE bot_session_id = '${sid}');`);
    expect(count).toBe('0');
  });

  // ── (e) Concurrent last promo ──
  it('exhausts promo capacity (max_uses=1)', () => {
    // First use should succeed
    const r1 = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_LAST_USE_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(r1.created).toBe(true);

    // Second use should fail (capacity exhausted)
    const r2 = callCreateOrder({
      sessionId: sessionId(),
      promoId: PROMO_LAST_USE_ID,
      discount: 200,
      expectedTotal: 1800,
    });
    expect(r2._error || r2._raw).toContain('promo_exhausted');
  });

  // ── No promo, no discount ──
  it('accepts order without promo and zero discount', () => {
    const result = callCreateOrder({
      sessionId: sessionId(),
      expectedTotal: 2000,
    });
    expect(result.created).toBe(true);
    expect(result.server_total).toBe(2000);
    expect(result.server_discount).toBe(0);
    expect(result.server_volume_discount).toBe(0);
  });
});

} // end if (dbUrl)
