-- Atomic default-connection switcher
-- Validates: ownership, status, verification, health, country support
-- Clears old default and sets new one in single transaction
CREATE OR REPLACE FUNCTION public.set_default_connection(
  p_business_id UUID,
  p_connection_id UUID,
  p_country_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_conn RECORD;
  v_supported TEXT[];
BEGIN
  -- Lock and read the target connection
  SELECT id, gateway, connection_status, connection_mode,
         verified_at, health_status, is_default, business_id
  INTO v_conn
  FROM public.payout_accounts
  WHERE id = p_connection_id
  FOR UPDATE;

  IF v_conn IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'connection_not_found');
  END IF;

  -- Verify business ownership
  IF v_conn.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch');
  END IF;

  -- Verify connection is active
  IF v_conn.connection_status != 'active' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'connection_not_active');
  END IF;

  -- Verify connection is verified
  IF v_conn.verified_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'connection_not_verified');
  END IF;

  -- Verify connection is healthy
  IF v_conn.health_status IS DISTINCT FROM 'healthy' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'connection_unhealthy');
  END IF;

  -- Verify provider supports the country
  v_supported := CASE v_conn.gateway
    WHEN 'paystack' THEN ARRAY['NG', 'GH']
    WHEN 'flutterwave' THEN ARRAY['NG', 'GH']
    WHEN 'stripe' THEN ARRAY['US', 'CA', 'GB']
    WHEN 'square' THEN ARRAY['US']
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (p_country_code = ANY(v_supported)) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'provider_country_mismatch');
  END IF;

  -- Already default? No-op
  IF v_conn.is_default THEN
    RETURN jsonb_build_object('success', true, 'already_default', true);
  END IF;

  -- Atomically clear old default and set new one
  UPDATE public.payout_accounts
  SET is_default = false, updated_at = NOW()
  WHERE business_id = p_business_id AND is_default = true;

  UPDATE public.payout_accounts
  SET is_default = true, updated_at = NOW()
  WHERE id = p_connection_id;

  RETURN jsonb_build_object('success', true, 'connection_id', p_connection_id);
END;
$$;
