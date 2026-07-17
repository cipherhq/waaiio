CREATE OR REPLACE FUNCTION release_credits_atomic(
  p_business_id UUID,
  p_campaign_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign RECORD;
  v_releasable INTEGER;
  v_credit RECORD;
  v_released INTEGER := 0;
  v_to_release INTEGER;
BEGIN
  -- Lock the campaign
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

  -- Cannot release if not reserved or already released/consumed
  IF v_campaign.reservation_status NOT IN ('reserved', 'partially_consumed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_releasable',
      'status', v_campaign.reservation_status);
  END IF;

  -- Calculate releasable amount (reserved minus consumed)
  v_releasable := v_campaign.credits_reserved - v_campaign.credits_consumed;
  IF v_releasable <= 0 THEN
    -- Fully consumed, just mark released
    UPDATE growth_campaigns SET reservation_status = 'consumed' WHERE id = p_campaign_id;
    RETURN jsonb_build_object('success', true, 'released', 0, 'reason', 'fully_consumed');
  END IF;

  -- Restore credits to original grants (newest first, cap at grant amount)
  v_to_release := v_releasable;
  FOR v_credit IN
    SELECT id, remaining, amount
    FROM growth_credits
    WHERE business_id = p_business_id
      AND remaining < amount  -- Only credits that were deducted from
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    FOR UPDATE
  LOOP
    EXIT WHEN v_to_release <= 0;
    DECLARE
      v_restorable INTEGER := LEAST(v_to_release, v_credit.amount - v_credit.remaining);
    BEGIN
      IF v_restorable > 0 THEN
        UPDATE growth_credits SET remaining = remaining + v_restorable WHERE id = v_credit.id;
        v_released := v_released + v_restorable;
        v_to_release := v_to_release - v_restorable;
      END IF;
    END;
  END LOOP;

  -- Mark campaign released
  UPDATE growth_campaigns
  SET reservation_status = 'released'
  WHERE id = p_campaign_id;

  -- Record transaction
  INSERT INTO growth_credit_transactions (business_id, campaign_id, type, amount, balance_after)
  VALUES (p_business_id, p_campaign_id, 'release', v_released, NULL);

  RETURN jsonb_build_object('success', true, 'released', v_released, 'was_reserved', v_campaign.credits_reserved, 'was_consumed', v_campaign.credits_consumed);
END;
$$;

-- Revoke public access on new function

-- Re-revoke on updated functions (CREATE OR REPLACE resets grants)

