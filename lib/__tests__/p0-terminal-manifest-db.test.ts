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
        finalization_completed_at = NOW(),
        payment_authority_version = 1;
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
        ARRAY['loyalty_award', 'owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_internal', 'required_external', 'required_external'],
        ARRAY['internal', 'external', 'external'],
        ARRAY[NULL, 'meta_whatsapp', 'resend']
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
    expect(effectCount).toBe('3');
  });

  it('MAN-02: duplicate initialization is idempotent (same hash)', () => {
    psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_1}',
        ARRAY['loyalty_award', 'owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_internal', 'required_external', 'required_external'],
        ARRAY['internal', 'external', 'external'],
        ARRAY[NULL, 'meta_whatsapp', 'resend']
      );
    `);

    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_1}',
        ARRAY['loyalty_award', 'owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_internal', 'required_external', 'required_external'],
        ARRAY['internal', 'external', 'external'],
        ARRAY[NULL, 'meta_whatsapp', 'resend']
      );
    `);
    expect(result).toContain('"already_initialized": true');
  });

  it('MAN-03: wrong claim token rejected', () => {
    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_1}', '${CLAIM_2}',
        ARRAY['loyalty_award', 'owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_internal', 'required_external', 'required_external'],
        ARRAY['internal', 'external', 'external'],
        ARRAY[NULL, 'meta_whatsapp', 'resend']
      );
    `);
    expect(result).toContain('token_mismatch');
  });

  it('MAN-05: unknown effect key rejected by canonical catalog', () => {
    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_2}', '${CLAIM_1}',
        ARRAY['loyalty_award', 'owner_notif_whatsapp', 'owner_notif_email', 'fake_effect'],
        ARRAY['required_internal', 'required_external', 'required_external', 'optional'],
        ARRAY['internal', 'external', 'external', 'internal'],
        ARRAY[NULL, 'meta_whatsapp', 'resend', NULL]
      );
    `);
    expect(result).toContain('unknown_effect_key');
  });

  it('MAN-06: semantic mismatch rejected (wrong category for known key)', () => {
    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_2}', '${CLAIM_1}',
        ARRAY['loyalty_award', 'owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['optional', 'required_external', 'required_external'],
        ARRAY['internal', 'external', 'external'],
        ARRAY[NULL, 'meta_whatsapp', 'resend']
      );
    `);
    expect(result).toContain('semantic_mismatch');
  });

  it('MAN-07: missing required effect rejected', () => {
    // Only supply loyalty_award + owner_notif_whatsapp, omit required owner_notif_email
    const result = psql(`
      SELECT initialize_terminal_effects(
        '${PAY_2}', '${CLAIM_1}',
        ARRAY['loyalty_award', 'owner_notif_whatsapp'],
        ARRAY['required_internal', 'required_external'],
        ARRAY['internal', 'external'],
        ARRAY[NULL, 'meta_whatsapp']
      );
    `);
    expect(result).toContain('missing_required_effect');
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
    // terminal_reason_conflict: the existing 'not_deliverable' != 'delivery_failure'
    // Step 3 (already-terminated check) runs BEFORE step 6 (reason validation)
    expect(result).toContain('terminal_reason_conflict');
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
        ARRAY['loyalty_award', 'owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_internal', 'required_external', 'required_external'],
        ARRAY['internal', 'external', 'external'],
        ARRAY[NULL, 'meta_whatsapp', 'resend']
      );
    `);
    expect(result).toContain('payment_already_terminated');
  });

  // ─── FINALIZATION WITH MANIFEST ───────────────────────

  it('FIN-01: genuine legacy payment (NULL authority version) without manifest still finalizes', () => {
    // Set payment_authority_version to NULL to simulate a pre-Phase-A historical payment
    psql(`UPDATE payments SET payment_authority_version = NULL WHERE id = '${PAY_2}';`);
    const result = psql(`
      SELECT finalize_payment_confirmation('${PAY_2}', '${CLAIM_1}');
    `);
    expect(result).toContain('"finalized": true');
    expect(result).toContain('"has_manifest": false');
  });

  it('FIN-04: Phase-A payment without manifest is rejected (fail-closed)', () => {
    // PAY_2 has payment_authority_version = 1 (Phase-A), no manifest
    resetPayment(PAY_2, CLAIM_1);
    const result = psql(`
      SELECT finalize_payment_confirmation('${PAY_2}', '${CLAIM_1}');
    `);
    expect(result).toContain('manifest_required_for_phase_a');
  });

  it('FIN-02: manifest with incomplete required_internal blocks finalization', () => {
    psql(`
      SELECT initialize_terminal_effects(
        '${PAY_3}', '${CLAIM_1}',
        ARRAY['loyalty_award', 'owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_internal', 'required_external', 'required_external'],
        ARRAY['internal', 'external', 'external'],
        ARRAY[NULL, 'meta_whatsapp', 'resend']
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
        ARRAY['owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_external', 'required_external'],
        ARRAY['external', 'external'],
        ARRAY['meta_whatsapp', 'resend']
      );
    `);

    // Complete all effects (as superuser, bypassing service_role restriction)
    psql(`
      UPDATE payment_terminal_effects
      SET status = 'completed', completed_at = NOW()
      WHERE payment_id = '${PAY_1}';
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

  // ─── LIFECYCLE AUTHORITY RUNTIME PROOFS ────────────────

  it('LIFE-01: external effect cannot complete before emission fence', () => {
    // Initialize manifest + reserve effect + try to complete WITHOUT emission fence
    resetPayment(PAY_1, CLAIM_1);
    psql(`
      SELECT initialize_terminal_effects('${PAY_1}', '${CLAIM_1}',
        ARRAY['owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_external', 'required_external'],
        ARRAY['external', 'external'],
        ARRAY['meta_whatsapp', 'resend']);
    `);
    const reserveResult = psql(`SELECT reserve_terminal_effect('${PAY_1}', 'owner_notif_whatsapp', '${CLAIM_1}');`);
    expect(reserveResult).toContain('"reserved": true');
    // Extract effect token
    const effectToken = reserveResult.match(/"effect_token": "([^"]+)"/)?.[1] || '';

    // Try to complete WITHOUT emission fence (emission_started_at IS NULL)
    const completeResult = psql(`SELECT complete_external_effect('${PAY_1}', 'owner_notif_whatsapp', '${effectToken}');`);
    expect(completeResult).toContain('emission_not_started');
  });

  it('LIFE-02: provider throw after emission fence → indeterminate, never completed', () => {
    resetPayment(PAY_1, CLAIM_1);
    psql(`
      SELECT initialize_terminal_effects('${PAY_1}', '${CLAIM_1}',
        ARRAY['owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_external', 'required_external'],
        ARRAY['external', 'external'],
        ARRAY['meta_whatsapp', 'resend']);
    `);
    const reserveResult = psql(`SELECT reserve_terminal_effect('${PAY_1}', 'owner_notif_whatsapp', '${CLAIM_1}');`);
    const effectToken = reserveResult.match(/"effect_token": "([^"]+)"/)?.[1] || '';

    // Begin emission fence
    psql(`SELECT begin_terminal_external_emission('${PAY_1}', 'owner_notif_whatsapp', '${CLAIM_1}', '${effectToken}');`);

    // Simulate provider throw → mark indeterminate (not completed)
    const markResult = psql(`SELECT mark_effect_indeterminate('${PAY_1}', 'owner_notif_whatsapp', '${effectToken}');`);
    expect(markResult).toContain('"marked": true');

    // Verify status is indeterminate
    const status = psql(`SELECT status FROM payment_terminal_effects WHERE payment_id = '${PAY_1}' AND effect_key = 'owner_notif_whatsapp';`);
    expect(status).toBe('indeterminate');

    // Cannot change to completed after indeterminate
    const completeAttempt = psql(`SELECT complete_external_effect('${PAY_1}', 'owner_notif_whatsapp', '${effectToken}');`);
    expect(completeAttempt).toContain('not_claimed');
  });

  it('LIFE-03: failed internal mutation → effect not completed', () => {
    resetPayment(PAY_1, CLAIM_1);
    psql(`
      SELECT initialize_terminal_effects('${PAY_1}', '${CLAIM_1}',
        ARRAY['session_deactivation', 'owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_internal', 'required_external', 'required_external'],
        ARRAY['internal', 'external', 'external'],
        ARRAY[NULL, 'meta_whatsapp', 'resend']);
    `);
    const reserveResult = psql(`SELECT reserve_terminal_effect('${PAY_1}', 'session_deactivation', '${CLAIM_1}');`);
    const effectToken = reserveResult.match(/"effect_token": "([^"]+)"/)?.[1] || '';

    // Effect is claimed but NOT completed — simulates mutation failure
    const status = psql(`SELECT status FROM payment_terminal_effects WHERE payment_id = '${PAY_1}' AND effect_key = 'session_deactivation';`);
    expect(status).toBe('claimed');

    // Verify finalization is blocked because required_internal is not completed
    const finalizeResult = psql(`SELECT finalize_payment_confirmation('${PAY_1}', '${CLAIM_1}');`);
    expect(finalizeResult).toContain('incomplete_required_internal');
  });

  it('LIFE-04: retry of terminal external effect does not re-emit', () => {
    resetPayment(PAY_1, CLAIM_1);
    psql(`
      SELECT initialize_terminal_effects('${PAY_1}', '${CLAIM_1}',
        ARRAY['owner_notif_whatsapp', 'owner_notif_email'],
        ARRAY['required_external', 'required_external'],
        ARRAY['external', 'external'],
        ARRAY['meta_whatsapp', 'resend']);
    `);
    // Complete the effect through full lifecycle
    const res = psql(`SELECT reserve_terminal_effect('${PAY_1}', 'owner_notif_whatsapp', '${CLAIM_1}');`);
    const token = res.match(/"effect_token": "([^"]+)"/)?.[1] || '';
    psql(`SELECT begin_terminal_external_emission('${PAY_1}', 'owner_notif_whatsapp', '${CLAIM_1}', '${token}');`);
    psql(`SELECT complete_external_effect('${PAY_1}', 'owner_notif_whatsapp', '${token}');`);

    // Retry: reserve again → should get already_terminal
    const retryReserve = psql(`SELECT reserve_terminal_effect('${PAY_1}', 'owner_notif_whatsapp', '${CLAIM_1}');`);
    expect(retryReserve).toContain('already_terminal');
    expect(retryReserve).toContain('"current_status": "completed"');
  });
});
