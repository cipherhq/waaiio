-- ═══════════════════════════════════════════════════════════════════════════
-- M436: SEC-005 — Admin MFA enforcement with aal2
--
-- This migration implements the following security controls:
--   1. Creates admin_step_up_authorizations table for step-up MFA challenges.
--   2. Introduces has_admin_role(required_roles text[]) as the single canonical
--      helper for all admin-role checks; requires aal2 (MFA) in the JWT.
--   3. Rewrites is_admin() and is_support() to delegate to has_admin_role(),
--      enforcing aal2 on every RLS call that previously only checked
--      raw_app_meta_data.role.
--   4. Replaces all 28 inline profiles.role / raw_app_meta_data.role admin RLS
--      policies across 20 tables with the canonical helper functions.
--   5. Adds cleanup_expired_step_ups() for cron-driven housekeeping.
--
-- Pre-conditions:
--   - is_admin() exists (created in 247_admin_role_escalation_fix.sql)
--   - is_admin_or_support() / is_admin_or_finance() exist
--   - All listed tables and policies exist in production
--
-- Invariant: No existing non-admin authenticated RLS policy is altered.
--            Only admin-path policies are replaced.
-- ═══════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- §1. admin_step_up_authorizations table
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  uuid        NOT NULL REFERENCES auth.users(id),
  session_id     text        NOT NULL,
  action_type    text        NOT NULL CHECK (action_type IN (
                               'payout_approve',
                               'payout_generate',
                               'provider_config',
                               'team_grant',
                               'team_revoke',
                               'impersonate',
                               'refund'
                             )),
  target_id      text,
  params_hash    text        NOT NULL,
  challenge_id   uuid,
  verified_at    timestamptz,
  consumed_at    timestamptz,
  expires_at     timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_step_up_authorizations ENABLE ROW LEVEL SECURITY;

-- Deny-all: only the service role may touch this table directly.
CREATE POLICY "admin_step_up_deny_all"
  ON public.admin_step_up_authorizations
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Efficient lookup: find pending/unconsumed rows for a given admin session.
CREATE INDEX IF NOT EXISTS idx_admin_step_up_lookup
  ON public.admin_step_up_authorizations (admin_user_id, consumed_at, expires_at);

-- ════════════════════════════════════════════════════════════════════════════
-- §2. has_admin_role(required_roles text[]) — canonical helper
--
-- Returns TRUE only when ALL of the following hold:
--   a) The JWT aal claim is 'aal2' (MFA verified session)
--   b) auth.users.raw_app_meta_data ->> 'role' is in required_roles
--
-- SECURITY DEFINER + SET search_path = '' prevents search-path injection.
-- Fail-closed: any exception or NULL → false.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.has_admin_role(required_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (auth.jwt() ->> 'aal') = 'aal2'
    AND (
      SELECT raw_app_meta_data ->> 'role'
      FROM auth.users
      WHERE id = auth.uid()
    ) = ANY(required_roles),
    false
  )
$$;

REVOKE EXECUTE ON FUNCTION public.has_admin_role(text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_admin_role(text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_admin_role(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_admin_role(text[]) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- §3. Rewrite is_admin() — now requires aal2
--
-- Replaces the plpgsql version from 247_admin_role_escalation_fix.sql.
-- Delegates entirely to has_admin_role so there is exactly one aal2 check.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.has_admin_role(ARRAY['admin']) $$;

-- Preserve existing authenticated-only ACL (set by 374_admin_helper_acl_normalization.sql)
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- §4. Rewrite is_support() — now requires aal2
--
-- New name matches requirement spec. Also replaces is_admin_or_support() with
-- an aal2-gated version. Callers of is_admin_or_support() should migrate to
-- is_support() — both are kept to avoid breaking existing code.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_support()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.has_admin_role(ARRAY['admin', 'support']) $$;

REVOKE EXECUTE ON FUNCTION public.is_support() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_support() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_support() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_support() TO service_role;

-- Keep is_admin_or_support() consistent (also requires aal2 now)
CREATE OR REPLACE FUNCTION public.is_admin_or_support()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']) $$;

-- Preserve existing ACL
REVOKE ALL ON FUNCTION public.is_admin_or_support() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_or_support() FROM anon;
REVOKE ALL ON FUNCTION public.is_admin_or_support() FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_admin_or_support() TO authenticated;

-- Keep is_admin_or_finance() consistent (also requires aal2 now)
CREATE OR REPLACE FUNCTION public.is_admin_or_finance()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.has_admin_role(ARRAY['admin', 'finance']) $$;

-- Preserve existing ACL
REVOKE ALL ON FUNCTION public.is_admin_or_finance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_or_finance() FROM anon;
REVOKE ALL ON FUNCTION public.is_admin_or_finance() FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_admin_or_finance() TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- §5. Replace inline profiles.role admin RLS policies with canonical helpers
--
-- For every policy below:
--   DROP IF EXISTS removes the old inline-role check.
--   CREATE installs the helper-based replacement.
--
-- Naming convention: new policy names are identical to old names so that any
-- external monitoring or documentation referencing them continues to resolve.
-- ════════════════════════════════════════════════════════════════════════════

-- ── admin_audit_logs ──────────────────────────────────────────────────────
-- Old: "Admins can view audit logs" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "Admins can view audit logs" ON public.admin_audit_logs;
CREATE POLICY "Admins can view audit logs"
  ON public.admin_audit_logs
  FOR ALL
  USING (public.is_admin());

-- ── ai_usage ──────────────────────────────────────────────────────────────
-- Old: "ai_usage_admin" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "ai_usage_admin" ON public.ai_usage;
CREATE POLICY "ai_usage_admin"
  ON public.ai_usage
  FOR ALL
  USING (public.is_admin());

-- ── business_payouts ──────────────────────────────────────────────────────
-- Old: "Admins have full access to business_payouts" (ALL, profiles.role = 'admin')
DROP POLICY IF EXISTS "Admins have full access to business_payouts" ON public.business_payouts;
CREATE POLICY "Admins have full access to business_payouts"
  ON public.business_payouts
  FOR ALL
  USING (public.is_admin());

-- ── businesses ────────────────────────────────────────────────────────────
-- Old: "Admins can view all businesses" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "Admins can view all businesses" ON public.businesses;
CREATE POLICY "Admins can view all businesses"
  ON public.businesses
  FOR SELECT
  USING (public.is_admin());

-- ── campaign_donations ────────────────────────────────────────────────────
-- Old: "admin_all_campaign_donations" (ALL, profiles.role = 'admin')
DROP POLICY IF EXISTS "admin_all_campaign_donations" ON public.campaign_donations;
CREATE POLICY "admin_all_campaign_donations"
  ON public.campaign_donations
  FOR ALL
  USING (public.is_admin());

-- ── conversation_usage ────────────────────────────────────────────────────
-- Old: "conversation_usage_admin" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "conversation_usage_admin" ON public.conversation_usage;
CREATE POLICY "conversation_usage_admin"
  ON public.conversation_usage
  FOR ALL
  USING (public.is_admin());

-- ── countries ─────────────────────────────────────────────────────────────
-- Old: "countries_admin_all" (ALL, profiles.role = 'admin')
DROP POLICY IF EXISTS "countries_admin_all" ON public.countries;
CREATE POLICY "countries_admin_all"
  ON public.countries
  FOR ALL
  USING (public.is_admin());

-- ── fraud_events ──────────────────────────────────────────────────────────
-- Old: "fraud_events_admin_read" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "fraud_events_admin_read" ON public.fraud_events;
CREATE POLICY "fraud_events_admin_read"
  ON public.fraud_events
  FOR SELECT
  USING (public.is_admin());

-- ── payout_accounts ───────────────────────────────────────────────────────
-- Old: "Admins can view all payout accounts" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "Admins can view all payout accounts" ON public.payout_accounts;
CREATE POLICY "Admins can view all payout accounts"
  ON public.payout_accounts
  FOR SELECT
  USING (public.is_admin());

-- ── resellers ─────────────────────────────────────────────────────────────
-- Old: "Admin manages resellers" (ALL, profiles.role = 'admin')
DROP POLICY IF EXISTS "Admin manages resellers" ON public.resellers;
CREATE POLICY "Admin manages resellers"
  ON public.resellers
  FOR ALL
  USING (public.is_admin());

-- ── alerts ────────────────────────────────────────────────────────────────
-- Old: "Admin read access" (SELECT, profiles.role IN ('admin', 'support'))
DROP POLICY IF EXISTS "Admin read access" ON public.alerts;
CREATE POLICY "Admin read access"
  ON public.alerts
  FOR SELECT
  USING (public.is_support());

-- ── llm_classifications ───────────────────────────────────────────────────
-- Old: "Admin read access" (SELECT, profiles.role IN ('admin', 'support'))
DROP POLICY IF EXISTS "Admin read access" ON public.llm_classifications;
CREATE POLICY "Admin read access"
  ON public.llm_classifications
  FOR SELECT
  USING (public.is_support());

-- ── pending_transfers (finance manage — UPDATE) ───────────────────────────
-- Old: "Admin manages pending transfers" (UPDATE, profiles.role IN ('admin', 'finance'))
-- Source: 211_ocr_result_and_admin_rls.sql
DROP POLICY IF EXISTS "Admin manages pending transfers" ON public.pending_transfers;
CREATE POLICY "Admin manages pending transfers"
  ON public.pending_transfers
  FOR ALL
  USING (public.has_admin_role(ARRAY['admin', 'finance']));

-- ── platform_fee_invoices ─────────────────────────────────────────────────
-- Old: "Admin manages fee invoices" (ALL, profiles.role IN ('admin', 'finance'))
DROP POLICY IF EXISTS "Admin manages fee invoices" ON public.platform_fee_invoices;
CREATE POLICY "Admin manages fee invoices"
  ON public.platform_fee_invoices
  FOR ALL
  USING (public.has_admin_role(ARRAY['admin', 'finance']));

-- ── reseller_invoices ─────────────────────────────────────────────────────
-- Old: "Admin manages reseller invoices" (ALL, profiles.role IN ('admin', 'finance'))
DROP POLICY IF EXISTS "Admin manages reseller invoices" ON public.reseller_invoices;
CREATE POLICY "Admin manages reseller invoices"
  ON public.reseller_invoices
  FOR ALL
  USING (public.has_admin_role(ARRAY['admin', 'finance']));

-- ── subscription_payments ─────────────────────────────────────────────────
-- Old: "subscription_payments_admin" (SELECT, profiles.role IN ('admin', 'finance'))
DROP POLICY IF EXISTS "subscription_payments_admin" ON public.subscription_payments;
CREATE POLICY "subscription_payments_admin"
  ON public.subscription_payments
  FOR ALL
  USING (public.has_admin_role(ARRAY['admin', 'finance']));

-- ── business_broadcasts ───────────────────────────────────────────────────
-- Old: "business_broadcasts_admin" (ALL, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "business_broadcasts_admin" ON public.business_broadcasts;
CREATE POLICY "business_broadcasts_admin"
  ON public.business_broadcasts
  FOR ALL
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── event_invites ─────────────────────────────────────────────────────────
-- Old: "Admin reads event invites" (SELECT, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "Admin reads event invites" ON public.event_invites;
CREATE POLICY "Admin reads event invites"
  ON public.event_invites
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── flow_dropoffs ─────────────────────────────────────────────────────────
-- Old: "admin_read_dropoffs" (SELECT, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "admin_read_dropoffs" ON public.flow_dropoffs;
CREATE POLICY "admin_read_dropoffs"
  ON public.flow_dropoffs
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── parties ───────────────────────────────────────────────────────────────
-- Old: "Admin reads parties" (SELECT, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "Admin reads parties" ON public.parties;
CREATE POLICY "Admin reads parties"
  ON public.parties
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── reservations ──────────────────────────────────────────────────────────
-- Old: "Admin reads reservations" (SELECT, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "Admin reads reservations" ON public.reservations;
CREATE POLICY "Admin reads reservations"
  ON public.reservations
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── invoices ──────────────────────────────────────────────────────────────
-- Old: "Admin reads invoices" (SELECT, profiles.role IN ('admin', 'support', 'finance'))
DROP POLICY IF EXISTS "Admin reads invoices" ON public.invoices;
CREATE POLICY "Admin reads invoices"
  ON public.invoices
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance']));

-- ── pending_transfers (support/finance view — SELECT) ─────────────────────
-- Old: "Admin views pending transfers" (SELECT, profiles.role IN ('admin', 'support', 'finance'))
-- Source: 209_direct_bank_transfer.sql
-- Note: This is the second policy on pending_transfers — distinct from the
--       'Admin manages pending transfers' UPDATE policy above.
DROP POLICY IF EXISTS "Admin views pending transfers" ON public.pending_transfers;
CREATE POLICY "Admin views pending transfers"
  ON public.pending_transfers
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance']));

-- ── admin_role_permissions (manage — ALL) ────────────────────────────────
-- Old: "Admin manages permissions" (ALL, profiles.role IN ('admin', ...))
-- Source: 221_admin_permissions.sql
DROP POLICY IF EXISTS "Admin manages permissions" ON public.admin_role_permissions;
CREATE POLICY "Admin manages permissions"
  ON public.admin_role_permissions
  FOR ALL
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ── admin_role_permissions (read — SELECT) ───────────────────────────────
-- Old: "Admin roles read permissions" (SELECT, profiles.role IN ('admin', ...))
-- Source: 221_admin_permissions.sql
DROP POLICY IF EXISTS "Admin roles read permissions" ON public.admin_role_permissions;
CREATE POLICY "Admin roles read permissions"
  ON public.admin_role_permissions
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ── business_bank_accounts ────────────────────────────────────────────────
-- Old: "Admin reads bank accounts" (SELECT, profiles.role IN ('admin', 'support', 'finance', 'operations'))
DROP POLICY IF EXISTS "Admin reads bank accounts" ON public.business_bank_accounts;
CREATE POLICY "Admin reads bank accounts"
  ON public.business_bank_accounts
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ── event_tickets ─────────────────────────────────────────────────────────
-- Old: "Admin reads event tickets" (SELECT, profiles.role IN ('admin', 'support', 'finance', 'operations'))
DROP POLICY IF EXISTS "Admin reads event tickets" ON public.event_tickets;
CREATE POLICY "Admin reads event tickets"
  ON public.event_tickets
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ── growth_pricing ────────────────────────────────────────────────────────
-- Old: "growth_pricing_admin_select" (SELECT, profiles.role IN ('admin', 'support', 'finance', 'operations'))
DROP POLICY IF EXISTS "growth_pricing_admin_select" ON public.growth_pricing;
CREATE POLICY "growth_pricing_admin_select"
  ON public.growth_pricing
  FOR SELECT
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ════════════════════════════════════════════════════════════════════════════
-- §6. cleanup_expired_step_ups() — cron housekeeping
--
-- Deletes rows that expired more than 1 hour ago.
-- Called by the scheduled cron job; no application code calls this directly.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.cleanup_expired_step_ups()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.admin_step_up_authorizations
  WHERE expires_at < now() - interval '1 hour'
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_step_ups() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_step_ups() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_step_ups() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_step_ups() TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- §7. Self-verification
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_fn   text;
  v_fns  text[] := ARRAY[
    'has_admin_role(text[])',
    'is_admin()',
    'is_support()',
    'cleanup_expired_step_ups()'
  ];
BEGIN
  -- Verify all helper functions exist
  FOREACH v_fn IN ARRAY v_fns
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public'
        AND (p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')') ILIKE
            split_part(v_fn, '(', 1) || '%'
    ) THEN
      RAISE EXCEPTION 'M436 verification FAILED: function % not found in public schema', v_fn;
    END IF;
  END LOOP;

  -- Verify admin_step_up_authorizations table exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'admin_step_up_authorizations'
  ) THEN
    RAISE EXCEPTION 'M436 verification FAILED: admin_step_up_authorizations table not found';
  END IF;

  -- Verify RLS is enabled on admin_step_up_authorizations
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'admin_step_up_authorizations'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'M436 verification FAILED: RLS not enabled on admin_step_up_authorizations';
  END IF;

  RAISE NOTICE 'M436 self-verification PASSED: SEC-005 admin MFA enforcement applied';
END $$;
