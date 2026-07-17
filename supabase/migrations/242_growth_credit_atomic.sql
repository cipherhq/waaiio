-- Atomic credit reservation to prevent double-spend
CREATE OR REPLACE FUNCTION reserve_credits_atomic(
  p_business_id UUID,
  p_campaign_id UUID,
  p_amount INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available INTEGER;
  v_credit RECORD;
  v_remaining INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Calculate available credits with lock
  SELECT COALESCE(SUM(remaining), 0) INTO v_available
  FROM growth_credits
  WHERE business_id = p_business_id
    AND remaining > 0
    AND (expires_at IS NULL OR expires_at > NOW())
  FOR UPDATE;

  -- Check reserved credits from active campaigns
  v_remaining := v_available - COALESCE((
    SELECT SUM(credits_reserved - credits_consumed)
    FROM growth_campaigns
    WHERE business_id = p_business_id
      AND status IN ('draft', 'scheduled', 'sending')
  ), 0);

  IF v_remaining < p_amount THEN
    RETURN jsonb_build_object('success', false, 'reason', 'insufficient_credits', 'available', v_remaining);
  END IF;

  -- Update campaign with reserved credits
  UPDATE growth_campaigns
  SET credits_reserved = p_amount
  WHERE id = p_campaign_id AND business_id = p_business_id;

  -- Record transaction
  INSERT INTO growth_credit_transactions (business_id, campaign_id, type, amount, balance_after)
  VALUES (p_business_id, p_campaign_id, 'reserve', -p_amount, v_remaining - p_amount);

  RETURN jsonb_build_object('success', true, 'reserved', p_amount, 'remaining', v_remaining - p_amount);
END;
$$;

-- Atomic credit consumption (deducts from oldest first, with lock)
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
  v_credit RECORD;
  v_remaining INTEGER := p_amount;
  v_deduct INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Lock and iterate credits FIFO
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

  -- Update campaign consumed count
  UPDATE growth_campaigns
  SET credits_consumed = credits_consumed + p_amount
  WHERE id = p_campaign_id AND business_id = p_business_id;

  -- Record transaction
  INSERT INTO growth_credit_transactions (business_id, campaign_id, type, amount)
  VALUES (p_business_id, p_campaign_id, 'consume', -p_amount);

  RETURN jsonb_build_object('success', true, 'consumed', p_amount);
END;
$$;

-- Fixes moved to DO blocks for single-statement compatibility.
-- Separate blocks so exception handling is scoped correctly.
DO $fix1$ BEGIN
  DROP POLICY IF EXISTS "customer_consents_service_insert" ON public.customer_consents;
END $fix1$;

DO $fix2$ BEGIN
  ALTER TABLE public.growth_campaigns
    ADD CONSTRAINT uq_growth_campaign_dedup UNIQUE (business_id, name, type)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $fix2$;
