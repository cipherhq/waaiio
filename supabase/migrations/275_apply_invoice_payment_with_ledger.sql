-- ═══════════════════════════════════════════════════════
-- 275: apply_invoice_payment with immutable ledger record
-- On retry/concurrent call, returns the existing application
-- record without changing any balances.
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
  v_existing RECORD;
  v_balance_remaining NUMERIC;
  v_applied_amount NUMERIC;
  v_overpayment NUMERIC;
  v_new_amount_paid NUMERIC;
  v_is_fully_paid BOOLEAN;
  v_resulting_status TEXT;
  v_currency TEXT;
BEGIN
  -- Input validation
  IF p_payment_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Idempotency: return existing application record without changing balances
  SELECT amount_received, amount_applied, overpayment_amount, resulting_invoice_status
  INTO v_existing
  FROM public.invoice_payment_applications
  WHERE invoice_id = p_invoice_id AND payment_id = p_payment_id;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'already_applied',
      'applied_amount', v_existing.amount_applied,
      'overpayment_amount', v_existing.overpayment_amount,
      'resulting_status', v_existing.resulting_invoice_status
    );
  END IF;

  -- Also check platform_fees for backwards compatibility
  IF EXISTS (SELECT 1 FROM public.platform_fees WHERE payment_id = p_payment_id) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_applied');
  END IF;

  -- Lock and read the invoice
  SELECT total_amount, amount_paid, status, business_id, currency
  INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF v_invoice IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invoice_not_found');
  END IF;

  IF v_invoice.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch');
  END IF;

  IF v_invoice.status = 'paid' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_paid');
  END IF;

  -- Calculate applied vs overpayment
  v_balance_remaining := v_invoice.total_amount - COALESCE(v_invoice.amount_paid, 0);
  v_applied_amount := LEAST(p_payment_amount, v_balance_remaining);
  v_overpayment := p_payment_amount - v_applied_amount;
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_applied_amount;
  v_is_fully_paid := v_new_amount_paid >= v_invoice.total_amount;
  v_resulting_status := CASE WHEN v_is_fully_paid THEN 'paid' ELSE v_invoice.status END;
  v_currency := COALESCE(v_invoice.currency, 'NGN');

  -- Update invoice with only the applied amount
  UPDATE public.invoices
  SET amount_paid = v_new_amount_paid,
      status = v_resulting_status,
      paid_at = CASE WHEN v_is_fully_paid THEN NOW() ELSE paid_at END
  WHERE id = p_invoice_id;

  -- Immutable ledger record (UNIQUE constraint is the final backstop)
  INSERT INTO public.invoice_payment_applications (
    payment_id, invoice_id, business_id, currency,
    amount_received, amount_applied, overpayment_amount,
    resulting_invoice_status
  ) VALUES (
    p_payment_id, p_invoice_id, p_business_id, v_currency,
    p_payment_amount, v_applied_amount, v_overpayment,
    v_resulting_status
  );

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
