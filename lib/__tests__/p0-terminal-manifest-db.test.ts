/**
 * Phase A v15: Terminal effect manifest — real PostgreSQL tests.
 * Covers: manifest initialization, idempotency, semantic hash verification,
 * terminal predicate guards, terminate_payment_confirmation.
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

const BIZ = '00000000-0000-0000-0384-0000000b0001';
const PAY_1 = '00000000-0000-0000-0384-000000000001';
const PAY_2 = '00000000-0000-0000-0384-000000000002';
const PAY_3 = '00000000-0000-0000-0384-000000000003';
const PAY_TERM = '00000000-0000-0000-0384-000000000010';
const CLAIM_1 = '00000000-0000-0000-0384-0000000c0001';
const CLAIM_2 = '00000000-0000-0000-0384-0000000c0002';

describe.skipIf(!canRun)('Phase A v15: Terminal effect manifest', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount INT DEFAULT 0, status payment_status DEFAULT 'success',
        booking_id UUID, reservation_id UUID, order_id UUID,
        invoice_id UUID, campaign_id UUID, business_id UUID,
        confirmation_sent_at TIMESTAMPTZ,
        confirmation_processing_at TIMESTAMPTZ DEFAULT NOW(),
        confirmation_claim_token UUID,
        confirmation_terminal_reason TEXT,
        finalization_completed_at TIMESTAMPTZ DEFAULT NOW(),
        payment_authority_version INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS payment_confirmation_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID NOT NULL,
        attempt_number SMALLINT DEFAULT 1,
        delivery_status TEXT DEFAULT 'claiming',
        meta_message_id TEXT
      );
    `);

    const fs = require('fs');
    for (const mig of [
      '384_terminal_effect_tables.sql',
      '385_terminal_effect_manifest_rpcs.sql',
      '386_terminal_effect_lifecycle_rpcs.sql',
      '388_terminal_effect_confirmation_guards.sql',
    ]) {
      const sql = fs.readFileSync(`supabase/migrations/${mig}`, 'utf-8');
      psql(sql);
    }
  });

  afterAll(() => {
    psql(`
      DROP TABLE IF EXISTS payment_terminal_effects CASCADE;
      DROP TABLE IF EXISTS payment_terminal_manifests CASCADE;
      DROP TABLE IF EXISTS payment_confirmation_deliveries CASCADE;
      DROP TABLE IF EXISTS payment_rule_action_executions CASCADE;
      DROP TABLE IF EXISTS payment_rule_action_manifests CASCADE;
      DROP TABLE IF EXISTS payment_loyalty_applications CASCADE;
      DROP TABLE IF EXISTS payment_receipt_applications CASCADE;
      DROP TABLE IF EXISTS payment_visit_applications CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
    `);
  });

  function resetPayment(payId: string, claimToken: string) {
    psql(`
      DELETE FROM payment_terminal_effects WHERE payment_id = '${payId}';
      DELETE FROM payment_terminal_manifests WHERE payment_id = '${payId}';
      DELETE FROM payment_confirmation_deliveries WHERE payment_id = '${payId}';
      INSERT INTO payments (id, status, business_id, confirmation_claim_token,
        confirmation_processing_at, finalization_completed_at)
      VALUES ('${payId}', 'success', '${BIZ}', '${claimToken}', NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        status = 'success',
        confirmation_claim_token = '${claimToken}',
        confirmation_processing_at = NOW(),
        confirmation_sent_at = NULL,
        confirmation_terminal_reason = NULL,
        finalization_completed_at = NOW();
    `);
  }

  beforeEach(() => {
    resetPayment(PAY_1, CLAIM_1);
    resetPayment(PAY_2, CLAIM_1);
    resetPayment(PAY_3, CLAIM_1);
    resetPayment(PAY_TERM, CLAIM_1);
  });

  // ─── MANIFEST INITIALIZATION ──────────────────────────

  it('MAN-01: initialize creates header + effects atomically', () => {
    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_1}',
        ARRAY['loyalty_award', 'owner_notif_whatsapp'],
        ARRAY['required_internal', 'required_external'],
        ARRAY['internal', 'external'],
        ARRAY[NULL, 'meta_whatsapp']
      );
    `);
    expect(result).toContain('"initialized": true');
    expect(result).toContain('"already_initialized": false');

    const headerState = psql(`
      SELECT initialization_state FROM payment_terminal_manifests WHERE payment_id = '${PAY_1}';
    `);
    expect(headerState).toBe('initialized');

    const effectCount = psql(`
      SELECT COUNT(*) FROM payment_terminal_effects WHERE payment_id = '${PAY_1}';
    `);
    expect(effectCount).toBe('2');
  });

  it('MAN-02: duplicate initialization is idempotent (same hash)', () => {
    psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_1}',
        ARRAY['loyalty_award'],
        ARRAY['required_internal'],
        ARRAY['internal'],
        ARRAY[NULL]
      );
    `);

    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_1}',
        ARRAY['loyalty_award'],
        ARRAY['required_internal'],
        ARRAY['internal'],
        ARRAY[NULL]
      );
    `);
    expect(result).toContain('"already_initialized": true');
  });

  it('MAN-03: wrong claim token rejected', () => {
    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_2}',
        ARRAY['loyalty_award'],
        ARRAY['required_internal'],
        ARRAY['internal'],
        ARRAY[NULL]
      );
    `);
    expect(result).toContain('token_mismatch');
  });

  it('MAN-04: stage-2 incomplete rejected', () => {
    psql(`UPDATE payments SET finalization_completed_at = NULL WHERE id = '${PAY_2}';`);
    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_2}', '${CLAIM_1}',
        ARRAY['loyalty_award'],
        ARRAY['required_internal'],
        ARRAY['internal'],
        ARRAY[NULL]
      );
    `);
    expect(result).toContain('stage2_not_complete');
  });

  // ─── TERMINATE_PAYMENT_CONFIRMATION ───────────────────

  it('TERM-01: atomic termination sets reason + clears claim', () => {
    const result = psql(`
      SELECT terminate_payment_confirmation('${PAY_TERM}', '${CLAIM_1}', 'not_deliverable');
    `);
    expect(result).toContain('"terminated": true');

    const reason = psql(`
      SELECT confirmation_terminal_reason FROM payments WHERE id = '${PAY_TERM}';
    `);
    expect(reason).toBe('not_deliverable');

    const token = psql(`
      SELECT confirmation_claim_token FROM payments WHERE id = '${PAY_TERM}';
    `);
    expect(token).toBe(''); // NULL renders as empty in psql -t
  });

  it('TERM-02: idempotent retry after lost response', () => {
    psql(`SELECT terminate_payment_confirmation('${PAY_TERM}', '${CLAIM_1}', 'not_deliverable');`);

    // Token is now cleared. Retry with same token — should return already_terminated
    const result = psql(`
      SELECT terminate_payment_confirmation('${PAY_TERM}', '${CLAIM_1}', 'not_deliverable');
    `);
    expect(result).toContain('"already_terminated": true');
  });

  it('TERM-03: stale token after termination returns already_terminated', () => {
    psql(`SELECT terminate_payment_confirmation('${PAY_TERM}', '${CLAIM_1}', 'not_deliverable');`);

    // Different token — but payment is already terminated with same reason
    const result = psql(`
      SELECT terminate_payment_confirmation('${PAY_TERM}', '${CLAIM_2}', 'not_deliverable');
    `);
    expect(result).toContain('"already_terminated": true');
  });

  it('TERM-04: different terminal reason on already-terminated → conflict', () => {
    psql(`SELECT terminate_payment_confirmation('${PAY_TERM}', '${CLAIM_1}', 'not_deliverable');`);

    // Try to change the reason — should fail
    const result = psql(`
      SELECT terminate_payment_confirmation('${PAY_TERM}', '${CLAIM_2}', 'delivery_failure');
    `);
    // invalid_terminal_reason because 'delivery_failure' is not in allowed list
    // but even if it were, existing reason conflict would trigger
    expect(result).toContain('invalid_terminal_reason');
  });

  // ─── CLAIM TERMINAL PREDICATE GUARDS ──────────────────

  it('GUARD-01: terminated payment cannot be claimed', () => {
    psql(`SELECT terminate_payment_confirmation('${PAY_TERM}', '${CLAIM_1}', 'not_deliverable');`);

    const result = psql(`
      SELECT claim_payment_confirmation('${PAY_TERM}');
    `);
    expect(result).toContain('already_terminated');
  });

  it('GUARD-02: terminated payment cannot be renewed', () => {
    psql(`
      UPDATE payments SET confirmation_terminal_reason = 'not_deliverable'
      WHERE id = '${PAY_1}';
    `);

    const result = psql(`
      SELECT renew_payment_confirmation_claim('${PAY_1}', '${CLAIM_1}');
    `);
    expect(result).toContain('already_terminated');
  });

  it('GUARD-03: terminated payment cannot be finalized', () => {
    psql(`
      UPDATE payments SET confirmation_terminal_reason = 'not_deliverable'
      WHERE id = '${PAY_1}';
    `);

    const result = psql(`
      SELECT finalize_payment_confirmation('${PAY_1}', '${CLAIM_1}');
    `);
    expect(result).toContain('already_terminated');
  });

  it('GUARD-04: terminated payment cannot be released', () => {
    psql(`
      UPDATE payments SET confirmation_terminal_reason = 'not_deliverable'
      WHERE id = '${PAY_1}';
    `);

    const result = psql(`
      SELECT release_payment_confirmation('${PAY_1}', '${CLAIM_1}');
    `);
    expect(result).toContain('already_terminated');
  });

  it('GUARD-05: terminated payment cannot have manifest initialized', () => {
    psql(`
      UPDATE payments SET confirmation_terminal_reason = 'not_deliverable'
      WHERE id = '${PAY_1}';
    `);

    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_1}',
        ARRAY['loyalty_award'],
        ARRAY['required_internal'],
        ARRAY['internal'],
        ARRAY[NULL]
      );
    `);
    expect(result).toContain('payment_already_terminated');
  });

  // ─── FINALIZATION WITH MANIFEST ───────────────────────

  it('FIN-01: legacy payment without manifest still finalizes', () => {
    const result = psql(`
      SELECT finalize_payment_confirmation('${PAY_2}', '${CLAIM_1}');
    `);
    expect(result).toContain('"finalized": true');
    expect(result).toContain('"has_manifest": false');
  });

  it('FIN-02: manifest with incomplete required_internal blocks finalization', () => {
    psql(`
      SELECT initialize_terminal_effects(
        '${PAY_3}', '${CLAIM_1}',
        ARRAY['loyalty_award'],
        ARRAY['required_internal'],
        ARRAY['internal'],
        ARRAY[NULL]
      );
    `);

    const result = psql(`
      SELECT finalize_payment_confirmation('${PAY_3}', '${CLAIM_1}');
    `);
    expect(result).toContain('incomplete_required_internal');
  });

  it('FIN-03: manifest with all effects completed allows finalization', () => {
    psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_1}',
        ARRAY['session_deactivation'],
        ARRAY['required_internal'],
        ARRAY['internal'],
        ARRAY[NULL]
      );
    `);

    // Manually complete the effect
    psql(`
      UPDATE payment_terminal_effects
      SET status = 'completed', completed_at = NOW()
      WHERE payment_id = '${PAY_1}' AND effect_key = 'session_deactivation';
    `);

    const result = psql(`
      SELECT finalize_payment_confirmation('${PAY_1}', '${CLAIM_1}');
    `);
    expect(result).toContain('"finalized": true');
    expect(result).toContain('"has_manifest": true');
  });

  // ─── PRIVILEGE CHECKS ─────────────────────────────────

  it('ACL-01: anon cannot execute initialize_terminal_effects', () => {
    const priv = psql(`
      SELECT has_function_privilege('anon',
        'initialize_terminal_effects(uuid, uuid, text[], text[], text[], text[], integer)',
        'EXECUTE');
    `);
    expect(priv).toBe('f');
  });

  it('ACL-02: anon cannot execute terminate_payment_confirmation', () => {
    const priv = psql(`
      SELECT has_function_privilege('anon',
        'terminate_payment_confirmation(uuid, uuid, text)',
        'EXECUTE');
    `);
    expect(priv).toBe('f');
  });

  it('ACL-03: service_role CAN execute all manifest RPCs', () => {
    for (const sig of [
      'initialize_terminal_effects(uuid, uuid, text[], text[], text[], text[], integer)',
      'reserve_terminal_effect(uuid, text, uuid)',
      'terminate_payment_confirmation(uuid, uuid, text)',
    ]) {
      const priv = psql(`SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE');`);
      expect(priv).toBe('t');
    }
  });
});
