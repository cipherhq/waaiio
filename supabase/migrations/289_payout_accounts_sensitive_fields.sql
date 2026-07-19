-- ═══════════════════════════════════════════════════════
-- 289: Enforce sensitive-field authorization on payout_accounts
--
-- Browser/authenticated clients can only update safe display fields.
-- Sensitive fields (is_default, connection_status, connection_mode,
-- health_status, verified_at, last_health_check_at) can only be
-- changed by service_role (via SECURITY DEFINER RPCs or admin API).
--
-- Implementation: BEFORE UPDATE trigger that rejects changes to
-- sensitive columns unless the session role is service_role.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enforce_payout_accounts_sensitive_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- service_role bypasses this check (used by RPCs and admin routes)
  IF current_setting('role', true) = 'service_role'
     OR current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Block changes to sensitive fields
  IF NEW.is_default IS DISTINCT FROM OLD.is_default THEN
    RAISE EXCEPTION 'Cannot modify is_default directly — use set_default_connection RPC'
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  IF NEW.connection_status IS DISTINCT FROM OLD.connection_status THEN
    RAISE EXCEPTION 'Cannot modify connection_status directly'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.connection_mode IS DISTINCT FROM OLD.connection_mode THEN
    RAISE EXCEPTION 'Cannot modify connection_mode directly'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.health_status IS DISTINCT FROM OLD.health_status THEN
    RAISE EXCEPTION 'Cannot modify health_status directly'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'Cannot modify verified_at directly'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.last_health_check_at IS DISTINCT FROM OLD.last_health_check_at THEN
    RAISE EXCEPTION 'Cannot modify last_health_check_at directly'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- Attach trigger
DROP TRIGGER IF EXISTS trg_payout_accounts_sensitive_fields ON public.payout_accounts;
CREATE TRIGGER trg_payout_accounts_sensitive_fields
  BEFORE UPDATE ON public.payout_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_payout_accounts_sensitive_fields();
