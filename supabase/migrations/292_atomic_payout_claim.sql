-- Migration 292: Atomic payout claim for FIN-002
--
-- Adds columns and an RPC to prevent concurrent double-approval of payouts.
-- Before calling a payment provider, the caller must claim the payout atomically.
-- Only one claimant succeeds; all others receive an empty result set.
--
-- Provider idempotency keys are persisted BEFORE the provider call so that
-- retries reuse the same key and the provider deduplicates naturally.

-- ── New columns on business_payouts ──

ALTER TABLE business_payouts
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS provider_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- ── Atomic claim RPC ──
-- Uses a conditional UPDATE ... WHERE status IN (...) RETURNING to ensure
-- exactly one concurrent caller succeeds. The claim transitions the payout
-- to 'processing' and persists the idempotency key before any provider call.

CREATE OR REPLACE FUNCTION public.claim_payout_for_transfer(
  p_payout_id UUID,
  p_claim_token UUID,
  p_idempotency_key TEXT,
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
BEGIN
  RETURN QUERY
  UPDATE business_payouts
  SET
    status = 'processing',
    claim_token = p_claim_token,
    provider_idempotency_key = p_idempotency_key,
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

-- Restrict access: only service_role may call this function
REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, UUID, TEXT, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, UUID, TEXT, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payout_for_transfer(UUID, UUID, TEXT, TEXT, UUID) TO service_role;

-- ── Finalize RPC ──
-- After the provider call, finalize the payout with the correct claim token.
-- Only the original claimant can finalize. This prevents stale workers from
-- overwriting a newer claim's result.

CREATE OR REPLACE FUNCTION public.finalize_payout_transfer(
  p_payout_id UUID,
  p_claim_token UUID,
  p_status TEXT,
  p_gateway_transfer_code TEXT DEFAULT NULL,
  p_paid_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(finalized_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE business_payouts
  SET
    status = p_status,
    gateway_transfer_code = COALESCE(p_gateway_transfer_code, gateway_transfer_code),
    paid_at = p_paid_at,
    updated_at = NOW()
  WHERE id = p_payout_id
    AND claim_token = p_claim_token
    AND status = 'processing'
  RETURNING id AS finalized_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_payout_transfer(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_payout_transfer(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_payout_transfer(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_payout_transfer(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
