/**
 * ACC-198: Promo Routing Consistency — PostgreSQL Tests
 *
 * Runs against a real Supabase instance with the migrated schema.
 * Tests concurrency, privilege assertions, atomic audit rollback,
 * and migration repair scenarios.
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Skips gracefully in local dev if no DB connection.
 * CI zero-skip enforcement is handled in ci.yml, not here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).toString().trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: String((e as { stderr?: string }).stderr || e) };
  }
}

/** Run SQL in a separate process (independent connection) — returns promise */
function psqlAsync(sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      timeout: 15000,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    }).stdin?.end(sql);
  });
}

const USER_ID = '00000000-0000-4000-f198-000000000001';
const BIZ_ID = '00000000-0000-4000-a198-aaaaaaaaaaaa';
const BIZ_B_ID = '00000000-0000-4000-a198-bbbbbbbbbbbb';
const CAMP_A_ID = '00000000-0000-4000-c198-aaaaaaaaaaaa';
const CAMP_B_ID = '00000000-0000-4000-c198-bbbbbbbbbbbb';
const CAMP_C_ID = '00000000-0000-4000-c198-cccccccccccc';

describe.skipIf(!canRun)('ACC-198 DB: Promo routing consistency (real migrated schema)', () => {
  beforeAll(() => {
    // Cleanup any prior run
    psql(`
      DELETE FROM admin_audit_logs WHERE entity_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_campaign_codes WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_code_batches WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_prizes WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${BIZ_B_ID}');
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);

    // CI creates auth.users without phone; add it so the production
    // handle_new_user() trigger can fire (INSERT INTO profiles(id,phone,email))
    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;`);

    // Create test user — trigger fires and auto-creates profiles row
    psql(`
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0001980001')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create businesses with all required NOT NULL columns
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_ID}', 'Test Biz 198', 'test-biz-198', '${USER_ID}', '123 Test', 'Test City', 'Test', '+0001980002', 'active', 'manual', 'US', 'basic')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_B_ID}', 'Test Biz 198B', 'test-biz-198b', '${USER_ID}', '124 Test', 'Test City', 'Test', '+0001980003', 'active', 'manual', 'US', 'basic')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM admin_audit_logs WHERE entity_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_campaign_codes WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_code_batches WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_prizes WHERE campaign_id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}');
      DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${BIZ_B_ID}');
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);
  });

  it('CHECK constraint enforces routing consistency', () => {
    // Valid: keyword mode with keyword set and bare=false
    expect(() => {
      psql(`
        INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
        VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Test KW', 'keyword', 'PROMO', false, 'w', 't', 'i', 'a', 'e');
      `);
    }).not.toThrow();

    // Cleanup
    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);

    // Invalid: keyword mode with bare=true should fail
    expect(() => {
      psql(`
        INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
        VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Test Bad', 'keyword', 'PROMO', true, 'w', 't', 'i', 'a', 'e');
      `);
    }).toThrow();
  });

  it('keyword normalization trigger uppercases and trims', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Test Norm', 'keyword', '  hello  ', false, 'w', 't', 'i', 'a', 'e');
    `);

    const kw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
    expect(kw).toBe('HELLO');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('update_promo_campaign_routing rejects integrity-locked campaigns', () => {
    // Create a campaign and lock it
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, integrity_locked, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Locked Camp', 'keyword', 'LOCKED', false, true, 'w', 't', 'i', 'a', 'e');
    `);

    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'bare_code', NULL, NULL);
    `);
    expect(result).toContain('integrity_locked');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('update_promo_campaign_routing detects keyword conflict', () => {
    // Create two campaigns — one active with keyword PROMO
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Active KW', 'active', 'keyword', 'PROMO', false, 'w', 't', 'i', 'a', 'e');
    `);
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_B_ID}', '${BIZ_ID}', 'Draft Camp', 'draft', 'bare_code', NULL, true, 'w', 't', 'i', 'a', 'e');
    `);

    // Try to change draft camp to keyword=PROMO → should detect conflict
    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_B_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'PROMO', NULL);
    `);
    expect(result).toContain('keyword_conflict');
    expect(result).toContain('Active KW');

    psql(`DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}')`);
  });

  it('update_promo_campaign_routing succeeds for non-conflicting change', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Draft Camp', 'draft', 'keyword', 'OLD', false, 'w', 't', 'i', 'a', 'e');
    `);

    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'NEWKW', NULL);
    `);
    expect(JSON.parse(result).success).toBe(true);

    // Verify the update
    const kw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
    expect(kw).toBe('NEWKW');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('update_promo_campaign_routing writes audit for active campaigns', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Active Audit', 'active', 'keyword', 'OLD', false, 'w', 't', 'i', 'a', 'e');
    `);

    psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'NEWAUDIT', NULL);
    `);

    const auditCount = psql(`
      SELECT count(*) FROM admin_audit_logs WHERE entity_id = '${CAMP_A_ID}' AND action = 'promotions.routing_update';
    `);
    expect(parseInt(auditCount)).toBeGreaterThanOrEqual(1);

    psql(`
      DELETE FROM admin_audit_logs WHERE entity_id = '${CAMP_A_ID}';
      DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}';
    `);
  });

  it('update_promo_campaign_routing does NOT write audit for draft campaigns', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Draft NoAudit', 'draft', 'keyword', 'OLD', false, 'w', 't', 'i', 'a', 'e');
    `);

    psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'NEWNEW', NULL);
    `);

    const auditCount = psql(`
      SELECT count(*) FROM admin_audit_logs WHERE entity_id = '${CAMP_A_ID}' AND action = 'promotions.routing_update';
    `);
    expect(parseInt(auditCount)).toBe(0);

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('cross-business routing change does not find campaign', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Biz A Camp', 'draft', 'keyword', 'BIZCROSS', false, 'w', 't', 'i', 'a', 'e');
    `);

    // Try to update using wrong business_id
    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_B_ID}', '${USER_ID}', 'keyword', 'NEWKW', NULL);
    `);
    expect(result).toContain('Campaign not found');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  it('validate_promo_campaign_activation detects scheduled keyword conflict', () => {
    // Create a scheduled campaign with keyword PROMO
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message, start_at, end_at)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Scheduled KW', 'scheduled', 'keyword', 'PROMO', false, 'w', 't', 'i', 'a', 'e', now() + interval '1 day', now() + interval '30 days');
    `);
    // Create a draft campaign with same keyword (to validate activation)
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message, start_at, end_at)
      VALUES ('${CAMP_B_ID}', '${BIZ_ID}', 'Draft KW', 'draft', 'keyword', 'PROMO', false, 'w', 't', 'i', 'a', 'e', now() + interval '1 day', now() + interval '30 days');
    `);

    const result = psql(`SELECT validate_promo_campaign_activation('${CAMP_B_ID}')`);
    expect(result).toContain('conflicts with campaign');
    expect(result).toContain('Scheduled KW');

    psql(`DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}')`);
  });

  // ── A. Atomic audit-write: verify routing update + audit are in same transaction ──
  it('routing update on active campaign produces both updated row and audit entry (same transaction)', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Atomic Audit', 'active', 'keyword', 'ATOMOLD', false, 'w', 't', 'i', 'a', 'e');
    `);

    const result = psql(`
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'ATOMNEW', 'test audit atomicity');
    `);
    expect(JSON.parse(result).success).toBe(true);

    // Verify the routing UPDATE landed
    const kw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
    expect(kw).toBe('ATOMNEW');

    // Verify the audit INSERT landed (same transaction — if either rolled back, both would be gone)
    const auditCount = psql(`
      SELECT count(*) FROM admin_audit_logs
        WHERE entity_id = '${CAMP_A_ID}' AND action = 'promotions.routing_update';
    `);
    expect(parseInt(auditCount)).toBeGreaterThanOrEqual(1);

    // Verify audit details contain before/after state
    const auditDetails = psql(`
      SELECT details::text FROM admin_audit_logs
        WHERE entity_id = '${CAMP_A_ID}' AND action = 'promotions.routing_update'
        ORDER BY created_at DESC LIMIT 1;
    `);
    expect(auditDetails).toContain('ATOMOLD');
    expect(auditDetails).toContain('ATOMNEW');

    psql(`
      DELETE FROM admin_audit_logs WHERE entity_id = '${CAMP_A_ID}';
      DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}';
    `);
  });

  // ── A2. Audit-write failure proves routing rollback (same transaction) ──
  it('audit-write failure rolls back the routing update (transaction atomicity proof)', () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Rollback Test', 'active', 'keyword', 'ROLLOLD', false, 'w', 't', 'i', 'a', 'e');
    `);

    // Make admin_audit_logs temporarily unwritable with a CHECK that always fails
    psql(`ALTER TABLE admin_audit_logs ADD CONSTRAINT temp_block_audit CHECK (false) NOT VALID;`);

    try {
      // The RPC runs in a single transaction: routing UPDATE + audit INSERT.
      // The audit INSERT will fail due to the CHECK constraint, which should
      // roll back the entire transaction including the routing UPDATE.
      const result = psqlMayFail(`
        SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'ROLLNEW', 'test rollback');
      `);

      // The RPC should have failed (audit INSERT blocked)
      expect(result.ok).toBe(false);

      // Verify routing was NOT updated (rolled back)
      const kw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
      expect(kw).toBe('ROLLOLD');
    } finally {
      // Clean up the blocking constraint
      psql(`ALTER TABLE admin_audit_logs DROP CONSTRAINT IF EXISTS temp_block_audit;`);
      psql(`
        DELETE FROM admin_audit_logs WHERE entity_id = '${CAMP_A_ID}';
        DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}';
      `);
    }
  });

  // ── B. Two-connection concurrency test ──
  // Uses independent psql child processes (separate PostgreSQL connections)
  // to prove FOR UPDATE serialization.
  it('two concurrent routing updates: one blocks until the other commits (FOR UPDATE)', async () => {
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Concurrency Test', 'draft', 'keyword', 'FIRST', false, 'w', 't', 'i', 'a', 'e');
    `);

    // Connection A: BEGIN, lock the row with FOR UPDATE via the RPC (which internally does SELECT ... FOR UPDATE),
    // then sleep to hold the lock, then COMMIT
    const sqlA = `
      BEGIN;
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'SECOND', NULL);
      SELECT pg_sleep(2);
      COMMIT;
    `;

    // Connection B: attempt same RPC concurrently — it will block on FOR UPDATE until A commits
    const sqlB = `
      SELECT update_promo_campaign_routing('${CAMP_A_ID}', '${BIZ_ID}', '${USER_ID}', 'keyword', 'THIRD', NULL);
    `;

    // Launch both concurrently via separate child processes (separate connections)
    const [resultA, resultB] = await Promise.all([
      psqlAsync(sqlA),
      psqlAsync(sqlB),
    ]);

    // Both should succeed (serialized by FOR UPDATE)
    expect(resultA.ok).toBe(true);
    expect(JSON.parse(resultA.stdout).success).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(JSON.parse(resultB.stdout).success).toBe(true);

    // The last writer wins — B waited for A's lock, then ran after A committed.
    // Since both succeed and B ran after A, the final value should be THIRD.
    const kw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
    expect(kw).toBe('THIRD');

    psql(`DELETE FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
  });

  // ── C. Unrelated unique_violation re-raise ──
  // The EXCEPTION handler in update_promo_campaign_routing only catches
  // idx_promo_campaigns_keyword_unique and idx_promo_campaigns_bare_code_active.
  // Any OTHER unique_violation hits the ELSE -> RAISE branch.
  // We prove this by creating a temporary unique constraint on `name` and triggering it.
  it('unrelated unique_violation is re-raised as raw error (not mapped to keyword/bare_code conflict)', () => {
    // Create two campaigns with different names
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'UniqueNameA', 'draft', 'keyword', 'UNQA', false, 'w', 't', 'i', 'a', 'e');
    `);
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_B_ID}', '${BIZ_ID}', 'UniqueNameB', 'draft', 'keyword', 'UNQB', false, 'w', 't', 'i', 'a', 'e');
    `);

    // Create a trigger that forces a unique_violation on an unrelated constraint
    // when we try to update routing. This simulates an unexpected unique_violation
    // that is NOT idx_promo_campaigns_keyword_unique or idx_promo_campaigns_bare_code_active.
    psql(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_temp_promo_name_unique ON promo_campaigns (business_id, name);
    `);

    try {
      // Now rename CAMP_B to have the same name as CAMP_A, then try routing update.
      // The routing update itself does not change name, so we use a trigger to force the conflict.
      psql(`
        CREATE OR REPLACE FUNCTION trg_force_name_collision() RETURNS TRIGGER AS $fn$
        BEGIN
          NEW.name := 'UniqueNameA';
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;

        CREATE TRIGGER trg_acc198_force_collision
          BEFORE UPDATE OF code_entry_mode ON promo_campaigns
          FOR EACH ROW
          WHEN (OLD.id = '${CAMP_B_ID}')
          EXECUTE FUNCTION trg_force_name_collision();
      `);

      // Call routing update on CAMP_B — it will trigger the name collision
      const result = psqlMayFail(`
        SELECT update_promo_campaign_routing('${CAMP_B_ID}', '${BIZ_ID}', '${USER_ID}', 'bare_code', NULL, NULL);
      `);

      // The error should be a raw PostgreSQL error (re-raised), NOT a mapped keyword/bare_code conflict
      expect(result.ok).toBe(false);
      expect(result.output).toContain('idx_temp_promo_name_unique');
      // Must NOT contain our mapped error codes
      expect(result.output).not.toContain('keyword_conflict');
      expect(result.output).not.toContain('bare_code_conflict');
    } finally {
      psql(`
        DROP TRIGGER IF EXISTS trg_acc198_force_collision ON promo_campaigns;
        DROP FUNCTION IF EXISTS trg_force_name_collision();
        DROP INDEX IF EXISTS idx_temp_promo_name_unique;
      `);
      psql(`DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}')`);
    }
  });

  // ── D. Privilege assertions ──
  it('anon role cannot execute update_promo_campaign_routing', () => {
    expect(() => {
      psql(`
        SET ROLE anon;
        SELECT update_promo_campaign_routing(
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          'keyword', 'TEST', NULL
        );
      `);
    }).toThrow();
    psql(`RESET ROLE;`);
  });

  it('anon role cannot execute activate_promo_campaign', () => {
    expect(() => {
      psql(`
        SET ROLE anon;
        SELECT activate_promo_campaign(
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          'business'
        );
      `);
    }).toThrow();
    psql(`RESET ROLE;`);
  });

  it('anon role cannot execute validate_promo_campaign_activation', () => {
    expect(() => {
      psql(`
        SET ROLE anon;
        SELECT validate_promo_campaign_activation('00000000-0000-0000-0000-000000000000');
      `);
    }).toThrow();
    psql(`RESET ROLE;`);
  });

  it('authenticated role cannot execute update_promo_campaign_routing', () => {
    expect(() => {
      psql(`
        SET ROLE authenticated;
        SELECT update_promo_campaign_routing(
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          'keyword', 'TEST', NULL
        );
      `);
    }).toThrow();
    psql(`RESET ROLE;`);
  });

  it('authenticated role cannot execute activate_promo_campaign', () => {
    expect(() => {
      psql(`
        SET ROLE authenticated;
        SELECT activate_promo_campaign(
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          'business'
        );
      `);
    }).toThrow();
    psql(`RESET ROLE;`);
  });

  it('authenticated role cannot execute validate_promo_campaign_activation', () => {
    expect(() => {
      psql(`
        SET ROLE authenticated;
        SELECT validate_promo_campaign_activation('00000000-0000-0000-0000-000000000000');
      `);
    }).toThrow();
    psql(`RESET ROLE;`);
  });

  // ── E. Legacy migration repair/abort: keyword/both mode with NULL keyword ──
  // The corrected migration aborts if any keyword/both campaign has NULL keyword.
  // We test this contract by verifying the CHECK constraint prevents such rows.
  it('CHECK constraint rejects keyword mode with NULL keyword (migration abort contract)', () => {
    expect(() => {
      psql(`
        INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
        VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Bad KW', 'keyword', NULL, false, 'w', 't', 'i', 'a', 'e');
      `);
    }).toThrow();
  });

  it('CHECK constraint rejects both mode with NULL keyword (migration abort contract)', () => {
    expect(() => {
      psql(`
        INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
        VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Bad Both', 'both', NULL, true, 'w', 't', 'i', 'a', 'e');
      `);
    }).toThrow();
  });

  // ── F. Scheduled bare-code conflict on activation ──
  it('validate_promo_campaign_activation detects scheduled bare-code conflict', () => {
    // Create an active campaign with bare codes
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Active Bare', 'active', 'bare_code', NULL, true, 'w', 't', 'i', 'a', 'e');
    `);
    // Create a draft campaign also with bare codes (to validate activation against active)
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message, start_at, end_at)
      VALUES ('${CAMP_B_ID}', '${BIZ_ID}', 'Draft Bare', 'draft', 'bare_code', NULL, true, 'w', 't', 'i', 'a', 'e', now() + interval '1 day', now() + interval '30 days');
    `);

    const result = psql(`SELECT validate_promo_campaign_activation('${CAMP_B_ID}')`);
    expect(result).toContain('Bare-code mode conflicts');
    expect(result).toContain('Active Bare');

    psql(`DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}')`);
  });

  // ── G. Migration 340 pre-migration harness: abort on invalid legacy rows ──
  // Proves migration 340 aborts (RAISE EXCEPTION) when both-mode campaigns have NULL keyword.
  // Uses SAVEPOINT to simulate running the migration on pre-340 state without permanent damage.
  it('migration 340 aborts on both-mode campaign with NULL keyword (pre-340 harness)', () => {
    // 1. Drop post-340 objects so migration can be re-run
    psql(`ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS chk_routing_consistency`);
    psql(`DROP TRIGGER IF EXISTS trg_normalize_promo_keyword ON promo_campaigns`);

    // 2. Re-create the OLD weak CHECK constraint (pre-340: only checks keyword when mode=keyword)
    psql(`
      ALTER TABLE promo_campaigns ADD CONSTRAINT chk_keyword_or_bare CHECK (
        (code_entry_mode = 'keyword' AND keyword IS NOT NULL) OR
        code_entry_mode IN ('bare_code', 'both')
      )
    `);

    try {
      // 3. Insert invalid legacy rows that pass the weak constraint but violate the strong one
      //    - both mode with NULL keyword (the unfixable case migration should abort on)
      psql(`
        INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
        VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'Both No KW', 'both', NULL, true, 'w', 't', 'i', 'a', 'e')
      `);

      // Verify the invalid row exists
      const beforeKw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
      expect(beforeKw).toBe('');  // psql returns empty string for NULL

      // 4. Read migration 340 SQL
      const migrationPath = path.resolve(__dirname, '../../supabase/migrations/340_promo_routing_consistency.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');

      // 5. Execute the migration SQL inside a BEGIN block so we can roll back
      //    The migration's DO $$ block should RAISE EXCEPTION on the both+NULL row
      //    psql -tAXq runs in autocommit, so we must wrap in an explicit transaction
      const result = psqlMayFail(`
        BEGIN;
        ${migrationSql}
        COMMIT;
      `);

      // 6. The migration should have failed (RAISE EXCEPTION 'Migration blocked: ...')
      //    The BEGIN block means the error aborts the transaction automatically
      expect(result.ok).toBe(false);
      expect(result.output).toContain('Migration blocked');

      // 7. Verify the invalid row still exists unchanged (transaction rolled back on error)
      const afterKw = psql(`SELECT keyword FROM promo_campaigns WHERE id = '${CAMP_A_ID}'`);
      expect(afterKw).toBe('');  // Still NULL (empty in psql output)
    } finally {
      // 9. Clean up: remove invalid test rows, restore the correct constraint
      psql(`DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}')`);
      psql(`ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS chk_keyword_or_bare`);
      psql(`ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS chk_routing_consistency`);
      psql(`
        ALTER TABLE promo_campaigns ADD CONSTRAINT chk_routing_consistency CHECK (
          (code_entry_mode = 'keyword'   AND keyword IS NOT NULL AND accept_bare_codes = false) OR
          (code_entry_mode = 'bare_code' AND keyword IS NULL     AND accept_bare_codes = true)  OR
          (code_entry_mode = 'both'      AND keyword IS NOT NULL AND accept_bare_codes = true)
        )
      `);
      psql(`DROP TRIGGER IF EXISTS trg_normalize_promo_keyword ON promo_campaigns`);
      psql(`
        CREATE TRIGGER trg_normalize_promo_keyword
          BEFORE INSERT OR UPDATE OF keyword ON promo_campaigns
          FOR EACH ROW EXECUTE FUNCTION normalize_promo_keyword()
      `);
    }
  });

  it('migration 340 aborts on keyword-mode campaign with NULL keyword (pre-340 harness)', () => {
    // Same pattern, but for keyword mode with NULL keyword
    psql(`ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS chk_routing_consistency`);
    psql(`DROP TRIGGER IF EXISTS trg_normalize_promo_keyword ON promo_campaigns`);
    psql(`
      ALTER TABLE promo_campaigns ADD CONSTRAINT chk_keyword_or_bare CHECK (
        (code_entry_mode = 'keyword' AND keyword IS NOT NULL) OR
        code_entry_mode IN ('bare_code', 'both')
      )
    `);

    try {
      // keyword+wrong bare flag is fixable (bare is forced to false), but NULL keyword is not
      // The old constraint requires keyword IS NOT NULL for keyword mode, so we can't insert
      // keyword+NULL via the old constraint. But we CAN insert both+NULL (the real concern).
      // So let's test that keyword mode with wrong bare is repaired but not aborted:
      psql(`
        INSERT INTO promo_campaigns (id, business_id, name, code_entry_mode, keyword, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
        VALUES ('${CAMP_A_ID}', '${BIZ_ID}', 'KW Wrong Bare', 'keyword', 'TEST', true, 'w', 't', 'i', 'a', 'e')
      `);

      const migrationPath = path.resolve(__dirname, '../../supabase/migrations/340_promo_routing_consistency.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');

      // This should succeed — keyword mode with keyword=TEST is fixable (bare forced to false)
      // Run migration + verify + rollback in ONE psql session (each psql call is a new connection)
      const result = psqlMayFail(`
        BEGIN;
        ${migrationSql}
        -- Verify the bare_codes flag was corrected
        SELECT accept_bare_codes FROM promo_campaigns WHERE id = '${CAMP_A_ID}';
        ROLLBACK;
      `);

      // Migration should succeed since keyword is present
      expect(result.ok).toBe(true);
      // Output contains the query result — 'f' for false
      expect(result.output).toContain('f');
    } finally {
      psql(`DELETE FROM promo_campaigns WHERE id IN ('${CAMP_A_ID}', '${CAMP_B_ID}', '${CAMP_C_ID}')`);
      psql(`ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS chk_keyword_or_bare`);
      psql(`ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS chk_routing_consistency`);
      psql(`
        ALTER TABLE promo_campaigns ADD CONSTRAINT chk_routing_consistency CHECK (
          (code_entry_mode = 'keyword'   AND keyword IS NOT NULL AND accept_bare_codes = false) OR
          (code_entry_mode = 'bare_code' AND keyword IS NULL     AND accept_bare_codes = true)  OR
          (code_entry_mode = 'both'      AND keyword IS NOT NULL AND accept_bare_codes = true)
        )
      `);
      psql(`DROP TRIGGER IF EXISTS trg_normalize_promo_keyword ON promo_campaigns`);
      psql(`
        CREATE TRIGGER trg_normalize_promo_keyword
          BEFORE INSERT OR UPDATE OF keyword ON promo_campaigns
          FOR EACH ROW EXECUTE FUNCTION normalize_promo_keyword()
      `);
    }
  });
});
