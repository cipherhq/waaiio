-- Migration 385: Terminal effect manifest + seal RPCs
--
-- Phase A v15: initialize_terminal_effects, reserve_terminal_effect,
-- terminate_payment_confirmation, seal_payment_rule_actions.
--
-- All RPCs: SECURITY DEFINER SET search_path = public, service_role only.

-- ═══════════════════════════════════════════════════════
-- 1. initialize_terminal_effects
--
-- Atomically creates a manifest header + all applicable effect rows
-- in one transaction. Crash before commit = zero rows.
-- Idempotent: existing initialized manifest returns already_initialized
-- after verifying hash match.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION initialize_terminal_effects(
  p_payment_id UUID,
  p_claim_token UUID,
  p_effect_keys TEXT[],
  p_categories TEXT[],
  p_execution_classes TEXT[],
  p_provider_channels TEXT[],
  p_manifest_version INTEGER DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_existing RECORD;
  v_effect_count INTEGER;
  v_semantic_hash TEXT;
  v_tuples TEXT[];
  v_i INTEGER;
  v_inserted INTEGER := 0;
  v_contract_version INTEGER := 1;
  -- Closed Stage-3 canonical catalog (DB authority)
  v_allowed_keys TEXT[] := ARRAY[
    'loyalty_award', 'ticket_inventory_finalization', 'ticket_row_creation',
    'session_deactivation', 'owner_notif_inapp',
    'customer_whatsapp', 'owner_notif_whatsapp', 'owner_notif_email',
    'donation_receipt_email',
    'customer_loyalty_whatsapp', 'receipt_pdf_generation', 'receipt_pdf_delivery',
    'customer_booking_email', 'ticket_delivery_whatsapp', 'ticket_delivery_email',
    'referral_generation', 'crm_visit_increment', 'automation_rule_handoff',
    'automation_sequences', 'membership_tier_assignment', 'feedback_marker'
  ];
BEGIN
  -- Array lengths must match
  IF array_length(p_effect_keys, 1) IS DISTINCT FROM array_length(p_categories, 1)
     OR array_length(p_effect_keys, 1) IS DISTINCT FROM array_length(p_execution_classes, 1)
     OR array_length(p_effect_keys, 1) IS DISTINCT FROM array_length(p_provider_channels, 1) THEN
    RETURN jsonb_build_object('error', 'array_length_mismatch');
  END IF;

  v_effect_count := COALESCE(array_length(p_effect_keys, 1), 0);

  -- ── CANONICAL CATALOG VALIDATION ──
  -- The DB is the authority for the closed Stage-3 catalog.
  -- Every caller-supplied effect must exist in the catalog with matching semantics.
  -- A caller cannot omit a required effect or fabricate an unknown key.
  FOR v_i IN 1..v_effect_count LOOP
    IF NOT (p_effect_keys[v_i] = ANY(v_allowed_keys)) THEN
      RETURN jsonb_build_object('error', 'unknown_effect_key',
        'key', p_effect_keys[v_i]);
    END IF;

    -- Validate category + execution_class match canonical mapping
    -- Required internal effects
    IF p_effect_keys[v_i] IN ('loyalty_award', 'ticket_inventory_finalization',
      'ticket_row_creation', 'session_deactivation', 'owner_notif_inapp') THEN
      IF p_categories[v_i] != 'required_internal' OR p_execution_classes[v_i] != 'internal' THEN
        RETURN jsonb_build_object('error', 'semantic_mismatch',
          'key', p_effect_keys[v_i], 'expected_category', 'required_internal');
      END IF;
    -- Required external effects
    ELSIF p_effect_keys[v_i] IN ('customer_whatsapp', 'owner_notif_whatsapp',
      'owner_notif_email', 'donation_receipt_email') THEN
      IF p_categories[v_i] != 'required_external' OR p_execution_classes[v_i] != 'external' THEN
        RETURN jsonb_build_object('error', 'semantic_mismatch',
          'key', p_effect_keys[v_i], 'expected_category', 'required_external');
      END IF;
    -- Optional effects: verify category = optional
    ELSE
      IF p_categories[v_i] != 'optional' THEN
        RETURN jsonb_build_object('error', 'semantic_mismatch',
          'key', p_effect_keys[v_i], 'expected_category', 'optional');
      END IF;
    END IF;
  END LOOP;

  -- 1. Lock payment row (with entity FKs for required-effect derivation)
  SELECT id, confirmation_claim_token, confirmation_processing_at,
         confirmation_sent_at, confirmation_terminal_reason,
         finalization_completed_at,
         booking_id, reservation_id, order_id, invoice_id, campaign_id
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'payment_not_found');
  END IF;

  -- 2. Verify master claim token
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('error', 'token_mismatch');
  END IF;

  -- 3. Not already finalized or terminated
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_finalized');
  END IF;
  IF v_payment.confirmation_terminal_reason IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_already_terminated');
  END IF;

  -- 4. Stage-2 must be complete
  IF v_payment.finalization_completed_at IS NULL THEN
    RETURN jsonb_build_object('error', 'stage2_not_complete');
  END IF;

  -- 4b. Required-effect completeness validation.
  -- The DB derives which required effects MUST be present for this payment's entity type.
  -- Omission of an applicable required effect fails the manifest.

  -- All payments require owner_notif_whatsapp and owner_notif_email (required_external)
  IF NOT ('owner_notif_whatsapp' = ANY(p_effect_keys)) THEN
    RETURN jsonb_build_object('error', 'missing_required_effect', 'key', 'owner_notif_whatsapp');
  END IF;
  IF NOT ('owner_notif_email' = ANY(p_effect_keys)) THEN
    RETURN jsonb_build_object('error', 'missing_required_effect', 'key', 'owner_notif_email');
  END IF;

  -- session_deactivation: required for invoice/campaign (non-exact-entity-family)
  IF v_payment.invoice_id IS NOT NULL OR v_payment.campaign_id IS NOT NULL THEN
    IF NOT ('session_deactivation' = ANY(p_effect_keys)) THEN
      RETURN jsonb_build_object('error', 'missing_required_effect', 'key', 'session_deactivation');
    END IF;
  END IF;

  -- owner_notif_inapp: required for booking, reservation, or campaign
  IF v_payment.booking_id IS NOT NULL OR v_payment.reservation_id IS NOT NULL
     OR v_payment.campaign_id IS NOT NULL THEN
    IF NOT ('owner_notif_inapp' = ANY(p_effect_keys)) THEN
      RETURN jsonb_build_object('error', 'missing_required_effect', 'key', 'owner_notif_inapp');
    END IF;
  END IF;

  -- 5. Compute semantic hash from the input arrays
  v_tuples := ARRAY[]::TEXT[];
  FOR v_i IN 1..v_effect_count LOOP
    v_tuples := array_append(v_tuples,
      p_effect_keys[v_i] || '|' || p_categories[v_i] || '|' ||
      p_execution_classes[v_i] || '|' ||
      COALESCE(p_provider_channels[v_i], 'none') || '|' ||
      v_contract_version::TEXT
    );
  END LOOP;
  -- Sort for determinism
  SELECT array_agg(t ORDER BY t) INTO v_tuples FROM unnest(v_tuples) AS t;
  v_semantic_hash := encode(digest(array_to_string(COALESCE(v_tuples, ARRAY[]::TEXT[]), ','), 'sha256'), 'hex');

  -- 6. Check for existing manifest header
  SELECT * INTO v_existing FROM payment_terminal_manifests
  WHERE payment_id = p_payment_id FOR UPDATE;

  IF FOUND THEN
    IF v_existing.initialization_state = 'initialized' THEN
      -- Verify exact match for idempotent replay
      IF v_existing.expected_semantic_hash = v_semantic_hash
         AND v_existing.expected_effect_count = v_effect_count
         AND v_existing.manifest_version = p_manifest_version THEN
        RETURN jsonb_build_object('initialized', true, 'already_initialized', true,
          'effect_count', v_effect_count, 'semantic_hash', v_semantic_hash);
      ELSE
        RETURN jsonb_build_object('error', 'manifest_mismatch',
          'expected_hash', v_existing.expected_semantic_hash,
          'computed_hash', v_semantic_hash);
      END IF;
    ELSE
      -- Prior crash left initializing state. Clean up and re-initialize.
      DELETE FROM payment_terminal_effects WHERE payment_id = p_payment_id;
      DELETE FROM payment_terminal_manifests WHERE payment_id = p_payment_id;
    END IF;
  END IF;

  -- 7. Insert manifest header with initializing state
  INSERT INTO payment_terminal_manifests
    (payment_id, manifest_version, initialization_state, expected_effect_count,
     expected_semantic_hash, contract_version)
  VALUES
    (p_payment_id, p_manifest_version, 'initializing', v_effect_count,
     v_semantic_hash, v_contract_version);

  -- 8. Insert all effect rows
  FOR v_i IN 1..v_effect_count LOOP
    INSERT INTO payment_terminal_effects
      (payment_id, effect_key, category, execution_class, provider_channel, contract_version)
    VALUES
      (p_payment_id, p_effect_keys[v_i], p_categories[v_i],
       p_execution_classes[v_i], p_provider_channels[v_i], v_contract_version);
    v_inserted := v_inserted + 1;
  END LOOP;

  -- 9. Verify count
  IF v_inserted != v_effect_count THEN
    RAISE EXCEPTION 'Effect count mismatch: expected %, inserted %', v_effect_count, v_inserted;
  END IF;

  -- 10. Mark initialized
  UPDATE payment_terminal_manifests
  SET initialization_state = 'initialized', initialized_at = NOW()
  WHERE payment_id = p_payment_id;

  RETURN jsonb_build_object('initialized', true, 'already_initialized', false,
    'effect_count', v_effect_count, 'semantic_hash', v_semantic_hash);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 2. reserve_terminal_effect
--
-- Transitions an effect from pending to claimed with a new effect token.
-- Validates master claim ownership. Supports stale lease reclaim.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION reserve_terminal_effect(
  p_payment_id UUID,
  p_effect_key TEXT,
  p_master_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_effect RECORD;
  v_new_effect_token UUID;
BEGIN
  -- 1. Lock payment, verify master claim
  SELECT confirmation_claim_token, confirmation_processing_at, confirmation_sent_at
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'payment_not_found');
  END IF;
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'already_finalized');
  END IF;
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_master_claim_token THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'token_mismatch');
  END IF;
  IF v_payment.confirmation_processing_at <= NOW() - INTERVAL '5 minutes' THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'master_claim_expired');
  END IF;

  -- 2. Lock effect row
  SELECT id, status, claim_token, claim_expires_at, emission_started_at,
         category, reserved_under_master_token
  INTO v_effect FROM payment_terminal_effects
  WHERE payment_id = p_payment_id AND effect_key = p_effect_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'effect_not_in_manifest');
  END IF;

  -- 3. Transition logic
  CASE v_effect.status
    WHEN 'pending' THEN
      -- Fresh reservation
      v_new_effect_token := gen_random_uuid();
      UPDATE payment_terminal_effects SET
        status = 'claimed',
        claim_token = v_new_effect_token,
        reserved_under_master_token = p_master_claim_token,
        claim_expires_at = NOW() + INTERVAL '2 minutes',
        updated_at = NOW()
      WHERE id = v_effect.id;
      RETURN jsonb_build_object('reserved', true,
        'effect_token', v_new_effect_token,
        'claim_expires_at', (NOW() + INTERVAL '2 minutes')::TEXT);

    WHEN 'claimed' THEN
      IF v_effect.claim_expires_at > NOW() THEN
        -- Active lease: check same master claimant
        IF v_effect.reserved_under_master_token = p_master_claim_token THEN
          UPDATE payment_terminal_effects SET
            claim_expires_at = NOW() + INTERVAL '2 minutes',
            updated_at = NOW()
          WHERE id = v_effect.id;
          RETURN jsonb_build_object('reserved', true,
            'effect_token', v_effect.claim_token,
            'already_reserved', true);
        ELSE
          RETURN jsonb_build_object('reserved', false, 'reason', 'lease_active_other_claimant');
        END IF;
      END IF;

      -- Lease expired: reclaim rules
      IF v_effect.emission_started_at IS NOT NULL THEN
        IF v_effect.category IN ('required_external', 'optional')
           AND v_effect.execution_class = 'external' THEN
          UPDATE payment_terminal_effects SET
            status = 'indeterminate', updated_at = NOW()
          WHERE id = v_effect.id;
          RETURN jsonb_build_object('reserved', false, 'reason', 'post_emission_indeterminate');
        END IF;
      END IF;

      -- Pre-emission stale: reclaim
      v_new_effect_token := gen_random_uuid();
      UPDATE payment_terminal_effects SET
        claim_token = v_new_effect_token,
        reserved_under_master_token = p_master_claim_token,
        claim_expires_at = NOW() + INTERVAL '2 minutes',
        updated_at = NOW()
      WHERE id = v_effect.id;
      RETURN jsonb_build_object('reserved', true,
        'effect_token', v_new_effect_token, 'reclaimed', true);

    WHEN 'completed', 'failed', 'indeterminate', 'skipped' THEN
      RETURN jsonb_build_object('reserved', false,
        'reason', 'already_terminal', 'current_status', v_effect.status);

    ELSE
      RETURN jsonb_build_object('reserved', false, 'reason', 'unexpected_status');
  END CASE;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 3. terminate_payment_confirmation
--
-- Atomic claim-fenced termination for not_deliverable payments.
-- Sets confirmation_terminal_reason + clears claim in one transaction.
-- Idempotent: already-terminated with same reason returns already_terminated.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION terminate_payment_confirmation(
  p_payment_id UUID,
  p_claim_token UUID,
  p_terminal_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  -- 1. Lock payment row
  SELECT confirmation_claim_token, confirmation_processing_at,
         confirmation_sent_at, confirmation_terminal_reason
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('terminated', false, 'reason', 'not_found');
  END IF;

  -- 2. Already finalized?
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('terminated', false, 'reason', 'already_finalized');
  END IF;

  -- 3. Already terminated? (idempotent — check BEFORE token validation)
  IF v_payment.confirmation_terminal_reason IS NOT NULL THEN
    IF v_payment.confirmation_terminal_reason = p_terminal_reason THEN
      RETURN jsonb_build_object('terminated', true, 'already_terminated', true);
    ELSE
      RETURN jsonb_build_object('terminated', false, 'reason', 'terminal_reason_conflict',
        'existing_reason', v_payment.confirmation_terminal_reason);
    END IF;
  END IF;

  -- 4. Validate claim token (only checked when not already terminal)
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('terminated', false, 'reason', 'token_mismatch');
  END IF;

  -- 5. Validate claim not expired
  IF v_payment.confirmation_processing_at <= NOW() - INTERVAL '5 minutes' THEN
    RETURN jsonb_build_object('terminated', false, 'reason', 'claim_expired');
  END IF;

  -- 6. Validate terminal reason
  IF p_terminal_reason IS NULL OR p_terminal_reason NOT IN ('not_deliverable') THEN
    RETURN jsonb_build_object('terminated', false, 'reason', 'invalid_terminal_reason');
  END IF;

  -- 7. Atomically: set terminal reason + clear claim ownership
  UPDATE payments
  SET confirmation_terminal_reason = p_terminal_reason,
      confirmation_processing_at = NULL,
      confirmation_claim_token = NULL
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('terminated', true, 'already_terminated', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 4. seal_payment_rule_actions
--
-- Atomic all-or-nothing seal of the matched rule-action set.
-- SOLE INSERT path for payment_rule_action_executions (CTO binding #1).
-- If manifest header already exists, returns already_sealed without
-- re-reading bot_rules (CTO binding #2: loser convergence).
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION seal_payment_rule_actions(
  p_payment_id UUID,
  p_actions JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing RECORD;
  v_action JSONB;
  v_inserted INTEGER := 0;
  v_expected INTEGER;
BEGIN
  v_expected := jsonb_array_length(COALESCE(p_actions, '[]'::JSONB));

  -- 1. Check for existing sealed manifest (FOR UPDATE to serialize concurrent sealers)
  SELECT id, sealed_at, action_count
  INTO v_existing
  FROM payment_rule_action_manifests
  WHERE payment_id = p_payment_id
  FOR UPDATE;

  IF FOUND THEN
    -- Already sealed. Return without reading bot_rules or inserting.
    RETURN jsonb_build_object(
      'sealed', true,
      'already_sealed', true,
      'action_count', v_existing.action_count
    );
  END IF;

  -- 2. Create manifest header
  -- UNIQUE(payment_id) ensures concurrent sealers serialize:
  -- loser gets unique_violation → entire transaction rolls back → zero rows.
  INSERT INTO payment_rule_action_manifests
    (payment_id, action_count, sealed_at)
  VALUES
    (p_payment_id, v_expected, NOW());

  -- 3. Insert every frozen action row
  FOR v_action IN SELECT * FROM jsonb_array_elements(COALESCE(p_actions, '[]'::JSONB))
  LOOP
    INSERT INTO payment_rule_action_executions
      (payment_id, rule_id, action_type, action_payload, action_fingerprint, status)
    VALUES (
      p_payment_id,
      (v_action->>'rule_id')::UUID,
      v_action->>'action_type',
      v_action->'action_payload',
      v_action->>'action_fingerprint',
      'pending'
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  -- 4. Verify inserted count
  IF v_inserted != v_expected THEN
    RAISE EXCEPTION 'Rule action count mismatch: expected %, inserted %',
      v_expected, v_inserted;
  END IF;

  -- 5. Transaction commits header + all rows atomically
  RETURN jsonb_build_object(
    'sealed', true,
    'already_sealed', false,
    'action_count', v_inserted
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 5. Privilege hardening for this migration's RPCs
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  REVOKE ALL ON FUNCTION initialize_terminal_effects(UUID, UUID, TEXT[], TEXT[], TEXT[], TEXT[], INTEGER) FROM PUBLIC;
  REVOKE ALL ON FUNCTION reserve_terminal_effect(UUID, TEXT, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION terminate_payment_confirmation(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION seal_payment_rule_actions(UUID, JSONB) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION initialize_terminal_effects(UUID, UUID, TEXT[], TEXT[], TEXT[], TEXT[], INTEGER) FROM anon;
    REVOKE ALL ON FUNCTION reserve_terminal_effect(UUID, TEXT, UUID) FROM anon;
    REVOKE ALL ON FUNCTION terminate_payment_confirmation(UUID, UUID, TEXT) FROM anon;
    REVOKE ALL ON FUNCTION seal_payment_rule_actions(UUID, JSONB) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION initialize_terminal_effects(UUID, UUID, TEXT[], TEXT[], TEXT[], TEXT[], INTEGER) FROM authenticated;
    REVOKE ALL ON FUNCTION reserve_terminal_effect(UUID, TEXT, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION terminate_payment_confirmation(UUID, UUID, TEXT) FROM authenticated;
    REVOKE ALL ON FUNCTION seal_payment_rule_actions(UUID, JSONB) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION initialize_terminal_effects(UUID, UUID, TEXT[], TEXT[], TEXT[], TEXT[], INTEGER) TO service_role;
    GRANT EXECUTE ON FUNCTION reserve_terminal_effect(UUID, TEXT, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION terminate_payment_confirmation(UUID, UUID, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION seal_payment_rule_actions(UUID, JSONB) TO service_role;
  END IF;
END $$;

-- Privilege verification hard gate
DO $$
DECLARE
  v_fn TEXT; v_sig TEXT; v_errors TEXT[] := '{}';
BEGIN
  FOR v_fn, v_sig IN VALUES
    ('initialize_terminal_effects', 'initialize_terminal_effects(uuid, uuid, text[], text[], text[], text[], integer)'),
    ('reserve_terminal_effect', 'reserve_terminal_effect(uuid, text, uuid)'),
    ('terminate_payment_confirmation', 'terminate_payment_confirmation(uuid, uuid, text)'),
    ('seal_payment_rule_actions', 'seal_payment_rule_actions(uuid, jsonb)')
  LOOP
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      v_errors := array_append(v_errors, 'FAIL: anon can execute ' || v_fn);
    END IF;
    IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      v_errors := array_append(v_errors, 'FAIL: authenticated can execute ' || v_fn);
    END IF;
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      v_errors := array_append(v_errors, 'FAIL: service_role cannot execute ' || v_fn);
    END IF;
  END LOOP;

  IF array_length(v_errors, 1) > 0 THEN
    RAISE EXCEPTION 'Migration 385 privilege verification failed: %', array_to_string(v_errors, '; ');
  END IF;

  RAISE NOTICE 'Migration 385: All privilege checks passed';
END $$;
