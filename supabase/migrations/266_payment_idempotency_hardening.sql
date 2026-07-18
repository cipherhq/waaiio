-- ═══════════════════════════════════════════════════════
-- 266: Payment idempotency hardening
-- ═══════════════════════════════════════════════════════
-- 1. Make payment_id UNCONDITIONALLY unique on platform_fees.
--    Refunding a fee must NOT allow the same payment_id to create another fee.
--    Refunds create separate reversal records, not re-insertions.
-- 2. Remove the invoice_id global uniqueness that blocks partial payments.
--    Idempotency is per payment_id, not per invoice_id.
-- 3. Create an atomic RPC for invoice payment application.

DO $setup$ BEGIN
  -- Drop the conditional payment_id unique (WHERE refunded_at IS NULL)
  DROP INDEX IF EXISTS public.idx_platform_fees_payment_unique;

  -- Create unconditional payment_id unique — a payment can only ever create one fee
  CREATE UNIQUE INDEX idx_platform_fees_payment_unique
    ON public.platform_fees (payment_id)
    WHERE payment_id IS NOT NULL;

  -- Drop the invoice_id global unique that blocks multiple partial payments
  DROP INDEX IF EXISTS public.idx_platform_fees_invoice_unique;

  -- Replace with (invoice_id, payment_id) unique for partial payment idempotency
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_invoice_payment_unique
    ON public.platform_fees (invoice_id, payment_id)
    WHERE invoice_id IS NOT NULL AND payment_id IS NOT NULL;
END $setup$;

-- Atomic invoice payment RPC: records fee + increments amount_paid in one transaction.
-- Two concurrent calls for the same payment_id will produce one increment and one fee.
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
  v_new_amount_paid NUMERIC;
  v_is_fully_paid BOOLEAN;
BEGIN
  -- Check if this payment was already applied (idempotency)
  IF EXISTS (
    SELECT 1 FROM public.platform_fees
    WHERE payment_id = p_payment_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_applied');
  END IF;

  -- Lock and read the invoice
  SELECT total_amount, amount_paid, status
  INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF v_invoice IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invoice_not_found');
  END IF;

  IF v_invoice.status = 'paid' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_paid');
  END IF;

  -- Calculate new amount
  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + p_payment_amount;
  v_is_fully_paid := v_new_amount_paid >= v_invoice.total_amount;

  -- Update invoice atomically
  UPDATE public.invoices
  SET amount_paid = v_new_amount_paid,
      status = CASE WHEN v_is_fully_paid THEN 'paid' ELSE status END,
      paid_at = CASE WHEN v_is_fully_paid THEN NOW() ELSE paid_at END
  WHERE id = p_invoice_id;

  -- Record platform fee (unique index prevents duplicates even under race)
  INSERT INTO public.platform_fees (
    business_id, invoice_id, payment_id,
    transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee, tier
  ) VALUES (
    p_business_id, p_invoice_id, p_payment_id,
    p_payment_amount, p_fee_percentage, p_fee_flat, p_fee_total, p_gateway_fee, p_tier::public.subscription_tier
  );

  RETURN jsonb_build_object(
    'success', true,
    'new_amount_paid', v_new_amount_paid,
    'is_fully_paid', v_is_fully_paid
  );
END;
$$;
