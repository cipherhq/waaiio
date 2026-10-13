-- 442: Server-managed business columns guard
--
-- BEFORE UPDATE trigger on public.businesses: raises if any server-managed
-- column is modified and the caller is not service_role.
-- Copies the role-detection pattern from prevent_tier_tampering() (181).
--
-- Server-managed columns:
--   verification_level, verification_status, payout_limit_monthly,
--   payout_mode, custom_fee_percentage, custom_fee_flat,
--   subscription_tier, owner_id, reseller_id, messaging_suspended
--
-- Owners can still update normal columns (name, description, hours, etc.).
-- SECURITY INVOKER — runs as the calling role.

-- ── 1. Guard function ──
CREATE OR REPLACE FUNCTION public.guard_server_managed_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Allow service_role (used by API routes and cron)
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Check each server-managed column; raise on any change
  IF NEW.verification_level IS DISTINCT FROM OLD.verification_level THEN
    RAISE EXCEPTION 'verification_level can only be modified by the server';
  END IF;

  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
    RAISE EXCEPTION 'verification_status can only be modified by the server';
  END IF;

  IF NEW.payout_limit_monthly IS DISTINCT FROM OLD.payout_limit_monthly THEN
    RAISE EXCEPTION 'payout_limit_monthly can only be modified by the server';
  END IF;

  IF NEW.payout_mode IS DISTINCT FROM OLD.payout_mode THEN
    RAISE EXCEPTION 'payout_mode can only be modified by the server';
  END IF;

  IF NEW.custom_fee_percentage IS DISTINCT FROM OLD.custom_fee_percentage THEN
    RAISE EXCEPTION 'custom_fee_percentage can only be modified by the server';
  END IF;

  IF NEW.custom_fee_flat IS DISTINCT FROM OLD.custom_fee_flat THEN
    RAISE EXCEPTION 'custom_fee_flat can only be modified by the server';
  END IF;

  IF NEW.subscription_tier IS DISTINCT FROM OLD.subscription_tier THEN
    RAISE EXCEPTION 'subscription_tier can only be modified by the server';
  END IF;

  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'owner_id can only be modified by the server';
  END IF;

  IF NEW.reseller_id IS DISTINCT FROM OLD.reseller_id THEN
    RAISE EXCEPTION 'reseller_id can only be modified by the server';
  END IF;

  IF NEW.messaging_suspended IS DISTINCT FROM OLD.messaging_suspended THEN
    RAISE EXCEPTION 'messaging_suspended can only be modified by the server';
  END IF;

  RETURN NEW;
END;
$$;

-- Revoke from PUBLIC, anon, authenticated — only service_role should call it
-- (but as SECURITY INVOKER, the trigger fires for everyone; the function body
-- checks the role and allows service_role through).
REVOKE ALL ON FUNCTION public.guard_server_managed_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_server_managed_columns() FROM anon;
REVOKE ALL ON FUNCTION public.guard_server_managed_columns() FROM authenticated;

-- The trigger must be callable by the trigger machinery regardless of REVOKE.
-- PostgreSQL fires BEFORE triggers for the table owner, so REVOKE on the
-- function does not prevent trigger execution. But grant to service_role
-- explicitly for documentation.
GRANT EXECUTE ON FUNCTION public.guard_server_managed_columns() TO service_role;

-- ── 2. Trigger (idempotent) ──
DROP TRIGGER IF EXISTS trg_guard_server_managed_columns ON public.businesses;

CREATE TRIGGER trg_guard_server_managed_columns
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_server_managed_columns();

-- ── 3. Drop the old single-column tier tampering trigger ──
-- guard_server_managed_columns now covers subscription_tier too.
DROP TRIGGER IF EXISTS trg_prevent_tier_tampering ON public.businesses;
-- Keep the old function for rollback safety; just detach the trigger.

-- ── 4. Self-verification ──
DO $$
DECLARE
  fn_exists boolean;
  trg_exists boolean;
  old_trg_gone boolean;
BEGIN
  -- Check new function exists
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'guard_server_managed_columns'
  ) INTO fn_exists;

  -- Check new trigger exists
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'businesses'
      AND t.tgname = 'trg_guard_server_managed_columns'
  ) INTO trg_exists;

  -- Check old tier-only trigger is removed
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'businesses'
      AND t.tgname = 'trg_prevent_tier_tampering'
  ) INTO old_trg_gone;

  IF fn_exists AND trg_exists AND old_trg_gone THEN
    RAISE NOTICE '442_business_server_managed_columns: PASS — guard_server_managed_columns + trigger present, old tier trigger removed';
  ELSE
    RAISE EXCEPTION '442_business_server_managed_columns: FAIL — fn=%, trg=%, old_removed=%',
      fn_exists, trg_exists, old_trg_gone;
  END IF;
END;
$$;
