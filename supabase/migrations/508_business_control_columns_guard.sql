-- ══════════════════════════════════════════════════════════
-- 508: Server-managed business control columns
--
-- Extends the 442 guard so that only the server (service_role) and the
-- function owner (SECURITY DEFINER functions such as
-- assign_first_shared_channel, promote_channel_candidate and
-- the channel transition functions) can change:
--   assigned_channel_id, whatsapp_channel_id, wa_method, country_code,
--   status, bot_code, trial_ends_at, is_verified, verified_at, verified_by,
--   whatsapp_plan, is_whitelabel
-- in addition to the 9 columns 442 already guards. Trial dates are set by
-- the trial lifecycle functions (SECURITY DEFINER), verification by admin
-- review through the server.
--
-- Also adds a BEFORE INSERT guard: only the server (service_role) and the
-- function owner can create a business (Owner decision 2026-11-03). Every app
-- path (signup, admin onboarding, reseller, WhatsApp onboarding) already
-- creates businesses with the service client.
--
-- Bot codes are locked against owner edits (Owner decision 2026-11-03).
-- Renames are done by support / admin through the server.
--
-- No data is changed. SECURITY INVOKER — runs as the calling role.
-- ══════════════════════════════════════════════════════════

-- ── 1. UPDATE guard (replaces the 442 body; same allow rule) ──
CREATE OR REPLACE FUNCTION public.guard_server_managed_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_db_owner TEXT;
BEGIN
  -- Allow service_role (used by API routes and cron via PostgREST)
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Allow the database owner role (SECURITY DEFINER functions run as the
  -- function owner). The owner of this trigger function is the trusted boundary.
  SELECT r.rolname INTO v_db_owner
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_roles r ON p.proowner = r.oid
   WHERE n.nspname = 'public'
     AND p.proname = 'guard_server_managed_columns'
   LIMIT 1;

  IF v_db_owner IS NOT NULL AND current_user = v_db_owner THEN
    RETURN NEW;
  END IF;

  -- 442 columns
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

  -- 508 control columns
  IF NEW.assigned_channel_id IS DISTINCT FROM OLD.assigned_channel_id THEN
    RAISE EXCEPTION 'assigned_channel_id can only be modified by the server';
  END IF;
  IF NEW.whatsapp_channel_id IS DISTINCT FROM OLD.whatsapp_channel_id THEN
    RAISE EXCEPTION 'whatsapp_channel_id can only be modified by the server';
  END IF;
  IF NEW.wa_method IS DISTINCT FROM OLD.wa_method THEN
    RAISE EXCEPTION 'wa_method can only be modified by the server';
  END IF;
  IF NEW.country_code IS DISTINCT FROM OLD.country_code THEN
    RAISE EXCEPTION 'country_code can only be modified by the server';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'status can only be modified by the server';
  END IF;
  IF NEW.bot_code IS DISTINCT FROM OLD.bot_code THEN
    RAISE EXCEPTION 'bot_code can only be modified by the server';
  END IF;
  IF NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at THEN
    RAISE EXCEPTION 'trial_ends_at can only be modified by the server';
  END IF;
  IF NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
    RAISE EXCEPTION 'is_verified can only be modified by the server';
  END IF;
  IF NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'verified_at can only be modified by the server';
  END IF;
  IF NEW.verified_by IS DISTINCT FROM OLD.verified_by THEN
    RAISE EXCEPTION 'verified_by can only be modified by the server';
  END IF;
  IF NEW.whatsapp_plan IS DISTINCT FROM OLD.whatsapp_plan THEN
    RAISE EXCEPTION 'whatsapp_plan can only be modified by the server';
  END IF;
  IF NEW.is_whitelabel IS DISTINCT FROM OLD.is_whitelabel THEN
    RAISE EXCEPTION 'is_whitelabel can only be modified by the server';
  END IF;

  -- messaging_suspended is guarded by trg_guard_messaging_suspended (363).
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_server_managed_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_server_managed_columns() FROM anon;
REVOKE ALL ON FUNCTION public.guard_server_managed_columns() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.guard_server_managed_columns() TO service_role;

-- ── 2. INSERT guard: server-only creation ──
CREATE OR REPLACE FUNCTION public.guard_business_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_db_owner TEXT;
BEGIN
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  SELECT r.rolname INTO v_db_owner
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_roles r ON p.proowner = r.oid
   WHERE n.nspname = 'public'
     AND p.proname = 'guard_business_insert'
   LIMIT 1;

  IF v_db_owner IS NOT NULL AND current_user = v_db_owner THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'businesses can only be created by the server';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_business_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_business_insert() FROM anon;
REVOKE ALL ON FUNCTION public.guard_business_insert() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.guard_business_insert() TO service_role;

DROP TRIGGER IF EXISTS trg_guard_business_insert ON public.businesses;
CREATE TRIGGER trg_guard_business_insert
  BEFORE INSERT ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_business_insert();

-- ── 3. Self-verification ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public' AND c.relname = 'businesses' AND t.tgname = 'trg_guard_server_managed_columns'
  ) THEN
    RAISE EXCEPTION '508: trg_guard_server_managed_columns is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON t.tgrelid = c.oid JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public' AND c.relname = 'businesses' AND t.tgname = 'trg_guard_business_insert'
  ) THEN
    RAISE EXCEPTION '508: trg_guard_business_insert is missing';
  END IF;
END;
$$;
