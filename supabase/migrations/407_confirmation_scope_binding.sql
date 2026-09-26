-- #397 CTO R3: Bind confirmation token to complete delivery scope.
-- A token previewed for normal pending must not authorize retry-only or different limit.

-- Add scope columns
ALTER TABLE launch_delivery_confirmations
  ADD COLUMN IF NOT EXISTS retry_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS send_limit INT NOT NULL DEFAULT 50;

-- Replace consume RPC with scope-bound version
CREATE OR REPLACE FUNCTION consume_launch_confirmation(
  p_token UUID,
  p_admin_id UUID,
  p_campaign_version TEXT,
  p_retry_only BOOLEAN DEFAULT false,
  p_send_limit INT DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_row RECORD;
BEGIN
  -- Atomic consume: checks ALL scope fields including retry_only and send_limit
  UPDATE launch_delivery_confirmations
  SET consumed_at = NOW()
  WHERE token = p_token
    AND admin_id = p_admin_id
    AND campaign_version = p_campaign_version
    AND retry_only = p_retry_only
    AND send_limit = p_send_limit
    AND consumed_at IS NULL
    AND created_at > NOW() - INTERVAL '5 minutes'
  RETURNING token, admin_id, campaign_version, eligible_count, pending_count,
            retry_only, send_limit
  INTO v_row;

  IF v_row IS NULL THEN
    -- Diagnose why
    SELECT * INTO v_row FROM launch_delivery_confirmations WHERE token = p_token;
    IF v_row IS NULL THEN
      RETURN jsonb_build_object('consumed', false, 'reason', 'not_found');
    END IF;
    IF v_row.consumed_at IS NOT NULL THEN
      RETURN jsonb_build_object('consumed', false, 'reason', 'already_consumed');
    END IF;
    IF v_row.admin_id != p_admin_id THEN
      RETURN jsonb_build_object('consumed', false, 'reason', 'wrong_admin');
    END IF;
    IF v_row.campaign_version != p_campaign_version THEN
      RETURN jsonb_build_object('consumed', false, 'reason', 'campaign_mismatch');
    END IF;
    IF v_row.retry_only != p_retry_only OR v_row.send_limit != p_send_limit THEN
      RETURN jsonb_build_object('consumed', false, 'reason', 'scope_mismatch');
    END IF;
    IF v_row.created_at <= NOW() - INTERVAL '5 minutes' THEN
      RETURN jsonb_build_object('consumed', false, 'reason', 'expired');
    END IF;
    RETURN jsonb_build_object('consumed', false, 'reason', 'unknown');
  END IF;

  RETURN jsonb_build_object(
    'consumed', true,
    'eligible_count', v_row.eligible_count,
    'pending_count', v_row.pending_count,
    'retry_only', v_row.retry_only,
    'send_limit', v_row.send_limit
  );
END;
$$;
