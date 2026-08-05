/**
 * P0-CONFIRM-1 — Real PostgreSQL tests for confirmation claim ownership
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const MIGRATION = path.resolve('supabase/migrations/307_confirmation_claim_lifecycle.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 15000 });
  return raw.split('\n').filter(l => { const t = l.trim(); return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t); }).join('\n').trim();
}
function psqlJson(sql: string): any { const r = psql(sql); return r ? JSON.parse(r) : null; }

function runTwoSessions(sqlA: string, sqlB: string): Promise<{ a: { stdout: string }; b: { stdout: string } }> {
  const { exec } = require('child_process') as typeof import('child_process');
  function execPsql(sql: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = exec(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, { timeout: 15000, encoding: 'utf-8' },
        (error, stdout, stderr) => {
          if (error && !stdout) reject(new Error(`psql failed: ${stderr || error.message}`));
          else resolve({ stdout: (stdout || '').trim() });
        });
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

const PAY = '55aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe.skipIf(!dbUrl)('P0-CONFIRM-1: PostgreSQL confirmation ownership', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), amount NUMERIC(12,2) DEFAULT 0,
        status TEXT DEFAULT 'pending', booking_id UUID, invoice_id UUID, campaign_id UUID,
        reservation_id UUID, order_id UUID,
        confirmation_sent_at TIMESTAMPTZ, confirmation_processing_at TIMESTAMPTZ,
        confirmation_claim_token UUID
      );`);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => { if (dbUrl) psql(`DROP TABLE IF EXISTS payments CASCADE;`); });

  function reset(status = 'success') {
    psql(`DELETE FROM payments; INSERT INTO payments (id, amount, status) VALUES ('${PAY}', 50, '${status}');`);
  }

  it('1. successful payment can be claimed', () => {
    reset();
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    expect(r.claimed).toBe(true);
  });

  it('2. claim returns UUID ownership token', () => {
    reset();
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    expect(r.claim_token).toMatch(/^[0-9a-f]{8}-/);
  });

  it('3. current owner can renew', () => {
    reset();
    const c = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    const r = psqlJson(`SELECT renew_payment_confirmation_claim('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    expect(r.renewed).toBe(true);
  });

  it('4. wrong token cannot renew', () => {
    reset();
    psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    const r = psqlJson(`SELECT renew_payment_confirmation_claim('${PAY}'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);`);
    expect(r.renewed).toBe(false);
    expect(r.reason).toBe('token_mismatch');
  });

  it('5. finalized payment cannot renew', () => {
    reset();
    const c = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    psqlJson(`SELECT finalize_payment_confirmation('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    const r = psqlJson(`SELECT renew_payment_confirmation_claim('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    expect(r.renewed).toBe(false);
    expect(r.reason).toBe('already_finalized');
  });

  it('6-13. stale-worker ownership race', () => {
    reset();
    // 6. Worker A claims
    const cA = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    expect(cA.claimed).toBe(true);
    const tokA = cA.claim_token;

    // 7. Make stale
    psql(`UPDATE payments SET confirmation_processing_at = NOW() - INTERVAL '10 minutes' WHERE id = '${PAY}';`);

    // 8. Worker B reclaims
    const cB = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    expect(cB.claimed).toBe(true);
    const tokB = cB.claim_token;
    expect(tokB).not.toBe(tokA);

    // 9. Token A cannot renew
    const renA = psqlJson(`SELECT renew_payment_confirmation_claim('${PAY}'::uuid, '${tokA}'::uuid);`);
    expect(renA.renewed).toBe(false);

    // 10. Token A cannot finalize
    const finA = psqlJson(`SELECT finalize_payment_confirmation('${PAY}'::uuid, '${tokA}'::uuid);`);
    expect(finA.finalized).toBe(false);

    // 11. Token A cannot release
    const relA = psqlJson(`SELECT release_payment_confirmation('${PAY}'::uuid, '${tokA}'::uuid);`);
    expect(relA.released).toBe(false);

    // 12. Token B can renew
    const renB = psqlJson(`SELECT renew_payment_confirmation_claim('${PAY}'::uuid, '${tokB}'::uuid);`);
    expect(renB.renewed).toBe(true);

    // 13. Token B can finalize
    const finB = psqlJson(`SELECT finalize_payment_confirmation('${PAY}'::uuid, '${tokB}'::uuid);`);
    expect(finB.finalized).toBe(true);
  });

  it('14. two concurrent sessions → one winner', async () => {
    reset();
    const sqlA = `BEGIN; SELECT claim_payment_confirmation('${PAY}'::uuid); SELECT pg_sleep(1); COMMIT;`;
    const sqlB = `SELECT claim_payment_confirmation('${PAY}'::uuid);`;
    const { a, b } = await runTwoSessions(sqlA, sqlB);
    const parse = (s: string) => JSON.parse(s.split('\n').filter(l => l.trim().startsWith('{'))[0]);
    const rA = parse(a.stdout); const rB = parse(b.stdout);
    expect([rA, rB].filter(r => r.claimed).length).toBe(1);
  });

  it('15. finalization clears processing_at and token', () => {
    reset();
    const c = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    psqlJson(`SELECT finalize_payment_confirmation('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    expect(psql(`SELECT confirmation_processing_at FROM payments WHERE id = '${PAY}';`)).toBe('');
    expect(psql(`SELECT confirmation_claim_token FROM payments WHERE id = '${PAY}';`)).toBe('');
    expect(psql(`SELECT confirmation_sent_at FROM payments WHERE id = '${PAY}';`)).not.toBe('');
  });

  it('16. release clears processing_at and token', () => {
    reset();
    const c = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    psqlJson(`SELECT release_payment_confirmation('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    expect(psql(`SELECT confirmation_processing_at FROM payments WHERE id = '${PAY}';`)).toBe('');
    expect(psql(`SELECT confirmation_claim_token FROM payments WHERE id = '${PAY}';`)).toBe('');
  });

  it('17. duplicate finalization is idempotent', () => {
    reset();
    const c = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    psqlJson(`SELECT finalize_payment_confirmation('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    const r = psqlJson(`SELECT finalize_payment_confirmation('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    expect(r.finalized).toBe(true);
    expect(r.already_finalized).toBe(true);
  });

  it('18. pending payment cannot be claimed', () => {
    reset('pending');
    const r = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_successful');
  });

  it('19. RPC responses do not disclose stored token except initial claim', () => {
    reset();
    const c = psqlJson(`SELECT claim_payment_confirmation('${PAY}'::uuid);`);
    // claim returns token — expected
    expect(c.claim_token).toBeDefined();
    // renew does NOT return token
    const ren = psqlJson(`SELECT renew_payment_confirmation_claim('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    expect(ren.claim_token).toBeUndefined();
    // finalize does NOT return token
    const fin = psqlJson(`SELECT finalize_payment_confirmation('${PAY}'::uuid, '${c.claim_token}'::uuid);`);
    expect(fin.claim_token).toBeUndefined();
  });

  it('20. RPCs restricted to service_role', () => {
    const src = require('fs').readFileSync(MIGRATION, 'utf-8');
    expect(src).toContain("REVOKE ALL ON FUNCTION claim_payment_confirmation(UUID) FROM PUBLIC");
    expect(src).toContain("REVOKE ALL ON FUNCTION renew_payment_confirmation_claim(UUID, UUID) FROM PUBLIC");
    expect(src).toContain("REVOKE ALL ON FUNCTION finalize_payment_confirmation(UUID, UUID) FROM PUBLIC");
    expect(src).toContain("REVOKE ALL ON FUNCTION release_payment_confirmation(UUID, UUID) FROM PUBLIC");
    expect(src).toContain("GRANT EXECUTE ON FUNCTION claim_payment_confirmation(UUID) TO service_role");
    expect(src).toContain("GRANT EXECUTE ON FUNCTION renew_payment_confirmation_claim(UUID, UUID) TO service_role");
  });
});
