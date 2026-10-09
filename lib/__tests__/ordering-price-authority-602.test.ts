/**
 * #602 M435: Ordering price authority — disposable PostgreSQL RPC tests.
 *
 * R2-2: Fixtures include required NOT NULL fields; setup asserts success.
 * R2-3: Each test uses unique session IDs; promo-reuse tests use dedicated promos.
 * R2-4: DB guard requires localhost + allowlisted DB name.
 * R2-5: Replay validates business, user, total, promo, discount, volume discount.
 * R2-6: Stacking test uses promo + volume together.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

// R2-4: Strict DB guard — require localhost AND allowlisted disposable DB name
if (dbUrl) {
  let parsedHost = '';
  let parsedDb = '';
  try {
    const u = new URL(dbUrl);
    parsedHost = u.hostname;
    parsedDb = u.pathname.replace(/^\//, '');
  } catch { /* invalid URL — will fail below */ }
  const isLocal = parsedHost === 'localhost' || parsedHost === '127.0.0.1';
  const isDisposable = /^waaiio_(m435_test|test)$/.test(parsedDb);
  if (!isLocal || !isDisposable) {
    throw new Error(
      `TEST_DATABASE_URL must point to localhost with an allowlisted disposable DB ` +
      `(waaiio_m435_test or waaiio_test). Got host=${parsedHost} db=${parsedDb}`,
    );
  }
}

if (!dbUrl) {
  describe.skip('#602 M435 ordering price authority (real PG) — requires TEST_DATABASE_URL', () => {
    it('skipped', () => {});
  });
} else {

// R2-2: Fail-fast SQL helper — throws on error instead of returning string
function sql(query: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: query, encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: any) {
    const msg = err.stderr?.trim() || err.stdout?.trim() || err.message;
    throw new Error(`SQL failed: ${msg}`);
  }
}

function sqlMayFail(query: string): string {
  try { return sql(query); }
  catch (err: any) { return `ERROR:${err.message}`; }
}

function sqlJson(query: string): Record<string, unknown> {
  const raw = sqlMayFail(query);
  if (raw.startsWith('ERROR:')) return { _error: raw };
  try {
    const lines = raw.split('\n');
    const jsonLine = lines.find(l => l.startsWith('{')) || raw;
    return JSON.parse(jsonLine);
  } catch {
    return { _raw: raw };
  }
}

// ── Test fixtures — each promo used by at most one positive test ──
const BIZ_ID = '00000000-0000-0000-0000-000000000602';
const USER_ID = '00000000-0000-0000-0000-000000000001'; // CI-seeded
const USER_B_ID = '00000000-0000-0000-0000-000000000000'; // CI-seeded alternate
const OTHER_BIZ_ID = '00000000-0000-0000-0000-000000000604';
const PRODUCT_A_ID = '00000000-0000-0000-0000-000000000610';
const PRODUCT_B_ID = '00000000-0000-0000-0000-000000000611';
const VARIANT_A_ID = '00000000-0000-0000-0000-000000000620';

// R2-3: Dedicated promos per test to avoid cross-test pollution
const PROMO_REJECT_EXPIRED = '00000000-0000-0000-0000-000000000630';
const PROMO_REJECT_FUTURE = '00000000-0000-0000-0000-000000000631';
const PROMO_REJECT_INACTIVE = '00000000-0000-0000-0000-000000000632';
const PROMO_REJECT_FLOW = '00000000-0000-0000-0000-000000000633';
const PROMO_REJECT_PRODUCT = '00000000-0000-0000-0000-000000000634';
const PROMO_REJECT_TENANT = '00000000-0000-0000-0000-000000000635';
const PROMO_10PCT_A = '00000000-0000-0000-0000-000000000640'; // for positive 10% test
const PROMO_10PCT_B = '00000000-0000-0000-0000-000000000641'; // for variant test
const PROMO_FIXED_A = '00000000-0000-0000-0000-000000000642'; // for positive fixed test
const PROMO_FIXED_CAP = '00000000-0000-0000-0000-000000000643'; // for cap test
const PROMO_INFLATED = '00000000-0000-0000-0000-000000000644'; // for inflated test
const PROMO_LAST_USE = '00000000-0000-0000-0000-000000000645'; // for capacity test
const PROMO_REUSE_A = '00000000-0000-0000-0000-000000000646'; // for reuse test
const PROMO_REPLAY = '00000000-0000-0000-0000-000000000647'; // for replay discount test
const PROMO_CONCURRENT = '00000000-0000-0000-0000-000000000649';
const PROMO_STACK = '00000000-0000-0000-0000-000000000648'; // for stacking test

const VOL_RULE_PCT = '00000000-0000-0000-0000-000000000650';
const VOL_RULE_FIXED_UNIT = '00000000-0000-0000-0000-000000000651';
const VOL_RULE_FIXED_TOTAL = '00000000-0000-0000-0000-000000000652';
const ADDON_A = '00000000-0000-0000-0000-000000000653';
const PROMO_STACK_CAP = '00000000-0000-0000-0000-000000000654';

function sessionId(): string {
  return sql("SELECT gen_random_uuid()::text;");
}

function cleanup() {
  sqlMayFail(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sqlMayFail(`DELETE FROM order_stock_applications WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sqlMayFail(`DELETE FROM promo_reservations WHERE order_id IN (SELECT id FROM orders WHERE business_id = '${BIZ_ID}');`);
  sqlMayFail(`DELETE FROM orders WHERE business_id = '${BIZ_ID}';`);
  sqlMayFail(`DELETE FROM promo_codes WHERE business_id IN ('${BIZ_ID}', '${OTHER_BIZ_ID}');`);
  sqlMayFail(`DELETE FROM volume_discount_rules WHERE business_id = '${BIZ_ID}';`);
  sqlMayFail(`DELETE FROM product_addons WHERE business_id = '${BIZ_ID}';`);
  sqlMayFail(`DELETE FROM product_variants WHERE product_id IN ('${PRODUCT_A_ID}', '${PRODUCT_B_ID}');`);
  sqlMayFail(`DELETE FROM products WHERE id IN ('${PRODUCT_A_ID}', '${PRODUCT_B_ID}');`);
  sqlMayFail(`DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${OTHER_BIZ_ID}');`);
}

beforeAll(() => {
  cleanup();

  // R2-2: Assert fixture setup succeeds (fail-fast sql helper throws on error)
  sql(`INSERT INTO businesses (id, name, owner_id, category, slug, address, city, neighborhood, phone, country_code) VALUES
    ('${BIZ_ID}', 'Test Biz 602', '${USER_ID}', 'restaurant', 'test-biz-602', '1 Test St', 'Lagos', 'VI', '+2340000000602', 'NG'),
    ('${OTHER_BIZ_ID}', 'Other Biz', '${USER_ID}', 'restaurant', 'other-biz-602', '2 Test St', 'Lagos', 'VI', '+2340000000604', 'NG')
    ON CONFLICT (id) DO NOTHING;`);

  sql(`INSERT INTO products (id, business_id, name, price, is_active) VALUES
    ('${PRODUCT_A_ID}', '${BIZ_ID}', 'Product A', 1000, true),
    ('${PRODUCT_B_ID}', '${BIZ_ID}', 'Product B', 500, true)
    ON CONFLICT (id) DO NOTHING;`);

  sql(`INSERT INTO product_variants (id, product_id, name, price, is_active) VALUES
    ('${VARIANT_A_ID}', '${PRODUCT_A_ID}', 'Large', 1200, true)
    ON CONFLICT (id) DO NOTHING;`);

  sql(`INSERT INTO product_addons (id, business_id, product_id, name, price, is_active)
    VALUES ('${ADDON_A}', '${BIZ_ID}', '${PRODUCT_A_ID}', 'Gift wrap', 100, true)
    ON CONFLICT (id) DO NOTHING;`);

  // R2-2: Volume discount rules include required `name` column
  sql(`INSERT INTO volume_discount_rules (id, business_id, product_id, name, discount_type, discount_value, min_quantity, max_quantity, is_active) VALUES
    ('${VOL_RULE_PCT}', '${BIZ_ID}', '${PRODUCT_A_ID}', 'Bulk A 10%', 'percentage', 10, 3, NULL, true),
    ('${VOL_RULE_FIXED_UNIT}', '${BIZ_ID}', '${PRODUCT_B_ID}', 'Bulk B per unit', 'fixed_per_unit', 50, 3, 3, true),
    ('${VOL_RULE_FIXED_TOTAL}', '${BIZ_ID}', '${PRODUCT_B_ID}', 'Bulk B total', 'fixed_total', 75, 4, 4, true)
    ON CONFLICT (id) DO NOTHING;`);

  // R2-3: Each promo dedicated to one test scenario
  sql(`INSERT INTO promo_codes (id, business_id, code, discount_type, discount_value, is_active, valid_from, valid_until, max_uses, current_uses, applicable_flow_types, applicable_services, min_order_amount) VALUES
    ('${PROMO_REJECT_EXPIRED}', '${BIZ_ID}', 'EXPIRED', 'percentage', 10, true, NOW()-INTERVAL'2d', NOW()-INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_REJECT_FUTURE}', '${BIZ_ID}', 'FUTURE', 'percentage', 10, true, NOW()+INTERVAL'1d', NOW()+INTERVAL'2d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_REJECT_INACTIVE}', '${BIZ_ID}', 'OFF', 'percentage', 10, false, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_REJECT_FLOW}', '${BIZ_ID}', 'SCHED', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{scheduling}', '{}', 0),
    ('${PROMO_REJECT_PRODUCT}', '${BIZ_ID}', 'ONLYB', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', ARRAY['${PRODUCT_B_ID}']::uuid[], 0),
    ('${PROMO_REJECT_TENANT}', '${OTHER_BIZ_ID}', 'OTHER', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_10PCT_A}', '${BIZ_ID}', 'TEN_A', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_10PCT_B}', '${BIZ_ID}', 'TEN_B', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_FIXED_A}', '${BIZ_ID}', 'FLAT_A', 'fixed', 200, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_FIXED_CAP}', '${BIZ_ID}', 'BIG', 'fixed', 99999, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_INFLATED}', '${BIZ_ID}', 'INF', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_LAST_USE}', '${BIZ_ID}', 'LAST', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', 1, 0, '{}', '{}', 0),
    ('${PROMO_REUSE_A}', '${BIZ_ID}', 'REUSE', 'fixed', 100, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_REPLAY}', '${BIZ_ID}', 'REPLAY', 'fixed', 150, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_STACK}', '${BIZ_ID}', 'STACK', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0),
    ('${PROMO_CONCURRENT}', '${BIZ_ID}', 'CONCURRENT', 'percentage', 10, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', 1, 0, '{}', '{}', 0),
    ('${PROMO_STACK_CAP}', '${BIZ_ID}', 'STACK_CAP', 'fixed', 99999, true, NOW()-INTERVAL'1d', NOW()+INTERVAL'1d', NULL, 0, '{}', '{}', 0)
    ON CONFLICT (id) DO NOTHING;`);

  // Verify fixtures installed
  const prodCount = sql(`SELECT count(*) FROM products WHERE id IN ('${PRODUCT_A_ID}','${PRODUCT_B_ID}');`);
  if (prodCount !== '2') throw new Error(`Fixture setup failed: expected 2 products, got ${prodCount}`);
  const promoCount = sql(`SELECT count(*) FROM promo_codes WHERE business_id = '${BIZ_ID}';`);
  if (parseInt(promoCount) < 10) throw new Error(`Fixture setup failed: expected >=10 promos, got ${promoCount}`);
  const volCount = sql(`SELECT count(*) FROM volume_discount_rules WHERE business_id = '${BIZ_ID}';`);
  if (volCount !== '3') throw new Error(`Fixture setup failed: expected 3 vol rules, got ${volCount}`);
});

afterAll(() => { cleanup(); });

interface CheckoutInput {
  sessionId: string;
  userId?: string;
  businessId?: string;
  promoId?: string;
  discount?: number;
  volumeDiscount?: number;
  expectedTotal?: number | null;
  totalAmount?: number;
  shippingCost?: number;
  addonsTotal?: number;
  zoneId?: string;
  items?: string;
}
function orderSql(opts: CheckoutInput): string {
  const uid = opts.userId || USER_ID;
  const bid = opts.businessId || BIZ_ID;
  const items = opts.items || `[{"product_id":"${PRODUCT_A_ID}","quantity":2,"unit_price":1000}]`;
  const amount = opts.totalAmount ?? opts.expectedTotal ?? 0;
  const expected = opts.expectedTotal === null ? 'NULL' : String(opts.expectedTotal ?? 0);
  return `
    SELECT create_order_atomic(
      '${opts.sessionId}'::uuid, '${bid}'::uuid, '${uid}'::uuid,
      'pending', NULL, NULL, ${amount}, ${opts.discount ?? 0}, ${opts.shippingCost ?? 0},
      ${opts.promoId ? `'${opts.promoId}'::uuid` : 'NULL'},
      'whatsapp', NULL, ${opts.zoneId ? `'${opts.zoneId}'::uuid` : 'NULL'}, NULL, ${opts.addonsTotal ?? 0}, ${opts.volumeDiscount ?? 0},
      NULL, NULL, NULL, NULL,
      '${items.replace(/'/g, "''")}'::jsonb, NULL, true, ${expected}
    );
  `;
}
function callOrder(opts: CheckoutInput): Record<string, unknown> {
  return sqlJson(orderSql(opts));
}
function asyncPsql(query: string) {
  const child = spawn('psql', [dbUrl!, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (v: Buffer) => { stdout += v.toString(); });
  child.stderr.on('data', (v: Buffer) => { stderr += v.toString(); });
  const done = new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
  });
  child.stdin.end(query);
  return { child, done, output: () => stdout };
}

describe('#602 M435 ordering price authority (real PG)', () => {

  // ── Promo rejection tests ──
  it('rejects fabricated discount without promo', () => {
    expect(callOrder({ sessionId: sessionId(), discount: 500, expectedTotal: 1500 })._error).toContain('discount_without_promo');
  });
  it('rejects cross-tenant promo', () => {
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_REJECT_TENANT, discount: 200, expectedTotal: 1800 })._error).toContain('promo_tenant_mismatch');
  });
  it('rejects inactive promo', () => {
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_REJECT_INACTIVE, discount: 200, expectedTotal: 1800 })._error).toContain('promo_inactive');
  });
  it('rejects expired promo', () => {
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_REJECT_EXPIRED, discount: 200, expectedTotal: 1800 })._error).toContain('promo_expired');
  });
  it('rejects not-yet-active promo', () => {
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_REJECT_FUTURE, discount: 200, expectedTotal: 1800 })._error).toContain('promo_not_yet_active');
  });
  it('rejects wrong flow type', () => {
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_REJECT_FLOW, discount: 200, expectedTotal: 1800 })._error).toContain('promo_wrong_flow');
  });
  it('rejects wrong product scope', () => {
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_REJECT_PRODUCT, discount: 200, expectedTotal: 1800 })._error).toContain('promo_wrong_product');
  });

  // ── Valid promo tests (each uses a unique promo) ──
  it('10% promo: server-computed discount', () => {
    const r = callOrder({ sessionId: sessionId(), promoId: PROMO_10PCT_A, discount: 200, expectedTotal: 1800 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(200);
    expect(r.server_total).toBe(1800);
  });
  it('fixed promo', () => {
    const r = callOrder({ sessionId: sessionId(), promoId: PROMO_FIXED_A, discount: 200, expectedTotal: 1800 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(200);
  });
  it('fixed promo capped at subtotal', () => {
    const r = callOrder({ sessionId: sessionId(), promoId: PROMO_FIXED_CAP, discount: 2000, expectedTotal: 0 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(2000);
  });
  it('rejects caller-inflated discount', () => {
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_INFLATED, discount: 5000, expectedTotal: -3000 })._error).toContain('discount_mismatch');
  });

  // ── No side effects on rejection ──
  it('zero order rows on rejected discount', () => {
    const sid = sessionId();
    callOrder({ sessionId: sid, discount: 9999, expectedTotal: -7999 });
    expect(sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`)).toBe('0');
  });

  // ── Capacity exhaustion ──
  it('exhausts promo capacity (max_uses=1)', () => {
    const r1 = callOrder({ sessionId: sessionId(), promoId: PROMO_LAST_USE, discount: 200, expectedTotal: 1800 });
    expect(r1.created).toBe(true);
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_LAST_USE, discount: 200, expectedTotal: 1800 })._error).toContain('promo_exhausted');
  });

  // ── No promo baseline ──
  it('accepts order without promo', () => {
    const r = callOrder({ sessionId: sessionId(), expectedTotal: 2000 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(0);
    expect(r.server_volume_discount).toBe(0);
  });

  // ── Volume discount (R2-6) ──
  it('percentage volume discount from locked DB price', () => {
    // Product A qty=3, rule: 10% at min_quantity=3, DB price=1000
    // 3*1000=3000, 10%=300
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":3,"unit_price":1000}]`;
    const r = callOrder({ sessionId: sessionId(), items, volumeDiscount: 300, expectedTotal: 2700 });
    expect(r.created).toBe(true);
    expect(r.server_volume_discount).toBe(300);
  });
  it('rejects caller-inflated volume discount', () => {
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":3,"unit_price":1000}]`;
    expect(callOrder({ sessionId: sessionId(), items, volumeDiscount: 9999, expectedTotal: -6999 })._error).toContain('volume_discount_mismatch');
  });
  it('no volume discount below min_quantity', () => {
    const r = callOrder({ sessionId: sessionId(), volumeDiscount: 0, expectedTotal: 2000 });
    expect(r.created).toBe(true);
    expect(r.server_volume_discount).toBe(0);
  });

  // ── Variant price authority ──
  it('uses locked variant price (not caller unit_price)', () => {
    // Variant A-Large: DB price=1200, qty=1, 10% promo=120, total=1080
    const items = `[{"product_id":"${PRODUCT_A_ID}","variant_id":"${VARIANT_A_ID}","quantity":1,"unit_price":1200}]`;
    const r = callOrder({ sessionId: sessionId(), items, promoId: PROMO_10PCT_B, discount: 120, expectedTotal: 1080 });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(120);
  });

  // ── Negative/zero quantities (603-D) ──
  it('rejects negative item quantity', () => {
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":-1,"unit_price":1000}]`;
    expect(callOrder({ sessionId: sessionId(), items, expectedTotal: -1000 })._error).toContain('invalid_quantity');
  });
  it('rejects zero item quantity', () => {
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":0,"unit_price":1000}]`;
    expect(callOrder({ sessionId: sessionId(), items, expectedTotal: 0 })._error).toContain('invalid_quantity');
  });
  it('no order on negative quantity', () => {
    const sid = sessionId();
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":-5,"unit_price":1000}]`;
    callOrder({ sessionId: sid, items, expectedTotal: -5000 });
    expect(sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`)).toBe('0');
  });

  // ── Idempotent replay (R2-5) ──
  it('allows exact replay', () => {
    const sid = sessionId();
    const r1 = callOrder({ sessionId: sid, expectedTotal: 2000 });
    expect(r1.created).toBe(true);
    const r2 = callOrder({ sessionId: sid, expectedTotal: 2000 });
    expect(r2.created).toBe(false);
    expect(r2.order_id).toBe(r1.order_id);
    expect(r2.server_total).toBe(2000); // R2-5: returns authoritative total
  });
  it('rejects replay with changed total', () => {
    const sid = sessionId();
    callOrder({ sessionId: sid, expectedTotal: 2000 });
    expect(callOrder({ sessionId: sid, expectedTotal: 1500 })._error).toContain('replay_total_mismatch');
  });
  it('rejects replay with changed promo', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000}).created).toBe(true);
    expect(callOrder({sessionId: sid, promoId: PROMO_REPLAY, expectedTotal: 2000})._error).toContain('replay_promo_mismatch');
  });
  it('rejects replay with changed discount', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, promoId: PROMO_REPLAY, discount: 150, expectedTotal: 1850}).created).toBe(true);
    expect(callOrder({sessionId: sid, promoId: PROMO_REPLAY, discount: 100, expectedTotal: 1850})._error).toContain('replay_discount_mismatch');
  });
  it('rejects replay with changed volume discount', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000}).created).toBe(true);
    expect(callOrder({sessionId: sid, volumeDiscount: 500, expectedTotal: 2000})._error).toContain('replay_volume_discount_mismatch');
  });

  // ── Per-customer promo reuse (R2-3/603-F) ──
  it('rejects promo already used by same customer', () => {
    const r1 = callOrder({ sessionId: sessionId(), promoId: PROMO_REUSE_A, discount: 100, expectedTotal: 1900 });
    expect(r1.created).toBe(true);
    expect(callOrder({ sessionId: sessionId(), promoId: PROMO_REUSE_A, discount: 100, expectedTotal: 1900 })._error).toContain('promo_already_used');
  });

  // ── Complete monetary replay and quantity contracts ──
  it('rejects missing expected total on validated replay', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000}).created).toBe(true);
    expect(callOrder({sessionId: sid, expectedTotal: null, totalAmount: 2000})._error).toContain('expected_total_required');
  });
  it('rejects cross-business order retry', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000}).created).toBe(true);
    expect(callOrder({sessionId: sid, businessId: OTHER_BIZ_ID, expectedTotal: 2000})._error).toContain('replay_business_mismatch');
  });
  it('rejects cross-customer order retry', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000}).created).toBe(true);
    expect(callOrder({sessionId: sid, userId: USER_B_ID, expectedTotal: 2000})._error).toContain('replay_user_mismatch');
  });
  it('rejects replay with altered payable quote', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000}).created).toBe(true);
    expect(callOrder({sessionId: sid, expectedTotal: 2000, totalAmount: 1})._error).toContain('replay_payment_amount_mismatch');
  });
  it('rejects new order with quoted payable not matching expected total', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000, totalAmount: 1})._error).toContain('quoted_payment_amount_mismatch');
    expect(sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`)).toBe('0');
  });
  it('rejects replay with altered delivery zone', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000}).created).toBe(true);
    expect(callOrder({sessionId: sid, expectedTotal: 2000, zoneId: '00000000-0000-0000-0000-000000000699'})._error).toContain('replay_zone_mismatch');
  });
  it('rejects replay with altered shipping fee', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 2000}).created).toBe(true);
    expect(callOrder({sessionId: sid, expectedTotal: 2000, shippingCost: 99})._error).toContain('replay_shipping_mismatch');
  });
  it('rejects negative addon quantity without creating an order', () => {
    const sid = sessionId();
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":1,"unit_price":1000,"addons":[{"id":"00000000-0000-0000-0000-000000000697","quantity":-1}]}]`;
    expect(callOrder({sessionId: sid, items, expectedTotal: 1000})._error).toContain('invalid_addon_quantity');
    expect(sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`)).toBe('0');
  });
  it('computes fixed-per-unit tier using canonical product B price', () => {
    const items = `[{"product_id":"${PRODUCT_B_ID}","quantity":3,"unit_price":1}]`;
    const r = callOrder({sessionId: sessionId(), items, volumeDiscount: 150, expectedTotal: 1350});
    expect(r.created).toBe(true); expect(r.server_volume_discount).toBe(150); expect(r.server_total).toBe(1350);
  });
  it('computes fixed-total tier using canonical product B price', () => {
    const items = `[{"product_id":"${PRODUCT_B_ID}","quantity":4,"unit_price":1}]`;
    const r = callOrder({sessionId: sessionId(), items, volumeDiscount: 75, expectedTotal: 1925});
    expect(r.created).toBe(true); expect(r.server_volume_discount).toBe(75); expect(r.server_total).toBe(1925);
  });
  it('serializes overlapping last-promo PostgreSQL transactions', async () => {
    const first = asyncPsql(`BEGIN;\n${orderSql({sessionId: sessionId(), promoId: PROMO_CONCURRENT, discount: 200, expectedTotal: 1800})}\nSELECT pg_sleep(2);\nCOMMIT;\n`);
    // Prove the first transaction has inserted its order but has not committed.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('First PG transaction never committed an order statement')), 8000);
      const check = () => {
        if (first.output().includes('"created": true')) { clearTimeout(timeout); resolve(); }
      };
      first.child.stdout.on('data', check);
      first.done.then(r => { check(); if (!first.output().includes('"created": true')) { clearTimeout(timeout); reject(new Error('First transaction failed: ' + r.stderr)); } }, reject);
      check();
    });
    const second = asyncPsql(orderSql({sessionId: sessionId(), userId: USER_B_ID, promoId: PROMO_CONCURRENT, discount: 200, expectedTotal: 1800}));
    const [a,b] = await Promise.all([first.done, second.done]);
    expect(a.code).toBe(0);
    expect(b.code).not.toBe(0);
    expect(b.stderr).toContain('promo_exhausted');
  }, 15000);

  it('rejects negative shipping cost without order creation', () => {
    const sid = sessionId();
    expect(callOrder({sessionId: sid, expectedTotal: 1900, shippingCost: -100})._error).toContain('invalid_shipping_cost');
    expect(sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`)).toBe('0');
  });
  it('persists DB-computed addon total and rejects a tampered quote', () => {
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":1,"unit_price":1000,"addons":[{"id":"${ADDON_A}","quantity":2}]}]`;
    const sid = sessionId();
    expect(callOrder({sessionId: sid, items, expectedTotal: 1200, addonsTotal: 0})._error).toContain('addons_total_mismatch');
    const r = callOrder({sessionId: sid, items, expectedTotal: 1200, addonsTotal: 200});
    expect(r.created).toBe(true);
    expect(sql(`SELECT addons_total FROM orders WHERE id = '${r.order_id}';`)).toBe('200');
  });
  it('rejects overstacked promo and volume discounts without a free order', () => {
    const sid = sessionId();
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":3,"unit_price":1000}]`;
    expect(callOrder({sessionId: sid, items, promoId: PROMO_STACK_CAP, discount: 3000, volumeDiscount: 300, expectedTotal: 0})._error)
      .toContain('combined_discount_exceeds_subtotal');
    expect(sql(`SELECT count(*) FROM orders WHERE bot_session_id = '${sid}';`)).toBe('0');
  });

  // ── Promo + volume stacking (R2-6) ──
  it('stacks promo and volume discount correctly', () => {
    // Product A qty=3: subtotal=3000
    // Volume 10%=300, promo STACK 10% of subtotal=300
    // total = 3000 - 300(promo) - 300(vol) = 2400
    const items = `[{"product_id":"${PRODUCT_A_ID}","quantity":3,"unit_price":1000}]`;
    const r = callOrder({
      sessionId: sessionId(),
      items,
      promoId: PROMO_STACK,
      discount: 300,
      volumeDiscount: 300,
      expectedTotal: 2400,
    });
    expect(r.created).toBe(true);
    expect(r.server_discount).toBe(300);
    expect(r.server_volume_discount).toBe(300);
    expect(r.server_total).toBe(2400);
  });
});

} // end if (dbUrl)
