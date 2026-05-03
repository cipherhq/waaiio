-- Update conversation limits to match new pricing tiers
CREATE OR REPLACE FUNCTION check_conversation_limit(
  p_business_id uuid
) RETURNS TABLE(
  allowed boolean,
  tier text,
  monthly_conversations integer,
  monthly_limit integer
) AS $$
DECLARE
  v_month text := to_char(now(), 'YYYY-MM');
  v_tier text;
  v_count integer;
  v_limit integer;
BEGIN
  SELECT subscription_tier INTO v_tier
  FROM businesses WHERE id = p_business_id;

  SELECT COALESCE(cu.conversation_count, 0) INTO v_count
  FROM conversation_usage cu
  WHERE cu.business_id = p_business_id AND cu.month_key = v_month;

  IF v_count IS NULL THEN v_count := 0; END IF;

  v_limit := CASE v_tier
    WHEN 'free' THEN 200
    WHEN 'growth' THEN 1000
    WHEN 'business' THEN 5000
    ELSE 200
  END;

  RETURN QUERY SELECT
    v_count < v_limit AS allowed,
    v_tier,
    v_count,
    v_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
