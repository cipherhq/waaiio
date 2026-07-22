CREATE OR REPLACE FUNCTION public.create_payout_with_adjustments(
  p_business_id UUID,
  p_period_start DATE,
  p_period_end DATE,
  p_gross_amount NUMERIC(12,2),
  p_platform_fee NUMERIC(12,2),
  p_gateway_fee NUMERIC(12,2),
  p_net_amount NUMERIC(12,2),
  p_status TEXT,
  p_payout_account_id UUID,
  p_flags JSONB,
  p_adjustment_ids UUID[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payout_id UUID;
BEGIN
  -- Insert payout
  INSERT INTO public.business_payouts (
    business_id, period_start, period_end,
    gross_amount, platform_fee, gateway_fee, net_amount,
    status, payout_account_id, flags, auto_generated
  ) VALUES (
    p_business_id, p_period_start, p_period_end,
    p_gross_amount, p_platform_fee, p_gateway_fee, p_net_amount,
    p_status, p_payout_account_id, p_flags, true
  )
  RETURNING id INTO v_payout_id;

  -- Assign adjustments atomically (same transaction)
  IF p_adjustment_ids IS NOT NULL AND array_length(p_adjustment_ids, 1) > 0 THEN
    UPDATE public.payout_adjustments
    SET applied_to_payout_id = v_payout_id,
        applied_at = NOW()
    WHERE id = ANY(p_adjustment_ids)
      AND applied_to_payout_id IS NULL;
  END IF;

  RETURN v_payout_id;
END;
$$;


