/**
 * Disposable PG test: loyalty tier multiplier in apply_payment_loyalty_once (#762 W17)
 *
 * Exercises the actual M484-corrected RPC against a real PostgreSQL database
 * with the full migration set applied. Requires TEST_DATABASE_URL.
 *
 * Tests: Gold 2x multiplier, no profile (default 1x), no tier (default 1x),
 * inactive tier (default 1x), cross-business tier (tenant isolation),
 * replay idempotency, rounding, transaction recording, and ACL checks.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';

const TEST_DB = process.env.TEST_DATABASE_URL;

// Skip the entire suite when no disposable PG is available.
// CI provides TEST_DATABASE_URL in the P0 security ACL job.
const skip = !TEST_DB;

describe.skipIf(skip)('#762 loyalty tier multiplier (disposable PG)', () => {
  let pool: pg.Pool;
  let bizId: string;
  let otherBizId: string;
  let paymentId: string;
  let bookingId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });

    // Create two businesses for tenant isolation tests
    const biz = await pool.query(`
      INSERT INTO businesses (id, name, owner_id, country_code, category, subscription_tier, metadata)
      VALUES (gen_random_uuid(), 'Tier Test Biz', gen_random_uuid(), 'NG', 'other', 'business',
        '{"loyalty_earning_enabled": true, "loyalty_points_mode": "per_visit", "loyalty_points_per_visit": 10}'::jsonb)
      RETURNING id
    `);
    bizId = biz.rows[0].id;

    const otherBiz = await pool.query(`
      INSERT INTO businesses (id, name, owner_id, country_code, category, subscription_tier)
      VALUES (gen_random_uuid(), 'Other Biz', gen_random_uuid(), 'NG', 'other', 'free')
      RETURNING id
    `);
    otherBizId = otherBiz.rows[0].id;
  });

  beforeEach(async () => {
    // Create a booking + payment for each test
    const booking = await pool.query(`
      INSERT INTO bookings (id, business_id, guest_phone, guest_name, service_id, date, time, status)
      VALUES (gen_random_uuid(), $1, '+2341234567890', 'Test Customer', gen_random_uuid(), '2099-01-01', '10:00', 'completed')
      RETURNING id
    `, [bizId]);
    bookingId = booking.rows[0].id;

    const payment = await pool.query(`
      INSERT INTO payments (id, amount, status, booking_id, gateway, currency)
      VALUES (gen_random_uuid(), 5000, 'success', $1, 'paystack', 'NGN')
      RETURNING id
    `, [bookingId]);
    paymentId = payment.rows[0].id;
  });

  afterEach(async () => {
    // Clean up test data
    await pool.query(`DELETE FROM payment_loyalty_applications WHERE business_id = $1`, [bizId]);
    await pool.query(`DELETE FROM loyalty_transactions WHERE business_id = $1`, [bizId]);
    await pool.query(`DELETE FROM loyalty_points WHERE business_id = $1`, [bizId]);
    await pool.query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
    await pool.query(`DELETE FROM bookings WHERE id = $1`, [bookingId]);
    await pool.query(`DELETE FROM customer_profiles WHERE business_id = $1`, [bizId]);
    await pool.query(`DELETE FROM membership_tiers WHERE business_id IN ($1, $2)`, [bizId, otherBizId]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [bizId, otherBizId]);
    await pool.end();
  });

  async function callRpc() {
    const result = await pool.query(
      `SELECT apply_payment_loyalty_once($1) AS result`, [paymentId]
    );
    return result.rows[0].result;
  }

  it('applies Gold tier 2x multiplier to base per-visit points', async () => {
    // Create tier
    const tier = await pool.query(`
      INSERT INTO membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ($1, 'Gold', 0, 2, true, 1) RETURNING id
    `, [bizId]);
    // Create customer profile with tier
    await pool.query(`
      INSERT INTO customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ($1, '+2341234567890', 'Test Customer', $2)
    `, [bizId, tier.rows[0].id]);

    const result = await callRpc();
    expect(result.applied).toBe(true);
    expect(result.already_applied).toBe(false);
    expect(result.points_awarded).toBe(20); // 10 base * 2x
  });

  it('uses default 1x when customer has no profile', async () => {
    // No customer_profiles row
    const result = await callRpc();
    expect(result.applied).toBe(true);
    expect(result.points_awarded).toBe(10); // base rate
  });

  it('uses default 1x when customer has no tier assigned', async () => {
    await pool.query(`
      INSERT INTO customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ($1, '+2341234567890', 'Test Customer', NULL)
    `, [bizId]);

    const result = await callRpc();
    expect(result.applied).toBe(true);
    expect(result.points_awarded).toBe(10);
  });

  it('uses default 1x when assigned tier is inactive', async () => {
    const tier = await pool.query(`
      INSERT INTO membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ($1, 'Inactive Gold', 0, 3, false, 1) RETURNING id
    `, [bizId]);
    await pool.query(`
      INSERT INTO customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ($1, '+2341234567890', 'Test', $2)
    `, [bizId, tier.rows[0].id]);

    const result = await callRpc();
    expect(result.applied).toBe(true);
    expect(result.points_awarded).toBe(10);
  });

  it('uses default 1x when tier belongs to a different business (tenant isolation)', async () => {
    // Create tier under OTHER business
    const tier = await pool.query(`
      INSERT INTO membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ($1, 'Other Gold', 0, 5, true, 1) RETURNING id
    `, [otherBizId]);
    // Profile references the cross-business tier (should not match due to mt.business_id check)
    await pool.query(`
      INSERT INTO customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ($1, '+2341234567890', 'Test', $2)
    `, [bizId, tier.rows[0].id]);

    const result = await callRpc();
    expect(result.applied).toBe(true);
    expect(result.points_awarded).toBe(10); // Tenant isolation: other-biz tier not applied
  });

  it('replay idempotency: second call returns already_applied', async () => {
    const first = await callRpc();
    expect(first.applied).toBe(true);
    expect(first.already_applied).toBe(false);

    const second = await callRpc();
    expect(second.applied).toBe(true);
    expect(second.already_applied).toBe(true);
  });

  it('records transaction with correct points_awarded', async () => {
    const tier = await pool.query(`
      INSERT INTO membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ($1, 'Silver', 0, 1.5, true, 1) RETURNING id
    `, [bizId]);
    await pool.query(`
      INSERT INTO customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ($1, '+2341234567890', 'Test', $2)
    `, [bizId, tier.rows[0].id]);

    await callRpc();

    const tx = await pool.query(`
      SELECT points_change, reason FROM loyalty_transactions
      WHERE business_id = $1 AND customer_phone = '+2341234567890'
      ORDER BY created_at DESC LIMIT 1
    `, [bizId]);
    expect(tx.rows[0].points_change).toBe(15); // floor(10 * 1.5)
    expect(tx.rows[0].reason).toBe('visit');
  });

  it('floors the multiplied result (no rounding up)', async () => {
    // per_amount mode: 550 / 100 = 5 base; 5 * 1.5 = 7.5 → floor = 7
    await pool.query(`
      UPDATE businesses SET metadata = '{"loyalty_earning_enabled": true, "loyalty_points_mode": "per_amount", "loyalty_points_per_currency": 100}'::jsonb
      WHERE id = $1
    `, [bizId]);
    await pool.query(`UPDATE payments SET amount = 550 WHERE id = $1`, [paymentId]);
    const tier = await pool.query(`
      INSERT INTO membership_tiers (business_id, name, min_spend, points_multiplier, is_active, sort_order)
      VALUES ($1, 'Silver', 0, 1.5, true, 1) RETURNING id
    `, [bizId]);
    await pool.query(`
      INSERT INTO customer_profiles (business_id, phone, name, membership_tier_id)
      VALUES ($1, '+2341234567890', 'Test', $2)
    `, [bizId, tier.rows[0].id]);

    const result = await callRpc();
    expect(result.points_awarded).toBe(7); // floor(5 * 1.5)
  });

  it('ACL: anon and authenticated cannot execute', async () => {
    const anonCheck = await pool.query(`
      SELECT has_function_privilege('anon', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') AS can
    `);
    expect(anonCheck.rows[0].can).toBe(false);

    const authCheck = await pool.query(`
      SELECT has_function_privilege('authenticated', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') AS can
    `);
    expect(authCheck.rows[0].can).toBe(false);
  });

  it('ACL: service_role can execute', async () => {
    const srCheck = await pool.query(`
      SELECT has_function_privilege('service_role', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') AS can
    `);
    expect(srCheck.rows[0].can).toBe(true);
  });
});
