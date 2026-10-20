-- ═══════════════════════════════════════════════════════════════════════════
-- M454: Force-settle already-executed bank transfer with refund reconciliation
--
-- PR #665: When a manual bank transfer has already been executed but a
-- concurrent refund reduces the available balance below the payout amount,
-- the normal confirm_manual_settlement RPC raises insufficient_balance.
--
-- This RPC allows an authorized admin to record the settlement WITH an
-- explicit reconciliation adjustment that accounts for the refund shortfall.
--
-- Requires: M453 (advisory lock coordination, confirm_manual_settlement)
-- ═══════════════════════════════════════════════════════════════════════════

-- §1. Extend step-up constraint with the recovery action
ALTER TABLE public.admin_step_up_authorizations
  DROP CONSTRAINT IF EXISTS admin_step_up_authorizations_action_type_check;

ALTER TABLE public.admin_step_up_authorizations
  ADD CONSTRAINT admin_step_up_authorizations_action_type_check
  CHECK (action_type IN (
    'payout_approve',
    'payout_reject',
    'payout_generate',
    'payout_confirm_settlement',
    'payout_force_settle',
    'provider_config',
    'team_grant',
    'team_revoke',
    'impersonate',
    'refund',
    'reseller_payout_approve',
    'reseller_payout_reject',
    'reseller_payout_mark_paid',
    'reseller_payout_generate',
    'commercial_config',
    'messaging_config',
    'messaging_suspension'
  ));

-- §2. Force-settle RPC
--
-- Atomically:
-- 1. Locks payout + advisory lock (serializes with refunds)
-- 2. Computes authoritative available balance
-- 3. If shortfall exists, inserts a payout_adjustment for the exact difference
-- 4. Transitions approved → paid
-- 5. Inserts audit log with reconciliation details
-- All in one transaction — any failure rolls back everything.

CREATE OR REPLACE FUNCTION public.force_settle_executed_transfer(
  p_payout_id     UUID,
  p_transfer_ref  TEXT,
  p_reason        TEXT,
  p_attestation   BOOLEAN,
  p_admin_id      UUID
)
RETURNS TABLE(settled_id UUID, adjustment_amount NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_payout RECORD;
  v_gross NUMERIC;
  v_fees NUMERIC;
  v_gw_fees NUMERIC;
  v_adj_sum NUMERIC;
  v_prior_paid NUMERIC;
  v_available NUMERIC;
  v_shortfall NUMERIC;
BEGIN
  -- Input validation
  IF p_attestation IS NOT TRUE THEN
    RAISE EXCEPTION 'attestation_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_transfer_ref IS NULL OR trim(p_transfer_ref) = '' THEN
    RAISE EXCEPTION 'transfer_reference_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'P0001';
  END IF;
  IF length(trim(p_transfer_ref)) > 100 THEN
    RAISE EXCEPTION 'transfer_reference_too_long' USING ERRCODE = 'P0001';
  END IF;

  -- Lock payout row
  SELECT id, business_id, net_amount, status, transfer_method
  INTO v_payout
  FROM public.business_payouts
  WHERE id = p_payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_payout.status <> 'approved' THEN
    RAISE EXCEPTION 'ineligible_status: %', v_payout.status USING ERRCODE = 'P0001';
  END IF;
  IF v_payout.transfer_method <> 'manual_bank' THEN
    RAISE EXCEPTION 'ineligible_method: %', v_payout.transfer_method USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock: serializes against finalize_refund_execution
  PERFORM pg_advisory_xact_lock(hashtext('payout_settle:' || v_payout.business_id::text));

  -- Authoritative balance check
  SELECT COALESCE(SUM(transaction_amount), 0),
         COALESCE(SUM(CASE WHEN NOT waived THEN fee_total ELSE 0 END), 0),
         COALESCE(SUM(gateway_fee), 0)
  INTO v_gross, v_fees, v_gw_fees
  FROM public.platform_fees
  WHERE business_id = v_payout.business_id
    AND is_direct_transfer = false AND refunded_at IS NULL;

  SELECT COALESCE(SUM(amount), 0) INTO v_adj_sum
  FROM public.payout_adjustments WHERE business_id = v_payout.business_id;

  SELECT COALESCE(SUM(net_amount), 0) INTO v_prior_paid
  FROM public.business_payouts
  WHERE business_id = v_payout.business_id
    AND status IN ('paid', 'processing', 'review_required')
    AND id <> p_payout_id;

  v_available := GREATEST(0, v_gross - v_fees - v_gw_fees + v_adj_sum - v_prior_paid);

  -- Calculate shortfall
  v_shortfall := v_payout.net_amount - v_available;

  -- If balance is sufficient, use normal settlement (no adjustment needed)
  -- If shortfall exists, create a reconciliation adjustment
  IF v_shortfall > 0.01 THEN
    INSERT INTO public.payout_adjustments (
      business_id, amount, reason, payment_id
    ) VALUES (
      v_payout.business_id,
      -v_shortfall,
      'Force-settle reconciliation: ' || trim(p_reason),
      NULL
    );
  ELSE
    v_shortfall := 0;
  END IF;

  -- Transition: approved → paid
  UPDATE public.business_payouts
  SET status = 'paid',
      transfer_reference = trim(p_transfer_ref),
      paid_at = NOW(),
      updated_at = NOW()
  WHERE id = p_payout_id
    AND status = 'approved'
    AND transfer_method = 'manual_bank';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cas_conflict' USING ERRCODE = 'P0001';
  END IF;

  -- Audit log with reconciliation details
  INSERT INTO public.admin_audit_logs (
    actor_id, action, entity_type, entity_id, details
  ) VALUES (
    p_admin_id,
    'force_settle_executed_transfer',
    'business_payout',
    p_payout_id,
    jsonb_build_object(
      'business_id', v_payout.business_id,
      'amount', v_payout.net_amount,
      'transfer_reference', trim(p_transfer_ref),
      'reason', trim(p_reason),
      'attestation', 'Admin attested that bank transfer was already executed',
      'shortfall', v_shortfall,
      'available_at_settlement', v_available,
      'reconciliation_adjustment', CASE WHEN v_shortfall > 0.01 THEN -v_shortfall ELSE 0 END
    )
  );

  RETURN QUERY SELECT p_payout_id, CASE WHEN v_shortfall > 0.01 THEN -v_shortfall ELSE 0::NUMERIC END;
END;
$$;

REVOKE ALL ON FUNCTION public.force_settle_executed_transfer(UUID, TEXT, TEXT, BOOLEAN, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_settle_executed_transfer(UUID, TEXT, TEXT, BOOLEAN, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.force_settle_executed_transfer(UUID, TEXT, TEXT, BOOLEAN, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.force_settle_executed_transfer(UUID, TEXT, TEXT, BOOLEAN, UUID) TO service_role;

-- §3. Verification
DO $$
DECLARE v_config text[];
BEGIN
  SELECT p.proconfig INTO v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'force_settle_executed_transfer';
  IF NOT ('search_path=public, extensions' = ANY(v_config)) THEN
    RAISE EXCEPTION 'force_settle_executed_transfer search_path incorrect: %', v_config;
  END IF;
END $$;
