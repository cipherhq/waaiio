-- Exact public source definition: 355_refund_convergence.sql
-- 7. Exactly-once finalization RPC

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

  -- Platform fee reversal
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

  -- Payout adjustment (atomic — no swallowed exceptions)
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
