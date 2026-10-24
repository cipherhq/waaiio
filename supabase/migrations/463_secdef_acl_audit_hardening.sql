-- Migration 463: SECURITY DEFINER ACL audit hardening
--
-- Audit NB-5: Independent staging inventory found exposed SECURITY DEFINER
-- functions callable by anon or authenticated without authorization need.
--
-- CHANGES:
--   1. calculate_volume_discount: REVOKE anon+authenticated, add SET search_path
--      (bot-only via service client; no internal auth check; was missing search_path)
--   2. check_conversation_limit: REVOKE anon+authenticated
--      (bot executor only via service client; no internal auth check)
--   3. get_business_revenue: REVOKE anon (has auth.uid() check but should require authentication)
--   4. get_order_revenue: REVOKE anon (has auth.uid() check but should require authentication)
--   5. get_outstanding_invoices: REVOKE anon (has auth.uid() check but should require authentication)
--   6. check_business_role: REVOKE anon (used in RLS policies, needs authenticated but not anon)
--
-- NOT CHANGED (intentionally public):
--   - handle_new_user: auth trigger, must remain accessible
--   - get_active_appointments_public: public booking pages
--   - get_upcoming_class_sessions: public class session pages
--
-- SECURITY: All changes are REVOKE-only (backward compatible).
-- The functions themselves are not modified — only execution grants are tightened.

-- ══════════════════════════════════════════════════════════
-- A. calculate_volume_discount — add missing search_path + lock to service_role
-- ══════════════════════════════════════════════════════════

-- Recreate with SET search_path to fix the missing config.
-- Body is identical to the existing function; only proconfig changes.
CREATE OR REPLACE FUNCTION public.calculate_volume_discount(
  p_business_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_unit_price integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule RECORD;
  v_discount INTEGER := 0;
BEGIN
  -- Find the best matching rule (most specific: product-level first, then business-wide)
  SELECT * INTO v_rule
  FROM volume_discount_rules
  WHERE business_id = p_business_id
    AND is_active = true
    AND (product_id = p_product_id OR product_id IS NULL)
    AND p_quantity >= min_quantity
    AND (max_quantity IS NULL OR p_quantity <= max_quantity)
  ORDER BY
    product_id IS NULL ASC,  -- product-specific first
    min_quantity DESC         -- highest matching tier
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Calculate discount based on type
  CASE v_rule.discount_type
    WHEN 'percentage' THEN
      v_discount := ROUND((p_unit_price * p_quantity * v_rule.discount_value) / 100);
    WHEN 'fixed_per_unit' THEN
      v_discount := ROUND(v_rule.discount_value * p_quantity);
    WHEN 'fixed_total' THEN
      v_discount := ROUND(v_rule.discount_value);
  END CASE;

  -- Cap discount at item total
  IF v_discount > (p_unit_price * p_quantity) THEN
    v_discount := p_unit_price * p_quantity;
  END IF;

  RETURN v_discount;
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_volume_discount(uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calculate_volume_discount(uuid, uuid, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.calculate_volume_discount(uuid, uuid, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_volume_discount(uuid, uuid, integer, integer) TO service_role;


-- ══════════════════════════════════════════════════════════
-- B. check_conversation_limit — lock to service_role
-- ══════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.check_conversation_limit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_conversation_limit(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_conversation_limit(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_conversation_limit(uuid) TO service_role;


-- ══════════════════════════════════════════════════════════
-- C. Dashboard revenue RPCs — revoke anon, keep authenticated
-- ══════════════════════════════════════════════════════════
-- These have internal auth.uid() ownership checks but should not be callable
-- without authentication at all. Must REVOKE from PUBLIC first (Postgres default
-- grants PUBLIC execute), then explicitly re-GRANT to authenticated + service_role.

REVOKE ALL ON FUNCTION public.get_business_revenue(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_business_revenue(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_business_revenue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_business_revenue(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_order_revenue(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_revenue(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_order_revenue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_revenue(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_outstanding_invoices(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_outstanding_invoices(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_outstanding_invoices(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_outstanding_invoices(uuid) TO service_role;


-- ══════════════════════════════════════════════════════════
-- D. check_business_role — revoke anon, keep authenticated (RLS dependency)
-- ══════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.check_business_role(uuid, uuid, business_role[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_business_role(uuid, uuid, business_role[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_business_role(uuid, uuid, business_role[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_business_role(uuid, uuid, business_role[]) TO service_role;


-- ══════════════════════════════════════════════════════════
-- E. Verification assertions
-- ══════════════════════════════════════════════════════════

DO $$
BEGIN
  -- A. calculate_volume_discount: NOT executable by anon or authenticated
  IF has_function_privilege('anon', 'public.calculate_volume_discount(uuid,uuid,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: calculate_volume_discount still executable by anon';
  END IF;
  IF has_function_privilege('authenticated', 'public.calculate_volume_discount(uuid,uuid,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: calculate_volume_discount still executable by authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.calculate_volume_discount(uuid,uuid,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: calculate_volume_discount NOT executable by service_role';
  END IF;

  -- A2. calculate_volume_discount: verify search_path is set
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'calculate_volume_discount'
      AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      AND p.proconfig IS NOT NULL
      AND 'search_path=public' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'ASSERT FAIL: calculate_volume_discount missing search_path=public';
  END IF;

  -- B. check_conversation_limit: NOT executable by anon or authenticated
  IF has_function_privilege('anon', 'public.check_conversation_limit(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: check_conversation_limit still executable by anon';
  END IF;
  IF has_function_privilege('authenticated', 'public.check_conversation_limit(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: check_conversation_limit still executable by authenticated';
  END IF;

  -- C. Dashboard RPCs: NOT executable by anon
  IF has_function_privilege('anon', 'public.get_business_revenue(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: get_business_revenue still executable by anon';
  END IF;
  IF has_function_privilege('anon', 'public.get_order_revenue(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: get_order_revenue still executable by anon';
  END IF;
  IF has_function_privilege('anon', 'public.get_outstanding_invoices(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: get_outstanding_invoices still executable by anon';
  END IF;
  -- C2. Dashboard RPCs: STILL executable by authenticated (dashboard needs them)
  IF NOT has_function_privilege('authenticated', 'public.get_business_revenue(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: get_business_revenue NOT executable by authenticated';
  END IF;

  -- D. check_business_role: NOT executable by anon, YES by authenticated (RLS dep)
  IF has_function_privilege('anon', 'public.check_business_role(uuid,uuid,business_role[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: check_business_role still executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.check_business_role(uuid,uuid,business_role[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT FAIL: check_business_role NOT executable by authenticated (RLS needs it)';
  END IF;

  RAISE NOTICE 'M463: All SECURITY DEFINER ACL assertions passed';
END;
$$;
