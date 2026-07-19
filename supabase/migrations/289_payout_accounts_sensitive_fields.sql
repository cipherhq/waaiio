-- ═══════════════════════════════════════════════════════
-- 289: Enforce sensitive-field authorization on payout_accounts
--
-- Server-controlled ALLOWLIST approach:
-- Browser/authenticated clients can only set safe display fields.
-- All routing-sensitive fields must come from service_role
-- (SECURITY DEFINER RPCs, admin API routes, or webhook handlers).
--
-- SAFE fields (browser-writable):
--   bank_code, bank_name, account_number, account_name,
--   provider_account_name, updated_at
--
-- SENSITIVE fields (service_role only):
--   is_default, is_active, gateway, business_id, connection_mode,
--   connection_status, subaccount_code, stripe_account_id,
--   flutterwave_mid, verified_at, health_status,
--   last_health_check_at, platform_percentage
--
-- Implementation: BEFORE UPDATE and BEFORE INSERT triggers.
-- ═══════════════════════════════════════════════════════

-- Helper: returns true when the current session is service_role
CREATE OR REPLACE FUNCTION public._is_service_role()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT current_setting('role', true) = 'service_role'
      OR (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role';
$$;

-- ── UPDATE trigger: block changes to sensitive fields ──
CREATE OR REPLACE FUNCTION public.enforce_payout_accounts_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public._is_service_role() THEN
    RETURN NEW;
  END IF;

  -- Reject any change to a sensitive field
  IF NEW.is_default IS DISTINCT FROM OLD.is_default THEN
    RAISE EXCEPTION 'Cannot modify is_default — use set_default_connection RPC'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    RAISE EXCEPTION 'Cannot modify is_active directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.gateway IS DISTINCT FROM OLD.gateway THEN
    RAISE EXCEPTION 'Cannot modify gateway directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'Cannot modify business_id directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.connection_mode IS DISTINCT FROM OLD.connection_mode THEN
    RAISE EXCEPTION 'Cannot modify connection_mode directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.connection_status IS DISTINCT FROM OLD.connection_status THEN
    RAISE EXCEPTION 'Cannot modify connection_status directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.subaccount_code IS DISTINCT FROM OLD.subaccount_code THEN
    RAISE EXCEPTION 'Cannot modify subaccount_code directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.stripe_account_id IS DISTINCT FROM OLD.stripe_account_id THEN
    RAISE EXCEPTION 'Cannot modify stripe_account_id directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.flutterwave_mid IS DISTINCT FROM OLD.flutterwave_mid THEN
    RAISE EXCEPTION 'Cannot modify flutterwave_mid directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'Cannot modify verified_at directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.health_status IS DISTINCT FROM OLD.health_status THEN
    RAISE EXCEPTION 'Cannot modify health_status directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.last_health_check_at IS DISTINCT FROM OLD.last_health_check_at THEN
    RAISE EXCEPTION 'Cannot modify last_health_check_at directly'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.platform_percentage IS DISTINCT FROM OLD.platform_percentage THEN
    RAISE EXCEPTION 'Cannot modify platform_percentage directly'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ── INSERT trigger: enforce safe defaults for sensitive fields ──
-- Browser clients can INSERT rows (for onboarding), but sensitive fields
-- are forced to safe defaults. Only service_role can set them freely.
CREATE OR REPLACE FUNCTION public.enforce_payout_accounts_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public._is_service_role() THEN
    RETURN NEW;
  END IF;

  -- Force safe defaults on all sensitive fields for browser inserts
  NEW.is_default := false;
  NEW.is_active := false;       -- must be activated by server after verification
  NEW.connection_status := 'pending';
  NEW.health_status := 'unchecked';
  NEW.verified_at := NULL;
  NEW.last_health_check_at := NULL;
  NEW.platform_percentage := 2.5;  -- cannot self-set fee

  RETURN NEW;
END;
$$;

-- Drop old trigger if it exists (from initial version of this migration)
DROP TRIGGER IF EXISTS trg_payout_accounts_sensitive_fields ON public.payout_accounts;

-- Attach triggers
CREATE TRIGGER trg_payout_accounts_update_guard
  BEFORE UPDATE ON public.payout_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_payout_accounts_update();

CREATE TRIGGER trg_payout_accounts_insert_guard
  BEFORE INSERT ON public.payout_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_payout_accounts_insert();
