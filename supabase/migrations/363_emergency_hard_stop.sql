-- ═══════════════════════════════════════════════════════
-- 363: Emergency Messaging Hard-Stop (S-1, #256)
--
-- Adds per-business messaging_suspended flag with:
-- - DB-enforced admin-only mutation (column-protection trigger)
-- - Atomic durable audit trail (append-only)
-- - Admin-only SECURITY DEFINER toggle RPC
-- ═══════════════════════════════════════════════════════

-- ── 1. Add messaging_suspended to businesses ──

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS messaging_suspended BOOLEAN NOT NULL DEFAULT false;

-- ── 2. Create append-only suspension audit table ──

CREATE TABLE IF NOT EXISTS public.messaging_suspension_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  actor_id    UUID NOT NULL,
  prior_state BOOLEAN NOT NULL,
  new_state   BOOLEAN NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.messaging_suspension_audit ENABLE ROW LEVEL SECURITY;

-- Admin read-only
CREATE POLICY admin_read_suspension_audit ON public.messaging_suspension_audit
  FOR SELECT USING (public.is_admin());

-- Append-only: block UPDATE/DELETE
CREATE OR REPLACE FUNCTION public.prevent_suspension_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'messaging_suspension_audit is append-only: % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_suspension_audit_no_update
  BEFORE UPDATE ON public.messaging_suspension_audit FOR EACH ROW
  EXECUTE FUNCTION public.prevent_suspension_audit_mutation();

CREATE TRIGGER trg_suspension_audit_no_delete
  BEFORE DELETE ON public.messaging_suspension_audit FOR EACH ROW
  EXECUTE FUNCTION public.prevent_suspension_audit_mutation();

-- ── 3. Column-protection trigger on businesses ──
-- Allows messaging_suspended mutation only by the trusted DB-owner role
-- (the role that owns toggle_messaging_suspension — typically postgres or
-- supabase_admin depending on the hosting environment).
-- Application roles (authenticated, service_role, anon) are always blocked.
-- This is production-compatible: Supabase project postgres is non-superuser
-- but owns all SECURITY DEFINER application functions.

CREATE OR REPLACE FUNCTION public.guard_messaging_suspended()
RETURNS TRIGGER AS $$
DECLARE
  v_trusted_owner TEXT;
BEGIN
  IF NEW.messaging_suspended IS DISTINCT FROM OLD.messaging_suspended THEN
    -- The trusted boundary is the owner of toggle_messaging_suspension().
    -- Only that role (the DB migration owner) may mutate this column.
    SELECT r.rolname INTO v_trusted_owner
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_roles r ON p.proowner = r.oid
     WHERE n.nspname = 'public'
       AND p.proname = 'toggle_messaging_suspension'
     LIMIT 1;

    IF v_trusted_owner IS NULL OR current_user != v_trusted_owner THEN
      RAISE EXCEPTION 'messaging_suspended can only be modified via toggle_messaging_suspension()';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_messaging_suspended
  BEFORE UPDATE ON public.businesses FOR EACH ROW
  EXECUTE FUNCTION public.guard_messaging_suspended();

-- ── 4. Admin-only toggle RPC with atomic audit ──

CREATE OR REPLACE FUNCTION public.toggle_messaging_suspension(
  p_business_id UUID,
  p_suspended BOOLEAN,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_prior_state BOOLEAN;
  v_biz_name TEXT;
BEGIN
  -- 1. Verify admin authorization
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'toggle_messaging_suspension requires authenticated caller';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'toggle_messaging_suspension requires admin role';
  END IF;

  -- 2. Lock and read current state
  SELECT messaging_suspended, name
  INTO v_prior_state, v_biz_name
  FROM businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF v_prior_state IS NULL THEN
    RAISE EXCEPTION 'Business not found: %', p_business_id;
  END IF;

  -- 3. No-op if already in desired state
  IF v_prior_state = p_suspended THEN
    RETURN jsonb_build_object(
      'success', true,
      'changed', false,
      'business_id', p_business_id,
      'messaging_suspended', p_suspended
    );
  END IF;

  -- 4. Update suspension state (trigger allows because current_user is superuser)
  UPDATE businesses
  SET messaging_suspended = p_suspended
  WHERE id = p_business_id;

  -- 5. Atomic audit record (same transaction)
  INSERT INTO messaging_suspension_audit (
    business_id, actor_id, prior_state, new_state, reason, created_at
  ) VALUES (
    p_business_id, v_caller_id, v_prior_state, p_suspended, p_reason, clock_timestamp()
  );

  RETURN jsonb_build_object(
    'success', true,
    'changed', true,
    'business_id', p_business_id,
    'business_name', v_biz_name,
    'messaging_suspended', p_suspended,
    'prior_state', v_prior_state,
    'actor_id', v_caller_id
  );
END;
$$;

-- Restrict EXECUTE: revoke from PUBLIC, grant only to authenticated
REVOKE ALL ON FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) TO authenticated;
