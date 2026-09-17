-- Migration 388: Terminal effect confirmation guards
--
-- Phase A v13: Add confirmation_terminal_reason IS NOT NULL guard to
-- all Stage-3 claim lifecycle RPCs. This closes the gap where
-- not_deliverable payments could be re-claimed (migration 307 only
-- checked confirmation_sent_at).
--
-- Also: finalize_payment_confirmation now enforces manifest completeness
-- and derives terminal outcome from DB state (v10/v11 design).
-- Legacy payments without manifests still finalize normally.

-- ═══════════════════════════════════════════════════════
-- Canonical Stage-3 terminal predicate:
--   confirmation_sent_at IS NOT NULL
--   OR confirmation_terminal_reason IS NOT NULL
-- ═══════════════════════════════════════════════════════

-- 1. claim_payment_confirmation — add terminal_reason guard
CREATE OR REPLACE FUNCTION claim_payment_confirmation(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_token UUID;
BEGIN
  SELECT id, amount, status, booking_id, invoice_id, campaign_id,
         reservation_id, order_id,
         confirmation_sent_at, confirmation_processing_at,
         confirmation_claim_token, confirmation_terminal_reason,
         payment_authority_version
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_successful');
  END IF;
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'already_completed', true, 'reason', 'already_sent');
  END IF;
  -- v13: terminal predicate guard
  IF v_payment.confirmation_terminal_reason IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_terminated',
      'terminal_reason', v_payment.confirmation_terminal_reason);
  END IF;
  IF v_payment.confirmation_processing_at IS NOT NULL
     AND v_payment.confirmation_processing_at > NOW() - INTERVAL '5 minutes' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'processing_in_progress');
  END IF;

  v_token := gen_random_uuid();
  UPDATE payments
  SET confirmation_processing_at = NOW(), confirmation_claim_token = v_token
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'claimed', true, 'claim_token', v_token,
    'payment_id', v_payment.id, 'amount', v_payment.amount,
    'booking_id', v_payment.booking_id, 'invoice_id', v_payment.invoice_id,
    'campaign_id', v_payment.campaign_id, 'reservation_id', v_payment.reservation_id,
    'order_id', v_payment.order_id,
    'payment_authority_version', v_payment.payment_authority_version
  );
END;
$$;

-- 2. renew_payment_confirmation_claim — add terminal_reason guard
CREATE OR REPLACE FUNCTION renew_payment_confirmation_claim(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  SELECT confirmation_sent_at, confirmation_claim_token, confirmation_terminal_reason
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'not_found');
  END IF;
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'already_finalized');
  END IF;
  -- v13: terminal predicate guard
  IF v_payment.confirmation_terminal_reason IS NOT NULL THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'already_terminated');
  END IF;
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payments SET confirmation_processing_at = NOW() WHERE id = p_payment_id;
  RETURN jsonb_build_object('renewed', true);
END;
$$;

-- 3. finalize_payment_confirmation — manifest checks + DB-derived outcome
CREATE OR REPLACE FUNCTION finalize_payment_confirmation(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_manifest RECORD;
  v_has_manifest BOOLEAN := false;
  v_total INTEGER;
  v_actual_hash TEXT;
  v_actual_tuples TEXT[];
  v_incomplete INTEGER;
  v_pending_ext INTEGER;
  v_dangling INTEGER;
  v_unexcused INTEGER;
  v_terminal_reason TEXT;
  v_whatsapp_applicable BOOLEAN;
  v_whatsapp_status TEXT;
  v_has_successful_delivery BOOLEAN;
  v_has_indeterminate BOOLEAN;
  v_has_any_delivery BOOLEAN;
BEGIN
  SELECT confirmation_sent_at, confirmation_processing_at,
         confirmation_claim_token, confirmation_terminal_reason,
         payment_authority_version
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'not_found');
  END IF;
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('finalized', true, 'already_finalized', true);
  END IF;
  -- v13: terminal predicate guard
  IF v_payment.confirmation_terminal_reason IS NOT NULL THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'already_terminated');
  END IF;
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'token_mismatch');
  END IF;

  -- Check if manifest exists (conditional — legacy payments may not have one)
  SELECT * INTO v_manifest FROM payment_terminal_manifests
  WHERE payment_id = p_payment_id;

  IF FOUND THEN
    v_has_manifest := true;

    -- Manifest must be fully initialized
    IF v_manifest.initialization_state != 'initialized' THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'manifest_not_initialized');
    END IF;

    -- Recompute and verify semantic hash
    SELECT COUNT(*),
           array_agg(
             effect_key || '|' || category || '|' || execution_class || '|' ||
             COALESCE(provider_channel, 'none') || '|' || contract_version::TEXT
             ORDER BY effect_key || '|' || category || '|' || execution_class || '|' ||
             COALESCE(provider_channel, 'none') || '|' || contract_version::TEXT
           )
    INTO v_total, v_actual_tuples
    FROM payment_terminal_effects WHERE payment_id = p_payment_id;

    v_actual_hash := encode(digest(
      array_to_string(COALESCE(v_actual_tuples, ARRAY[]::TEXT[]), ','), 'sha256'), 'hex');

    IF v_total != v_manifest.expected_effect_count THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'effect_count_mismatch',
        'expected', v_manifest.expected_effect_count, 'actual', v_total);
    END IF;
    IF v_actual_hash != v_manifest.expected_semantic_hash THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'semantic_hash_mismatch');
    END IF;

    -- Required internal: all must be completed
    SELECT COUNT(*) INTO v_incomplete FROM payment_terminal_effects
    WHERE payment_id = p_payment_id AND category = 'required_internal'
      AND status != 'completed';
    IF v_incomplete > 0 THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'incomplete_required_internal',
        'remaining', v_incomplete);
    END IF;

    -- Required external: must be in terminal state
    SELECT COUNT(*) INTO v_pending_ext FROM payment_terminal_effects
    WHERE payment_id = p_payment_id AND category = 'required_external'
      AND status NOT IN ('completed', 'failed', 'indeterminate');
    IF v_pending_ext > 0 THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'pending_required_external',
        'remaining', v_pending_ext);
    END IF;

    -- Optional: must be terminal or skipped with reason
    SELECT COUNT(*) INTO v_dangling FROM payment_terminal_effects
    WHERE payment_id = p_payment_id AND category = 'optional'
      AND status NOT IN ('completed', 'failed', 'indeterminate', 'skipped');
    IF v_dangling > 0 THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'dangling_optional',
        'remaining', v_dangling);
    END IF;

    SELECT COUNT(*) INTO v_unexcused FROM payment_terminal_effects
    WHERE payment_id = p_payment_id AND status = 'skipped'
      AND (suppression_reason IS NULL OR suppression_reason = '');
    IF v_unexcused > 0 THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'skipped_without_reason',
        'count', v_unexcused);
    END IF;

    -- DB-derived terminal outcome (v11 truth table)
    SELECT EXISTS(
      SELECT 1 FROM payment_terminal_effects
      WHERE payment_id = p_payment_id AND effect_key = 'customer_whatsapp'
    ) INTO v_whatsapp_applicable;

    IF NOT v_whatsapp_applicable THEN
      -- Case A: email-only or no-WhatsApp
      v_terminal_reason := NULL;
    ELSE
      SELECT status INTO v_whatsapp_status FROM payment_terminal_effects
      WHERE payment_id = p_payment_id AND effect_key = 'customer_whatsapp';

      IF v_whatsapp_status = 'completed' THEN
        v_terminal_reason := NULL; -- Case B
      ELSIF v_whatsapp_status = 'indeterminate' THEN
        v_terminal_reason := 'ambiguous_delivery'; -- Case C
      ELSIF v_whatsapp_status = 'failed' THEN
        -- Check delivery rows for Cases D vs E
        SELECT EXISTS(
          SELECT 1 FROM payment_confirmation_deliveries
          WHERE payment_id = p_payment_id
        ) INTO v_has_any_delivery;

        IF NOT v_has_any_delivery THEN
          v_terminal_reason := 'delivery_failure'; -- Case E
        ELSE
          SELECT EXISTS(
            SELECT 1 FROM payment_confirmation_deliveries
            WHERE payment_id = p_payment_id AND delivery_status = 'indeterminate'
          ) INTO v_has_indeterminate;

          IF v_has_indeterminate THEN
            v_terminal_reason := 'ambiguous_delivery'; -- Case C variant
          ELSE
            v_terminal_reason := 'delivery_failure'; -- Case D
          END IF;
        END IF;
      ELSE
        -- Should not reach (manifest checks caught pending/claimed)
        v_terminal_reason := 'ambiguous_delivery';
      END IF;
    END IF;
  ELSE
    -- No manifest row exists.
    -- Phase-A payments (payment_authority_version IS NOT NULL) MUST have a manifest.
    -- Only genuine historical/legacy payments (NULL authority version) may finalize without one.
    IF v_payment.payment_authority_version IS NOT NULL THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'manifest_required_for_phase_a',
        'payment_authority_version', v_payment.payment_authority_version);
    END IF;
    -- Legacy path: pre-authority payments finalize normally
    v_terminal_reason := NULL;
  END IF;

  -- Finalize
  UPDATE payments
  SET confirmation_sent_at = NOW(),
      confirmation_processing_at = NULL,
      confirmation_claim_token = NULL,
      confirmation_terminal_reason = v_terminal_reason
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('finalized', true, 'already_finalized', false,
    'has_manifest', v_has_manifest,
    'terminal_reason', v_terminal_reason);
END;
$$;

-- 4. release_payment_confirmation — add terminal_reason guard
CREATE OR REPLACE FUNCTION release_payment_confirmation(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  SELECT confirmation_sent_at, confirmation_claim_token, confirmation_terminal_reason
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'not_found');
  END IF;
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'already_finalized');
  END IF;
  -- v13: terminal predicate guard
  IF v_payment.confirmation_terminal_reason IS NOT NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'already_terminated');
  END IF;
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('released', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payments
  SET confirmation_processing_at = NULL, confirmation_claim_token = NULL
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('released', true);
END;
$$;
