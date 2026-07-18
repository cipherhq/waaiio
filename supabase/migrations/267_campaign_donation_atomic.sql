-- ═══════════════════════════════════════════════════════
-- 267: Atomic campaign donation + privilege grants
-- ═══════════════════════════════════════════════════════

-- Atomic campaign donation: status transition + increment in one transaction.
-- If the donation is not pending, returns false (idempotent on retry).
CREATE OR REPLACE FUNCTION public.apply_campaign_donation(
  p_payment_id UUID,
  p_campaign_id UUID,
  p_amount NUMERIC,
  p_business_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_donation_id UUID;
  v_campaign RECORD;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;

  -- Try to transition donation from pending to success (idempotent guard)
  UPDATE public.campaign_donations
  SET status = 'success'
  WHERE payment_id = p_payment_id
    AND status = 'pending'
  RETURNING id INTO v_donation_id;

  IF v_donation_id IS NULL THEN
    -- Try fallback: match by campaign_id where payment_id is null
    UPDATE public.campaign_donations
    SET status = 'success', payment_id = p_payment_id
    WHERE campaign_id = p_campaign_id
      AND status = 'pending'
      AND payment_id IS NULL
    RETURNING id INTO v_donation_id;
  END IF;

  IF v_donation_id IS NULL THEN
    -- No pending donation found — already processed (idempotent)
    RETURN jsonb_build_object('success', false, 'reason', 'already_processed');
  END IF;

  -- Atomic increment: only reached if we actually transitioned a donation
  SELECT id, business_id INTO v_campaign
  FROM public.campaigns
  WHERE id = p_campaign_id
  FOR UPDATE;

  IF v_campaign IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'campaign_not_found');
  END IF;

  UPDATE public.campaigns
  SET raised_amount = COALESCE(raised_amount, 0) + p_amount,
      donor_count = COALESCE(donor_count, 0) + 1
  WHERE id = p_campaign_id;

  RETURN jsonb_build_object('success', true, 'donation_id', v_donation_id);
END;
$$;
