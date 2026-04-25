-- Monthly conversation usage tracking per business
-- Tracks WhatsApp conversations (24h windows) and message counts
-- Used to enforce tier limits and monitor messaging costs

CREATE TABLE IF NOT EXISTS conversation_usage (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month_key text NOT NULL,                    -- format: '2026-04'
  conversation_count integer DEFAULT 0 NOT NULL,  -- unique 24h conversation windows
  inbound_count integer DEFAULT 0 NOT NULL,       -- messages received from customers
  outbound_count integer DEFAULT 0 NOT NULL,      -- messages sent (bot + staff)
  template_count integer DEFAULT 0 NOT NULL,      -- template messages (billed by Meta)
  last_message_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, month_key)
);

CREATE INDEX idx_conversation_usage_business ON conversation_usage(business_id);
CREATE INDEX idx_conversation_usage_month ON conversation_usage(month_key);

-- Atomic increment for inbound/outbound messages
CREATE OR REPLACE FUNCTION increment_message_usage(
  p_business_id uuid,
  p_direction text,       -- 'inbound', 'outbound', or 'template'
  p_is_new_conversation boolean DEFAULT false
) RETURNS void AS $$
DECLARE
  v_month text := to_char(now(), 'YYYY-MM');
BEGIN
  INSERT INTO conversation_usage (
    business_id, month_key,
    conversation_count,
    inbound_count,
    outbound_count,
    template_count,
    last_message_at
  ) VALUES (
    p_business_id, v_month,
    CASE WHEN p_is_new_conversation THEN 1 ELSE 0 END,
    CASE WHEN p_direction = 'inbound' THEN 1 ELSE 0 END,
    CASE WHEN p_direction = 'outbound' THEN 1 ELSE 0 END,
    CASE WHEN p_direction = 'template' THEN 1 ELSE 0 END,
    now()
  )
  ON CONFLICT (business_id, month_key)
  DO UPDATE SET
    conversation_count = conversation_usage.conversation_count +
      CASE WHEN p_is_new_conversation THEN 1 ELSE 0 END,
    inbound_count = conversation_usage.inbound_count +
      CASE WHEN p_direction = 'inbound' THEN 1 ELSE 0 END,
    outbound_count = conversation_usage.outbound_count +
      CASE WHEN p_direction = 'outbound' THEN 1 ELSE 0 END,
    template_count = conversation_usage.template_count +
      CASE WHEN p_direction = 'template' THEN 1 ELSE 0 END,
    last_message_at = now(),
    updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if business has exceeded conversation limit for their tier
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
  -- Get business tier
  SELECT subscription_tier INTO v_tier
  FROM businesses WHERE id = p_business_id;

  -- Get current month conversation count
  SELECT COALESCE(cu.conversation_count, 0) INTO v_count
  FROM conversation_usage cu
  WHERE cu.business_id = p_business_id AND cu.month_key = v_month;

  IF v_count IS NULL THEN v_count := 0; END IF;

  -- Tier limits
  v_limit := CASE v_tier
    WHEN 'free' THEN 200
    WHEN 'growth' THEN 1000
    WHEN 'business' THEN 999999  -- effectively unlimited
    ELSE 200
  END;

  RETURN QUERY SELECT
    v_count < v_limit AS allowed,
    v_tier,
    v_count,
    v_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
