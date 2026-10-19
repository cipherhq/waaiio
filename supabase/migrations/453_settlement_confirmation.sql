-- ═══════════════════════════════════════════════════════════════════════════
-- M453: Settlement confirmation — atomic RPC, step-up constraint, claim guard,
--       refund/settlement synchronization via advisory lock
--
-- PR #665: Manual bank transfer settlement requires:
-- 1. DB CHECK constraint for payout_confirm_settlement step-up action
-- 2. Atomic confirm_manual_settlement RPC (balance check + CAS + audit in
--    one transaction, serialized against refund finalization)
-- 3. claim_payout_for_transfer guard against manual_bank payouts
-- 4. finalize_refund_execution advisory lock coordination
--
-- Concurrency design:
--   Both confirm_manual_settlement and finalize_refund_execution acquire
--   pg_advisory_xact_lock(hashtext('payout_settle:' || business_id))
--   BEFORE reading platform_fees or transitioning payout status.
--   This serializes the two operations for the same business within
--   their respective transactions, closing the refund/settlement race.
-- ═══════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════
-- §1. Extend step-up action_type CHECK constraint
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.admin_step_up_authorizations
  DROP CONSTRAINT IF EXISTS admin_step_up_authorizations_action_type_check;

ALTER TABLE public.admin_step_up_authorizations
  ADD CONSTRAINT admin_step_up_authorizations_action_type_check
  CHECK (action_type IN (
    'payout_approve',
    'payout_reject',
    'payout_generate',
    'payout_confirm_settlement',
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

-- ════════════════════════════════════════════════════════════
-- §2. Atomic settlement confirmation RPC
--
-- Single transaction with advisory lock serialization:
-- 1. Acquire advisory lock on business_id (coordinates with finalize_refund_execution)
-- 2. Lock the payout row FOR UPDATE
-- 3. Compute authoritative available balance from platform_fees (under the lock)
-- 4. Verify balance sufficiency
-- 5. Transition approved → paid
-- 6. Insert audit log
-- If any step fails, the entire transaction rolls back.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.confirm_manual_settlement(
  p_payout_id       UUID,
  p_transfer_ref    TEXT,
  p_attestation     BOOLEAN,
  p_admin_id        UUID
)
RETURNS TABLE(confirmed_id UUID)
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
BEGIN
  -- Validate inputs before any locking
  IF p_attestation IS NOT TRUE THEN
    RAISE EXCEPTION 'attestation_required'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_transfer_ref IS NULL OR trim(p_transfer_ref) = '' THEN
    RAISE EXCEPTION 'transfer_reference_required'
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock the payout row
  SELECT id, business_id, net_amount, status, transfer_method
  INTO v_payout
  FROM public.business_payouts
  WHERE id = p_payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_payout.status <> 'approved' THEN
    RAISE EXCEPTION 'ineligible_status: %', v_payout.status
      USING ERRCODE = 'P0001';
  END IF;

  IF v_payout.transfer_method <> 'manual_bank' THEN
    RAISE EXCEPTION 'ineligible_method: %', v_payout.transfer_method
      USING ERRCODE = 'P0001';
  END IF;

  -- Advisory lock: serializes against finalize_refund_execution for this business.
  -- Both RPCs acquire this lock before reading platform_fees or transitioning payouts.
  PERFORM pg_advisory_xact_lock(hashtext('payout_settle:' || v_payout.business_id::text));

  -- Authoritative balance check UNDER the advisory lock.
  -- Same formula as computePlatformHeldTotals in payable-fees.ts:
  --   eligible = platform_fees WHERE is_direct_transfer = false AND refunded_at IS NULL
  --   gross = SUM(transaction_amount)
  --   fees = SUM(fee_total) WHERE NOT waived
  --   gw = SUM(gateway_fee)
  --   adj = SUM(payout_adjustments.amount)
  --   prior = SUM(business_payouts.net_amount) WHERE status IN (paid,processing,review_required) AND id != this
  --   available = MAX(0, gross - fees - gw + adj - prior)

  SELECT COALESCE(SUM(transaction_amount), 0),
         COALESCE(SUM(CASE WHEN NOT waived THEN fee_total ELSE 0 END), 0),
         COALESCE(SUM(gateway_fee), 0)
  INTO v_gross, v_fees, v_gw_fees
  FROM public.platform_fees
  WHERE business_id = v_payout.business_id
    AND is_direct_transfer = false
    AND refunded_at IS NULL;

  SELECT COALESCE(SUM(amount), 0) INTO v_adj_sum
  FROM public.payout_adjustments
  WHERE business_id = v_payout.business_id;

  SELECT COALESCE(SUM(net_amount), 0) INTO v_prior_paid
  FROM public.business_payouts
  WHERE business_id = v_payout.business_id
    AND status IN ('paid', 'processing', 'review_required')
    AND id <> p_payout_id;

  v_available := GREATEST(0, v_gross - v_fees - v_gw_fees + v_adj_sum - v_prior_paid);

  IF v_payout.net_amount > v_available + 0.01 THEN
    RAISE EXCEPTION 'insufficient_balance: payout=%, available=%', v_payout.net_amount, v_available
      USING ERRCODE = 'P0001';
  END IF;

  -- Atomic transition: approved → paid
  UPDATE public.business_payouts
  SET status = 'paid',
      transfer_reference = trim(p_transfer_ref),
      paid_at = NOW(),
      updated_at = NOW()
  WHERE id = p_payout_id
    AND status = 'approved'
    AND transfer_method = 'manual_bank';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cas_conflict'
      USING ERRCODE = 'P0001';
  END IF;

  -- Atomic audit log — same transaction, rolls back with status change
  INSERT INTO public.admin_audit_logs (
    actor_id, action, entity_type, entity_id, details
  ) VALUES (
    p_admin_id,
    'confirm_payout_settlement',
    'business_payout',
    p_payout_id::text,
    jsonb_build_object(
      'business_id', v_payout.business_id,
      'amount', v_payout.net_amount,
      'transfer_reference', trim(p_transfer_ref),
      'attestation', 'Admin attested that the bank transfer has been completed'
    )
  );

  RETURN QUERY SELECT p_payout_id AS confirmed_id;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_manual_settlement(UUID, TEXT, BOOLEAN, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_manual_settlement(UUID, TEXT, BOOLEAN, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.confirm_manual_settlement(UUID, TEXT, BOOLEAN, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_manual_settlement(UUID, TEXT, BOOLEAN, UUID) TO service_role;

-- ════════════════════════════════════════════════════════════
-- §3. Add advisory lock to finalize_refund_execution
--
-- Replaces M355 version. The ONLY change is adding the advisory
-- lock before reading/writing platform_fees and business_payouts.
-- All other logic is preserved exactly from M355.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.finalize_refund_execution(p_refund_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund RECORD; v_payment RECORD;
  v_new_refund_amount NUMERIC; v_is_fully_refunded BOOLEAN;
  v_fee_entity_col TEXT; v_fee_entity_val UUID;
  v_fee RECORD; v_fee_reduction NUMERIC;
  v_paid_payout RECORD;
BEGIN
  SELECT r.* INTO v_refund FROM public.refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'refund_not_found'); END IF;
  IF v_refund.status = 'success' THEN RETURN jsonb_build_object('finalized', true, 'reason', 'already_finalized'); END IF;
  IF v_refund.status != 'provider_success_unfinalized' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'invalid_state', 'current_status', v_refund.status);
  END IF;

  SELECT p.* INTO v_payment FROM public.payments p WHERE p.id = v_refund.payment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'payment_not_found'); END IF;

  -- Advisory lock: serializes against confirm_manual_settlement for this business.
  PERFORM pg_advisory_xact_lock(hashtext('payout_settle:' || v_refund.business_id::text));

  v_new_refund_amount := COALESCE(v_payment.refund_amount, 0) + v_refund.amount;
  v_is_fully_refunded := v_new_refund_amount >= v_payment.amount;

  UPDATE public.payments
  SET refund_amount = v_new_refund_amount, refund_reason = v_refund.reason,
      refunded_at = now(), refunded_by = v_refund.initiated_by,
      status = CASE WHEN v_is_fully_refunded THEN 'refunded'::public.payment_status ELSE status END
  WHERE id = v_refund.payment_id;

  IF v_is_fully_refunded AND v_payment.booking_id IS NOT NULL THEN
    UPDATE public.bookings SET deposit_status = 'refunded' WHERE id = v_payment.booking_id;
  END IF;
  IF v_is_fully_refunded AND v_payment.reservation_id IS NOT NULL THEN
    UPDATE public.reservations SET deposit_status = 'refunded' WHERE id = v_payment.reservation_id;
  END IF;

  IF v_payment.booking_id IS NOT NULL THEN v_fee_entity_col := 'booking_id'; v_fee_entity_val := v_payment.booking_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN v_fee_entity_col := 'invoice_id'; v_fee_entity_val := v_payment.invoice_id;
  ELSIF v_payment.order_id IS NOT NULL THEN v_fee_entity_col := 'order_id'; v_fee_entity_val := v_payment.order_id;
  END IF;

  IF v_fee_entity_col IS NOT NULL AND v_fee_entity_val IS NOT NULL THEN
    IF v_is_fully_refunded THEN
      EXECUTE format('UPDATE public.platform_fees SET fee_total = 0, refunded_at = now() WHERE %I = $1 AND refunded_at IS NULL', v_fee_entity_col) USING v_fee_entity_val;
    ELSE
      EXECUTE format('SELECT id, fee_total, fee_percentage, fee_flat, transaction_amount FROM public.platform_fees WHERE %I = $1 AND refunded_at IS NULL LIMIT 1', v_fee_entity_col) INTO v_fee USING v_fee_entity_val;
      IF v_fee IS NOT NULL AND v_fee.transaction_amount > 0 THEN
        v_fee_reduction := ROUND((v_fee.fee_percentage / 100.0 * v_refund.amount) + (v_fee.fee_flat::NUMERIC * v_refund.amount / v_fee.transaction_amount));
        UPDATE public.platform_fees SET fee_total = GREATEST(0, fee_total - v_fee_reduction) WHERE id = v_fee.id;
      END IF;
    END IF;
  END IF;

  SELECT bp.id INTO v_paid_payout FROM public.business_payouts bp
  WHERE bp.business_id = v_refund.business_id AND bp.status = 'paid' AND bp.period_end >= v_payment.created_at LIMIT 1;
  IF FOUND THEN
    INSERT INTO public.payout_adjustments (business_id, payout_id, amount, reason, payment_id)
    VALUES (v_refund.business_id, v_paid_payout.id, -v_refund.amount, 'Refund for payment ' || v_payment.gateway_reference, v_refund.payment_id);
  END IF;

  UPDATE public.refunds SET status = 'success', finalized_at = now() WHERE id = p_refund_id;
  RETURN jsonb_build_object('finalized', true, 'fully_refunded', v_is_fully_refunded);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_refund_execution(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_refund_execution(UUID) TO service_role;

-- ════════════════════════════════════════════════════════════
-- §4. Guard claim_payout_for_transfer against manual_bank payouts
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_payout_for_transfer(
  p_payout_id       UUID,
  p_transfer_method TEXT,
  p_approved_by     UUID DEFAULT NULL
)
RETURNS TABLE(
  claimed_id        UUID,
  claimed_token     UUID,
  idempotency_key   TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token UUID;
  v_key TEXT;
BEGIN
  IF p_transfer_method NOT IN ('paystack_transfer', 'stripe_transfer') THEN
    RAISE EXCEPTION 'Unsupported transfer method: %', p_transfer_method
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_token := gen_random_uuid();
  v_key := 'payout_' || p_payout_id::text;

  UPDATE public.business_payouts
  SET status = 'processing',
    transfer_method = p_transfer_method,
    claim_token = v_token,
    provider_idempotency_key = v_key,
    approved_by = COALESCE(p_approved_by, approved_by),
    approved_at = COALESCE(approved_at, NOW()),
    updated_at = NOW()
  WHERE id = p_payout_id
    AND status IN ('pending', 'approved', 'held')
    AND (transfer_method IS NULL OR transfer_method IS DISTINCT FROM 'manual_bank')
  RETURNING
    id AS claimed_id,
    claim_token AS claimed_token,
    provider_idempotency_key AS idempotency_key
  INTO claimed_id, claimed_token, idempotency_key;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.claim_payout_for_transfer(UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payout_for_transfer(UUID, TEXT, UUID) TO service_role;

-- ════════════════════════════════════════════════════════════
-- §5. Verification
-- ════════════════════════════════════════════════════════════

-- Verify confirm_manual_settlement search_path
DO $$
DECLARE v_config text[];
BEGIN
  SELECT p.proconfig INTO v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'confirm_manual_settlement';
  IF NOT ('search_path=public, extensions' = ANY(v_config)) THEN
    RAISE EXCEPTION 'confirm_manual_settlement search_path incorrect: %', v_config;
  END IF;
END $$;

-- Verify claim_payout_for_transfer search_path
DO $$
DECLARE v_config text[];
BEGIN
  SELECT p.proconfig INTO v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'claim_payout_for_transfer';
  IF NOT ('search_path=public' = ANY(v_config)) THEN
    RAISE EXCEPTION 'claim_payout_for_transfer search_path incorrect: %', v_config;
  END IF;
END $$;
