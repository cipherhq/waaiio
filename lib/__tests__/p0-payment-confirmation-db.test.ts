/**
 * P0-CONFIRM-1 — Real PostgreSQL contention tests for payment confirmation
 *
 * Requires TEST_DATABASE_URL.
 * Proves claim/finalize/release RPCs are concurrent-safe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const MIGRATION_307 = path.resolve('supabase/migrations/307_confirmation_claim_lifecycle.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  });
  return raw.split('\n').filter(l => {
    const t = l.trim();
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t);
  }).join('\n').trim();
}

function psqlJson(sql: string): any {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : null;
}

function runTwoSessions(sqlA: string, sqlB: string): Promise<{ a: { stdout: string }; b: { stdout: string } }> {
  const { exec } = require('child_process') as typeof import('child_process');
  function execPsql(sql: string): Promise<{ stdout: string }> {
    return new Promise((resolve) => {
      const child = exec(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, { timeout: 15000, encoding: 'utf-8' },
        (error, stdout) => resolve({ stdout: (stdout || '').trim() }));
      child.stdin!.write(sql);
      child.stdin!.end();
    });
  }
  return new Promise(async (resolve) => {
    const promiseA = execPsql(sqlA);
    await new Promise(r => setTimeout(r, 500));
    const promiseB = execPsql(sqlB);
    const [a, b] = await Promise.all([promiseA, promiseB]);
    resolve({ a, b });
  });
}

const PAY_ID = '33aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAY_ID2 = '33bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe.skipIf(!dbUrl)('Payment confirmation: Real PostgreSQL contention tests', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);
    psql(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount NUMERIC(12,2) DEFAULT 0,
        status TEXT DEFAULT 'pending',
        booking_id UUID, invoice_id UUID, campaign_id UUID,
        reservation_id UUID, order_id UUID,
        confirmation_sent_at TIMESTAMPTZ,
        confirmation_processing_at TIMESTAMPTZ
      );
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_307}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS payments CASCADE;`);
  });

  it('1. first claim on successful payment succeeds', () => {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_ID}', 50, 'success');`);

    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(true);
    expect(r.payment_id).toBe(PAY_ID);
    expect(r.amount).toBe(50);
  });

  it('2. second claim while processing is rejected', () => {
    // Previous test left processing_at set
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('processing_in_progress');
  });

  it('3. two concurrent claims → exactly one winner', async () => {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_ID}', 75, 'success');`);

    const sqlA = `
      BEGIN;
      SELECT claim_payment_confirmation('${PAY_ID}'::uuid);
      SELECT pg_sleep(1);
      COMMIT;
    `;
    const sqlB = `
      SELECT claim_payment_confirmation('${PAY_ID}'::uuid);
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB);
    const resultLines = (s: string) => s.split('\n').filter(l => l.trim().startsWith('{'));
    const rA = JSON.parse(resultLines(a.stdout)[0]);
    const rB = JSON.parse(resultLines(b.stdout)[0]);

    const claimed = [rA, rB].filter(r => r.claimed === true);
    const denied = [rA, rB].filter(r => r.claimed === false);
    expect(claimed).toHaveLength(1);
    expect(denied).toHaveLength(1);
  });

  it('4. finalize after claim sets confirmation_sent_at', () => {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_ID}', 50, 'success');`);

    psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    const r = psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.finalized).toBe(true);
    expect(r.already_finalized).toBe(false);

    const sentAt = psql(`SELECT confirmation_sent_at FROM payments WHERE id = '${PAY_ID}';`);
    expect(sentAt).not.toBe('');
  });

  it('5. duplicate finalize is idempotent', () => {
    // Previous test already finalized
    const r = psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.finalized).toBe(true);
    expect(r.already_finalized).toBe(true);
  });

  it('6. claim after finalization returns already_completed', () => {
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.already_completed).toBe(true);
  });

  it('7. release clears processing, allows retry', () => {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_ID}', 50, 'success');`);

    psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    // Simulate failure → release
    psqlJson(`SELECT release_payment_confirmation('${PAY_ID}'::uuid);`);

    const processingAt = psql(`SELECT confirmation_processing_at FROM payments WHERE id = '${PAY_ID}';`);
    expect(processingAt).toBe('');

    // Now can reclaim
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(true);
  });

  it('8. pending payment cannot be claimed', () => {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_ID}', 50, 'pending');`);

    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_successful');
  });

  it('9. stale claim (>5 min) allows reclaim', () => {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status, confirmation_processing_at)
          VALUES ('${PAY_ID}', 50, 'success', NOW() - INTERVAL '10 minutes');`);

    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(true);
  });

  it('10. finalize without prior claim is rejected', () => {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_ID}', 50, 'success');`);

    const r = psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.finalized).toBe(false);
    expect(r.reason).toBe('not_processing');
  });

  it('11. release does not affect already-finalized payment', () => {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_ID}', 50, 'success');`);

    psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid);`);

    // Release should not clear confirmation_sent_at
    psqlJson(`SELECT release_payment_confirmation('${PAY_ID}'::uuid);`);
    const sentAt = psql(`SELECT confirmation_sent_at FROM payments WHERE id = '${PAY_ID}';`);
    expect(sentAt).not.toBe('');
  });
});
