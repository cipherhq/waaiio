-- M472: Reconcile finalize_refund_execution with corrected P1-4 fix.
--
-- Staging applied the original M469 body before the P1-4 correction that uses
-- platform_fees.created_at (fee allocation time) instead of payments.created_at
-- (payment initiation time) for payout-period matching. This migration
-- forward-patches the function to the authoritative definition.
--
-- Idempotent: CREATE OR REPLACE on a function that already has the corrected
-- body is a no-op (same definition). Fresh installations that applied the
-- corrected M469 source will see no behavioral change.
--
-- Does not touch confirm_manual_settlement or force_settle_executed_transfer
-- (those were not affected by P1-4).
--
-- Preserves: SECURITY DEFINER, SET search_path = '', advisory locking,
-- currency checks, legacy fee provenance, REVOKE/GRANT.
BEGIN;

-- Verify M469 dependencies are present before replacing the function.
DO $$ BEGIN
 IF to_regprocedure('public.finalize_refund_execution(uuid)') IS NULL THEN
   RAISE EXCEPTION 'M472 requires M469 finalize_refund_execution to exist';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='platform_fees' AND column_name='created_at') THEN
   RAISE EXCEPTION 'M472 requires platform_fees.created_at column';
 END IF;
END $$;

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
  v_payment_currency VARCHAR(3);
  v_legacy_fee_id UUID;
  v_legacy_fee_count INTEGER;
  v_entity_payment_count INTEGER;
  v_fee_allocated_at DATE;
BEGIN
  SELECT r.* INTO v_refund FROM public.refunds r WHERE r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'refund_not_found'); END IF;
  IF v_refund.status = 'success' THEN RETURN jsonb_build_object('finalized', true, 'reason', 'already_finalized'); END IF;
  IF v_refund.status != 'provider_success_unfinalized' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'invalid_state', 'current_status', v_refund.status);
  END IF;

  SELECT p.* INTO v_payment FROM public.payments p WHERE p.id = v_refund.payment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'payment_not_found'); END IF;

  IF v_payment.business_id IS DISTINCT FROM v_refund.business_id THEN
    RAISE EXCEPTION 'refund_business_mismatch' USING ERRCODE='P0001';
  END IF;
  v_payment_currency := v_payment.currency;
  IF v_payment_currency IS NULL OR v_payment_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'refund_currency_unclassified' USING ERRCODE='P0001';
  END IF;
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

  -- Scope fee reversal to the original payment. Legacy fees with a NULL
  -- payment_id may be used only when there is exactly one fee and one payment
  -- for the same business and whitelisted entity. Do not backfill payment_id.
  IF v_payment.booking_id IS NOT NULL THEN
    v_fee_entity_col := 'booking_id'; v_fee_entity_val := v_payment.booking_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN
    v_fee_entity_col := 'invoice_id'; v_fee_entity_val := v_payment.invoice_id;
  ELSIF v_payment.order_id IS NOT NULL THEN
    v_fee_entity_col := 'order_id'; v_fee_entity_val := v_payment.order_id;
  END IF;

  IF v_fee_entity_col IS NOT NULL THEN
    EXECUTE format('SELECT COUNT(*) FROM public.payments WHERE business_id=$1 AND %I=$2',v_fee_entity_col)
      INTO v_entity_payment_count USING v_refund.business_id,v_fee_entity_val;
    EXECUTE format('SELECT COUNT(*),MIN(id::text)::uuid FROM public.platform_fees WHERE business_id=$1 AND %I=$2 AND payment_id IS NULL',v_fee_entity_col)
      INTO v_legacy_fee_count,v_legacy_fee_id USING v_refund.business_id,v_fee_entity_val;
    IF v_legacy_fee_count > 0 AND
       (v_legacy_fee_count <> 1 OR v_entity_payment_count <> 1) THEN
      RAISE EXCEPTION 'refund_fee_payment_provenance_required' USING ERRCODE='P0001';
    END IF;
  END IF;

  IF v_is_fully_refunded THEN
    UPDATE public.platform_fees SET fee_total=0,refunded_at=now()
    WHERE business_id=v_refund.business_id
      AND (payment_id=v_payment.id OR id=v_legacy_fee_id)
      AND refunded_at IS NULL;
  ELSE
    FOR v_fee IN SELECT id,fee_total,fee_percentage,fee_flat,transaction_amount
      FROM public.platform_fees
      WHERE business_id=v_refund.business_id
        AND (payment_id=v_payment.id OR id=v_legacy_fee_id)
        AND refunded_at IS NULL
    LOOP
      IF v_fee.transaction_amount > 0 THEN
        v_fee_reduction := ROUND(
          (v_fee.fee_percentage / 100.0 * v_refund.amount)
          + (v_fee.fee_flat::NUMERIC * v_refund.amount / v_fee.transaction_amount)
        );
        UPDATE public.platform_fees
        SET fee_total=GREATEST(0,fee_total-v_fee_reduction)
        WHERE id=v_fee.id;
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM public.platform_fees f WHERE
    (f.payment_id=v_payment.id OR f.id=v_legacy_fee_id)
    AND f.business_id=v_refund.business_id AND f.is_direct_transfer=false) THEN
    -- Use the fee's created_at (allocation time) for payout-period matching,
    -- not payments.created_at. Payout generators filter by platform_fees.created_at,
    -- so that timestamp determines which period the fee was allocated to.
    SELECT f.created_at::date INTO v_fee_allocated_at FROM public.platform_fees f
    WHERE (f.payment_id=v_payment.id OR f.id=v_legacy_fee_id)
      AND f.business_id=v_refund.business_id AND f.is_direct_transfer=false
    ORDER BY f.created_at LIMIT 1;
    IF v_fee_allocated_at IS NULL THEN v_fee_allocated_at := v_payment.created_at::date; END IF;
    IF EXISTS (SELECT 1 FROM public.business_payouts bp WHERE bp.business_id=v_refund.business_id
      AND bp.status='paid' AND (bp.currency IS NULL OR bp.currency !~ '^[A-Z]{3}$')
      AND bp.period_start <= v_fee_allocated_at AND bp.period_end >= v_fee_allocated_at) THEN
      RAISE EXCEPTION 'refund_payout_currency_reconciliation_required' USING ERRCODE='P0001';
    END IF;
    -- Overlapping same-currency paid periods are ambiguous without an explicit
    -- payment-to-payout ledger link. Never choose an arbitrary candidate.
    IF (SELECT COUNT(*) FROM public.business_payouts bp
        WHERE bp.business_id=v_refund.business_id AND bp.status='paid'
          AND bp.currency=v_payment_currency
          AND bp.period_start <= v_fee_allocated_at
          AND bp.period_end >= v_fee_allocated_at) > 1 THEN
      RAISE EXCEPTION 'refund_payout_allocation_ambiguous' USING ERRCODE='P0001';
    END IF;
    SELECT bp.id INTO v_paid_payout FROM public.business_payouts bp
    WHERE bp.business_id=v_refund.business_id AND bp.status='paid'
      AND bp.currency=v_payment_currency
      AND bp.period_start <= v_fee_allocated_at AND bp.period_end >= v_fee_allocated_at
    ORDER BY bp.period_end DESC,bp.id LIMIT 1;
    IF FOUND THEN
      INSERT INTO public.payout_adjustments(business_id,payout_id,amount,reason,payment_id,currency)
      VALUES(v_refund.business_id,v_paid_payout.id,-v_refund.amount,
       'Refund for payment ' || v_payment.gateway_reference,v_refund.payment_id,v_payment_currency);
    END IF;
  END IF;
  UPDATE public.refunds SET status = 'success', finalized_at = now() WHERE id = p_refund_id;
  RETURN jsonb_build_object('finalized', true, 'fully_refunded', v_is_fully_refunded);
END;
$$;

-- Re-apply REVOKE/GRANT (idempotent — safe to repeat)
REVOKE ALL ON FUNCTION public.finalize_refund_execution(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_refund_execution(UUID) TO service_role;

-- Verify the corrected function contains the fee-allocation-time fix
DO $$
DECLARE v_src TEXT;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE oid = 'public.finalize_refund_execution(uuid)'::regprocedure;
  IF v_src NOT LIKE '%v_fee_allocated_at%' THEN
    RAISE EXCEPTION 'M472 verification FAILED: finalize_refund_execution missing v_fee_allocated_at';
  END IF;
  IF v_src NOT LIKE '%f.created_at::date INTO v_fee_allocated_at%' THEN
    RAISE EXCEPTION 'M472 verification FAILED: finalize_refund_execution missing fee created_at lookup';
  END IF;
  RAISE NOTICE 'M472: finalize_refund_execution reconciled with P1-4 fee-allocation-time fix';
END $$;

COMMIT;
