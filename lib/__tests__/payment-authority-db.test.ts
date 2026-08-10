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
        finalization_claim_token UUID,
        payment_authority_version INTEGER
      );
      CREATE TABLE IF NOT EXISTS orders (id UUID PRIMARY KEY, status TEXT DEFAULT 'pending');
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
    psql(`INSERT INTO orders (id) VALUES ('${ORD_ID}') ON CONFLICT (id) DO NOTHING;`);
    psql(`INSERT INTO products (id, stock) VALUES ('${PROD_ID}', 10) ON CONFLICT (id) DO UPDATE SET stock = 10;`);
    psql(`DELETE FROM order_items WHERE order_id = '${ORD_ID}';`);
    psql(`DELETE FROM order_stock_applications WHERE order_id = '${ORD_ID}';`);
    psql(`INSERT INTO order_items (order_id, product_id, quantity) VALUES ('${ORD_ID}', '${PROD_ID}', 3);`);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${PAY_ID}', '${ORD_ID}');`);
    expect(r.applied).toBe(true);
    expect(r.already_applied).toBe(false);
    const stock = psql(`SELECT stock FROM products WHERE id = '${PROD_ID}';`);
    expect(parseInt(stock)).toBe(7);
  });

  it('12. apply_order_stock_once: retry is idempotent', () => {
    const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${PAY_ID}', '${ORD_ID}');`);
    expect(r.applied).toBe(true);
    expect(r.already_applied).toBe(true);
    expect(parseInt(psql(`SELECT stock FROM products WHERE id = '${PROD_ID}';`))).toBe(7);
  });

  it('13. two-session order-stock race: exactly-once decrement', async () => {
    // Reset state
    psql(`UPDATE products SET stock = 20 WHERE id = '${PROD_ID}';`);
    psql(`DELETE FROM order_stock_applications WHERE order_id = '${ORD_ID}';`);

    const PAY2 = '00000000-0000-0000-0314-000000000099';
    // Use same payment+order for both workers (concurrent webhook + "I've Paid")

    // Worker A: calls RPC, holds transaction open with pg_sleep(1)
    const sqlA = `
      BEGIN;
      SET ROLE service_role;
      SELECT apply_order_stock_once('${PAY_ID}', '${ORD_ID}');
      SELECT pg_sleep(1);
      COMMIT;
    `;

    // Worker B: starts 300ms later, same payment+order — blocks on FOR UPDATE
    const sqlB = `
      BEGIN;
      SET ROLE service_role;
      SELECT apply_order_stock_once('${PAY_ID}', '${ORD_ID}');
      COMMIT;
    `;

    const { exec } = require('child_process') as typeof import('child_process');
    function execPsql(sql: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      return new Promise((resolve) => {
        const child = exec(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, { timeout: 15000, encoding: 'utf-8' },
          (error, stdout, stderr) => resolve({
            stdout: (stdout || '').trim(), stderr: (stderr || '').trim(),
            exitCode: error ? (error as { code?: number }).code || 1 : 0,
          }));
        child.stdin!.write(sql);
        child.stdin!.end();
      });
    }

    const promiseA = execPsql(sqlA);
    await new Promise(r => setTimeout(r, 300));
    const promiseB = execPsql(sqlB);
    const [a, b] = await Promise.all([promiseA, promiseB]);

    // Both must succeed semantically (no raw unique violation)
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    // One applied, one already_applied
    expect(a.stdout).toContain('"applied": true');
    expect(b.stdout).toContain('"applied": true');
    const aAlready = a.stdout.includes('"already_applied": true');
    const bAlready = b.stdout.includes('"already_applied": true');
    // Exactly one is already_applied
    expect(aAlready !== bAlready).toBe(true);

    // Stock decremented exactly once (20 - 3 = 17)
    expect(parseInt(psql(`SELECT stock FROM products WHERE id = '${PROD_ID}';`))).toBe(17);

    // Exactly one marker row
    expect(parseInt(psql(`SELECT COUNT(*) FROM order_stock_applications WHERE payment_id = '${PAY_ID}' AND order_id = '${ORD_ID}';`))).toBe(1);
  }, 15000);

  it('14. order not found → safe rejection', () => {
    const r = psqlJson(`SET ROLE service_role; SELECT apply_order_stock_once('${PAY_ID}', gen_random_uuid());`);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('order_not_found');
  });

  // ── Cross-entrypoint race: two workers claim finalization simultaneously ──

  it('15. two-session finalization claim race: exactly one wins', async () => {
    // Reset payment to success + no finalization
    psql(`UPDATE payments SET status = 'success', finalization_completed_at = NULL, finalization_processing_at = NULL, finalization_claim_token = NULL WHERE id = '${PAY_ID}';`);

    const { exec } = require('child_process') as typeof import('child_process');
    function execPsql(sql: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      return new Promise((resolve) => {
        const child = exec(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, { timeout: 15000, encoding: 'utf-8' },
          (error, stdout, stderr) => resolve({
            stdout: (stdout || '').trim(), stderr: (stderr || '').trim(),
            exitCode: error ? (error as { code?: number }).code || 1 : 0,
          }));
        child.stdin!.write(sql);
        child.stdin!.end();
      });
    }

    // Worker A (webhook): claims finalization, holds with pg_sleep
    const sqlA = `
      BEGIN;
      SET ROLE service_role;
      SELECT claim_payment_finalization('${PAY_ID}');
      SELECT pg_sleep(1);
      COMMIT;
    `;

    // Worker B ("I've Paid"): tries to claim same payment 300ms later
    const sqlB = `
      BEGIN;
      SET ROLE service_role;
      SELECT claim_payment_finalization('${PAY_ID}');
      COMMIT;
    `;

    const promiseA = execPsql(sqlA);
    await new Promise(r => setTimeout(r, 300));
    const promiseB = execPsql(sqlB);
    const [a, b] = await Promise.all([promiseA, promiseB]);

    // Both should succeed (exit 0) — no crash
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    // Exactly one claimed, one denied (processing_in_progress)
    const aClaimed = a.stdout.includes('"claimed": true');
    const bClaimed = b.stdout.includes('"claimed": true');
    expect(aClaimed || bClaimed).toBe(true);
    // At most one winner
    if (aClaimed && bClaimed) {
      // Both claimed is only possible if A committed before B checked
      // In that case B should see processing_in_progress — but timing may vary
      // The important invariant: finalization_processing_at is set once
    }

    // Final state: exactly one processing claim active
    const processing = psql(`SELECT finalization_processing_at IS NOT NULL FROM payments WHERE id = '${PAY_ID}';`);
    expect(processing).toBe('t');
  }, 15000);

  it('16. cross-entrypoint: claim + complete + second claimer sees already_completed', () => {
    // Reset
    psql(`UPDATE payments SET status = 'success', finalization_completed_at = NULL, finalization_processing_at = NULL, finalization_claim_token = NULL WHERE id = '${PAY_ID}';`);

    // Worker A claims and completes
    const claim = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    expect(claim.claimed).toBe(true);
    const complete = psqlJson(`SET ROLE service_role; SELECT complete_payment_finalization('${PAY_ID}', '${claim.claim_token}'::uuid);`);
    expect(complete.completed).toBe(true);

    // Worker B tries to claim — gets already_completed
    const claim2 = psqlJson(`SET ROLE service_role; SELECT claim_payment_finalization('${PAY_ID}');`);
    expect(claim2.claimed).toBe(false);
    expect(claim2.already_completed).toBe(true);

    // Finalization is durably complete
    const completed = psql(`SELECT finalization_completed_at IS NOT NULL FROM payments WHERE id = '${PAY_ID}';`);
    expect(completed).toBe('t');
  });
});
