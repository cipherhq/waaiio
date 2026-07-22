CREATE OR REPLACE FUNCTION reserve_credits_atomic(
  p_business_id UUID,
  p_campaign_id UUID,
  p_amount INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_available INTEGER;
  v_campaign RECORD;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Lock the campaign row to prevent concurrent reservations
  SELECT id, reservation_status, credits_reserved, business_id
  INTO v_campaign
  FROM public.growth_campaigns
  WHERE id = p_campaign_id
  FOR UPDATE;

  IF v_campaign IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'campaign_not_found');
  END IF;

  IF v_campaign.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'unauthorized');
  END IF;

  -- Prevent double reservation
  IF v_campaign.reservation_status NOT IN ('none', 'released', 'expired') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_reserved',
      'reservation_id', v_campaign.reservation_id);
  END IF;

  -- Lock all credit rows for this business to prevent concurrent reservation races
  PERFORM id FROM public.growth_credits
  WHERE business_id = p_business_id
    AND remaining > 0
    AND (expires_at IS NULL OR expires_at > NOW())
  FOR UPDATE;

  -- Now safely aggregate (rows are locked)
  SELECT COALESCE(SUM(remaining), 0) INTO v_available
  FROM public.growth_credits
  WHERE business_id = p_business_id
    AND remaining > 0
    AND (expires_at IS NULL OR expires_at > NOW());

  -- Subtract existing active reservations from other campaigns
  v_available := v_available - COALESCE((
    SELECT SUM(credits_reserved - credits_consumed)
    FROM public.growth_campaigns
    WHERE business_id = p_business_id
      AND id != p_campaign_id
      AND reservation_status IN ('reserved', 'partially_consumed')
  ), 0);

  IF v_available < p_amount THEN
    RETURN jsonb_build_object('success', false, 'reason', 'insufficient_credits', 'available', v_available);
  END IF;

  -- Update campaign with reservation
  UPDATE public.growth_campaigns
  SET credits_reserved = p_amount,
      credits_consumed = 0,
      reservation_status = 'reserved',
      reservation_id = gen_random_uuid(),
      reservation_expires_at = NOW() + INTERVAL '24 hours'
  WHERE id = p_campaign_id;

  -- Get the new reservation_id
  SELECT reservation_id INTO v_campaign.reservation_id
  FROM public.growth_campaigns WHERE id = p_campaign_id;

  -- Record transaction
  INSERT INTO public.growth_credit_transactions (business_id, campaign_id, type, amount, balance_after)
  VALUES (p_business_id, p_campaign_id, 'reserve', -p_amount, v_available - p_amount);

  RETURN jsonb_build_object(
    'success', true,
    'reservation_id', v_campaign.reservation_id,
    'reserved', p_amount,
    'remaining', v_available - p_amount
  );
END;
$$;

