-- ═══════════════════════════════════════════════════════
-- 291: Square connection support + financial safety
-- ═══════════════════════════════════════════════════════

-- ── 1. Square merchant location ──
ALTER TABLE public.payout_accounts
  ADD COLUMN IF NOT EXISTS square_location_id VARCHAR(100);

-- ── 1b. Confirmation claim columns ──
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS confirmation_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_claim_token TEXT;

-- ── 2. Normalized provider order reference ──
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_order_ref TEXT;

-- Immutable payment-attempt key for idempotent retry recovery.
-- Format: gateway:business_id:reference_code (deterministic, survives gateway_reference overwrites)
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_attempt_key TEXT;

-- ── 3. Widen gateway_reference to TEXT for Square IDs (up to 192 chars) ──
ALTER TABLE public.payments
  ALTER COLUMN gateway_reference TYPE TEXT;

-- Provider-scoped unique on attempt key (prevents duplicate logical attempts per gateway+business)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_attempt_key_unique
  ON public.payments (payment_attempt_key)
  WHERE payment_attempt_key IS NOT NULL;

-- Unique index on checkout_short_ref for short URL lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_checkout_short_ref
  ON public.payments ((metadata->>'checkout_short_ref'))
  WHERE metadata->>'checkout_short_ref' IS NOT NULL;

-- Provider-scoped unique on order ref
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_order_unique
  ON public.payments (gateway, payout_account_id, provider_order_ref)
  WHERE provider_order_ref IS NOT NULL;

-- ── 4. Webhook lease columns ──
ALTER TABLE public.processed_webhook_events
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

-- ── 5. Credential lifecycle columns ──
ALTER TABLE public.business_connection_secrets
  ADD COLUMN IF NOT EXISTS encrypted_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_refreshed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_scopes TEXT,
  ADD COLUMN IF NOT EXISTS refresh_lease_token TEXT,
  ADD COLUMN IF NOT EXISTS refresh_lease_expires_at TIMESTAMPTZ;

-- ── 6. Refund idempotency and fee reversal ──
ALTER TABLE public.refunds
  ADD COLUMN IF NOT EXISTS provider_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS planned_fee_reversal NUMERIC(12,2) DEFAULT 0;

-- Expand refund status
ALTER TABLE public.refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
ALTER TABLE public.refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('pending', 'processing', 'success', 'failed', 'review_required'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_provider_idempotency
  ON public.refunds (payment_id, provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;

-- Unique on gateway_refund_reference per gateway (prevents duplicate finalization)
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_gateway_ref_unique
  ON public.refunds (gateway, gateway_refund_reference)
  WHERE gateway_refund_reference IS NOT NULL;

-- ── 6b. Square merchant tenant identity — one active connection per merchant ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_accounts_square_merchant_active
  ON public.payout_accounts (square_merchant_id)
  WHERE square_merchant_id IS NOT NULL AND is_active = true;

-- ── 7. Atomic Square replacement (payout + secret + payout_mode) ──
CREATE OR REPLACE FUNCTION public.replace_square_connection_full(
  p_business_id           UUID,
  p_merchant_id           TEXT,
  p_location_id           TEXT,
  p_encrypted_access      TEXT,
  p_encrypted_refresh     TEXT,
  p_token_expires_at      TIMESTAMPTZ,
  p_token_scopes          TEXT,
  p_key_identifier        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz_exists BOOLEAN;
  v_revoked INT;
  v_has_default BOOLEAN;
  v_new_id UUID;
  v_old_ids UUID[];
BEGIN
  IF p_business_id IS NULL OR p_merchant_id IS NULL OR trim(p_merchant_id) = ''
     OR p_location_id IS NULL OR trim(p_location_id) = ''
     OR p_encrypted_access IS NULL OR trim(p_encrypted_access) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_input');
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.businesses WHERE id = p_business_id) INTO v_biz_exists;
  IF NOT v_biz_exists THEN
    RETURN jsonb_build_object('success', false, 'reason', 'business_not_found');
  END IF;

  -- Lock the business row BEFORE inspecting payout accounts to prevent concurrent mutations
  PERFORM id FROM public.businesses WHERE id = p_business_id FOR UPDATE;

  -- Lock ALL connections for this business (not just Square) to protect default invariant
  PERFORM id FROM public.payout_accounts
    WHERE business_id = p_business_id FOR UPDATE;

  SELECT array_agg(id) INTO v_old_ids FROM public.payout_accounts
    WHERE business_id = p_business_id AND gateway = 'square' AND is_active = true;

  -- Revoke only Square connections
  UPDATE public.payout_accounts
    SET is_active = false, connection_status = 'revoked', is_default = false, updated_at = NOW()
    WHERE business_id = p_business_id AND gateway = 'square' AND is_active = true;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  IF v_old_ids IS NOT NULL THEN
    UPDATE public.business_connection_secrets
      SET revoked_at = NOW(), updated_at = NOW()
      WHERE payout_account_id = ANY(v_old_ids) AND revoked_at IS NULL;
  END IF;

  -- Check if ANY active connection already claims default (regardless of health).
  -- If any active connection has is_default = true, don't compete — insert as non-default.
  -- This prevents two rows having is_default = true (one unhealthy, one healthy).
  SELECT EXISTS(
    SELECT 1 FROM public.payout_accounts
      WHERE business_id = p_business_id AND is_default = true AND is_active = true
  ) INTO v_has_default;

  INSERT INTO public.payout_accounts (
    business_id, gateway, square_merchant_id, square_location_id,
    platform_percentage, is_active, is_default, connection_mode,
    connection_status, health_status, verified_at
  ) VALUES (
    p_business_id, 'square', p_merchant_id, p_location_id,
    2.5, true, NOT v_has_default, 'connect', 'active', 'healthy', NOW()
  ) RETURNING id INTO v_new_id;

  INSERT INTO public.business_connection_secrets (
    payout_account_id, business_id, encrypted_secret_key, encrypted_refresh_token,
    token_expires_at, token_refreshed_at, token_scopes, key_identifier,
    verified_at, verification_method
  ) VALUES (
    v_new_id, p_business_id, p_encrypted_access, p_encrypted_refresh,
    p_token_expires_at, NOW(), p_token_scopes, p_key_identifier,
    NOW(), 'oauth_exchange'
  );

  IF NOT v_has_default THEN
    UPDATE public.businesses SET payout_mode = 'direct_split' WHERE id = p_business_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'connection_id', v_new_id,
    'is_default', NOT v_has_default, 'revoked_count', v_revoked
  );
END;
$$;

REVOKE ALL ON FUNCTION public.replace_square_connection_full(UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_square_connection_full(UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT)
  TO service_role;

-- ── 8. Token refresh lease RPCs ──
CREATE OR REPLACE FUNCTION public.acquire_refresh_lease(
  p_secret_id UUID, p_claim_token TEXT, p_lease_seconds INT DEFAULT 60
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_secret RECORD;
BEGIN
  IF p_secret_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_input');
  END IF;
  SELECT id, revoked_at, refresh_lease_token, refresh_lease_expires_at
    INTO v_secret FROM public.business_connection_secrets WHERE id = p_secret_id FOR UPDATE;
  IF v_secret IS NULL THEN RETURN jsonb_build_object('acquired', false, 'reason', 'not_found'); END IF;
  IF v_secret.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('acquired', false, 'reason', 'revoked'); END IF;
  IF v_secret.refresh_lease_token IS NOT NULL AND v_secret.refresh_lease_expires_at > NOW() THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'lease_held');
  END IF;
  UPDATE public.business_connection_secrets
    SET refresh_lease_token = p_claim_token,
        refresh_lease_expires_at = NOW() + (p_lease_seconds || ' seconds')::INTERVAL, updated_at = NOW()
    WHERE id = p_secret_id;
  RETURN jsonb_build_object('acquired', true);
END; $$;

CREATE OR REPLACE FUNCTION public.complete_refresh_lease(
  p_secret_id UUID, p_claim_token TEXT, p_new_access_token TEXT,
  p_new_refresh_token TEXT, p_new_expires_at TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_secret RECORD;
BEGIN
  IF p_secret_id IS NULL OR p_claim_token IS NULL OR p_new_access_token IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_input');
  END IF;
  SELECT id, refresh_lease_token, refresh_lease_expires_at, revoked_at
    INTO v_secret FROM public.business_connection_secrets WHERE id = p_secret_id FOR UPDATE;
  IF v_secret IS NULL THEN RETURN jsonb_build_object('success', false, 'reason', 'not_found'); END IF;
  IF v_secret.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'reason', 'revoked'); END IF;
  IF v_secret.refresh_lease_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_lease_owner');
  END IF;
  IF v_secret.refresh_lease_expires_at IS NOT NULL AND v_secret.refresh_lease_expires_at <= NOW() THEN
    RETURN jsonb_build_object('success', false, 'reason', 'lease_expired');
  END IF;
  UPDATE public.business_connection_secrets
    SET encrypted_secret_key = p_new_access_token,
        encrypted_refresh_token = COALESCE(NULLIF(p_new_refresh_token, ''), encrypted_refresh_token),
        token_expires_at = p_new_expires_at, token_refreshed_at = NOW(),
        refresh_lease_token = NULL, refresh_lease_expires_at = NULL, updated_at = NOW()
    WHERE id = p_secret_id;
  RETURN jsonb_build_object('success', true);
END; $$;

REVOKE ALL ON FUNCTION public.acquire_refresh_lease(UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_refresh_lease(UUID, TEXT, INT) TO service_role;
REVOKE ALL ON FUNCTION public.complete_refresh_lease(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_refresh_lease(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ── 9. Atomic refund reservation ──
CREATE OR REPLACE FUNCTION public.claim_refund_balance(
  p_payment_id UUID, p_refund_amount NUMERIC(12,2), p_idempotency_key TEXT,
  p_currency VARCHAR(3) DEFAULT 'USD', p_waaiio_fee_total NUMERIC(12,2) DEFAULT 0
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_payment RECORD; v_total_refunded NUMERIC(12,2); v_total_fee_reversed NUMERIC(12,2);
  v_remaining NUMERIC(12,2); v_planned_reversal NUMERIC(12,2); v_refund_id UUID; v_existing_id UUID;
  v_existing_fee NUMERIC(12,2); v_existing_amount NUMERIC(12,2);
BEGIN
  IF p_payment_id IS NULL OR p_refund_amount IS NULL OR p_refund_amount <= 0 THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'invalid_input');
  END IF;
  IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'invalid_input');
  END IF;
  SELECT id, amount, status, business_id, gateway, currency INTO v_payment
    FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF v_payment IS NULL THEN RETURN jsonb_build_object('claimed', false, 'reason', 'payment_not_found'); END IF;
  IF v_payment.status != 'success' THEN
    -- Allow replay of completed full refund (status='refunded')
    IF v_payment.status = 'refunded' THEN
      SELECT id, planned_fee_reversal, amount INTO v_existing_id, v_existing_fee, v_existing_amount
        FROM public.refunds
        WHERE payment_id = p_payment_id AND provider_idempotency_key = p_idempotency_key;
      IF v_existing_id IS NOT NULL THEN
        -- Reject key reuse with changed parameters
        IF v_existing_amount != p_refund_amount THEN
          RETURN jsonb_build_object('claimed', false, 'reason', 'parameter_mismatch', 'detail', 'amount');
        END IF;
        RETURN jsonb_build_object('claimed', true, 'refund_id', v_existing_id, 'existing', true,
          'planned_fee_reversal', COALESCE(v_existing_fee, 0));
      END IF;
    END IF;
    RETURN jsonb_build_object('claimed', false, 'reason', 'payment_not_successful');
  END IF;
  IF p_currency != v_payment.currency THEN RETURN jsonb_build_object('claimed', false, 'reason', 'currency_mismatch'); END IF;

  SELECT id, planned_fee_reversal, amount INTO v_existing_id, v_existing_fee, v_existing_amount
    FROM public.refunds
    WHERE payment_id = p_payment_id AND provider_idempotency_key = p_idempotency_key;
  IF v_existing_id IS NOT NULL THEN
    -- Reject key reuse with changed parameters
    IF v_existing_amount != p_refund_amount THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'parameter_mismatch', 'detail', 'amount');
    END IF;
    RETURN jsonb_build_object('claimed', true, 'refund_id', v_existing_id, 'existing', true,
      'planned_fee_reversal', COALESCE(v_existing_fee, 0));
  END IF;

  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(COALESCE(planned_fee_reversal, 0)), 0)
    INTO v_total_refunded, v_total_fee_reversed FROM public.refunds
    WHERE payment_id = p_payment_id AND status NOT IN ('failed');
  v_remaining := v_payment.amount - v_total_refunded;
  IF p_refund_amount > v_remaining THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'exceeds_balance',
      'remaining', v_remaining, 'requested', p_refund_amount);
  END IF;

  v_planned_reversal := 0;
  IF p_waaiio_fee_total > 0 AND v_payment.amount > 0 THEN
    v_planned_reversal := LEAST(
      ROUND(p_refund_amount / v_payment.amount * p_waaiio_fee_total, 2),
      p_waaiio_fee_total - v_total_fee_reversed
    );
    IF v_planned_reversal < 0 THEN v_planned_reversal := 0; END IF;
  END IF;

  INSERT INTO public.refunds (
    payment_id, business_id, amount, status, gateway,
    provider_idempotency_key, planned_fee_reversal, refund_type
  ) VALUES (
    p_payment_id, v_payment.business_id, p_refund_amount, 'pending',
    v_payment.gateway, p_idempotency_key, v_planned_reversal,
    CASE WHEN p_refund_amount >= v_payment.amount THEN 'full' ELSE 'partial' END
  ) RETURNING id INTO v_refund_id;

  RETURN jsonb_build_object('claimed', true, 'refund_id', v_refund_id,
    'planned_fee_reversal', v_planned_reversal, 'remaining_after', v_remaining - p_refund_amount);
END; $$;

REVOKE ALL ON FUNCTION public.claim_refund_balance(UUID, NUMERIC, TEXT, VARCHAR, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_refund_balance(UUID, NUMERIC, TEXT, VARCHAR, NUMERIC) TO service_role;

-- ── 10. Comprehensive atomic refund finalization ──
-- One transaction: refund status + payment totals + booking/reservation + fee reversal + payout adjustment
CREATE OR REPLACE FUNCTION public.finalize_square_refund(
  p_refund_id UUID, p_square_refund_id TEXT, p_final_status TEXT,
  p_fee_reversed NUMERIC(12,2) DEFAULT NULL,
  p_refund_reason TEXT DEFAULT NULL,
  p_initiated_by UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_refund RECORD;
  v_payment RECORD;
  v_new_refund_amount NUMERIC(12,2);
  v_is_fully_refunded BOOLEAN;
  v_fee RECORD;
  v_fee_entity_col TEXT;
  v_fee_entity_val UUID;
  v_payout RECORD;
BEGIN
  IF p_refund_id IS NULL OR p_square_refund_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_input');
  END IF;
  IF p_final_status NOT IN ('success', 'failed', 'review_required') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_status');
  END IF;

  -- Lock and read the refund
  SELECT id, status, payment_id, amount, gateway_refund_reference, business_id, planned_fee_reversal
    INTO v_refund FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_refund IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'refund_not_found');
  END IF;
  IF v_refund.status NOT IN ('pending', 'processing', 'review_required') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_finalized');
  END IF;
  IF v_refund.gateway_refund_reference IS NOT NULL
     AND v_refund.gateway_refund_reference != p_square_refund_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'refund_id_mismatch');
  END IF;

  -- Update refund status
  UPDATE public.refunds
    SET status = p_final_status,
        gateway_refund_reference = p_square_refund_id,
        planned_fee_reversal = COALESCE(p_fee_reversed, planned_fee_reversal)
    WHERE id = p_refund_id;

  -- Compute effective fee reversal (accounts for p_fee_reversed override)
  v_refund.planned_fee_reversal := COALESCE(p_fee_reversed, v_refund.planned_fee_reversal);

  -- For failed/review_required: no financial mutations (reservation released by status change)
  IF p_final_status != 'success' THEN
    RETURN jsonb_build_object('success', true, 'payment_id', v_refund.payment_id, 'financial', false);
  END IF;

  -- ── Success: apply all financial mutations ──

  -- Lock and read the payment
  SELECT id, amount, refund_amount, booking_id, reservation_id, invoice_id,
         campaign_id, order_id, business_id, gateway_reference, collection_mode
    INTO v_payment FROM public.payments WHERE id = v_refund.payment_id FOR UPDATE;

  IF v_payment IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'payment_not_found');
  END IF;

  -- Update payment refund totals
  v_new_refund_amount := COALESCE(v_payment.refund_amount, 0) + v_refund.amount;
  v_is_fully_refunded := (v_new_refund_amount >= v_payment.amount);

  UPDATE public.payments
    SET refund_amount = v_new_refund_amount,
        refund_reason = p_refund_reason,
        refunded_at = NOW(),
        refunded_by = p_initiated_by,
        status = CASE WHEN v_is_fully_refunded THEN 'refunded'::payment_status ELSE status END
    WHERE id = v_refund.payment_id;

  -- Update booking/reservation deposit status on full refund
  IF v_is_fully_refunded AND v_payment.booking_id IS NOT NULL THEN
    UPDATE public.bookings SET deposit_status = 'refunded' WHERE id = v_payment.booking_id;
  END IF;
  IF v_is_fully_refunded AND v_payment.reservation_id IS NOT NULL THEN
    UPDATE public.reservations SET deposit_status = 'refunded' WHERE id = v_payment.reservation_id;
  END IF;

  -- Fee reversal
  v_fee_entity_col := CASE
    WHEN v_payment.booking_id IS NOT NULL THEN 'booking_id'
    WHEN v_payment.invoice_id IS NOT NULL THEN 'invoice_id'
    WHEN v_payment.campaign_id IS NOT NULL THEN 'campaign_id'
    WHEN v_payment.order_id IS NOT NULL THEN 'order_id'
    WHEN v_payment.reservation_id IS NOT NULL THEN 'reservation_id'
    ELSE NULL
  END;
  v_fee_entity_val := COALESCE(
    v_payment.booking_id, v_payment.invoice_id, v_payment.campaign_id,
    v_payment.order_id, v_payment.reservation_id
  );

  -- Fee reversal — scoped by payment_id to avoid affecting other payments' fees
  -- platform_fees has a payment_id column (migration 248)
  IF v_is_fully_refunded THEN
    UPDATE public.platform_fees
      SET refunded_at = NOW()
      WHERE payment_id = v_refund.payment_id AND refunded_at IS NULL;
  ELSE
    -- Partial: use the refund row's fixed planned_fee_reversal for deterministic reduction
    SELECT id, fee_total INTO v_fee
      FROM public.platform_fees
      WHERE payment_id = v_refund.payment_id AND refunded_at IS NULL
      LIMIT 1;

    IF v_fee IS NOT NULL AND v_fee.fee_total > 0 THEN
      UPDATE public.platform_fees
        SET fee_total = GREATEST(0, fee_total - COALESCE(v_refund.planned_fee_reversal, 0))
        WHERE id = v_fee.id;
    END IF;
  END IF;

  -- Payout adjustment: only for platform-collected payments (not direct_split)
  IF v_payment.collection_mode != 'connect' THEN
    SELECT bp.id INTO v_payout
      FROM public.business_payouts bp, public.payments p
      WHERE p.id = v_refund.payment_id
        AND bp.business_id = v_refund.business_id
        AND bp.status = 'paid'
        AND bp.period_end >= p.created_at
      LIMIT 1;

    IF v_payout IS NOT NULL THEN
      INSERT INTO public.payout_adjustments (business_id, payout_id, amount, reason, payment_id)
      VALUES (v_refund.business_id, v_payout.id, -v_refund.amount,
              'Refund for payment ' || v_payment.gateway_reference, v_refund.payment_id);
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'payment_id', v_refund.payment_id, 'financial', true,
    'fully_refunded', v_is_fully_refunded);
END; $$;

REVOKE ALL ON FUNCTION public.finalize_square_refund(UUID, TEXT, TEXT, NUMERIC, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_square_refund(UUID, TEXT, TEXT, NUMERIC, TEXT, UUID) TO service_role;

-- ── 11. Atomic webhook event claim/reclaim ──
CREATE OR REPLACE FUNCTION public.claim_webhook_event(
  p_event_id TEXT, p_gateway TEXT, p_event_type TEXT,
  p_claim_token TEXT, p_lease_seconds INT DEFAULT 120
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_existing RECORD; v_inserted BOOLEAN := false;
BEGIN
  IF p_event_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('outcome', 'error', 'reason', 'invalid_input');
  END IF;
  BEGIN
    INSERT INTO public.processed_webhook_events (
      event_id, gateway, event_type, status, claim_token,
      lease_expires_at, first_received_at, last_attempted_at, attempts
    ) VALUES (
      p_event_id, p_gateway, p_event_type, 'processing', p_claim_token,
      NOW() + (p_lease_seconds || ' seconds')::INTERVAL, NOW(), NOW(), 1
    );
    v_inserted := true;
  EXCEPTION WHEN unique_violation THEN v_inserted := false;
  END;
  IF v_inserted THEN RETURN jsonb_build_object('outcome', 'claimed'); END IF;

  SELECT status, lease_expires_at, claim_token, attempts INTO v_existing
    FROM public.processed_webhook_events WHERE event_id = p_event_id FOR UPDATE;
  IF v_existing IS NULL THEN RETURN jsonb_build_object('outcome', 'error', 'reason', 'not_found'); END IF;
  IF v_existing.status = 'completed' THEN RETURN jsonb_build_object('outcome', 'duplicate'); END IF;
  IF v_existing.status = 'processing' AND v_existing.lease_expires_at > NOW() THEN
    RETURN jsonb_build_object('outcome', 'lease_active');
  END IF;

  UPDATE public.processed_webhook_events
    SET status = 'processing', claim_token = p_claim_token,
        lease_expires_at = NOW() + (p_lease_seconds || ' seconds')::INTERVAL,
        last_attempted_at = NOW(), attempts = COALESCE(v_existing.attempts, 0) + 1
    WHERE event_id = p_event_id AND status IN ('failed', 'processing');
  RETURN jsonb_build_object('outcome', 'retry');
END; $$;

REVOKE ALL ON FUNCTION public.claim_webhook_event(TEXT, TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_event(TEXT, TEXT, TEXT, TEXT, INT) TO service_role;

-- ── 12. Atomic OAuth revocation ──
CREATE OR REPLACE FUNCTION public.revoke_square_connection(
  p_merchant_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_conn RECORD; v_was_default BOOLEAN;
BEGIN
  IF p_merchant_id IS NULL THEN
    RETURN jsonb_build_object('revoked', false, 'reason', 'invalid_input');
  END IF;
  SELECT id, business_id, is_default INTO v_conn FROM public.payout_accounts
    WHERE gateway = 'square' AND square_merchant_id = p_merchant_id AND is_active = true
    FOR UPDATE;
  IF v_conn IS NULL THEN RETURN jsonb_build_object('revoked', false, 'reason', 'not_found'); END IF;

  v_was_default := v_conn.is_default;

  UPDATE public.payout_accounts
    SET is_active = false, connection_status = 'revoked', health_status = 'unhealthy',
        is_default = false, updated_at = NOW()
    WHERE id = v_conn.id;
  UPDATE public.business_connection_secrets
    SET revoked_at = NOW(), updated_at = NOW()
    WHERE payout_account_id = v_conn.id AND revoked_at IS NULL;

  -- If the revoked connection was default, check if any other active healthy default exists
  -- If not, reset payout_mode to platform_managed
  IF v_was_default THEN
    UPDATE public.businesses
      SET payout_mode = 'platform_managed'
      WHERE id = v_conn.business_id
      AND NOT EXISTS (
        SELECT 1 FROM public.payout_accounts
        WHERE business_id = v_conn.business_id AND is_active = true AND is_default = true
      );
  END IF;

  RETURN jsonb_build_object('revoked', true, 'connection_id', v_conn.id);
END; $$;

REVOKE ALL ON FUNCTION public.revoke_square_connection(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_square_connection(TEXT) TO service_role;

-- ── 13. Atomic non-Square refund finalization ──
-- One transaction: refund status + payment totals + booking/reservation + fee reversal + payout adjustment
-- Used by refund-handler.ts for Paystack, Stripe, Flutterwave, PayPal refunds
CREATE OR REPLACE FUNCTION public.finalize_refund_generic(
  p_refund_id UUID,
  p_gateway_refund_ref TEXT DEFAULT NULL,
  p_final_status TEXT DEFAULT 'success',
  p_gateway_response JSONB DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_refund RECORD;
  v_payment RECORD;
  v_new_refund_amount NUMERIC(12,2);
  v_is_fully_refunded BOOLEAN;
  v_fee RECORD;
BEGIN
  -- Input validation
  IF p_refund_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_input');
  END IF;
  IF p_final_status NOT IN ('success', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_status');
  END IF;

  -- Lock and read refund
  SELECT * INTO v_refund FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF v_refund IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'refund_not_found');
  END IF;
  IF v_refund.status IN ('success', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_finalized');
  END IF;

  -- Update refund status
  UPDATE public.refunds SET
    status = p_final_status,
    gateway_refund_reference = COALESCE(p_gateway_refund_ref, gateway_refund_reference),
    gateway_response = COALESCE(p_gateway_response, gateway_response)
  WHERE id = p_refund_id;

  -- For failed: no financial mutations
  IF p_final_status != 'success' THEN
    RETURN jsonb_build_object('success', true, 'financial', false);
  END IF;

  -- Lock and read payment
  SELECT id, amount, refund_amount, booking_id, reservation_id, invoice_id,
         campaign_id, order_id, business_id, gateway_reference, collection_mode
    INTO v_payment FROM public.payments WHERE id = v_refund.payment_id FOR UPDATE;
  IF v_payment IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'payment_not_found');
  END IF;

  -- Update payment refund totals
  v_new_refund_amount := COALESCE(v_payment.refund_amount, 0) + v_refund.amount;
  v_is_fully_refunded := (v_new_refund_amount >= v_payment.amount);

  UPDATE public.payments SET
    refund_amount = v_new_refund_amount,
    refunded_at = NOW(),
    status = CASE WHEN v_is_fully_refunded THEN 'refunded'::payment_status ELSE status END
  WHERE id = v_refund.payment_id;

  -- Booking/reservation deposit status
  IF v_is_fully_refunded AND v_payment.booking_id IS NOT NULL THEN
    UPDATE public.bookings SET deposit_status = 'refunded' WHERE id = v_payment.booking_id;
  END IF;
  IF v_is_fully_refunded AND v_payment.reservation_id IS NOT NULL THEN
    UPDATE public.reservations SET deposit_status = 'refunded' WHERE id = v_payment.reservation_id;
  END IF;

  -- Fee reversal — scoped by payment_id
  IF v_is_fully_refunded THEN
    UPDATE public.platform_fees SET refunded_at = NOW()
      WHERE payment_id = v_refund.payment_id AND refunded_at IS NULL;
  ELSE
    -- Proportional partial fee reversal
    SELECT id, fee_total, transaction_amount INTO v_fee
      FROM public.platform_fees WHERE payment_id = v_refund.payment_id AND refunded_at IS NULL LIMIT 1;
    IF v_fee IS NOT NULL AND v_fee.transaction_amount > 0 THEN
      UPDATE public.platform_fees SET
        fee_total = GREATEST(0, fee_total - ROUND(v_fee.fee_total * v_refund.amount / v_fee.transaction_amount, 2))
      WHERE id = v_fee.id;
    END IF;
  END IF;

  -- Payout adjustment: only for non-connect (platform held the funds)
  IF v_payment.collection_mode IS DISTINCT FROM 'connect' THEN
    DECLARE v_payout RECORD;
    BEGIN
      SELECT bp.id INTO v_payout
        FROM public.business_payouts bp, public.payments p
        WHERE p.id = v_refund.payment_id
          AND bp.business_id = v_refund.business_id
          AND bp.status = 'paid'
          AND bp.period_end >= p.created_at
        LIMIT 1;
      IF v_payout IS NOT NULL THEN
        INSERT INTO public.payout_adjustments (business_id, payout_id, amount, reason, payment_id)
        VALUES (v_refund.business_id, v_payout.id, -v_refund.amount,
                'Refund for payment ' || v_payment.gateway_reference, v_refund.payment_id);
      END IF;
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'financial', true, 'fully_refunded', v_is_fully_refunded);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_refund_generic(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_refund_generic(UUID, TEXT, TEXT, JSONB) TO service_role;
