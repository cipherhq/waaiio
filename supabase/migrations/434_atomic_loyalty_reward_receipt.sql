-- M434 / #598: Atomic and replay-safe loyalty reward redemption.
-- Deliberately additive: existing redeem_loyalty_points remains unchanged for legacy
-- callers; only new approved writers must use this restricted service_role RPC.
-- Transaction guarantees points UPDATE + receipt INSERT either both commit or both roll back.
-- Key and reward code have DB uniqueness so retries cannot burn points twice or issue duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_reward_receipt_key
  ON public.loyalty_transactions (business_id, reference_id)
  WHERE reason = 'redemption' AND reference_id LIKE 'bot:%';

CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_reward_receipt_code
  ON public.loyalty_transactions (business_id, reference_type)
  WHERE reason = 'redemption' AND reference_type LIKE 'code:RW-%';

CREATE OR REPLACE FUNCTION public.redeem_loyalty_reward_once(
  p_loyalty_id uuid,
  p_business_id uuid,
  p_customer_phone text,
  p_points integer,
  p_redemption_key text,
  p_redemption_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account record;
  v_code text;
  v_new_balance integer;
BEGIN
  IF p_loyalty_id IS NULL OR p_business_id IS NULL OR p_customer_phone IS NULL
    OR p_points IS NULL OR p_points <= 0 OR p_points > 100000000
    OR p_redemption_key !~ '^bot:[a-zA-Z0-9-]{8,100}$'
    OR p_redemption_code !~ '^RW-[A-Z2-9]{6}$'
  THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_request');
  END IF;

  -- Lock the account before replay check. A concurrent request must see the
  -- committed receipt and balance, not compute from the stale pre-redeem session.
  SELECT lp.id, lp.business_id, lp.customer_phone, lp.points_balance
    INTO v_account
  FROM public.loyalty_points lp
  WHERE lp.id = p_loyalty_id AND lp.business_id = p_business_id
    AND ltrim(lp.customer_phone, '+') = ltrim(p_customer_phone, '+')
    AND lp.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'account_not_found');
  END IF;

  SELECT substring(lt.reference_type FROM 6) INTO v_code
  FROM public.loyalty_transactions lt
  WHERE lt.business_id = p_business_id AND lt.reference_id = p_redemption_key
    AND lt.reason = 'redemption' AND lt.points_change < 0
    AND lt.reference_type LIKE 'code:RW-%'
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'replayed', true,
                              'code', v_code, 'points_balance', v_account.points_balance);
  END IF;

  IF v_account.points_balance < p_points THEN
    RETURN jsonb_build_object('success', false, 'reason', 'insufficient_points');
  END IF;

  UPDATE public.loyalty_points
  SET points_balance = points_balance - p_points,
      total_redeemed = total_redeemed + p_points,
      updated_at = now()
  WHERE id = p_loyalty_id
  RETURNING points_balance INTO v_new_balance;

  -- Any INSERT/UNIQUE failure aborts the whole function transaction,
  -- including the preceding points UPDATE.
  INSERT INTO public.loyalty_transactions (
    business_id, customer_phone, points_change, reason, reference_id, reference_type
  ) VALUES (
    p_business_id, v_account.customer_phone, -p_points, 'redemption',
    p_redemption_key, 'code:' || p_redemption_code
  );

  RETURN jsonb_build_object('success', true, 'replayed', false,
                            'code', p_redemption_code, 'points_balance', v_new_balance);
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_loyalty_reward_once(uuid,uuid,text,integer,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_reward_once(uuid,uuid,text,integer,text,text)
  TO service_role;
