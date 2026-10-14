-- 446: Payout accounts — server-only writes, column-limited reads
--
-- Removes all direct DML from anon/authenticated on payout_accounts.
-- All mutations go through service_role RPCs (swap_payout_account,
-- disconnect_payout_account from M441). Reads are column-limited
-- to exclude secret/token columns.

-- ══════════════════════════════════════════════════════════════════
-- §1  Revoke direct DML from non-service roles
-- ══════════════════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE ON public.payout_accounts FROM PUBLIC, anon, authenticated;

-- Drop the owner INSERT/UPDATE policies (reads stay)
DROP POLICY IF EXISTS "Business owners can insert own payout accounts" ON public.payout_accounts;
DROP POLICY IF EXISTS "Business owners can update own payout accounts" ON public.payout_accounts;

-- ══════════════════════════════════════════════════════════════════
-- §2  Column-limited reads for authenticated
-- ══════════════════════════════════════════════════════════════════
-- Revoke table-wide SELECT, then grant on safe columns only.
-- Excluded (secret/token columns):
--   square_access_token  — Square OAuth bearer token
--   subaccount_code      — Paystack/Flutterwave sub-account secret
--   stripe_account_id    — Stripe Connect account identifier (semi-secret)
--
-- Owner and admin SELECT policies (M009, M439) are kept;
-- they gate row visibility. Column grants gate which columns
-- are readable within those visible rows.

REVOKE SELECT ON public.payout_accounts FROM anon;
REVOKE SELECT ON public.payout_accounts FROM authenticated;

GRANT SELECT (
  id,
  business_id,
  gateway,
  bank_code,
  bank_name,
  account_number,
  account_name,
  square_merchant_id,
  platform_percentage,
  is_active,
  verified_at,
  created_at,
  updated_at
) ON public.payout_accounts TO authenticated;

-- ══════════════════════════════════════════════════════════════════
-- §3  service_role full access (explicit, not from defaults)
-- ══════════════════════════════════════════════════════════════════

GRANT ALL ON public.payout_accounts TO service_role;

-- ══════════════════════════════════════════════════════════════════
-- §4  OAuth connect states table
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.oauth_connect_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'square')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.oauth_connect_states ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated grants — service_role only
GRANT ALL ON public.oauth_connect_states TO service_role;

-- ══════════════════════════════════════════════════════════════════
-- §5  Replace swap_payout_account with unified signature
-- ══════════════════════════════════════════════════════════════════
-- Drop the M441 8-arg overload to avoid "function is not unique" ambiguity.
-- The new 11-arg version keeps all M441 guarantees (FOR UPDATE lock,
-- business_not_found check, idx_payout_accounts_business_active invariant).

DROP FUNCTION IF EXISTS public.swap_payout_account(uuid, text, text, text, text, text, text, timestamptz);

CREATE OR REPLACE FUNCTION public.swap_payout_account(
  p_business_id        uuid,
  p_gateway            text,
  p_bank_code          text     DEFAULT NULL,
  p_bank_name          text     DEFAULT NULL,
  p_account_number     text     DEFAULT NULL,
  p_account_name       text     DEFAULT NULL,
  p_subaccount_code    text     DEFAULT NULL,
  p_verified_at        timestamptz DEFAULT NULL,
  p_stripe_account_id  text     DEFAULT NULL,
  p_square_merchant_id text     DEFAULT NULL,
  p_square_access_token text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_id uuid;
BEGIN
  PERFORM 1 FROM businesses WHERE id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'business_not_found: %', p_business_id;
  END IF;

  PERFORM id FROM payout_accounts
    WHERE business_id = p_business_id AND is_active = true
    FOR UPDATE;

  UPDATE payout_accounts
    SET is_active = false, updated_at = now()
    WHERE business_id = p_business_id AND is_active = true;

  INSERT INTO payout_accounts (
    business_id, gateway, subaccount_code,
    bank_code, bank_name, account_number, account_name,
    stripe_account_id, square_merchant_id, square_access_token,
    platform_percentage, is_active, verified_at
  ) VALUES (
    p_business_id, p_gateway, p_subaccount_code,
    p_bank_code, p_bank_name, p_account_number, p_account_name,
    p_stripe_account_id, p_square_merchant_id, p_square_access_token,
    2.5, true, p_verified_at
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- Permissions: the old 8-arg overload was dropped above; grant new only
REVOKE ALL ON FUNCTION public.swap_payout_account(uuid, text, text, text, text, text, text, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.swap_payout_account(uuid, text, text, text, text, text, text, timestamptz, text, text, text) TO service_role;

-- ══════════════════════════════════════════════════════════════════
-- §6  Verification
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE _errors text[] := '{}';
BEGIN
  -- authenticated cannot INSERT
  IF has_table_privilege('authenticated', 'public.payout_accounts', 'INSERT') THEN
    _errors := _errors || 'authenticated still has INSERT';
  END IF;
  -- authenticated cannot UPDATE
  IF has_table_privilege('authenticated', 'public.payout_accounts', 'UPDATE') THEN
    _errors := _errors || 'authenticated still has UPDATE';
  END IF;
  -- authenticated cannot DELETE
  IF has_table_privilege('authenticated', 'public.payout_accounts', 'DELETE') THEN
    _errors := _errors || 'authenticated still has DELETE';
  END IF;
  -- authenticated cannot see square_access_token
  IF has_column_privilege('authenticated', 'public.payout_accounts', 'square_access_token', 'SELECT') THEN
    _errors := _errors || 'authenticated can SELECT square_access_token';
  END IF;
  -- authenticated cannot see subaccount_code
  IF has_column_privilege('authenticated', 'public.payout_accounts', 'subaccount_code', 'SELECT') THEN
    _errors := _errors || 'authenticated can SELECT subaccount_code';
  END IF;
  -- authenticated cannot see stripe_account_id
  IF has_column_privilege('authenticated', 'public.payout_accounts', 'stripe_account_id', 'SELECT') THEN
    _errors := _errors || 'authenticated can SELECT stripe_account_id';
  END IF;
  -- service_role has full access
  IF NOT has_table_privilege('service_role', 'public.payout_accounts', 'SELECT') THEN
    _errors := _errors || 'service_role missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.payout_accounts', 'INSERT') THEN
    _errors := _errors || 'service_role missing INSERT';
  END IF;
  -- Exactly one swap_payout_account overload
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'swap_payout_account' AND pronamespace = 'public'::regnamespace) != 1 THEN
    _errors := _errors || 'swap_payout_account: expected exactly 1 overload, found ' || (SELECT count(*) FROM pg_proc WHERE proname = 'swap_payout_account' AND pronamespace = 'public'::regnamespace);
  END IF;
  -- oauth_connect_states not readable by authenticated
  IF has_table_privilege('authenticated', 'public.oauth_connect_states', 'SELECT') THEN
    _errors := _errors || 'authenticated can SELECT oauth_connect_states';
  END IF;

  IF array_length(_errors, 1) > 0 THEN
    RAISE EXCEPTION 'M446 VERIFICATION FAILED: %', array_to_string(_errors, '; ');
  END IF;
  RAISE NOTICE 'M446: all privilege checks passed';
END $$;
