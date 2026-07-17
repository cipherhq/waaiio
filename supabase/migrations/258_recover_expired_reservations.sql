CREATE OR REPLACE FUNCTION recover_expired_reservations()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_campaign RECORD;
  v_recovered INTEGER := 0;
  v_released_total INTEGER := 0;
BEGIN
  -- Find expired reservations
  FOR v_campaign IN
    SELECT id, business_id, credits_reserved, credits_consumed
    FROM public.growth_campaigns
    WHERE reservation_status IN ('reserved', 'partially_consumed')
      AND reservation_expires_at < NOW()
    FOR UPDATE SKIP LOCKED  -- Don't block on actively-processed campaigns
  LOOP
    -- Release via the atomic release function
    PERFORM release_credits_atomic(v_campaign.business_id, v_campaign.id);

    -- Mark as expired (not just released)
    UPDATE public.growth_campaigns SET reservation_status = 'expired' WHERE id = v_campaign.id;

    v_recovered := v_recovered + 1;
    v_released_total := v_released_total + (v_campaign.credits_reserved - v_campaign.credits_consumed);
  END LOOP;

  RETURN jsonb_build_object('recovered', v_recovered, 'credits_released', v_released_total);
END;
$$;

