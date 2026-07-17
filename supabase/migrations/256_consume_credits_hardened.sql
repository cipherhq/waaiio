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
  v_campaign RECORD;
  v_credit RECORD;
  v_remaining INTEGER := p_amount;
  v_deduct INTEGER;
  v_consumable INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Lock and verify the campaign reservation
  SELECT id, reservation_status, credits_reserved, credits_consumed, business_id
  INTO v_campaign
  FROM growth_campaigns
  WHERE id = p_campaign_id
  FOR UPDATE;

  IF v_campaign IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'campaign_not_found');
  END IF;

  IF v_campaign.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'unauthorized');
  END IF;

  -- Must have an active reservation
  IF v_campaign.reservation_status NOT IN ('reserved', 'partially_consumed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_active_reservation',
      'status', v_campaign.reservation_status);
  END IF;

  -- Cannot consume more than reserved
  v_consumable := v_campaign.credits_reserved - v_campaign.credits_consumed;
  IF p_amount > v_consumable THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exceeds_reservation',
      'consumable', v_consumable, 'requested', p_amount);
  END IF;

  -- Lock and iterate credits FIFO (exclude expired)
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

  -- Update campaign consumed count and status
  UPDATE growth_campaigns
  SET credits_consumed = credits_consumed + p_amount,
      reservation_status = CASE
        WHEN credits_consumed + p_amount >= credits_reserved THEN 'consumed'
        ELSE 'partially_consumed'
      END
  WHERE id = p_campaign_id;

  -- Record transaction
  INSERT INTO growth_credit_transactions (business_id, campaign_id, type, amount)
  VALUES (p_business_id, p_campaign_id, 'consume', -p_amount);

  RETURN jsonb_build_object('success', true, 'consumed', p_amount,
    'total_consumed', v_campaign.credits_consumed + p_amount,
    'total_reserved', v_campaign.credits_reserved);
END;
$$;

