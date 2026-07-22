-- ═══════════════════════════════════════════════════════
-- 271: Replace apply_invoice_payment with overpayment tracking
-- Records full payment amount in fees, applies only invoice balance,
-- returns overpayment_amount for caller to handle.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.apply_invoice_payment(
  p_invoice_id UUID,
  p_payment_id UUID,
  p_payment_amount NUMERIC,
  p_business_id UUID,
  p_fee_percentage NUMERIC DEFAULT 0,
  p_fee_flat NUMERIC DEFAULT 0,
  p_fee_total NUMERIC DEFAULT 0,
  p_gateway_fee NUMERIC DEFAULT 0,
  p_tier TEXT DEFAULT 'free'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice RECORD;
  v_balance_remaining NUMERIC;
  v_applied_amount NUMERIC;
  v_overpayment NUMERIC;
  v_new_amount_paid NUMERIC;
  v_is_fully_paid BOOLEAN;
BEGIN
  -- Input validation
  IF p_payment_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Idempotency: check if this payment was already applied anywhere
  IF EXISTS (SELECT 1 FROM public.platform_fees WHERE payment_id = p_payment_id) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_applied');
  END IF;

  -- Lock and read the invoice
  SELECT total_amount, amount_paid, status, business_id
  INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF v_invoice IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invoice_not_found');
  END IF;

  -- Verify business ownership
  IF v_invoice.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch');
  END IF;

  IF v_invoice.status = 'paid' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_paid');
  END IF;

  -- Calculate applied vs overpayment (never silently discard excess)
  v_balance_remaining := v_invoice.total_amount - COALESCE(v_invoice.amount_paid, 0);
  v_applied_amount := LEAST(p_payment_amount, v_balance_remaining);
  v_overpayment := p_payment_amount - v_applied_amount;
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_applied_amount;
  v_is_fully_paid := v_new_amount_paid >= v_invoice.total_amount;

  -- Update invoice with only the applied amount
  UPDATE public.invoices
  SET amount_paid = v_new_amount_paid,
      status = CASE WHEN v_is_fully_paid THEN 'paid' ELSE status END,
      paid_at = CASE WHEN v_is_fully_paid THEN NOW() ELSE paid_at END
  WHERE id = p_invoice_id;

  -- Record platform fee on FULL payment amount (traceable)
  INSERT INTO public.platform_fees (
    business_id, invoice_id, payment_id,
    transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee, tier
  ) VALUES (
    p_business_id, p_invoice_id, p_payment_id,
    p_payment_amount, p_fee_percentage, p_fee_flat, p_fee_total, p_gateway_fee,
    p_tier::public.subscription_tier
  );

  RETURN jsonb_build_object(
    'success', true,
    'new_amount_paid', v_new_amount_paid,
    'is_fully_paid', v_is_fully_paid,
    'applied_amount', v_applied_amount,
    'overpayment_amount', v_overpayment
  );
END;
$$;
