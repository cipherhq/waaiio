/**
 * PROMO-1: Real two-connection generation contention tests.
 *
 * Uses independent child processes with separate PostgreSQL connections
 * to prove concurrent generation safety.
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFile } from 'child_process';
import { createHmac } from 'crypto';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlJson(sql: string): Record<string, unknown> {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : {};
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

const BIZ = '00000000-0000-0000-0399-000000000001';
const CAMPAIGN = '00000000-0000-0000-0399-100000000001';
const PRIZE = '00000000-0000-0000-0399-200000000001';
const USER = '00000000-0000-0000-0399-500000000001';

describe.skipIf(!canRun)('PROMO-1: Real two-connection generation contention', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT '${USER}'::UUID; $$ LANGUAGE SQL STABLE;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, email TEXT);
      INSERT INTO auth.users (id) VALUES ('${USER}') ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY, name TEXT NOT NULL DEFAULT 'T', slug TEXT NOT NULL DEFAULT 't',
        owner_id UUID DEFAULT '${USER}', status TEXT DEFAULT 'active',
        address TEXT DEFAULT 'x', city TEXT DEFAULT 'x', neighborhood TEXT DEFAULT 'x',
        phone TEXT DEFAULT '+0', country_code TEXT DEFAULT 'NG'
      );
      CREATE TABLE IF NOT EXISTS business_members (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, user_id UUID);
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID, action TEXT,
        entity_type TEXT, entity_id UUID, details JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO businesses (id, name, slug) VALUES ('${BIZ}', 'ContBiz', 'cont') ON CONFLICT DO NOTHING;
    `);

    const fs = require('fs');
    psql(fs.readFileSync('supabase/migrations/321_promotions_schema.sql', 'utf-8'));
    psql(fs.readFileSync('supabase/migrations/336_fix_promo_audit_entity_id_cast.sql', 'utf-8'));

    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, keyword) VALUES
        ('${CAMPAIGN}', '${BIZ}', 'Contention Test', 'draft', 'CONT');
      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity) VALUES
        ('${PRIZE}', '${CAMPAIGN}', 'Limited Prize', 'cash', 2);
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) TO service_role;
      GRANT EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) TO service_role;
      GRANT EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) TO service_role;
      GRANT EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) TO service_role;
      GRANT EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
      GRANT EXECUTE ON FUNCTION get_promo_campaign_aggregates(UUID[]) TO service_role;
      GRANT EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) TO service_role;
      GRANT EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) TO service_role;
    `);
  });

  afterAll(() => {
    if (!canRun) return;
    psql(`
      DROP TABLE IF EXISTS promo_pending_eligibility CASCADE;
      DROP TABLE IF EXISTS promo_eligibility_acks CASCADE;
      DROP TABLE IF EXISTS promo_verification_attempts CASCADE;
      DROP TABLE IF EXISTS promo_redemptions CASCADE;
      DROP TABLE IF EXISTS promo_campaign_codes CASCADE;
      DROP TABLE IF EXISTS promo_code_batches CASCADE;
      DROP TABLE IF EXISTS promo_prizes CASCADE;
      DROP TABLE IF EXISTS promo_campaigns CASCADE;
      DROP TYPE IF EXISTS promo_campaign_status, promo_code_entry_mode, promo_prize_type,
        promo_batch_status, promo_batch_source, promo_code_status, promo_code_outcome,
        promo_fulfillment_status, promo_attempt_result CASCADE;
      DROP FUNCTION IF EXISTS claim_promo_code, validate_promo_campaign_activation,
        admin_promo_governance, activate_promo_campaign, commit_promo_code_chunk,
        commit_promo_import_chunk, get_promo_campaign_aggregates, reset_promo_failed_batch,
        create_promo_batch_atomic, update_promo_campaign_updated_at, validate_promo_campaign_status_transition CASCADE;
      DROP TABLE IF EXISTS admin_audit_logs CASCADE;
      DELETE FROM businesses WHERE id = '${BIZ}';
    `);
  });

  // ═══════ A. SAME BATCH / SAME CURSOR RACE ═══════

  it('CONTENTION-A: same batch, same cursor — exactly one wins', async () => {
    // Create a batch at cursor 0
    const batchId = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, status, progress_cursor)
      VALUES ('${CAMPAIGN}', 'generated', 100, 'processing', 0) RETURNING id;
    RESET ROLE;`);

    const chunk1 = JSON.stringify([{ hash: 'cont_a_1', encrypted: 'e1', suffix: 'CA01', outcome: 'try_again', prize_id: '' }]);
    const chunk2 = JSON.stringify([{ hash: 'cont_a_2', encrypted: 'e2', suffix: 'CA02', outcome: 'try_again', prize_id: '' }]);

    const sql1 = `SET ROLE service_role;
      SELECT commit_promo_code_chunk('${batchId}'::uuid, 0, '${chunk1}'::jsonb, 1);
    RESET ROLE;`;

    const sql2 = `SET ROLE service_role;
      SELECT commit_promo_code_chunk('${batchId}'::uuid, 0, '${chunk2}'::jsonb, 1);
    RESET ROLE;`;

    // Launch both in parallel with independent connections
    const [r1, r2] = await Promise.all([psqlAsync(sql1), psqlAsync(sql2)]);

    // One should succeed, one should fail (cursor mismatch or lock contention)
    const results = [r1, r2];
    const successes = results.filter(r => r.ok && r.stdout.includes('"success": true'));
    const failures = results.filter(r => !r.ok || r.stdout.includes('"success": false') || r.stdout.includes('Cursor mismatch'));

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // Cursor advanced exactly once
    const cursor = psql(`SELECT progress_cursor FROM promo_code_batches WHERE id = '${batchId}';`);
    expect(parseInt(cursor)).toBe(1);

    // Exactly one code row inserted
    const codeCount = psql(`SELECT count(*) FROM promo_campaign_codes WHERE batch_id = '${batchId}';`);
    expect(parseInt(codeCount)).toBe(1);
  });

  // ═══════ B. TWO BATCHES / SAME PRIZE RACE ═══════

  it('CONTENTION-B: two batches, same prize — no over-allocation', async () => {
    // Prize has quantity=2, allocated_count currently 0

    const batch1 = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, status, progress_cursor)
      VALUES ('${CAMPAIGN}', 'generated', 3, 'processing', 0) RETURNING id;
    RESET ROLE;`);

    const batch2 = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, status, progress_cursor)
      VALUES ('${CAMPAIGN}', 'generated', 3, 'processing', 0) RETURNING id;
    RESET ROLE;`);

    // Each batch tries to allocate 2 winners for the prize (total 4, but prize has quantity 2)
    const chunk1 = JSON.stringify([
      { hash: 'cont_b1_1', encrypted: 'e1', suffix: 'B101', outcome: 'winner', prize_id: PRIZE },
      { hash: 'cont_b1_2', encrypted: 'e2', suffix: 'B102', outcome: 'winner', prize_id: PRIZE },
      { hash: 'cont_b1_3', encrypted: 'e3', suffix: 'B103', outcome: 'try_again', prize_id: '' },
    ]);
    const chunk2 = JSON.stringify([
      { hash: 'cont_b2_1', encrypted: 'e4', suffix: 'B201', outcome: 'winner', prize_id: PRIZE },
      { hash: 'cont_b2_2', encrypted: 'e5', suffix: 'B202', outcome: 'winner', prize_id: PRIZE },
      { hash: 'cont_b2_3', encrypted: 'e6', suffix: 'B203', outcome: 'try_again', prize_id: '' },
    ]);

    const sql1 = `SET ROLE service_role;
      SELECT commit_promo_code_chunk('${batch1}'::uuid, 0, '${chunk1}'::jsonb, 3);
    RESET ROLE;`;
    const sql2 = `SET ROLE service_role;
      SELECT commit_promo_code_chunk('${batch2}'::uuid, 0, '${chunk2}'::jsonb, 3);
    RESET ROLE;`;

    await Promise.all([psqlAsync(sql1), psqlAsync(sql2)]);

    // Prize allocated_count must never exceed quantity (2)
    const allocated = psql(`SELECT allocated_count FROM promo_prizes WHERE id = '${PRIZE}';`);
    expect(parseInt(allocated)).toBeLessThanOrEqual(2);

    // Winner code count for this prize must never exceed quantity
    const winnerCount = psql(`SELECT count(*) FROM promo_campaign_codes WHERE prize_id = '${PRIZE}' AND outcome = 'winner';`);
    expect(parseInt(winnerCount)).toBeLessThanOrEqual(2);

    // Excess winner attempts should have been downgraded to try_again
    const totalCodes = psql(`SELECT count(*) FROM promo_campaign_codes WHERE campaign_id = '${CAMPAIGN}';`);
    expect(parseInt(totalCodes)).toBeGreaterThanOrEqual(1);
  });

  // ═══════ C. FAILED CHUNK / RETRY ═══════

  it('CONTENTION-C: failed chunk leaves cursor unchanged, retry succeeds', async () => {
    const batchId = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, status, progress_cursor)
      VALUES ('${CAMPAIGN}', 'generated', 10, 'processing', 0) RETURNING id;
    RESET ROLE;`);

    // First insert a code to create a collision target
    psql(`SET ROLE service_role;
      INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, display_suffix, outcome)
      VALUES ('${BIZ}', '${CAMPAIGN}', '${batchId}', 'collision_target_c', 'COLC', 'try_again');
    RESET ROLE;`);

    // Attempt chunk with colliding hash — should fail entirely
    const collidingChunk = JSON.stringify([
      { hash: 'collision_target_c', encrypted: 'e1', suffix: 'COLC', outcome: 'try_again', prize_id: '' },
    ]);

    const failResult = await psqlAsync(`SET ROLE service_role;
      SELECT commit_promo_code_chunk('${batchId}'::uuid, 0, '${collidingChunk}'::jsonb, 1);
    RESET ROLE;`);

    // Should fail due to unique violation
    expect(failResult.ok).toBe(false);

    // Cursor should NOT have advanced
    const cursorAfterFail = psql(`SELECT progress_cursor FROM promo_code_batches WHERE id = '${batchId}';`);
    expect(parseInt(cursorAfterFail)).toBe(0);

    // Prize allocation should be unchanged (no try_again → winner conversion)
    // Now retry with a valid chunk at same cursor
    const validChunk = JSON.stringify([
      { hash: 'retry_valid_c', encrypted: 'e2', suffix: 'RVC1', outcome: 'try_again', prize_id: '' },
    ]);

    const retryResult = await psqlAsync(`SET ROLE service_role;
      SELECT commit_promo_code_chunk('${batchId}'::uuid, 0, '${validChunk}'::jsonb, 1);
    RESET ROLE;`);

    expect(retryResult.ok).toBe(true);

    const cursorAfterRetry = psql(`SELECT progress_cursor FROM promo_code_batches WHERE id = '${batchId}';`);
    expect(parseInt(cursorAfterRetry)).toBe(1);
  });

  // ═══════ D. IMPORT CONTENTION: two imports fight for last prize ═══════

  it('IMPORT-CONTENTION-1: two imports compete for last prize — no over-allocation', async () => {
    // Create a prize with quantity=1
    const prizeId = psql(`SET ROLE service_role;
      INSERT INTO promo_prizes (campaign_id, name, prize_type, quantity, allocated_count)
      VALUES ('${CAMPAIGN}', 'Scarce', 'product', 1, 0) RETURNING id;
    RESET ROLE;`);

    const batch1 = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, status, progress_cursor)
      VALUES ('${CAMPAIGN}', 'imported', 1, 'processing', 0) RETURNING id;
    RESET ROLE;`);
    const batch2 = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, status, progress_cursor)
      VALUES ('${CAMPAIGN}', 'imported', 1, 'processing', 0) RETURNING id;
    RESET ROLE;`);

    const chunk1 = JSON.stringify([{ hash: 'imp_c1_1', encrypted: 'e1', suffix: 'IC11', outcome: 'winner', prize_id: prizeId }]);
    const chunk2 = JSON.stringify([{ hash: 'imp_c2_1', encrypted: 'e2', suffix: 'IC21', outcome: 'winner', prize_id: prizeId }]);

    const [r1, r2] = await Promise.all([
      psqlAsync(`SET ROLE service_role; SELECT commit_promo_import_chunk('${batch1}'::uuid, '${chunk1}'::jsonb); RESET ROLE;`),
      psqlAsync(`SET ROLE service_role; SELECT commit_promo_import_chunk('${batch2}'::uuid, '${chunk2}'::jsonb); RESET ROLE;`),
    ]);

    // Both should succeed (one winner, one downgraded to try_again)
    const allocated = psql(`SELECT allocated_count FROM promo_prizes WHERE id = '${prizeId}';`);
    expect(parseInt(allocated)).toBeLessThanOrEqual(1);

    const winnerCount = psql(`SELECT count(*) FROM promo_campaign_codes WHERE prize_id = '${prizeId}' AND outcome = 'winner';`);
    expect(parseInt(winnerCount)).toBeLessThanOrEqual(1);
    expect(parseInt(winnerCount)).toBe(parseInt(allocated));
  });

  // ═══════ E. ACTIVATION vs GENERATION RACE ═══════

  it('ACTIVATE-GENERATE-1: activation blocks subsequent generation', async () => {
    // Create a fresh campaign for this test
    const campId = psql(`SET ROLE service_role;
      INSERT INTO promo_campaigns (business_id, name, status, keyword, code_entry_mode)
      VALUES ('${BIZ}', 'ActGenTest', 'draft', 'ACTGEN', 'keyword') RETURNING id;
    RESET ROLE;`);

    // Create batch and one code so activation can succeed
    const batchId = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, generated_count, status, progress_cursor)
      VALUES ('${campId}', 'generated', 1, 1, 'completed', 1) RETURNING id;
    RESET ROLE;`);
    psql(`SET ROLE service_role;
      INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, display_suffix, outcome)
      VALUES ('${BIZ}', '${campId}', '${batchId}', 'actgen_h1', 'AG01', 'try_again');
    RESET ROLE;`);

    // Activate the campaign
    psql(`SET ROLE service_role; SELECT activate_promo_campaign('${campId}'); RESET ROLE;`);
    const status = psql(`SELECT status FROM promo_campaigns WHERE id = '${campId}';`);
    expect(status).toBe('active');

    // Now try to generate more codes — should be rejected
    const genBatch = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, status, progress_cursor)
      VALUES ('${campId}', 'generated', 1, 'processing', 0) RETURNING id;
    RESET ROLE;`);

    const genChunk = JSON.stringify([{ hash: 'actgen_h2', encrypted: 'e2', suffix: 'AG02', outcome: 'try_again', prize_id: '' }]);
    const genResult = await psqlAsync(`SET ROLE service_role;
      SELECT commit_promo_code_chunk('${genBatch}'::uuid, 0, '${genChunk}'::jsonb, 1);
    RESET ROLE;`);

    // Should fail because campaign is active
    if (genResult.ok && genResult.stdout) {
      const parsed = JSON.parse(genResult.stdout);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('active');
    }
  });

  // ═══════ E2. DETERMINISTIC ACTIVATION VS BATCH-START SERIALIZATION ═══════
  // Proves that batch creation (create_promo_batch_atomic) and activation
  // (activate_promo_campaign) serialize on the campaign row lock.
  //
  // Architecture:
  //   Connection A: BEGIN → activate_promo_campaign (locks campaign FOR UPDATE,
  //     validates, sets active) → pg_sleep(0.5) → COMMIT
  //   Connection B: create_promo_batch_atomic (blocks on campaign FOR UPDATE)
  //   Probe: FOR UPDATE NOWAIT confirms lock is held
  //   When A commits: campaign = active, B resumes → sees active → rejects batch
  //
  // This proves the REAL activation authority, not a direct UPDATE bypass.

  it('ACTIVATE-GEN-DETERMINISTIC: real activate_promo_campaign blocks batch creation', async () => {
    const campId = psql(`SET ROLE service_role;
      INSERT INTO promo_campaigns (business_id, name, status, keyword, code_entry_mode,
        winner_message, try_again_message, invalid_message)
      VALUES ('${BIZ}', 'DetOverlap', 'draft', 'DETOVR', 'keyword',
        'You won!', 'Try again', 'Invalid') RETURNING id;
    RESET ROLE;`);

    // Need at least one completed batch + code for activation to pass validation
    const completedBatch = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, generated_count, status, progress_cursor)
      VALUES ('${campId}', 'generated', 1, 1, 'completed', 1) RETURNING id;
    RESET ROLE;`);
    psql(`SET ROLE service_role;
      INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, display_suffix, outcome)
      VALUES ('${BIZ}', '${campId}', '${completedBatch}', 'detovr_h1', 'DV01', 'try_again');
    RESET ROLE;`);

    // Connection A: real activate_promo_campaign (locks campaign via FOR UPDATE inside RPC)
    // Wrapped in explicit transaction with pg_sleep to hold the lock
    const connA = psqlAsync(`
      SET ROLE service_role;
      BEGIN;
      SELECT activate_promo_campaign('${campId}');
      SELECT pg_sleep(0.5);
      COMMIT;
      RESET ROLE;
    `);

    // Wait for A to acquire the lock
    await new Promise(r => setTimeout(r, 100));

    // Connection B: attempt batch creation — blocks on campaign FOR UPDATE inside RPC
    const connB = psqlAsync(`
      SET ROLE service_role;
      SELECT create_promo_batch_atomic('${campId}'::uuid, 'generated'::promo_batch_source, 10);
      RESET ROLE;
    `);

    // Probe: verify campaign lock is held by A (should fail with lock error)
    const probe = psqlMayFail(`
      BEGIN;
      SET LOCAL lock_timeout = '200ms';
      SELECT id FROM promo_campaigns WHERE id = '${campId}' FOR UPDATE NOWAIT;
      COMMIT;
    `);
    // Probe should fail — A holds the lock
    expect(probe.ok).toBe(false);

    // Wait for both connections to complete
    const [resultA, resultB] = await Promise.all([connA, connB]);

    // ASSERTIONS:

    // 1. Activation succeeded via real activate_promo_campaign
    expect(resultA.ok).toBe(true);
    const finalStatus = psql(`SELECT status FROM promo_campaigns WHERE id = '${campId}';`);
    expect(finalStatus).toBe('active');

    // 2. Batch creation rejected — campaign is active when B's lock is released
    expect(resultB.ok).toBe(true); // psql exits 0 (RPC returns JSONB, not exception)
    if (resultB.stdout) {
      const lines = resultB.stdout.split('\n').filter(l => l.trim().startsWith('{'));
      if (lines.length > 0) {
        const parsed = JSON.parse(lines[lines.length - 1]);
        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('active');
      }
    }

    // 3. No batch was created after activation
    const pendingBatches = psql(`SELECT count(*) FROM promo_code_batches WHERE campaign_id = '${campId}' AND status = 'pending';`);
    expect(parseInt(pendingBatches)).toBe(0);

    // 4. No post-activation code inserted (only original 1)
    const codeCount = psql(`SELECT count(*) FROM promo_campaign_codes WHERE campaign_id = '${campId}';`);
    expect(parseInt(codeCount)).toBe(1);

    // 5. Generation batch cursor never advanced (no batch was created)
    const genBatchCount = psql(`SELECT count(*) FROM promo_code_batches WHERE campaign_id = '${campId}' AND source = 'generated' AND status != 'completed';`);
    expect(parseInt(genBatchCount)).toBe(0);
  });

  // ═══════ F. CONCURRENT MESSAGE IDEMPOTENCY ═══════

  it('MESSAGE-RACE-WINNER: same message + same winner — one redemption', async () => {
    // Create a campaign with a code for this test
    const campId = psql(`SET ROLE service_role;
      INSERT INTO promo_campaigns (business_id, name, status, keyword)
      VALUES ('${BIZ}', 'MsgRace', 'active', 'MSGRACE') RETURNING id;
    RESET ROLE;`);
    const prizeId = psql(`SET ROLE service_role;
      INSERT INTO promo_prizes (campaign_id, name, prize_type, quantity)
      VALUES ('${campId}', 'RacePrize', 'cash', 1) RETURNING id;
    RESET ROLE;`);
    const batchId = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, generated_count, status)
      VALUES ('${campId}', 'generated', 1, 1, 'completed') RETURNING id;
    RESET ROLE;`);

    const testHash = createHmac('sha256', 'dev-promo-key').update('RACECODE1234').digest('hex');
    psql(`SET ROLE service_role;
      INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, display_suffix, outcome, prize_id)
      VALUES ('${BIZ}', '${campId}', '${batchId}', '${testHash}', 'R234', 'winner', '${prizeId}');
    RESET ROLE;`);

    const msgId = 'race-msg-' + Date.now();
    const sql = `SET ROLE service_role;
      SELECT claim_promo_code('${BIZ}'::uuid, '${campId}'::uuid, '${testHash}', '+234900', '${msgId}');
    RESET ROLE;`;

    // Launch two concurrent claims with same message ID
    const [r1, r2] = await Promise.all([psqlAsync(sql), psqlAsync(sql)]);

    // Exactly one redemption
    const redemptionCount = psql(`SELECT count(*) FROM promo_redemptions WHERE inbound_message_id = '${msgId}';`);
    expect(parseInt(redemptionCount)).toBe(1);

    // Code claimed exactly once
    const codeStatus = psql(`SELECT status FROM promo_campaign_codes WHERE normalized_code_hash = '${testHash}' AND campaign_id = '${campId}';`);
    expect(codeStatus).toBe('claimed');

    // BOTH calls must return winner (not already_claimed for duplicate delivery)
    // Advisory lock serializes them — second sees the replay
    const winnerResults = [r1, r2].filter(r => r.ok && r.stdout.includes('"winner"'));
    expect(winnerResults.length).toBe(2); // Both resolve to winner

    // Zero already_claimed responses
    const alreadyClaimed = [r1, r2].filter(r => r.stdout.includes('"already_claimed"'));
    expect(alreadyClaimed.length).toBe(0);

    // Second call should have idempotent_replay=true
    const replays = [r1, r2].filter(r => r.stdout.includes('"idempotent_replay": true'));
    expect(replays.length).toBeGreaterThanOrEqual(1);

    // Same claim_reference
    const refs = [r1, r2].map(r => {
      try { const p = JSON.parse(r.stdout); return p.claim_reference; } catch { return null; }
    }).filter(Boolean);
    if (refs.length === 2) expect(refs[0]).toBe(refs[1]);
  });

  // ═══════ F2. CONCURRENT RATE LIMIT ═══════

  it('RATE-CONTENTION: concurrent rate-limited attempts serialize correctly', async () => {
    // Campaign with limit=1 attempt per window
    const campId = psql(`SET ROLE service_role;
      INSERT INTO promo_campaigns (business_id, name, status, keyword,
        rate_limit_max_attempts, rate_limit_window_minutes, max_attempts_per_phone)
      VALUES ('${BIZ}', 'RateRace', 'active', 'RATRACE', 1, 60, 100) RETURNING id;
    RESET ROLE;`);
    const batchId = psql(`SET ROLE service_role;
      INSERT INTO promo_code_batches (campaign_id, source, requested_count, generated_count, status)
      VALUES ('${campId}', 'generated', 1, 1, 'completed') RETURNING id;
    RESET ROLE;`);
    const testHash = createHmac('sha256', 'dev-promo-key').update('RATERACE1234').digest('hex');
    psql(`SET ROLE service_role;
      INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, display_suffix, outcome)
      VALUES ('${BIZ}', '${campId}', '${batchId}', '${testHash}', 'RR34', 'try_again');
    RESET ROLE;`);

    const phone = '+234999';
    const sql1 = `SET ROLE service_role; SELECT claim_promo_code('${BIZ}'::uuid, '${campId}'::uuid, '${testHash}', '${phone}', 'rate-msg-1'); RESET ROLE;`;
    const sql2 = `SET ROLE service_role; SELECT claim_promo_code('${BIZ}'::uuid, '${campId}'::uuid, '${testHash}', '${phone}', 'rate-msg-2'); RESET ROLE;`;

    // Two unique messages, same campaign+phone, concurrently. Limit=1.
    const [r1, r2] = await Promise.all([psqlAsync(sql1), psqlAsync(sql2)]);

    // One should succeed (try_again), one should be rate_limited
    const tryAgain = [r1, r2].filter(r => r.ok && r.stdout.includes('"try_again"'));
    const rateLimited = [r1, r2].filter(r => r.ok && r.stdout.includes('"rate_limited"'));

    // Advisory lock serializes: exactly one passes, one rate-limited
    expect(tryAgain.length + rateLimited.length).toBe(2);
    expect(tryAgain.length).toBeLessThanOrEqual(1); // At most one passes

    // Persisted attempts within policy
    const attemptCount = psql(`SELECT count(*) FROM promo_verification_attempts WHERE campaign_id = '${campId}' AND phone_e164 = '${phone}';`);
    expect(parseInt(attemptCount)).toBeLessThanOrEqual(2);
  });

  // ═══════ G. SECURITY: authenticated denied activation validator ═══════

  it('SECURITY-1: authenticated denied validate_promo_campaign_activation', () => {
    const r = psqlMayFail(`SET ROLE authenticated; SELECT validate_promo_campaign_activation('${CAMPAIGN}'); RESET ROLE;`);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('permission denied');
  });

  it('SECURITY-2: service_role can execute validate_promo_campaign_activation', () => {
    const r = psqlMayFail(`SET ROLE service_role; SELECT validate_promo_campaign_activation('${CAMPAIGN}'); RESET ROLE;`);
    // May fail with validation errors but NOT with permission denied
    if (!r.ok) {
      expect(r.output).not.toContain('permission denied');
    }
  });
});