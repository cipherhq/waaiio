/**
 * P0-CONFIRM-1 — Real PostgreSQL tests for claim ownership + contention
 *
 * Requires TEST_DATABASE_URL.
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

const PAY_ID = '44aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe.skipIf(!dbUrl)('Payment confirmation: Claim ownership + contention', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount NUMERIC(12,2) DEFAULT 0, status TEXT DEFAULT 'pending',
        booking_id UUID, invoice_id UUID, campaign_id UUID,
        reservation_id UUID, order_id UUID,
        confirmation_sent_at TIMESTAMPTZ, confirmation_processing_at TIMESTAMPTZ,
        confirmation_claim_token UUID
      );
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_307}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS payments CASCADE;`);
  });

  function resetPayment(status = 'success') {
    psql(`DELETE FROM payments;`);
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_ID}', 50, '${status}');`);
  }

  // ── 1. Claim returns an unguessable UUID token ──
  it('1. claim returns UUID ownership token', () => {
    resetPayment();
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(true);
    expect(r.claim_token).toBeDefined();
    expect(r.claim_token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // UUID format
  });

  // ── 2. Finalize with correct token succeeds ──
  it('2. finalize with correct token succeeds', () => {
    resetPayment();
    const claim = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    const fin = psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid, '${claim.claim_token}'::uuid);`);
    expect(fin.finalized).toBe(true);
    expect(fin.already_finalized).toBe(false);
    const sentAt = psql(`SELECT confirmation_sent_at FROM payments WHERE id = '${PAY_ID}';`);
    expect(sentAt).not.toBe('');
  });

  // ── 3. Release with correct token succeeds ──
  it('3. release with correct token succeeds', () => {
    resetPayment();
    const claim = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    const rel = psqlJson(`SELECT release_payment_confirmation('${PAY_ID}'::uuid, '${claim.claim_token}'::uuid);`);
    expect(rel.released).toBe(true);
    const proc = psql(`SELECT confirmation_processing_at FROM payments WHERE id = '${PAY_ID}';`);
    expect(proc).toBe('');
    const tok = psql(`SELECT confirmation_claim_token FROM payments WHERE id = '${PAY_ID}';`);
    expect(tok).toBe('');
  });

  // ── 4. Finalize with wrong token fails ──
  it('4. finalize with wrong token fails, confirmation_sent_at stays NULL', () => {
    resetPayment();
    psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    const fin = psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);`);
    expect(fin.finalized).toBe(false);
    expect(fin.reason).toBe('token_mismatch');
    const sentAt = psql(`SELECT confirmation_sent_at FROM payments WHERE id = '${PAY_ID}';`);
    expect(sentAt).toBe('');
  });

  // ── 5. Release with wrong token fails ──
  it('5. release with wrong token fails, current claim preserved', () => {
    resetPayment();
    const claim = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    const rel = psqlJson(`SELECT release_payment_confirmation('${PAY_ID}'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);`);
    expect(rel.released).toBe(false);
    expect(rel.reason).toBe('token_mismatch');
    // Original claim still intact
    const tok = psql(`SELECT confirmation_claim_token FROM payments WHERE id = '${PAY_ID}';`);
    expect(tok).toBe(claim.claim_token);
  });

  // ── 6. Stale-worker ownership race ──
  it('6. stale worker A cannot finalize/release worker B claim', () => {
    resetPayment();
    // a. Worker A claims → token A
    const claimA = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(claimA.claimed).toBe(true);
    const tokenA = claimA.claim_token;

    // b. Make A's claim stale (>5 min)
    psql(`UPDATE payments SET confirmation_processing_at = NOW() - INTERVAL '10 minutes' WHERE id = '${PAY_ID}';`);

    // c. Worker B reclaims → token B
    const claimB = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(claimB.claimed).toBe(true);
    const tokenB = claimB.claim_token;
    expect(tokenB).not.toBe(tokenA);

    // d. Token A cannot finalize
    const finA = psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid, '${tokenA}'::uuid);`);
    expect(finA.finalized).toBe(false);
    expect(finA.reason).toBe('token_mismatch');

    // e. Token A cannot release
    const relA = psqlJson(`SELECT release_payment_confirmation('${PAY_ID}'::uuid, '${tokenA}'::uuid);`);
    expect(relA.released).toBe(false);
    expect(relA.reason).toBe('token_mismatch');

    // f. Token B still stored and active
    const storedTok = psql(`SELECT confirmation_claim_token FROM payments WHERE id = '${PAY_ID}';`);
    expect(storedTok).toBe(tokenB);

    // g. Token B can finalize
    const finB = psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid, '${tokenB}'::uuid);`);
    expect(finB.finalized).toBe(true);
  });

  // ── 7. Two simultaneous claimers → one winner ──
  it('7. two concurrent claims → exactly one winner', async () => {
    resetPayment();
    const sqlA = `BEGIN; SELECT claim_payment_confirmation('${PAY_ID}'::uuid); SELECT pg_sleep(1); COMMIT;`;
    const sqlB = `SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`;
    const { a, b } = await runTwoSessions(sqlA, sqlB);
    const parse = (s: string) => JSON.parse(s.split('\n').filter(l => l.trim().startsWith('{'))[0]);
    const rA = parse(a.stdout);
    const rB = parse(b.stdout);
    const claimed = [rA, rB].filter(r => r.claimed === true);
    expect(claimed).toHaveLength(1);
  });

  // ── 13. Finalization clears processing_at and token ──
  it('13. finalization clears processing_at and claim_token', () => {
    resetPayment();
    const claim = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid, '${claim.claim_token}'::uuid);`);
    const proc = psql(`SELECT confirmation_processing_at FROM payments WHERE id = '${PAY_ID}';`);
    const tok = psql(`SELECT confirmation_claim_token FROM payments WHERE id = '${PAY_ID}';`);
    expect(proc).toBe('');
    expect(tok).toBe('');
    const sent = psql(`SELECT confirmation_sent_at FROM payments WHERE id = '${PAY_ID}';`);
    expect(sent).not.toBe('');
  });

  // ── 14. Finalized payment rejects new claims ──
  it('14. finalized payment rejects new claims', () => {
    // Previous test finalized the payment
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.already_completed).toBe(true);
  });

  // ── 15. Pending payment ineligible ──
  it('15. pending payment rejected', () => {
    resetPayment('pending');
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_successful');
  });

  // ── 16. Duplicate finalize is idempotent ──
  it('16. duplicate finalize returns already_finalized', () => {
    resetPayment();
    const claim = psqlJson(`SELECT claim_payment_confirmation('${PAY_ID}'::uuid);`);
    psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid, '${claim.claim_token}'::uuid);`);
    // Second finalize — token was cleared, but confirmation_sent_at is set
    const fin2 = psqlJson(`SELECT finalize_payment_confirmation('${PAY_ID}'::uuid, '${claim.claim_token}'::uuid);`);
    expect(fin2.finalized).toBe(true);
    expect(fin2.already_finalized).toBe(true);
  });
});
