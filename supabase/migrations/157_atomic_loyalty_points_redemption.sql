-- Atomic loyalty points redemption with row-level locking to prevent double-redeem
CREATE OR REPLACE FUNCTION redeem_loyalty_points(
  p_loyalty_id uuid,
  p_points integer
)
RETURNS boolean AS $$
DECLARE
  v_current integer;
BEGIN
  SELECT points_balance INTO v_current
  FROM loyalty_points
  WHERE id = p_loyalty_id
  FOR UPDATE;

  IF v_current IS NULL OR v_current < p_points THEN
    RETURN false;
  END IF;

  UPDATE loyalty_points
  SET points_balance = points_balance - p_points,
      total_redeemed = total_redeemed + p_points
  WHERE id = p_loyalty_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
