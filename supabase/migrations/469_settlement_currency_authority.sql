-- M469 currency-isolated settlement/refund RPCs. M453/M454/M466/M468 required.
-- M467 pricing is independent. No historical backfill.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='business_payouts' AND column_name='currency')
 OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payout_adjustments' AND column_name='currency')
 OR to_regprocedure('public.confirm_manual_settlement(uuid,text,boolean,uuid)') IS NULL
 OR to_regprocedure('public.force_settle_executed_transfer(uuid,text,text,boolean,uuid)') IS NULL
 OR to_regprocedure('public.finalize_refund_execution(uuid)') IS NULL
 OR NOT EXISTS (
   SELECT 1 FROM pg_indexes WHERE schemaname='public'
    AND indexname='idx_business_payouts_period_unique'
    AND indexdef LIKE '%COALESCE%currency%'
 )
 THEN RAISE EXCEPTION 'M469 dependencies M453 M454 M466 M468 not ready'; END IF;
END $$;


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
  SELECT id, business_id, net_amount, status, transfer_method, currency
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

 IF v_payout.currency IS NULL OR v_payout.currency !~ '^[A-Z]{3}$' THEN
   RAISE EXCEPTION 'currency_reconciliation_required:payout' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.business_payouts h WHERE h.business_id=v_payout.business_id
  AND (h.currency IS NULL OR h.currency !~ '^[A-Z]{3}$')) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:payout_history' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.payout_adjustments h WHERE h.business_id=v_payout.business_id
  AND (h.currency IS NULL OR h.currency !~ '^[A-Z]{3}$')) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:adjustments' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.platform_fees f LEFT JOIN public.payments pay ON pay.id=f.payment_id
  WHERE f.business_id=v_payout.business_id AND f.is_direct_transfer=false AND f.refunded_at IS NULL
   AND (pay.id IS NULL OR pay.currency IS NULL OR pay.currency !~ '^[A-Z]{3}$'
    OR pay.business_id IS DISTINCT FROM v_payout.business_id)) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:fees' USING ERRCODE='P0001';
 END IF;


  -- Authoritative balance check UNDER the advisory lock.
  -- Same formula as computePlatformHeldTotals in payable-fees.ts:
  --   eligible = platform_fees WHERE is_direct_transfer = false AND refunded_at IS NULL
  --   gross = SUM(transaction_amount)
  --   fees = SUM(fee_total) WHERE NOT waived
  --   gw = SUM(gateway_fee)
  --   adj = SUM(payout_adjustments.amount)
  --   prior = SUM(business_payouts.net_amount) WHERE status IN (paid,processing,review_required) AND id != this
  --   available = MAX(0, gross - fees - gw + adj - prior)

  SELECT COALESCE(SUM(f.transaction_amount),0),
    COALESCE(SUM(CASE WHEN NOT f.waived THEN f.fee_total ELSE 0 END),0),
    COALESCE(SUM(f.gateway_fee),0)
  INTO v_gross,v_fees,v_gw_fees
  FROM public.platform_fees f JOIN public.payments pay ON pay.id=f.payment_id
  WHERE f.business_id=v_payout.business_id AND f.is_direct_transfer=false
   AND f.refunded_at IS NULL AND pay.currency=v_payout.currency
   AND pay.business_id=v_payout.business_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_adj_sum
  FROM public.payout_adjustments
  WHERE business_id = v_payout.business_id AND currency = v_payout.currency;

  SELECT COALESCE(SUM(net_amount), 0) INTO v_prior_paid
  FROM public.business_payouts
  WHERE business_id = v_payout.business_id
    AND status IN ('paid', 'processing', 'review_required', 'approved')
    AND id <> p_payout_id AND currency = v_payout.currency;

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
    p_payout_id,
    jsonb_build_object(
      'business_id', v_payout.business_id,
      'amount', v_payout.net_amount,
      'currency', v_payout.currency,
      'transfer_reference', trim(p_transfer_ref),
      'attestation', 'Admin attested that the bank transfer has been completed'
    )
  );

  RETURN QUERY SELECT p_payout_id AS confirmed_id;
END;
$$;

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
  SELECT id, business_id, net_amount, status, transfer_method, currency
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

 IF v_payout.currency IS NULL OR v_payout.currency !~ '^[A-Z]{3}$' THEN
   RAISE EXCEPTION 'currency_reconciliation_required:payout' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.business_payouts h WHERE h.business_id=v_payout.business_id
  AND (h.currency IS NULL OR h.currency !~ '^[A-Z]{3}$')) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:payout_history' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.payout_adjustments h WHERE h.business_id=v_payout.business_id
  AND (h.currency IS NULL OR h.currency !~ '^[A-Z]{3}$')) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:adjustments' USING ERRCODE='P0001';
 END IF;
 IF EXISTS (SELECT 1 FROM public.platform_fees f LEFT JOIN public.payments pay ON pay.id=f.payment_id
  WHERE f.business_id=v_payout.business_id AND f.is_direct_transfer=false AND f.refunded_at IS NULL
   AND (pay.id IS NULL OR pay.currency IS NULL OR pay.currency !~ '^[A-Z]{3}$'
    OR pay.business_id IS DISTINCT FROM v_payout.business_id)) THEN
   RAISE EXCEPTION 'currency_reconciliation_required:fees' USING ERRCODE='P0001';
 END IF;


  -- Authoritative balance check
  SELECT COALESCE(SUM(f.transaction_amount),0),
    COALESCE(SUM(CASE WHEN NOT f.waived THEN f.fee_total ELSE 0 END),0),
    COALESCE(SUM(f.gateway_fee),0)
  INTO v_gross,v_fees,v_gw_fees
  FROM public.platform_fees f JOIN public.payments pay ON pay.id=f.payment_id
  WHERE f.business_id=v_payout.business_id AND f.is_direct_transfer=false
   AND f.refunded_at IS NULL AND pay.currency=v_payout.currency
   AND pay.business_id=v_payout.business_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_adj_sum
  FROM public.payout_adjustments WHERE business_id = v_payout.business_id AND currency = v_payout.currency;

  SELECT COALESCE(SUM(net_amount), 0) INTO v_prior_paid
  FROM public.business_payouts
  WHERE business_id = v_payout.business_id
    AND status IN ('paid', 'processing', 'review_required', 'approved')
    AND id <> p_payout_id AND currency = v_payout.currency;

  v_available := GREATEST(0, v_gross - v_fees - v_gw_fees + v_adj_sum - v_prior_paid);

  -- Calculate shortfall
  v_shortfall := v_payout.net_amount - v_available;

  -- If balance is sufficient, use normal settlement (no adjustment needed)
  -- If shortfall exists, create a reconciliation adjustment
  IF v_shortfall > 0.01 THEN
    INSERT INTO public.payout_adjustments (
      business_id, amount, reason, payment_id, currency
    ) VALUES (
      v_payout.business_id,
      -v_shortfall,
      'Force-settle reconciliation: ' || trim(p_reason),
      NULL,
      v_payout.currency
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
      'currency', v_payout.currency,
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
    EXECUTE format('SELECT COUNT(*),MIN(id) FROM public.platform_fees WHERE business_id=$1 AND %I=$2 AND payment_id IS NULL',v_fee_entity_col)
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

  IF EXISTS (SELECT 1 FROM public.platform_fees f WHERE f.payment_id=v_payment.id
    AND f.business_id=v_refund.business_id AND f.is_direct_transfer=false) THEN
    IF EXISTS (SELECT 1 FROM public.business_payouts bp WHERE bp.business_id=v_refund.business_id
      AND bp.status='paid' AND (bp.currency IS NULL OR bp.currency !~ '^[A-Z]{3}$')
      AND bp.period_start <= v_payment.created_at::date AND bp.period_end >= v_payment.created_at::date) THEN
      RAISE EXCEPTION 'refund_payout_currency_reconciliation_required' USING ERRCODE='P0001';
    END IF;
    -- Overlapping same-currency paid periods are ambiguous without an explicit
    -- payment-to-payout ledger link. Never choose an arbitrary candidate.
    IF (SELECT COUNT(*) FROM public.business_payouts bp
        WHERE bp.business_id=v_refund.business_id AND bp.status='paid'
          AND bp.currency=v_payment_currency
          AND bp.period_start <= v_payment.created_at::date
          AND bp.period_end >= v_payment.created_at::date) > 1 THEN
      RAISE EXCEPTION 'refund_payout_allocation_ambiguous' USING ERRCODE='P0001';
    END IF;
    SELECT bp.id INTO v_paid_payout FROM public.business_payouts bp
    WHERE bp.business_id=v_refund.business_id AND bp.status='paid'
      AND bp.currency=v_payment_currency
      AND bp.period_start <= v_payment.created_at::date AND bp.period_end >= v_payment.created_at::date
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


REVOKE ALL ON FUNCTION public.confirm_manual_settlement(UUID,TEXT,BOOLEAN,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.force_settle_executed_transfer(UUID,TEXT,TEXT,BOOLEAN,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finalize_refund_execution(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_manual_settlement(UUID,TEXT,BOOLEAN,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.force_settle_executed_transfer(UUID,TEXT,TEXT,BOOLEAN,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_refund_execution(UUID) TO service_role;
COMMIT;
