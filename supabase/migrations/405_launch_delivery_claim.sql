-- #397 CTO correction: atomic claim/fencing for concurrent delivery safety.
-- Two concurrent workers must not both send to the same subscriber.

-- Add claim columns for fencing
ALTER TABLE launch_subscribers
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Atomic claim RPC: only one caller wins delivery rights for a subscriber + campaign.
-- Uses UPDATE ... WHERE to atomically check + set the claim.
-- Returns: { claimed: bool, already_sent: bool, subscriber_id: text }
CREATE OR REPLACE FUNCTION claim_launch_delivery(
  p_subscriber_id UUID,
  p_campaign_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_row RECORD;
  v_token UUID;
BEGIN
  -- Atomic read + conditional update in one statement.
  -- Only claims if: active, not already sent for this campaign, and no active claim.
  v_token := gen_random_uuid();

  UPDATE launch_subscribers
  SET
    claim_token = v_token,
    claimed_at = NOW(),
    campaign_version = p_campaign_version,
    updated_at = NOW()
  WHERE id = p_subscriber_id
    AND opt_in_status = 'active'
    AND NOT (campaign_version = p_campaign_version AND notification_status = 'sent')
    AND (claim_token IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')
  RETURNING id, wa_number, receiving_number, opt_in_status, notification_status
  INTO v_row;

  IF v_row IS NULL THEN
    -- Could not claim — check why
    SELECT notification_status, campaign_version, opt_in_status
    INTO v_row
    FROM launch_subscribers
    WHERE id = p_subscriber_id;

    IF v_row IS NULL THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
    END IF;
    IF v_row.opt_in_status != 'active' THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'opted_out');
    END IF;
    IF v_row.campaign_version = p_campaign_version AND v_row.notification_status = 'sent' THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'already_sent', 'already_sent', true);
    END IF;
    -- Another worker holds the claim
    RETURN jsonb_build_object('claimed', false, 'reason', 'claimed_by_other');
  END IF;

  RETURN jsonb_build_object(
    'claimed', true,
    'claim_token', v_token,
    'subscriber_id', v_row.id,
    'wa_number', v_row.wa_number,
    'receiving_number', v_row.receiving_number
  );
END;
$$;

-- Release/complete a claim after successful or failed delivery.
CREATE OR REPLACE FUNCTION complete_launch_delivery(
  p_subscriber_id UUID,
  p_claim_token UUID,
  p_status TEXT,           -- 'sent' or 'failed'
  p_message_id TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE launch_subscribers
  SET
    notification_status = p_status,
    provider_message_id = COALESCE(p_message_id, provider_message_id),
    delivery_error = CASE WHEN p_status = 'sent' THEN NULL ELSE p_error END,
    delivered_at = CASE WHEN p_status = 'sent' THEN NOW() ELSE delivered_at END,
    claim_token = NULL,
    claimed_at = NULL,
    updated_at = NOW()
  WHERE id = p_subscriber_id
    AND claim_token = p_claim_token
  ;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'claim_mismatch');
  END IF;

  RETURN jsonb_build_object('completed', true);
END;
$$;
