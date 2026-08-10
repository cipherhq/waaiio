/**
 * Migration 314 — payment finalization lifecycle: real PostgreSQL tests.
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 10000,
  }).trim();
}
function psqlJson(sql: string): Record<string, unknown> {
  const r = psql(sql);
  return r ? JSON.parse(r) : {};
}

describe.skipIf(!canRun)('Migration 314: payment finalization lifecycle', () => {
  const PAY_ID = '00000000-0000-0000-0314-000000000001';

  beforeAll(() => {
    // Minimal schema for payment finalization tests
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;

      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount INT DEFAULT 0, currency TEXT DEFAULT 'NGN',
        gateway TEXT DEFAULT 'paystack', gateway_reference TEXT,
        status TEXT DEFAULT 'pending', gateway_status TEXT DEFAULT 'pending',
        gateway_fee INT DEFAULT 0, paid_at TIMESTAMPTZ,
        booking_id UUID, invoice_id UUID, campaign_id UUID,
        reservation_id UUID, order_id UUID,
        metadata JSONB DEFAULT '{}'::jsonb,
        confirmation_sent_at TIMESTAMPTZ,
        finalization_completed_at TIMESTAMPTZ,
        finalization_processing_at TIMESTAMPTZ,
        finalization_claim_token UUID
      );
      CREATE TABLE IF NOT EXISTS products (id UUID PRIMARY KEY, stock INT DEFAULT 0);
      CREATE TABLE IF NOT EXISTS product_variants (id UUID PRIMARY KEY, stock INT DEFAULT 0);
      CREATE TABLE IF NOT EXISTS order_items (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID, product_id UUID, variant_id UUID, quantity INT DEFAULT 1);
    `);
    // Apply migration 314
    const fs = require('fs');
    const migSql = fs.readFileSync('supabase/migrations/314_payment_finalization_lifecycle.sql', 'utf-8');
    psql(migSql.replace(/--.*$/gm, ''));

    // Create test payment
    psql(`INSERT INTO payments (id, amount, status, gateway_reference)
          VALUES ('${PAY_ID}', 5000, 'success', 'REF-314-TEST')
          ON CONFLICT (id) DO UPDATE SET status = 'success', finalization_completed_at = NULL, finalization_processing_at = NULL, finalization_claim_token = NULL;`);
  });

  afterAll(() => {
    if (!canRun) return;
    psql(`DELETE FROM payments WHERE id = '${PAY_ID}';`);
    psql(`DROP TABLE IF EXISTS payments CASCADE;`);
  });

  it('1. claim succeeds for successful payment', () => {
    psql(`UPDATE payments SET finalization_completed_at = NULL, finalization_processing_at = NULL, finalization_claim_token = NULL WHERE id = '${PAY_ID}';`);
    const r = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    expect(r.claimed).toBe(true);
    expect(r.claim_token).toBeTruthy();
    expect(r.payment_id).toBe(PAY_ID);
  });

  it('2. claim rejected for non-success payment', () => {
    psql(`UPDATE payments SET status = 'pending', finalization_completed_at = NULL, finalization_processing_at = NULL, finalization_claim_token = NULL WHERE id = '${PAY_ID}';`);
    const r = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_successful');
    psql(`UPDATE payments SET status = 'success' WHERE id = '${PAY_ID}';`);
  });

  it('3. claim rejected when already completed', () => {
    psql(`UPDATE payments SET finalization_completed_at = NOW(), finalization_processing_at = NULL, finalization_claim_token = NULL WHERE id = '${PAY_ID}';`);
    const r = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    expect(r.claimed).toBe(false);
    expect(r.already_completed).toBe(true);
    psql(`UPDATE payments SET finalization_completed_at = NULL WHERE id = '${PAY_ID}';`);
  });

  it('4. claim rejected when another worker is processing (fresh lease)', () => {
    psql(`UPDATE payments SET finalization_completed_at = NULL, finalization_processing_at = NOW(), finalization_claim_token = gen_random_uuid() WHERE id = '${PAY_ID}';`);
    const r = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('processing_in_progress');
  });

  it('5. stale claim can be reclaimed (>5 min)', () => {
    psql(`UPDATE payments SET finalization_processing_at = NOW() - INTERVAL '6 minutes', finalization_claim_token = gen_random_uuid() WHERE id = '${PAY_ID}';`);
    const r = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    expect(r.claimed).toBe(true);
  });

  it('6. complete with correct token succeeds', () => {
    psql(`UPDATE payments SET finalization_completed_at = NULL, finalization_processing_at = NULL, finalization_claim_token = NULL WHERE id = '${PAY_ID}';`);
    const claim = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    const token = claim.claim_token;
    const r = psqlJson(`SET ROLE service_role; SELECT complete_payment_finalization('${PAY_ID}', '${token}'::uuid);`);
    expect(r.completed).toBe(true);
    expect(r.already_completed).toBe(false);
    // Verify durable marker
    const completed = psql(`SELECT finalization_completed_at IS NOT NULL FROM payments WHERE id = '${PAY_ID}';`);
    expect(completed).toBe('t');
  });

  it('7. complete with wrong token → token_mismatch', () => {
    psql(`UPDATE payments SET finalization_completed_at = NULL, finalization_processing_at = NOW(), finalization_claim_token = gen_random_uuid() WHERE id = '${PAY_ID}';`);
    const r = psqlJson(`SET ROLE service_role; SELECT complete_payment_finalization('${PAY_ID}', gen_random_uuid());`);
    expect(r.completed).toBe(false);
    expect(r.reason).toBe('token_mismatch');
  });

  it('8. complete is idempotent (already completed)', () => {
    psql(`UPDATE payments SET finalization_completed_at = NOW(), finalization_processing_at = NULL, finalization_claim_token = NULL WHERE id = '${PAY_ID}';`);
    const r = psqlJson(`SET ROLE service_role; SELECT complete_payment_finalization('${PAY_ID}', gen_random_uuid());`);
    expect(r.completed).toBe(true);
    expect(r.already_completed).toBe(true);
  });

  it('9. release clears claim for retry', () => {
    psql(`UPDATE payments SET finalization_completed_at = NULL, finalization_processing_at = NULL, finalization_claim_token = NULL WHERE id = '${PAY_ID}';`);
    const claim = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    const token = claim.claim_token;
    const r = psqlJson(`SET ROLE service_role; SELECT release_payment_finalization('${PAY_ID}', '${token}'::uuid);`);
    expect(r.released).toBe(true);
    // Can reclaim immediately
    const r2 = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    expect(r2.claimed).toBe(true);
  });

  it('10. release with wrong token → token_mismatch', () => {
    psql(`UPDATE payments SET finalization_completed_at = NULL, finalization_processing_at = NOW(), finalization_claim_token = gen_random_uuid() WHERE id = '${PAY_ID}';`);
    const r = psqlJson(`SET ROLE service_role; SELECT release_payment_finalization('${PAY_ID}', gen_random_uuid());`);
    expect(r.released).toBe(false);
    expect(r.reason).toBe('token_mismatch');
  });

  // ── Order Stock Application ──

  const ORD_ID = '00000000-0000-0000-0314-000000000002';
  const PROD_ID = '00000000-0000-0000-0314-000000000003';

  it('11. apply_order_stock_once: first application decrements stock', () => {
    psql(`INSERT INTO products (id, stock) VALUES ('${PROD_ID}', 10) ON CONFLICT (id) DO UPDATE SET stock = 10;`);
    psql(`DELETE FROM order_items WHERE order_id = '${ORD_ID}';`);
    psql(`DELETE FROM order_stock_applications WHERE order_id = '${ORD_ID}';`);
    psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ORD_ID}', '${PROD_ID}', 3);`);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${PAY_ID}', '${ORD_ID}');`);
    expect(r.applied).toBe(true);
    expect(r.already_applied).toBe(false);
    const stock = psql(`SELECT stock FROM products WHERE id = '${PROD_ID}';`);
    expect(parseInt(stock)).toBe(7); // 10 - 3
  });

  it('12. apply_order_stock_once: retry is idempotent (no double decrement)', () => {
    const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${PAY_ID}', '${ORD_ID}');`);
    expect(r.applied).toBe(true);
    expect(r.already_applied).toBe(true);
    const stock = psql(`SELECT stock FROM products WHERE id = '${PROD_ID}';`);
    expect(parseInt(stock)).toBe(7); // Still 7, not 4
  });

  it('13. historical backfill logic: success payments get finalization_completed_at', () => {
    // Simulate what the migration backfill does for a payment that existed before migration
    psql(`UPDATE payments SET finalization_completed_at = NULL WHERE id = '${PAY_ID}';`);
    // Run the same backfill SQL
    psql(`UPDATE payments SET finalization_completed_at = COALESCE(paid_at, NOW()) WHERE status = 'success' AND finalization_completed_at IS NULL;`);
    const completed = psql(`SELECT finalization_completed_at IS NOT NULL FROM payments WHERE id = '${PAY_ID}';`);
    expect(completed).toBe('t');
  });
});
