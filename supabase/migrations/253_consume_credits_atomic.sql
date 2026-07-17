-- Atomic credit consumption (deducts from oldest first, with lock)
CREATE OR REPLACE FUNCTION consume_credits_atomic(
  p_business_id UUID,
  p_campaign_id UUID,
  p_amount INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit RECORD;
  v_remaining INTEGER := p_amount;
  v_deduct INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Lock and iterate credits FIFO
  FOR v_credit IN
    SELECT id, remaining
    FROM growth_credits
    WHERE business_id = p_business_id
      AND remaining > 0
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_deduct := LEAST(v_remaining, v_credit.remaining);
    UPDATE growth_credits SET remaining = remaining - v_deduct WHERE id = v_credit.id;
    v_remaining := v_remaining - v_deduct;
  END LOOP;

  -- Update campaign consumed count
  UPDATE growth_campaigns
  SET credits_consumed = credits_consumed + p_amount
  WHERE id = p_campaign_id AND business_id = p_business_id;

  -- Record transaction
  INSERT INTO growth_credit_transactions (business_id, campaign_id, type, amount)
  VALUES (p_business_id, p_campaign_id, 'consume', -p_amount);

  RETURN jsonb_build_object('success', true, 'consumed', p_amount);
END;
$$;

-- Fixes moved to DO blocks for single-statement compatibility.
