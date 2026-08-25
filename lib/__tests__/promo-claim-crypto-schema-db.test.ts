/**
 * Issue #188: PROMO-CLAIM-CRYPTO-SCHEMA — Regression Tests
 *
 * Proves that claim_promo_code works when pgcrypto lives in the extensions
 * schema (Supabase production layout) and NOT in public.
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
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

function testHash(code: string): string {
  return createHmac('sha256', 'dev-promo-key').update(code).digest('hex');
}

const BIZ_ID = '00000000-0000-0000-0338-000000000001';
const CAMPAIGN_ID = '00000000-0000-0000-0338-100000000001';
const PRIZE_ID = '00000000-0000-0000-0338-200000000001';
const BATCH_ID = '00000000-0000-0000-0338-300000000001';
const CODE_WINNER = '00000000-0000-0000-0338-400000000001';
const CODE_TRYAGAIN = '00000000-0000-0000-0338-400000000002';
const CODE_ROLLBACK = '00000000-0000-0000-0338-400000000003';
const USER_ID = '00000000-0000-0000-0338-500000000001';

describe.skipIf(!canRun)('Issue #188: Promo Claim Crypto Schema', () => {
  beforeAll(() => {
    // ── Reproduce Supabase extension layout ──
    // pgcrypto MUST be in the extensions schema, NOT in public.
    // This reproduces the production environment where the defect occurs.
    psql(`
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE EXTENSION IF NOT EXISTS "pgcrypto" SCHEMA extensions;

      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;
      GRANT USAGE ON SCHEMA public TO authenticated;
      GRANT USAGE ON SCHEMA public TO anon;
      GRANT USAGE ON SCHEMA extensions TO service_role;
      GRANT USAGE ON SCHEMA extensions TO authenticated;
      GRANT USAGE ON SCHEMA extensions TO anon;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT '${USER_ID}'::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, email TEXT);
      INSERT INTO auth.users (id) VALUES ('${USER_ID}') ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Test', slug TEXT NOT NULL DEFAULT 'test',
        owner_id UUID DEFAULT '${USER_ID}', capabilities TEXT[] DEFAULT '{}',
        subscription_tier TEXT DEFAULT 'growth', status TEXT DEFAULT 'active',
        address TEXT DEFAULT 'x', city TEXT DEFAULT 'x', neighborhood TEXT DEFAULT 'x',
        phone TEXT DEFAULT '+0', country_code TEXT DEFAULT 'NG'
      );
      -- Required by migration 321 RLS policies
      CREATE TABLE IF NOT EXISTS business_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID REFERENCES businesses(id), user_id UUID
      );
      -- Required by migration 321/336 admin governance functions
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID, action TEXT,
        entity_type TEXT, entity_id UUID, details JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO businesses (id, name, slug, owner_id)
        VALUES ('${BIZ_ID}', 'CryptoTest', 'crypto-test', '${USER_ID}')
      ON CONFLICT DO NOTHING;
    `);

    // Apply migrations in canonical order: 321 → 330 → 331 → 336 → 338 (fix)
    const fs = require('fs');
    psql(fs.readFileSync('supabase/migrations/321_promotions_schema.sql', 'utf-8'));
    psql(fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8'));
    psql(fs.readFileSync('supabase/migrations/331_promo_winner_security.sql', 'utf-8'));
    psql(fs.readFileSync('supabase/migrations/336_fix_promo_audit_entity_id_cast.sql', 'utf-8'));
    psql(fs.readFileSync('supabase/migrations/338_fix_claim_promo_code_crypto_schema.sql', 'utf-8'));

    // Seed test data
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, keyword, code_entry_mode, accept_bare_codes,
        rate_limit_max_attempts, rate_limit_window_minutes, max_attempts_per_phone)
      VALUES ('${CAMPAIGN_ID}', '${BIZ_ID}', 'CryptoTest', 'active', 'CRYPTO', 'keyword', false, 10, 60, 50);

      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity)
        VALUES ('${PRIZE_ID}', '${CAMPAIGN_ID}', 'CryptoPrize', 'cash', 100);

      INSERT INTO promo_code_batches (id, campaign_id, source, requested_count, generated_count, status)
        VALUES ('${BATCH_ID}', '${CAMPAIGN_ID}', 'generated', 100, 100, 'completed');

      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, display_suffix, outcome, prize_id, status) VALUES
        ('${CODE_WINNER}', '${BIZ_ID}', '${CAMPAIGN_ID}', '${BATCH_ID}', '${testHash('CRYPTOWIN123')}', 'N123', 'winner', '${PRIZE_ID}', 'unused'),
        ('${CODE_TRYAGAIN}', '${BIZ_ID}', '${CAMPAIGN_ID}', '${BATCH_ID}', '${testHash('CRYPTOTRY456')}', 'Y456', 'try_again', NULL, 'unused'),
        ('${CODE_ROLLBACK}', '${BIZ_ID}', '${CAMPAIGN_ID}', '${BATCH_ID}', '${testHash('CRYPTORB9012')}', 'B012', 'winner', '${PRIZE_ID}', 'unused');

      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
    `);
  });

  afterAll(() => {
    if (!canRun) return;
    psql(`
      DROP TABLE IF EXISTS promo_pickup_verifications CASCADE;
      DROP TABLE IF EXISTS promo_eligibility_acks CASCADE;
      DROP TABLE IF EXISTS promo_verification_attempts CASCADE;
      DROP TABLE IF EXISTS promo_redemptions CASCADE;
      DROP TABLE IF EXISTS promo_campaign_codes CASCADE;
      DROP TABLE IF EXISTS promo_code_batches CASCADE;
      DROP TABLE IF EXISTS promo_prizes CASCADE;
      DROP TABLE IF EXISTS promo_campaigns CASCADE;
      DROP TYPE IF EXISTS promo_campaign_status, promo_code_entry_mode, promo_prize_type,
        promo_batch_status, promo_batch_source, promo_code_status, promo_code_outcome,
        promo_fulfillment_status, promo_attempt_result, promo_verification_mode,
        promo_verification_status CASCADE;
      DROP FUNCTION IF EXISTS claim_promo_code, validate_promo_campaign_activation,
        admin_promo_governance, activate_promo_campaign, commit_promo_code_chunk,
        commit_promo_import_chunk, get_promo_campaign_aggregates, reset_promo_failed_batch,
        create_promo_batch_atomic, update_promo_campaign_updated_at, validate_promo_campaign_status_transition,
        transition_promo_fulfillment, issue_promo_pickup_token, verify_promo_pickup CASCADE;
      DROP TABLE IF EXISTS admin_audit_logs CASCADE;
      DROP TABLE IF EXISTS business_members CASCADE;
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
    `);
  });

  // ══════════ GUARD: extension layout must match Supabase production ══════════
  it('GUARD: pgcrypto extension is in extensions schema (pg_extension proof)', () => {
    const nspname = psql(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto';`);
    expect(nspname).toBe('extensions');
  });

  it('GUARD: public.gen_random_bytes does NOT exist (to_regprocedure proof)', () => {
    const result = psql(`SELECT to_regprocedure('public.gen_random_bytes(integer)') IS NULL;`);
    expect(result).toBe('t');
  });

  it('GUARD: extensions.gen_random_bytes DOES exist (to_regprocedure proof)', () => {
    const result = psql(`SELECT to_regprocedure('extensions.gen_random_bytes(integer)') IS NOT NULL;`);
    expect(result).toBe('t');
  });

  it('GUARD: claim_promo_code has SET search_path = public', () => {
    const config = psql(`
      SELECT proconfig FROM pg_proc WHERE proname = 'claim_promo_code';
    `);
    expect(config).toContain('search_path=public');
  });

  // ══════════ A. Valid unused winner code ══════════
  it('A. winner claim succeeds with extensions.gen_random_bytes', () => {
    const r = psqlJson(`
      SET ROLE service_role;
      SELECT claim_promo_code('${BIZ_ID}','${CAMPAIGN_ID}','${testHash('CRYPTOWIN123')}','+2348001','msg-cw1');
      RESET ROLE;
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe('winner');
    expect(r.claim_reference).toBeDefined();
    expect(r.prize_name).toBe('CryptoPrize');
    expect(r.redemption_id).toBeDefined();
    expect(r.verification_mode).toBe('standard');
    expect(r.verification_status).toBe('phone_verified');
  });

  it('A.2 code status transitions to claimed', () => {
    const status = psql(`SELECT status FROM promo_campaign_codes WHERE id = '${CODE_WINNER}';`);
    expect(status).toBe('claimed');
  });

  it('A.3 redemption row committed with claim reference', () => {
    const r = psqlJson(`
      SELECT row_to_json(r) FROM promo_redemptions r WHERE promo_code_id = '${CODE_WINNER}';
    `);
    expect(r.outcome).toBe('winner');
    expect(r.claim_reference).toBeDefined();
    expect((r.claim_reference as string).startsWith('WAA-')).toBe(true);
    expect(r.fulfillment_status).toBe('pending');
    expect(r.verification_mode).toBe('standard');
    expect(r.verification_status).toBe('phone_verified');
  });

  // ══════════ B. Valid unused try_again code ══════════
  it('B. try_again claim succeeds', () => {
    const r = psqlJson(`
      SET ROLE service_role;
      SELECT claim_promo_code('${BIZ_ID}','${CAMPAIGN_ID}','${testHash('CRYPTOTRY456')}','+2348002','msg-ct1');
      RESET ROLE;
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe('try_again');
    expect(r.claim_reference).toBeDefined();
    expect(r.redemption_id).toBeDefined();
  });

  it('B.2 try_again code transitions to claimed', () => {
    const status = psql(`SELECT status FROM promo_campaign_codes WHERE id = '${CODE_TRYAGAIN}';`);
    expect(status).toBe('claimed');
  });

  it('B.3 try_again redemption commits with fulfilled status', () => {
    const r = psqlJson(`
      SELECT row_to_json(r) FROM promo_redemptions r WHERE promo_code_id = '${CODE_TRYAGAIN}';
    `);
    expect(r.outcome).toBe('try_again');
    expect(r.fulfillment_status).toBe('fulfilled');
    expect(r.verification_status).toBe('not_required');
  });

  // ══════════ C. Claim reference format ══════════
  it('C. claim reference matches WAA-XXXX-XXXX-XXXX-XXXX format', () => {
    const ref = psql(`SELECT claim_reference FROM promo_redemptions WHERE promo_code_id = '${CODE_WINNER}';`);
    expect(ref).toMatch(/^WAA-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('C.2 claim reference persisted on redemption row', () => {
    const count = parseInt(psql(`
      SELECT count(*) FROM promo_redemptions
      WHERE promo_code_id = '${CODE_WINNER}' AND claim_reference IS NOT NULL AND length(claim_reference) > 0;
    `));
    expect(count).toBe(1);
  });

  // ══════════ D. Invalid code ══════════
  it('D. invalid code returns invalid result', () => {
    const r = psqlJson(`
      SET ROLE service_role;
      SELECT claim_promo_code('${BIZ_ID}','${CAMPAIGN_ID}','${testHash('NONEXISTENT')}','+2348003','msg-cn1');
      RESET ROLE;
    `);
    expect(r.success).toBe(false);
    expect(r.result).toBe('invalid');
  });

  it('D.2 invalid code creates no redemption', () => {
    const count = parseInt(psql(`
      SELECT count(*) FROM promo_redemptions WHERE inbound_message_id = 'msg-cn1';
    `));
    expect(count).toBe(0);
  });

  // ══════════ E. Replay / already_claimed ══════════
  it('E. winner replay returns idempotent result', () => {
    const r = psqlJson(`
      SET ROLE service_role;
      SELECT claim_promo_code('${BIZ_ID}','${CAMPAIGN_ID}','${testHash('CRYPTOWIN123')}','+2348001','msg-cw1');
      RESET ROLE;
    `);
    expect(r.result).toBe('winner');
    expect(r.idempotent_replay).toBe(true);
  });

  it('E.2 no duplicate redemption created', () => {
    const count = parseInt(psql(`
      SELECT count(*) FROM promo_redemptions WHERE promo_code_id = '${CODE_WINNER}';
    `));
    expect(count).toBe(1);
  });

  it('E.3 second claimant gets already_claimed', () => {
    const r = psqlJson(`
      SET ROLE service_role;
      SELECT claim_promo_code('${BIZ_ID}','${CAMPAIGN_ID}','${testHash('CRYPTOWIN123')}','+2348099','msg-ac1');
      RESET ROLE;
    `);
    expect(r.result).toBe('already_claimed');
  });

  // ══════════ F. Real transaction rollback after downstream failure ══════════
  // Strategy: install a temporary CHECK constraint on promo_redemptions that
  // rejects the specific CODE_ROLLBACK promo_code_id. This forces the INSERT
  // to fail AFTER claim_promo_code has already executed:
  //   UPDATE promo_campaign_codes SET status = 'claimed'
  // Because the entire function runs in a single transaction, the code status
  // update is rolled back when the INSERT fails.

  it('F.1 install test fault: block redemption INSERT for rollback code', () => {
    // Verify CODE_ROLLBACK is unused before the test
    const statusBefore = psql(`SELECT status FROM promo_campaign_codes WHERE id = '${CODE_ROLLBACK}';`);
    expect(statusBefore).toBe('unused');

    // Install a CHECK constraint that rejects this specific promo_code_id
    psql(`
      ALTER TABLE promo_redemptions
        ADD CONSTRAINT test_fault_block_rollback_code
        CHECK (promo_code_id != '${CODE_ROLLBACK}'::UUID);
    `);
  });

  it('F.2 claim with fault installed fails (downstream INSERT rejected)', () => {
    const r = psqlMayFail(`
      SET ROLE service_role;
      SELECT claim_promo_code('${BIZ_ID}','${CAMPAIGN_ID}','${testHash('CRYPTORB9012')}','+2348004','msg-rb1');
      RESET ROLE;
    `);
    // The RPC should fail because the redemption INSERT violates the test constraint
    expect(r.ok).toBe(false);
    expect(r.output).toContain('test_fault_block_rollback_code');
  });

  it('F.3 code remains unused after rollback (status not partially committed)', () => {
    const status = psql(`SELECT status FROM promo_campaign_codes WHERE id = '${CODE_ROLLBACK}';`);
    expect(status).toBe('unused');
  });

  it('F.4 claimed_at remains null after rollback', () => {
    const claimedAt = psql(`SELECT claimed_at IS NULL FROM promo_campaign_codes WHERE id = '${CODE_ROLLBACK}';`);
    expect(claimedAt).toBe('t');
  });

  it('F.5 claimed_by_phone remains null after rollback', () => {
    const claimedBy = psql(`SELECT claimed_by_phone IS NULL FROM promo_campaign_codes WHERE id = '${CODE_ROLLBACK}';`);
    expect(claimedBy).toBe('t');
  });

  it('F.6 no redemption row exists after rollback', () => {
    const count = parseInt(psql(`SELECT count(*) FROM promo_redemptions WHERE promo_code_id = '${CODE_ROLLBACK}';`));
    expect(count).toBe(0);
  });

  it('F.7 no verification attempt logged after rollback', () => {
    const count = parseInt(psql(`SELECT count(*) FROM promo_verification_attempts WHERE inbound_message_id = 'msg-rb1';`));
    expect(count).toBe(0);
  });

  it('F.8 remove test fault and claim succeeds normally', () => {
    // Remove the test fault constraint
    psql(`ALTER TABLE promo_redemptions DROP CONSTRAINT test_fault_block_rollback_code;`);

    // Now claim the same code — should succeed with the real migration-338 function
    const r = psqlJson(`
      SET ROLE service_role;
      SELECT claim_promo_code('${BIZ_ID}','${CAMPAIGN_ID}','${testHash('CRYPTORB9012')}','+2348004','msg-rb2');
      RESET ROLE;
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe('winner');

    // Code is now claimed
    const status = psql(`SELECT status FROM promo_campaign_codes WHERE id = '${CODE_ROLLBACK}';`);
    expect(status).toBe('claimed');

    // Redemption committed
    const count = parseInt(psql(`SELECT count(*) FROM promo_redemptions WHERE promo_code_id = '${CODE_ROLLBACK}';`));
    expect(count).toBe(1);
  });
});
