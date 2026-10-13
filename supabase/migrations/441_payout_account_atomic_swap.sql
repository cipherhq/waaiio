-- 441_payout_account_atomic_swap.sql
--
-- Two transactional RPCs for payout-account mutations:
--   swap_payout_account   — deactivate old + insert new in one transaction
--   disconnect_payout_account — deactivate account + reset payout_mode
--
-- Both are SECURITY INVOKER, callable only by service_role.

-- ============================================================
-- 1. swap_payout_account
-- ============================================================
CREATE OR REPLACE FUNCTION public.swap_payout_account(
  p_business_id    uuid,
  p_gateway        text,
  p_bank_code      text,
  p_bank_name      text,
  p_account_number text,
  p_account_name   text,
  p_subaccount_code text DEFAULT NULL,
  p_verified_at    timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_id uuid;
BEGIN
  -- Lock existing active accounts for this business to prevent concurrent swaps
  PERFORM id FROM payout_accounts
    WHERE business_id = p_business_id AND is_active = true
    FOR UPDATE;

  -- Deactivate any currently active account
  UPDATE payout_accounts
    SET is_active = false, updated_at = now()
    WHERE business_id = p_business_id AND is_active = true;

  -- Insert the new active account
  INSERT INTO payout_accounts (
    business_id, gateway, subaccount_code,
    bank_code, bank_name, account_number, account_name,
    platform_percentage, is_active, verified_at
  ) VALUES (
    p_business_id, p_gateway, p_subaccount_code,
    p_bank_code, p_bank_name, p_account_number, p_account_name,
    2.5, true, p_verified_at
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- ============================================================
-- 2. disconnect_payout_account
-- ============================================================
CREATE OR REPLACE FUNCTION public.disconnect_payout_account(
  p_business_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Verify business exists
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'business_not_found: %', p_business_id;
  END IF;

  -- Deactivate any active payout account
  UPDATE payout_accounts
    SET is_active = false, updated_at = now()
    WHERE business_id = p_business_id AND is_active = true;

  -- Reset payout mode to platform_managed
  UPDATE businesses
    SET payout_mode = 'platform_managed'
    WHERE id = p_business_id;
END;
$$;

-- ============================================================
-- Permissions: service_role only
-- ============================================================
REVOKE ALL ON FUNCTION public.swap_payout_account(uuid, text, text, text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.swap_payout_account(uuid, text, text, text, text, text, text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.disconnect_payout_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.disconnect_payout_account(uuid) TO service_role;
