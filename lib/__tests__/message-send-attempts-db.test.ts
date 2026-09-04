/**
 * Message Send Attempts — Real PostgreSQL Tests (#257)
 *
 * Tests migration 367 schema, constraints, state transitions,
 * disposition enforcement, WAMID immutability, RLS, and grants.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/message-send-attempts-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

const BIZ_ID = 'b0000000-0000-0000-0000-000000000257';

describe.skipIf(!canRun)('Message Send Attempts DB Tests (#257 / Migration 367)', () => {
  beforeAll(() => {
    // Ensure test business exists
    const bizResult = psqlMayFail(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone)
      VALUES ('${BIZ_ID}', 'Test257', 'test257-msa', '00000000-0000-0000-0000-000000000001', '1 Test', 'Test', 'Test', '+1')
      ON CONFLICT (id) DO NOTHING;
    `);
    if (bizResult.includes('ERROR') && !bizResult.includes('duplicate')) {
      throw new Error(`Failed to seed business: ${bizResult}`);
    }
  });

  // ── Schema existence ──

  it('1. message_send_attempts table exists', () => {
    const exists = psql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'message_send_attempts';");
    expect(exists).toBe('1');
  });

  // ── Status transitions ──

  it('2. Valid: pending_authorization → sending → accepted', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET status = 'sending', sent_at = NOW() WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET status = 'accepted', meta_message_id = 'wamid.test1', meta_accepted_at = NOW() WHERE id = '${id}';`);
    const status = psql(`SELECT status FROM message_send_attempts WHERE id = '${id}';`);
    expect(status).toBe('accepted');
  });

  it('3. Valid: sending → ambiguous', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET status = 'sending' WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET status = 'ambiguous', needs_reconciliation = true WHERE id = '${id}';`);
    expect(psql(`SELECT status FROM message_send_attempts WHERE id = '${id}';`)).toBe('ambiguous');
  });

  it('4. Valid: ambiguous → review_required', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, status) VALUES ('${BIZ_ID}', '+1234', 'pending_authorization') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET status = 'sending' WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET status = 'ambiguous' WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET status = 'review_required' WHERE id = '${id}';`);
    expect(psql(`SELECT status FROM message_send_attempts WHERE id = '${id}';`)).toBe('review_required');
  });

  it('5. Invalid: pending_authorization → accepted (skips sending)', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    const err = psqlMayFail(`UPDATE message_send_attempts SET status = 'accepted' WHERE id = '${id}';`);
    expect(err).toContain('Invalid attempt status transition');
  });

  it('6. Invalid: accepted → failed_send (terminal)', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET status = 'sending' WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET status = 'accepted', meta_message_id = 'wamid.test6' WHERE id = '${id}';`);
    const err = psqlMayFail(`UPDATE message_send_attempts SET status = 'failed_send' WHERE id = '${id}';`);
    expect(err).toContain('terminal');
  });

  // ── Financial disposition ──

  it('7. Valid: pending_authorization → reserved → charged', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET financial_disposition = 'reserved', spend_period_start = NOW() WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET financial_disposition = 'charged' WHERE id = '${id}';`);
    expect(psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${id}';`)).toBe('charged');
  });

  it('8. Valid: reserved → released', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET financial_disposition = 'reserved', spend_period_start = NOW() WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET financial_disposition = 'released' WHERE id = '${id}';`);
    expect(psql(`SELECT financial_disposition FROM message_send_attempts WHERE id = '${id}';`)).toBe('released');
  });

  it('9. Invalid: pending_authorization → charged (illegal skip)', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    const err = psqlMayFail(`UPDATE message_send_attempts SET financial_disposition = 'charged' WHERE id = '${id}';`);
    expect(err).toContain('Invalid financial_disposition transition');
  });

  it('10. Invalid: charged → released (write-once terminal)', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET financial_disposition = 'reserved', spend_period_start = NOW() WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET financial_disposition = 'charged' WHERE id = '${id}';`);
    const err = psqlMayFail(`UPDATE message_send_attempts SET financial_disposition = 'released' WHERE id = '${id}';`);
    expect(err).toContain('write-once');
  });

  // ── spend_period_start immutability ──

  it('11. spend_period_start immutable after binding', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET financial_disposition = 'reserved', spend_period_start = '2026-01-01' WHERE id = '${id}';`);
    const err = psqlMayFail(`UPDATE message_send_attempts SET spend_period_start = '2026-02-01' WHERE id = '${id}';`);
    expect(err).toContain('immutable after binding');
  });

  // ── WAMID immutability ──

  it('12. meta_message_id write-once', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    psql(`UPDATE message_send_attempts SET status = 'sending' WHERE id = '${id}';`);
    psql(`UPDATE message_send_attempts SET status = 'accepted', meta_message_id = 'wamid.first' WHERE id = '${id}';`);
    const err = psqlMayFail(`UPDATE message_send_attempts SET meta_message_id = 'wamid.second' WHERE id = '${id}';`);
    expect(err).toContain('write-once');
  });

  // ── attempt_scope CHECK ──

  it('13. Business scope requires business_id', () => {
    const err = psqlMayFail(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES (NULL, '+1234', 'business');`);
    expect(err).toContain('chk_business_scope');
  });

  it('14. Platform scope allows NULL business_id', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope) VALUES (NULL, '+1234', 'platform') RETURNING id;`);
    expect(id).toBeTruthy();
  });

  it('15a. FK RESTRICT: cannot delete business with attempt records', () => {
    // Create a temp business with an attempt
    const tempBiz = psql("INSERT INTO businesses (name, slug, owner_id, address, city, neighborhood, phone) VALUES ('TempBiz', 'temp-biz-fk-' || substr(md5(random()::text),1,8), '00000000-0000-0000-0000-000000000001', '1 Test', 'T', 'T', '+1') RETURNING id;");
    psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${tempBiz}', '+1234');`);
    const err = psqlMayFail(`DELETE FROM businesses WHERE id = '${tempBiz}';`);
    expect(err.toLowerCase()).toMatch(/restrict|referenced|foreign key/);
  });

  it('15b. reserved_at defaults to NULL (no financial encumbrance at INSERT)', () => {
    const id = psql(`INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1234') RETURNING id;`);
    const val = psql(`SELECT reserved_at FROM message_send_attempts WHERE id = '${id}';`);
    expect(val).toBe('');  // NULL renders as empty in psql -tA
  });

  // ── RLS ──

  it('15. Authenticated non-owner cannot see other business attempts', () => {
    // Insert as superuser
    psql(`INSERT INTO message_send_attempts (id, business_id, recipient_phone) VALUES ('f0000000-0000-0000-0000-000000000257', '${BIZ_ID}', '+1234') ON CONFLICT DO NOTHING;`);
    // Query as a different authenticated user
    const NON_OWNER = '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated"}';
    const count = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${NON_OWNER}', false);
      SET ROLE authenticated;
      SELECT count(*)::int FROM message_send_attempts WHERE id = 'f0000000-0000-0000-0000-000000000257';
      RESET ROLE;
    `);
    // Should see 0 rows (RLS denies)
    const lines = count.split('\n').filter(l => l.trim() !== '');
    expect(lines[lines.length - 1]).toBe('0');
  });

  // ── Grants ──

  it('16. Service role can INSERT and UPDATE', () => {
    const result = psqlMayFail(`
      SET ROLE service_role;
      INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+9999') RETURNING id;
      RESET ROLE;
    `);
    expect(result).not.toContain('permission denied');
    // Extract the ID and try an update
    const id = result.split('\n').filter(l => l.trim()).pop() || '';
    if (id && id.length > 10) {
      const updateResult = psqlMayFail(`
        SET ROLE service_role;
        UPDATE message_send_attempts SET status = 'sending' WHERE id = '${id}';
        RESET ROLE;
      `);
      expect(updateResult).not.toContain('permission denied');
    }
  });

  it('17. Authenticated cannot INSERT (service-role only mutations)', () => {
    const CLAIMS = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${CLAIMS}', false);
      SET ROLE authenticated;
      INSERT INTO message_send_attempts (business_id, recipient_phone) VALUES ('${BIZ_ID}', '+1111');
      RESET ROLE;
    `);
    // Either permission denied (no table-level grant) or RLS violation (no matching policy)
    expect(err.toLowerCase()).toMatch(/permission denied|row-level security/);
  });
});
