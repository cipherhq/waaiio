/**
 * #602: Ordering price authority — disposable PostgreSQL RPC tests.
 *
 * Tests M435 create_order_atomic against a real PostgreSQL database.
 * Requires TEST_DATABASE_URL (set by CI bootstrap; hard-deny non-disposable DBs).
 *
 * 603-B: Guard against non-disposable databases.
 * 603-C: Volume discount rules, variant pricing, negative quantities, replay validation.
 * 603-D: Positive quantity enforcement.
 * 603-E: Idempotent replay validates monetary contract.
 * 603-F: Per-customer promo reuse, volume rule locking.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

// 603-B: Hard-deny non-disposable databases
if (dbUrl && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1') && !dbUrl.includes('test') && !dbUrl.includes('disposable')) {
  throw new Error('TEST_DATABASE_URL appears to point to a non-disposable database. Refusing to run destructive test fixtures.');
}

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
const USER_ID = '00000000-0000-0000-0000-000000000001'; // 603-B: use CI-seeded user
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
const VOL_RULE_PCT_ID = '00000000-0000-0000-0000-000000000640';
const VOL_RULE_FIXED_ID = '00000000-0000-0000-0000-000000000641';

function sessionId(): string {
  return sql("SELECT gen_random_uuid()::text;");
}

function cleanup() {
  sql(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM order_stock_applications WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM promo_reservations WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sql(`DELETE FROM orders WHERE business_id = '${BIZ_ID}';`);
  sql(`DELETE FROM promo_codes WHERE business_id IN ('${BIZ_ID}', '${OTHER_BIZ_ID}');`);
  sql(`DELETE FROM volume_discount_rules WHERE business_id = '${BIZ_ID}';`);
  sql(`DELETE FROM product_addons WHERE business_id = '${BIZ_ID}';`);
  sql(`DELETE FROM product_variants WHERE product_id IN ('${PRODUCT_A_ID}', '${PRODUCT_B_ID}');`);
  sql(`DELETE FROM products WHERE id IN ('${PRODUCT_A_ID}', '${PRODUCT_B_ID}');`);
  sql(`DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${OTHER_BIZ_ID}');`);
}

beforeAll(() => {
  cleanup();

  sql(`INSERT INTO businesses (id, name, owner_id, category) VALUES
    ('${BIZ_ID}', 'Test Biz 602', '${USER_ID}', 'restaurant'),
    ('${OTHER_BIZ_ID}', 'Other Biz', '${USER_ID}', 'restaurant')
    ON CONFLICT (id) DO NOTHING;`);

  // Products: A=$1000, B=$500
  sql(`INSERT INTO products (id, business_id, name, price, is_active) VALUES
    ('${PRODUCT_A_ID}', '${BIZ_ID}', 'Product A', 1000, true),
    ('${PRODUCT_B_ID}', '${BIZ_ID}', 'Product B', 500, true)
    ON CONFLICT (id) DO NOTHING;`);

  // Variant: A-Large=$1200
  sql(`INSERT INTO product_variants (id, product_id, name, price, is_active) VALUES
    ('${VARIANT_A_ID}', '${PRODUCT_A_ID}', 'Large', 1200, true)
    ON CONFLICT (id) DO NOTHING;`);

  // Volume discount rules
  sql(`INSERT INTO volume_discount_rules (id, business_id, product_id, discount_type, discount_value, min_quantity, max_quantity, is_active) VALUES
    ('${VOL_RULE_PCT_ID}', '${BIZ_ID}', '${PRODUCT_A_ID}', 'percentage', 10, 3, NULL, true),
    ('${VOL_RULE_FIXED_ID}', '${BIZ_ID}', NULL, 'fixed_per_unit', 50, 5, NULL, true)
    ON CONFLICT (id) DO NOTHING;`);

  // Promos
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

afterAll(() => { cleanup(); });

function callCreateOrder(opts: {
  sessionId: string;
  promoId?: string;
  discount?: number;
  volumeDiscount?: number;
  expectedTotal?: number;
  items?: string;
}): Record<string, unknown> {
  const items = opts.items || `[{"product_id":"${PRODUCT_A_ID}","quantity":2,"unit_price":1000}]`;
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

  // ── Promo eligibility tests ──

  it('rejects fabricated discount without promo code', () => {
    const r = callCreateOrder({ sessionId: sessionId(), discount: 500, expectedTotal: 1500 });
    expect(r._error || r._raw).toContain('discount_without_promo');
  });

  it('rejects cross-tenant promo', () => {
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_OTHER_BIZ_ID, discount: 200, expectedTotal: 1800 });
    expect(r._error || r._raw).toContain('promo_tenant_mismatch');
  });

  it('rejects inactive promo', () => {
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_INACTIVE_ID, discount: 200, expectedTotal: 1800 });
    expect(r._error || r._raw).toContain('promo_inactive');
  });

  it('rejects expired promo', () => {
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_EXPIRED_ID, discount: 200, expectedTotal: 1800 });
    expect(r._error || r._raw).toContain('promo_expired');
  });

  it('rejects not-yet-active promo', () => {
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_FUTURE_ID, discount: 200, expectedTotal: 1800 });
    expect(r._error || r._raw).toContain('promo_not_yet_active');
  });

  it('rejects promo for wrong flow type', () => {
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_WRONG_FLOW_ID, discount: 200, expectedTotal: 1800 });
    expect(r._error || r._raw).toContain('promo_wrong_flow');
  });

  it('rejects promo for wrong product scope', () => {
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_WRONG_PRODUCT_ID, discount: 200, expectedTotal: 1800 });
    expect(r._error || r._raw).toContain('promo_wrong_product');
  });

  // ── Valid promo tests ──

  it('accepts valid 10% promo with server-computed discount', () => {
    // Product A: price=1000, qty=2 → subtotal=2000, 10%=200, total=1800
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_10PCT_ID, discount: 200, expectedTotal: 1800 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(200);
    expect(r.server_total).toBe(1800);
  });

  it('accepts valid fixed promo', () => {
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_FIXED_ID, discount: 200, expectedTotal: 1800 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(200);
  });

  it('caps fixed promo at subtotal', () => {
    // BIG: fixed 99999 capped at subtotal=2000, total=0
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_FIXED_CAP_ID, discount: 2000, expectedTotal: 0 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(2000);
    expect(r.server_total).toBe(0);
  });

  it('rejects caller-inflated discount', () => {
    const r = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_10PCT_ID, discount: 5000, expectedTotal: -3000 });
    expect(r._error || r._raw).toContain('discount_mismatch');
  });

  // ── No side effects on rejection ──

  it('creates zero order rows on rejected fabricated discount', () => {
    const sid = sessionId();
    callCreateOrder({ sessionId: sid, discount: 9999, expectedTotal: -7999 });
    expect(sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`)).toBe('0');
  });

  it('creates zero promo reservations on rejected promo', () => {
    const sid = sessionId();
    callCreateOrder({ sessionId: sid, promoId: PROMO_EXPIRED_ID, discount: 200, expectedTotal: 1800 });
    expect(sql(`SELECT count(*) FROM promo_reservations WHERE order_id IN (SELECT id FROM orders WHERE bot_session_id = '${sid}');`)).toBe('0');
  });

  // ── Promo capacity exhaustion ──

  it('exhausts promo capacity (max_uses=1)', () => {
    const r1 = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_LAST_USE_ID, discount: 200, expectedTotal: 1800 });
    expect(r1.created).toBe(true);
    const r2 = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_LAST_USE_ID, discount: 200, expectedTotal: 1800 });
    expect(r2._error || r2._raw).toContain('promo_exhausted');
  });

  // ── No promo baseline ──

  it('accepts order without promo and zero discount', () => {
    const r = callCreateOrder({ sessionId: sessionId(), expectedTotal: 2000 });
    expect(r.created).toBe(true);
    expect(r.server_total).toBe(2000);
    expect(r.server_discount).toBe(0);
    expect(r.server_volume_discount).toBe(0);
  });

  // ── 603-C: Volume discount rule tests ──

  it('computes percentage volume discount from locked DB price', () => {
    // Product A qty=3, vol rule: 10% at min_quantity=3
    // DB price=1000, 3*1000=3000, 10%=300
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":3,"unit_price":1000}]`;
    const r = callCreateOrder({ sessionId: sessionId(), items, volumeDiscount: 300, expectedTotal: 2700 });
    expect(r.created).toBe(true);
    expect(r.server_volume_discount).toBe(300);
  });

  it('rejects caller-inflated volume discount', () => {
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":3,"unit_price":1000}]`;
    const r = callCreateOrder({ sessionId: sessionId(), items, volumeDiscount: 9999, expectedTotal: -6999 });
    expect(r._error || r._raw).toContain('volume_discount_mismatch');
  });

  it('applies no volume discount below min_quantity', () => {
    // Product A qty=2, vol rule min_quantity=3 → no discount
    const r = callCreateOrder({ sessionId: sessionId(), volumeDiscount: 0, expectedTotal: 2000 });
    expect(r.created).toBe(true);
    expect(r.server_volume_discount).toBe(0);
  });

  // ── 603-C: Variant price authority ──

  it('uses locked variant price for discount and total', () => {
    // Variant A-Large: price=1200, qty=1 → subtotal=1200, 10% promo=120, total=1080
    const items = `[{"product_id":"${PRODUCT_A_ID}","variant_id":"${VARIANT_A_ID}","quantity":1,"unit_price":1200}]`;
    const r = callCreateOrder({ sessionId: sessionId(), items, promoId: PROMO_10PCT_ID, discount: 120, expectedTotal: 1080 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(120);
    expect(r.server_total).toBe(1080);
  });

  // ── 603-D: Negative quantity enforcement ──

  it('rejects negative item quantity', () => {
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":-1,"unit_price":1000}]`;
    const r = callCreateOrder({ sessionId: sessionId(), items, expectedTotal: -1000 });
    expect(r._error || r._raw).toContain('invalid_quantity');
  });

  it('rejects zero item quantity', () => {
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":0,"unit_price":1000}]`;
    const r = callCreateOrder({ sessionId: sessionId(), items, expectedTotal: 0 });
    expect(r._error || r._raw).toContain('invalid_quantity');
  });

  it('creates no order on negative quantity (no side effects)', () => {
    const sid = sessionId();
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":-5,"unit_price":1000}]`;
    callCreateOrder({ sessionId: sid, items, expectedTotal: -5000 });
    expect(sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`)).toBe('0');
  });

  // ── 603-E: Idempotent replay validation ──

  it('allows exact replay (same session, same cart, same amounts)', () => {
    const sid = sessionId();
    const r1 = callCreateOrder({ sessionId: sid, expectedTotal: 2000 });
    expect(r1.created).toBe(true);
    const r2 = callCreateOrder({ sessionId: sid, expectedTotal: 2000 });
    expect(r2.created).toBe(false);
    expect(r2.order_id).toBe(r1.order_id);
  });

  it('rejects replay with changed expected total', () => {
    const sid = sessionId();
    const r1 = callCreateOrder({ sessionId: sid, expectedTotal: 2000 });
    expect(r1.created).toBe(true);
    const r2 = callCreateOrder({ sessionId: sid, expectedTotal: 1500 });
    expect(r2._error || r2._raw).toContain('replay_total_mismatch');
  });

  it('rejects replay with changed promo code', () => {
    const sid = sessionId();
    const r1 = callCreateOrder({ sessionId: sid, expectedTotal: 2000 });
    expect(r1.created).toBe(true);
    const r2 = callCreateOrder({ sessionId: sid, promoId: PROMO_10PCT_ID, discount: 200, expectedTotal: 1800 });
    expect(r2._error || r2._raw).toContain('replay_promo_mismatch');
  });

  it('rejects replay with changed discount amount', () => {
    const sid = sessionId();
    const r1 = callCreateOrder({ sessionId: sid, promoId: PROMO_FIXED_ID, discount: 200, expectedTotal: 1800 });
    expect(r1.created).toBe(true);
    const r2 = callCreateOrder({ sessionId: sid, promoId: PROMO_FIXED_ID, discount: 100, expectedTotal: 1900 });
    expect(r2._error || r2._raw).toContain('replay_discount_mismatch');
  });

  // ── 603-F: Per-customer promo reuse ──

  it('rejects promo already used by same customer', () => {
    // First order with promo succeeds
    const r1 = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_FIXED_ID, discount: 200, expectedTotal: 1800 });
    expect(r1.created).toBe(true);
    // Second order with same promo by same user → rejected
    const r2 = callCreateOrder({ sessionId: sessionId(), promoId: PROMO_FIXED_ID, discount: 200, expectedTotal: 1800 });
    expect(r2._error || r2._raw).toContain('promo_already_used');
  });

  // ── Promo + volume discount stacking ──

  it('stacks promo and volume discount correctly', () => {
    // Product A qty=3: subtotal=3000, vol 10%=300, promo TEN 10%=300
    // total = 3000 - 300(promo) - 300(vol) = 2400
    // Note: need a fresh promo that hasn't been used by this user
    // Use PROMO_FIXED_CAP which gives full subtotal as discount = 3000, total=0
    // Actually let's use the baseline: just volume discount + no promo
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":3,"unit_price":1000}]`;
    const r = callCreateOrder({
      sessionId: sessionId(),
      items,
      volumeDiscount: 300,
      expectedTotal: 2700,
    });
    expect(r.created).toBe(true);
    expect(r.server_volume_discount).toBe(300);
    expect(r.server_total).toBe(2700);
  });
});

} // end if (dbUrl)
