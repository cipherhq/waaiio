-- Migration 243: Growth credit system hardening
-- Adds CHECK constraints, reservation lifecycle, atomic RPCs, and recovery

-- 1. Add CHECK constraints to growth_credits
ALTER TABLE growth_credits
  ADD CONSTRAINT chk_credits_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT chk_credits_remaining_non_negative CHECK (remaining >= 0),
  ADD CONSTRAINT chk_credits_remaining_lte_amount CHECK (remaining <= amount);

-- 2. Add reservation lifecycle tracking to growth_campaigns
ALTER TABLE growth_campaigns
  ADD COLUMN IF NOT EXISTS reservation_id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS reservation_status TEXT DEFAULT 'none'
    CHECK (reservation_status IN ('none', 'reserved', 'partially_consumed', 'consumed', 'released', 'expired')),
  ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Idempotency key must be unique per business
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_idempotency
  ON growth_campaigns(business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 3. Drop old campaign unique constraint (replace with idempotency key)
ALTER TABLE growth_campaigns DROP CONSTRAINT IF EXISTS uq_growth_campaign_dedup;

-- 4. Replace reserve_credits_atomic with full reservation lifecycle
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
  v_campaign RECORD;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Lock the campaign row to prevent concurrent reservations
  SELECT id, reservation_status, credits_reserved, business_id
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

  -- Prevent double reservation
  IF v_campaign.reservation_status NOT IN ('none', 'released', 'expired') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_reserved',
      'reservation_id', v_campaign.reservation_id);
  END IF;

  -- Calculate available credits with lock (exclude expired)
  SELECT COALESCE(SUM(remaining), 0) INTO v_available
  FROM growth_credits
  WHERE business_id = p_business_id
    AND remaining > 0
    AND (expires_at IS NULL OR expires_at > NOW())
  FOR UPDATE;

  -- Subtract existing active reservations from other campaigns
  v_available := v_available - COALESCE((
    SELECT SUM(credits_reserved - credits_consumed)
    FROM growth_campaigns
    WHERE business_id = p_business_id
      AND id != p_campaign_id
      AND reservation_status IN ('reserved', 'partially_consumed')
  ), 0);

  IF v_available < p_amount THEN
    RETURN jsonb_build_object('success', false, 'reason', 'insufficient_credits', 'available', v_available);
  END IF;

  -- Update campaign with reservation
  UPDATE growth_campaigns
  SET credits_reserved = p_amount,
      credits_consumed = 0,
      reservation_status = 'reserved',
      reservation_id = gen_random_uuid(),
      reservation_expires_at = NOW() + INTERVAL '24 hours'
  WHERE id = p_campaign_id;

  -- Get the new reservation_id
  SELECT reservation_id INTO v_campaign.reservation_id
  FROM growth_campaigns WHERE id = p_campaign_id;

  -- Record transaction
  INSERT INTO growth_credit_transactions (business_id, campaign_id, type, amount, balance_after)
  VALUES (p_business_id, p_campaign_id, 'reserve', -p_amount, v_available - p_amount);

  RETURN jsonb_build_object(
    'success', true,
    'reservation_id', v_campaign.reservation_id,
    'reserved', p_amount,
    'remaining', v_available - p_amount
  );
END;
$$;

-- 5. Replace consume_credits_atomic with reservation verification
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
  v_campaign RECORD;
  v_credit RECORD;
  v_remaining INTEGER := p_amount;
  v_deduct INTEGER;
  v_consumable INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Lock and verify the campaign reservation
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

  -- Must have an active reservation
  IF v_campaign.reservation_status NOT IN ('reserved', 'partially_consumed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_active_reservation',
      'status', v_campaign.reservation_status);
  END IF;

  -- Cannot consume more than reserved
  v_consumable := v_campaign.credits_reserved - v_campaign.credits_consumed;
  IF p_amount > v_consumable THEN
    RETURN jsonb_build_object('success', false, 'reason', 'exceeds_reservation',
      'consumable', v_consumable, 'requested', p_amount);
  END IF;

  -- Lock and iterate credits FIFO (exclude expired)
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

  -- Update campaign consumed count and status
  UPDATE growth_campaigns
  SET credits_consumed = credits_consumed + p_amount,
      reservation_status = CASE
        WHEN credits_consumed + p_amount >= credits_reserved THEN 'consumed'
        ELSE 'partially_consumed'
      END
  WHERE id = p_campaign_id;

  -- Record transaction
  INSERT INTO growth_credit_transactions (business_id, campaign_id, type, amount)
  VALUES (p_business_id, p_campaign_id, 'consume', -p_amount);

  RETURN jsonb_build_object('success', true, 'consumed', p_amount,
    'total_consumed', v_campaign.credits_consumed + p_amount,
    'total_reserved', v_campaign.credits_reserved);
END;
$$;

-- 6. New atomic release RPC
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
REVOKE ALL ON FUNCTION release_credits_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION release_credits_atomic(UUID, UUID) TO service_role;

-- Re-revoke on updated functions (CREATE OR REPLACE resets grants)
REVOKE ALL ON FUNCTION reserve_credits_atomic(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_credits_atomic(UUID, UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION consume_credits_atomic(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_credits_atomic(UUID, UUID, INTEGER) TO service_role;

-- 7. Stuck reservation recovery function
CREATE OR REPLACE FUNCTION recover_expired_reservations()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign RECORD;
  v_recovered INTEGER := 0;
  v_released_total INTEGER := 0;
BEGIN
  -- Find expired reservations
  FOR v_campaign IN
    SELECT id, business_id, credits_reserved, credits_consumed
    FROM growth_campaigns
    WHERE reservation_status IN ('reserved', 'partially_consumed')
      AND reservation_expires_at < NOW()
    FOR UPDATE SKIP LOCKED  -- Don't block on actively-processed campaigns
  LOOP
    -- Release via the atomic release function
    PERFORM release_credits_atomic(v_campaign.business_id, v_campaign.id);

    -- Mark as expired (not just released)
    UPDATE growth_campaigns SET reservation_status = 'expired' WHERE id = v_campaign.id;

    v_recovered := v_recovered + 1;
    v_released_total := v_released_total + (v_campaign.credits_reserved - v_campaign.credits_consumed);
  END LOOP;

  RETURN jsonb_build_object('recovered', v_recovered, 'credits_released', v_released_total);
END;
$$;

REVOKE ALL ON FUNCTION recover_expired_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION recover_expired_reservations() TO service_role;
