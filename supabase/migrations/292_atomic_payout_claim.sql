-- Migration 292: Atomic payout execution for FIN-002
--
-- Prevents concurrent double-approval and provides provider idempotency.
-- PostgreSQL generates claim tokens and deterministic provider keys.
-- Application code cannot supply arbitrary values or status transitions.
--
-- Reserved in MIGRATION_REGISTRY.md by claude on 2026-07-26.

-- ── New columns on business_payouts ──

ALTER TABLE business_payouts
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS provider_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- Unique partial index: provider_idempotency_key must be unique when set.
-- Prevents the same deterministic key from being persisted twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_provider_idempotency_key
  ON business_payouts (provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- claim_payout_for_transfer
--
-- Atomically claims a payout for automated provider transfer.
-- PostgreSQL generates the claim_token and provider_idempotency_key.
-- Only paystack_transfer and stripe_transfer are accepted.
-- Returns the generated values only to the winning claimant.
-- A concurrent loser receives zero rows.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_payout_for_transfer(
  p_payout_id UUID,
  p_transfer_method TEXT,
  p_approved_by UUID DEFAULT NULL
)
RETURNS TABLE(
  claimed_id UUID,
  claimed_token UUID,
  idempotency_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token UUID;
  v_key TEXT;
BEGIN
  -- Only automated transfer methods may claim
  IF p_transfer_method NOT IN ('paystack_transfer', 'stripe_transfer') THEN
    RAISE EXCEPTION 'Unsupported transfer method: %', p_transfer_method
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Generate server-side values
  v_token := gen_random_uuid();
  v_key := 'payout_' || p_payout_id::text;

  RETURN QUERY
  UPDATE business_payouts
  SET
    status = 'processing',
    claim_token = v_token,
    provider_idempotency_key = v_key,
    processing_started_at = NOW(),
    transfer_method = p_transfer_method,
    approved_by = COALESCE(p_approved_by, approved_by),
    approved_at = COALESCE(approved_at, NOW()),
    updated_at = NOW()
  WHERE id = p_payout_id
    AND status IN ('pending', 'approved', 'held')
  RETURNING
    id AS claimed_id,
    claim_token AS claimed_token,
    provider_idempotency_key AS idempotency_key;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payout_for_transfer(UUID, TEXT, UUID) TO service_role;

-- ════════════════════════════════════════════════════════════
-- mark_payout_provider_submitted
--
-- After the provider accepts the transfer, persist the provider's
-- transfer code. Payout remains in 'processing' awaiting webhook.
-- Requires matching claim token and current status = processing.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mark_payout_provider_submitted(
  p_payout_id UUID,
  p_claim_token UUID,
  p_gateway_transfer_code TEXT
)
RETURNS TABLE(submitted_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_gateway_transfer_code IS NULL OR p_gateway_transfer_code = '' THEN
    RAISE EXCEPTION 'gateway_transfer_code is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  UPDATE business_payouts
  SET
    gateway_transfer_code = p_gateway_transfer_code,
    updated_at = NOW()
  WHERE id = p_payout_id
    AND claim_token = p_claim_token
    AND status = 'processing'
  RETURNING id AS submitted_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_payout_provider_submitted(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_payout_provider_submitted(UUID, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.mark_payout_provider_submitted(UUID, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payout_provider_submitted(UUID, UUID, TEXT) TO service_role;

-- ════════════════════════════════════════════════════════════
-- mark_payout_transfer_failed
--
-- Conclusive provider rejection. Changes processing → failed.
-- Cannot return to pending, approved or held.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mark_payout_transfer_failed(
  p_payout_id UUID,
  p_claim_token UUID
)
RETURNS TABLE(failed_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE business_payouts
  SET
    status = 'failed',
    updated_at = NOW()
  WHERE id = p_payout_id
    AND claim_token = p_claim_token
    AND status = 'processing'
  RETURNING id AS failed_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_payout_transfer_failed(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_payout_transfer_failed(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.mark_payout_transfer_failed(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payout_transfer_failed(UUID, UUID) TO service_role;

-- ════════════════════════════════════════════════════════════
-- mark_payout_review_required
--
-- Ambiguous provider outcome (timeout, connection reset, etc.).
-- Changes processing → review_required.
-- Preserves claim token, provider key and processing timestamp.
-- Cannot return to pending, approved or held.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mark_payout_review_required(
  p_payout_id UUID,
  p_claim_token UUID
)
RETURNS TABLE(review_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE business_payouts
  SET
    status = 'review_required',
    updated_at = NOW()
  WHERE id = p_payout_id
    AND claim_token = p_claim_token
    AND status = 'processing'
  RETURNING id AS review_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_payout_review_required(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_payout_review_required(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.mark_payout_review_required(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_payout_review_required(UUID, UUID) TO service_role;

-- ── Drop the old generic finalizer if it was created in a prior draft ──
DROP FUNCTION IF EXISTS public.finalize_payout_transfer(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ);
