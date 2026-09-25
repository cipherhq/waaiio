-- #397 CTO correction: serverless-safe confirmation tokens for launch delivery.
-- Cannot use in-memory Map because Vercel GET and POST may run on different instances.

CREATE TABLE IF NOT EXISTS public.launch_delivery_confirmations (
  token       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL,
  campaign_version TEXT NOT NULL,
  eligible_count   INT NOT NULL,
  pending_count    INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ  -- NULL until consumed; non-NULL = replay protection
);

-- Auto-expire old tokens (cleanup via index for efficient scans)
CREATE INDEX IF NOT EXISTS idx_launch_confirm_expiry
  ON launch_delivery_confirmations(created_at);

-- RLS: admin-only
ALTER TABLE launch_delivery_confirmations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_launch_confirmations" ON launch_delivery_confirmations
  FOR ALL USING (public.is_admin());

-- Atomic consume: marks token as consumed, returns confirmation data.
-- Fails if: wrong admin, wrong campaign, already consumed, or expired (>5min).
CREATE OR REPLACE FUNCTION consume_launch_confirmation(
  p_token UUID,
  p_admin_id UUID,
  p_campaign_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_row RECORD;
BEGIN
  -- Atomic read + update: only one caller can consume
  UPDATE launch_delivery_confirmations
  SET consumed_at = NOW()
  WHERE token = p_token
    AND admin_id = p_admin_id
    AND campaign_version = p_campaign_version
    AND consumed_at IS NULL
    AND created_at > NOW() - INTERVAL '5 minutes'
  RETURNING token, admin_id, campaign_version, eligible_count, pending_count
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
    IF v_row.created_at <= NOW() - INTERVAL '5 minutes' THEN
      RETURN jsonb_build_object('consumed', false, 'reason', 'expired');
    END IF;
    RETURN jsonb_build_object('consumed', false, 'reason', 'unknown');
  END IF;

  RETURN jsonb_build_object(
    'consumed', true,
    'eligible_count', v_row.eligible_count,
    'pending_count', v_row.pending_count
  );
END;
$$;
