-- Atomic credit reservation to prevent double-spend
CREATE OR REPLACE FUNCTION reserve_credits_atomic(
  p_business_id UUID,
  p_campaign_id UUID,
  p_amount INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available INTEGER;
  v_credit RECORD;
  v_remaining INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Calculate available credits with lock
  SELECT COALESCE(SUM(remaining), 0) INTO v_available
  FROM growth_credits
  WHERE business_id = p_business_id
    AND remaining > 0
    AND (expires_at IS NULL OR expires_at > NOW())
  FOR UPDATE;

  -- Check reserved credits from active campaigns
  v_remaining := v_available - COALESCE((
    SELECT SUM(credits_reserved - credits_consumed)
    FROM growth_campaigns
    WHERE business_id = p_business_id
      AND status IN ('draft', 'scheduled', 'sending')
  ), 0);

  IF v_remaining < p_amount THEN
    RETURN jsonb_build_object('success', false, 'reason', 'insufficient_credits', 'available', v_remaining);
  END IF;

  -- Update campaign with reserved credits
  UPDATE growth_campaigns
  SET credits_reserved = p_amount
  WHERE id = p_campaign_id AND business_id = p_business_id;

  -- Record transaction
  INSERT INTO growth_credit_transactions (business_id, campaign_id, type, amount, balance_after)
  VALUES (p_business_id, p_campaign_id, 'reserve', -p_amount, v_remaining - p_amount);

  RETURN jsonb_build_object('success', true, 'reserved', p_amount, 'remaining', v_remaining - p_amount);
END;
$$;

