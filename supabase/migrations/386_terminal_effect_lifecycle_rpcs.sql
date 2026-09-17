-- Migration 386: Terminal effect lifecycle RPCs
--
-- Phase A v15: emission fence + state transition RPCs.
-- All transitions are server-side enforced; no generic p_status parameter.

-- ═══════════════════════════════════════════════════════
-- 1. begin_terminal_external_emission
--
-- Emission fence: atomically authorizes a provider call by setting
-- emission_started_at. After this, worker death never permits re-emission.
-- Requires BOTH current master claim AND current effect token.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION begin_terminal_external_emission(
  p_payment_id UUID,
  p_effect_key TEXT,
  p_master_claim_token UUID,
  p_effect_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_effect RECORD;
BEGIN
  -- 1. Lock payment, verify master claim
  SELECT confirmation_claim_token, confirmation_processing_at, confirmation_sent_at
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'payment_not_found');
  END IF;
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'already_finalized');
  END IF;
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_master_claim_token THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'token_mismatch');
  END IF;
  IF v_payment.confirmation_processing_at <= NOW() - INTERVAL '5 minutes' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'claim_expired');
  END IF;

  -- 2. Lock effect row
  SELECT id, status, claim_token, claim_expires_at, emission_started_at,
         category, execution_class
  INTO v_effect FROM payment_terminal_effects
  WHERE payment_id = p_payment_id AND effect_key = p_effect_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'effect_not_in_manifest');
  END IF;

  -- 3. execution_class must be external
  IF v_effect.execution_class != 'external' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_external_effect');
  END IF;

  -- 4. Effect must be claimed
  IF v_effect.status != 'claimed' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'effect_not_claimed',
      'current_status', v_effect.status);
  END IF;

  -- 5. Effect token must match
  IF v_effect.claim_token != p_effect_token THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'effect_token_mismatch');
  END IF;

  -- 6. Effect lease not expired
  IF v_effect.claim_expires_at IS NOT NULL AND v_effect.claim_expires_at <= NOW() THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'effect_lease_expired');
  END IF;

  -- 7. emission_started_at must be NULL
  IF v_effect.emission_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'already_emitted');
  END IF;

  -- 8. Set emission marker
  UPDATE payment_terminal_effects
  SET emission_started_at = NOW(), updated_at = NOW()
  WHERE id = v_effect.id;

  RETURN jsonb_build_object('authorized', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 2. complete_internal_effect
--
-- For internal execution_class only. 5 pre-emission guards:
-- effect exists, status=claimed, token matches, execution_class=internal,
-- reserved_under_master_token = current master.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION complete_internal_effect(
  p_payment_id UUID,
  p_effect_key TEXT,
  p_effect_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_effect RECORD;
BEGIN
  -- Lock payment to read current master
  SELECT confirmation_claim_token, confirmation_processing_at
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'payment_not_found');
  END IF;

  -- Lock effect
  SELECT id, status, claim_token, claim_expires_at, execution_class,
         reserved_under_master_token
  INTO v_effect FROM payment_terminal_effects
  WHERE payment_id = p_payment_id AND effect_key = p_effect_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'effect_not_found');
  END IF;

  -- Guard 1: execution_class must be internal
  IF v_effect.execution_class != 'internal' THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'wrong_execution_class');
  END IF;

  -- Guard 2: status must be claimed
  IF v_effect.status != 'claimed' THEN
    IF v_effect.status = 'completed' THEN
      RETURN jsonb_build_object('completed', true, 'already_completed', true);
    END IF;
    RETURN jsonb_build_object('completed', false, 'reason', 'not_claimed',
      'current_status', v_effect.status);
  END IF;

  -- Guard 3: effect token matches
  IF v_effect.claim_token != p_effect_token THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'effect_token_mismatch');
  END IF;

  -- Guard 4: effect lease valid
  IF v_effect.claim_expires_at IS NOT NULL AND v_effect.claim_expires_at <= NOW() THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'effect_lease_expired');
  END IF;

  -- Guard 5: reservation belongs to current master claim
  IF v_effect.reserved_under_master_token != v_payment.confirmation_claim_token THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'master_ownership_revoked');
  END IF;

  -- Transition: claimed → completed
  UPDATE payment_terminal_effects
  SET status = 'completed', completed_at = NOW(), updated_at = NOW()
  WHERE id = v_effect.id;

  RETURN jsonb_build_object('completed', true, 'already_completed', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 3. complete_external_effect
--
-- For external execution_class only. Post-emission only.
-- Bounded completion capability: effect_token is sufficient authority
-- (master claim may have turned over after emission was authorized).
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION complete_external_effect(
  p_payment_id UUID,
  p_effect_key TEXT,
  p_effect_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_effect RECORD;
BEGIN
  SELECT id, status, claim_token, emission_started_at, execution_class
  INTO v_effect FROM payment_terminal_effects
  WHERE payment_id = p_payment_id AND effect_key = p_effect_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'effect_not_found');
  END IF;

  IF v_effect.execution_class != 'external' THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'wrong_execution_class');
  END IF;

  IF v_effect.status != 'claimed' THEN
    IF v_effect.status = 'completed' THEN
      RETURN jsonb_build_object('completed', true, 'already_completed', true);
    END IF;
    RETURN jsonb_build_object('completed', false, 'reason', 'not_claimed',
      'current_status', v_effect.status);
  END IF;

  IF v_effect.claim_token != p_effect_token THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'effect_token_mismatch');
  END IF;

  IF v_effect.emission_started_at IS NULL THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'emission_not_started');
  END IF;

  UPDATE payment_terminal_effects
  SET status = 'completed', completed_at = NOW(), updated_at = NOW()
  WHERE id = v_effect.id;

  RETURN jsonb_build_object('completed', true, 'already_completed', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 4. fail_external_effect
--
-- Pre-emission only. Post-emission failure is structurally impossible
-- (must use mark_effect_indeterminate instead).
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fail_external_effect(
  p_payment_id UUID,
  p_effect_key TEXT,
  p_effect_token UUID,
  p_failure_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_effect RECORD;
BEGIN
  SELECT id, status, claim_token, emission_started_at, execution_class
  INTO v_effect FROM payment_terminal_effects
  WHERE payment_id = p_payment_id AND effect_key = p_effect_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'effect_not_found');
  END IF;

  IF v_effect.execution_class != 'external' THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'wrong_execution_class');
  END IF;

  IF v_effect.status != 'claimed' THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'not_claimed',
      'current_status', v_effect.status);
  END IF;

  IF v_effect.claim_token != p_effect_token THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'effect_token_mismatch');
  END IF;

  -- CRITICAL: post-emission failure is NOT permitted
  IF v_effect.emission_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'post_emission_failed_not_permitted',
      'required_action', 'use mark_effect_indeterminate');
  END IF;

  IF p_failure_reason IS NULL OR p_failure_reason = '' THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'failure_reason_required');
  END IF;

  UPDATE payment_terminal_effects
  SET status = 'failed', completed_at = NOW(), suppression_reason = p_failure_reason,
      updated_at = NOW()
  WHERE id = v_effect.id;

  RETURN jsonb_build_object('failed', true, 'pre_emission', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 5. mark_effect_indeterminate
--
-- Post-emission only. Provider handoff outcome unknown.
-- Bounded completion capability (effect token sufficient).
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mark_effect_indeterminate(
  p_payment_id UUID,
  p_effect_key TEXT,
  p_effect_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_effect RECORD;
BEGIN
  SELECT id, status, claim_token, emission_started_at, execution_class
  INTO v_effect FROM payment_terminal_effects
  WHERE payment_id = p_payment_id AND effect_key = p_effect_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'effect_not_found');
  END IF;

  IF v_effect.execution_class != 'external' THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'wrong_execution_class');
  END IF;

  IF v_effect.status != 'claimed' THEN
    IF v_effect.status = 'indeterminate' THEN
      RETURN jsonb_build_object('marked', true, 'already_indeterminate', true);
    END IF;
    RETURN jsonb_build_object('marked', false, 'reason', 'not_claimed',
      'current_status', v_effect.status);
  END IF;

  IF v_effect.claim_token != p_effect_token THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'effect_token_mismatch');
  END IF;

  IF v_effect.emission_started_at IS NULL THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'emission_not_started');
  END IF;

  UPDATE payment_terminal_effects
  SET status = 'indeterminate', completed_at = NOW(), updated_at = NOW()
  WHERE id = v_effect.id;

  RETURN jsonb_build_object('marked', true, 'already_indeterminate', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 6. skip_optional_effect
--
-- Only for optional category effects. Requires suppression reason.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION skip_optional_effect(
  p_payment_id UUID,
  p_effect_key TEXT,
  p_effect_token UUID,
  p_suppression_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_effect RECORD;
BEGIN
  SELECT id, status, claim_token, category, emission_started_at
  INTO v_effect FROM payment_terminal_effects
  WHERE payment_id = p_payment_id AND effect_key = p_effect_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', false, 'reason', 'effect_not_found');
  END IF;

  IF v_effect.category != 'optional' THEN
    RETURN jsonb_build_object('skipped', false, 'reason', 'not_optional');
  END IF;

  IF v_effect.status NOT IN ('pending', 'claimed') THEN
    IF v_effect.status = 'skipped' THEN
      RETURN jsonb_build_object('skipped', true, 'already_skipped', true);
    END IF;
    RETURN jsonb_build_object('skipped', false, 'reason', 'not_skippable',
      'current_status', v_effect.status);
  END IF;

  -- If claimed, verify token
  IF v_effect.status = 'claimed' AND v_effect.claim_token != p_effect_token THEN
    RETURN jsonb_build_object('skipped', false, 'reason', 'effect_token_mismatch');
  END IF;

  -- Cannot skip after emission started
  IF v_effect.emission_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', false, 'reason', 'emission_already_started');
  END IF;

  IF p_suppression_reason IS NULL OR p_suppression_reason = '' THEN
    RETURN jsonb_build_object('skipped', false, 'reason', 'suppression_reason_required');
  END IF;

  UPDATE payment_terminal_effects
  SET status = 'skipped', suppression_reason = p_suppression_reason,
      completed_at = NOW(), updated_at = NOW()
  WHERE id = v_effect.id;

  RETURN jsonb_build_object('skipped', true, 'already_skipped', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 7. advance_rule_action — atomic pending→sending emission fence
--
-- For provider-emitting rule actions. Sets emission_started_at.
-- After this, worker death never permits re-emission.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION advance_rule_action(
  p_payment_id UUID,
  p_rule_id UUID,
  p_target_status TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT id, status, emission_started_at
  INTO v_row FROM payment_rule_action_executions
  WHERE payment_id = p_payment_id AND rule_id = p_rule_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'not_found');
  END IF;

  -- Legal transitions only
  CASE p_target_status
    WHEN 'sending' THEN
      -- pending → sending (emission fence)
      IF v_row.status != 'pending' THEN
        RETURN jsonb_build_object('advanced', false, 'reason', 'not_pending',
          'current_status', v_row.status);
      END IF;
      UPDATE payment_rule_action_executions
      SET status = 'sending', emission_started_at = NOW()
      WHERE id = v_row.id;

    WHEN 'completed' THEN
      -- sending → completed (provider confirmed) OR pending → completed (internal action)
      IF v_row.status NOT IN ('pending', 'sending') THEN
        IF v_row.status = 'completed' THEN
          RETURN jsonb_build_object('advanced', true, 'already_completed', true);
        END IF;
        RETURN jsonb_build_object('advanced', false, 'reason', 'invalid_transition',
          'current_status', v_row.status);
      END IF;
      UPDATE payment_rule_action_executions
      SET status = 'completed', executed_at = NOW()
      WHERE id = v_row.id;

    WHEN 'indeterminate' THEN
      -- sending → indeterminate (post-emission uncertainty)
      IF v_row.status != 'sending' THEN
        IF v_row.status = 'indeterminate' THEN
          RETURN jsonb_build_object('advanced', true, 'already_indeterminate', true);
        END IF;
        RETURN jsonb_build_object('advanced', false, 'reason', 'not_sending',
          'current_status', v_row.status);
      END IF;
      IF v_row.emission_started_at IS NULL THEN
        RETURN jsonb_build_object('advanced', false, 'reason', 'emission_not_started');
      END IF;
      UPDATE payment_rule_action_executions
      SET status = 'indeterminate'
      WHERE id = v_row.id;

    WHEN 'failed' THEN
      -- pending → failed (pre-emission failure only)
      IF v_row.status != 'pending' THEN
        RETURN jsonb_build_object('advanced', false, 'reason', 'not_pending',
          'current_status', v_row.status);
      END IF;
      IF v_row.emission_started_at IS NOT NULL THEN
        RETURN jsonb_build_object('advanced', false, 'reason', 'post_emission_failed_not_permitted');
      END IF;
      UPDATE payment_rule_action_executions
      SET status = 'failed'
      WHERE id = v_row.id;

    ELSE
      RETURN jsonb_build_object('advanced', false, 'reason', 'invalid_target_status');
  END CASE;

  RETURN jsonb_build_object('advanced', true, 'new_status', p_target_status);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 8. Privilege hardening
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  REVOKE ALL ON FUNCTION begin_terminal_external_emission(UUID, TEXT, UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION complete_internal_effect(UUID, TEXT, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION complete_external_effect(UUID, TEXT, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION fail_external_effect(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION mark_effect_indeterminate(UUID, TEXT, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION skip_optional_effect(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION advance_rule_action(UUID, UUID, TEXT) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION begin_terminal_external_emission(UUID, TEXT, UUID, UUID) FROM anon;
    REVOKE ALL ON FUNCTION complete_internal_effect(UUID, TEXT, UUID) FROM anon;
    REVOKE ALL ON FUNCTION complete_external_effect(UUID, TEXT, UUID) FROM anon;
    REVOKE ALL ON FUNCTION fail_external_effect(UUID, TEXT, UUID, TEXT) FROM anon;
    REVOKE ALL ON FUNCTION mark_effect_indeterminate(UUID, TEXT, UUID) FROM anon;
    REVOKE ALL ON FUNCTION skip_optional_effect(UUID, TEXT, UUID, TEXT) FROM anon;
    REVOKE ALL ON FUNCTION advance_rule_action(UUID, UUID, TEXT) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION begin_terminal_external_emission(UUID, TEXT, UUID, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION complete_internal_effect(UUID, TEXT, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION complete_external_effect(UUID, TEXT, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION fail_external_effect(UUID, TEXT, UUID, TEXT) FROM authenticated;
    REVOKE ALL ON FUNCTION mark_effect_indeterminate(UUID, TEXT, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION skip_optional_effect(UUID, TEXT, UUID, TEXT) FROM authenticated;
    REVOKE ALL ON FUNCTION advance_rule_action(UUID, UUID, TEXT) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION begin_terminal_external_emission(UUID, TEXT, UUID, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION complete_internal_effect(UUID, TEXT, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION complete_external_effect(UUID, TEXT, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION fail_external_effect(UUID, TEXT, UUID, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION mark_effect_indeterminate(UUID, TEXT, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION skip_optional_effect(UUID, TEXT, UUID, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION advance_rule_action(UUID, UUID, TEXT) TO service_role;
  END IF;
END $$;

-- Privilege verification
DO $$
DECLARE
  v_fn TEXT; v_sig TEXT; v_errors TEXT[] := '{}';
BEGIN
  FOR v_fn, v_sig IN VALUES
    ('begin_terminal_external_emission', 'begin_terminal_external_emission(uuid, text, uuid, uuid)'),
    ('complete_internal_effect', 'complete_internal_effect(uuid, text, uuid)'),
    ('complete_external_effect', 'complete_external_effect(uuid, text, uuid)'),
    ('fail_external_effect', 'fail_external_effect(uuid, text, uuid, text)'),
    ('mark_effect_indeterminate', 'mark_effect_indeterminate(uuid, text, uuid)'),
    ('skip_optional_effect', 'skip_optional_effect(uuid, text, uuid, text)'),
    ('advance_rule_action', 'advance_rule_action(uuid, uuid, text)')
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
    RAISE EXCEPTION 'Migration 386 privilege verification failed: %', array_to_string(v_errors, '; ');
  END IF;

  RAISE NOTICE 'Migration 386: All privilege checks passed';
END $$;
