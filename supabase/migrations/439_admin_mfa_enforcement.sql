-- ═══════════════════════════════════════════════════════════════════════════
-- M439: SEC-005 — Admin MFA enforcement with aal2
--
-- This migration implements the following security controls:
--   1. Creates admin_step_up_authorizations table for step-up MFA challenges.
--   2. Introduces has_admin_role(required_roles text[]) as the single canonical
--      helper for all admin-role checks; requires aal2 (MFA) in the JWT.
--   3. Rewrites is_admin(), is_support() and has_platform_role() to
--      delegate to has_admin_role(), enforcing aal2 on legacy RLS paths
--      that previously only checked raw_app_meta_data.role.
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
                               'payout_reject',
                               'payout_generate',
                               'provider_config',
                               'team_grant',
                               'team_revoke',
                               'impersonate',
                               'refund',
                               'reseller_payout_approve',
                               'reseller_payout_reject',
                               'reseller_payout_mark_paid',
                               'reseller_payout_generate',
                               'commercial_config',
                               'messaging_config',
                               'messaging_suspension'
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

-- Service role needs explicit table-level DML (BYPASSRLS skips RLS, not ACL).
GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_step_up_authorizations TO service_role;
REVOKE ALL ON TABLE public.admin_step_up_authorizations FROM PUBLIC, anon, authenticated;

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

-- LANGUAGE plpgsql defers body validation to execution time. LANGUAGE sql
-- would fail at CREATE time in environments where auth.jwt() is not yet
-- available (e.g. CI migration validation on disposable PostgreSQL).
CREATE OR REPLACE FUNCTION public.has_admin_role(required_roles text[])
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  -- Check aal2 from the JWT
  IF (auth.jwt() ->> 'aal') IS DISTINCT FROM 'aal2' THEN
    RETURN false;
  END IF;

  -- Check the canonical role from auth.users app_metadata
  SELECT raw_app_meta_data ->> 'role'
  INTO v_role
  FROM auth.users
  WHERE id = auth.uid();

  RETURN COALESCE(v_role = ANY(required_roles), false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.has_admin_role(text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_admin_role(text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_admin_role(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_admin_role(text[]) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- §2b. Close the legacy has_platform_role() RLS path (M365).
--
-- M365 policies on demo_requests, attendance_log and ai_classification_log
-- still invoke has_platform_role(), not is_admin()/is_support(). Leaving it
-- role-only would allow password-only Admin sessions to access those tables.
-- Keep the existing role-array permissions/ACL and enforce the SAME aal2 gate
-- from the canonical admin helper. No policy commands or tenant permissions
-- are broadened.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.has_platform_role(p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public.has_admin_role(p_roles) $$;

REVOKE ALL ON FUNCTION public.has_platform_role(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_platform_role(text[]) FROM anon;
REVOKE ALL ON FUNCTION public.has_platform_role(text[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.has_platform_role(text[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.has_platform_role(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_platform_role(text[]) TO service_role;

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
-- Preserves SELECT scope — admin reads audit logs; writes go through service client.
DROP POLICY IF EXISTS "Admins can view audit logs" ON public.admin_audit_logs;
CREATE POLICY "Admins can view audit logs"
  ON public.admin_audit_logs
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Drop legacy INSERT policy from M010 (used profiles.role, no aal2).
-- SEC-005: All audit writes go through the service client via logAdminAudit().
-- No authenticated INSERT policy needed — direct PostgREST writes blocked.
DROP POLICY IF EXISTS "Admins can insert audit logs" ON public.admin_audit_logs;
REVOKE INSERT, UPDATE, DELETE ON public.admin_audit_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_audit_logs TO service_role;

-- ── ai_usage ──────────────────────────────────────────────────────────────
-- Old: "ai_usage_admin" (SELECT, profiles.role = 'admin')
-- Preserves SELECT scope.
DROP POLICY IF EXISTS "ai_usage_admin" ON public.ai_usage;
CREATE POLICY "ai_usage_admin"
  ON public.ai_usage
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ── business_payouts ──────────────────────────────────────────────────────
-- Old: "Admins have full access to business_payouts" (ALL, profiles.role = 'admin')
-- SEC-005: Admin payout reads via PostgREST; writes via service-role routes
-- with step-up authorization. FOR SELECT prevents direct DML bypass.
DROP POLICY IF EXISTS "Admins have full access to business_payouts" ON public.business_payouts;
CREATE POLICY "Admins can view business_payouts"
  ON public.business_payouts
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Revoke DML from authenticated — all payout mutations go through
-- service-role API routes that require step-up authorization.
-- Explicitly grant to service_role (CI environments lack ALTER DEFAULT PRIVILEGES).
REVOKE INSERT, UPDATE, DELETE ON TABLE public.business_payouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.business_payouts TO service_role;

-- Same pattern for reseller_payouts: all writes via service-role API routes.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.reseller_payouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reseller_payouts TO service_role;

-- Impersonation tokens are issued via service-role API only.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.admin_impersonation_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_impersonation_tokens TO service_role;

-- ── businesses ────────────────────────────────────────────────────────────
-- Old: "Admins can view all businesses" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "Admins can view all businesses" ON public.businesses;
CREATE POLICY "Admins can view all businesses"
  ON public.businesses
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ── campaign_donations ────────────────────────────────────────────────────
-- Old: "admin_all_campaign_donations" (ALL, profiles.role = 'admin')
DROP POLICY IF EXISTS "admin_all_campaign_donations" ON public.campaign_donations;
CREATE POLICY "admin_all_campaign_donations"
  ON public.campaign_donations
  FOR ALL
  TO authenticated
  USING (public.is_admin());

-- ── conversation_usage ────────────────────────────────────────────────────
-- Old: "conversation_usage_admin" (SELECT, profiles.role = 'admin')
-- Preserves SELECT scope.
DROP POLICY IF EXISTS "conversation_usage_admin" ON public.conversation_usage;
CREATE POLICY "conversation_usage_admin"
  ON public.conversation_usage
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ── countries ─────────────────────────────────────────────────────────────
-- Old: "countries_admin_all" (ALL, profiles.role = 'admin')
DROP POLICY IF EXISTS "countries_admin_all" ON public.countries;
CREATE POLICY "countries_admin_all"
  ON public.countries
  FOR ALL
  TO authenticated
  USING (public.is_admin());

-- ── fraud_events ──────────────────────────────────────────────────────────
-- Old: "fraud_events_admin_read" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "fraud_events_admin_read" ON public.fraud_events;
CREATE POLICY "fraud_events_admin_read"
  ON public.fraud_events
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ── payout_accounts ───────────────────────────────────────────────────────
-- Old: "Admins can view all payout accounts" (SELECT, profiles.role = 'admin')
DROP POLICY IF EXISTS "Admins can view all payout accounts" ON public.payout_accounts;
CREATE POLICY "Admins can view all payout accounts"
  ON public.payout_accounts
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- ── resellers ─────────────────────────────────────────────────────────────
-- Old: "Admin manages resellers" (ALL, profiles.role = 'admin')
DROP POLICY IF EXISTS "Admin manages resellers" ON public.resellers;
CREATE POLICY "Admin manages resellers"
  ON public.resellers
  FOR ALL
  TO authenticated
  USING (public.is_admin());

-- ── alerts ────────────────────────────────────────────────────────────────
-- Old: "Admin read access" (SELECT, profiles.role IN ('admin', 'support'))
DROP POLICY IF EXISTS "Admin read access" ON public.alerts;
CREATE POLICY "Admin read access"
  ON public.alerts
  FOR SELECT
  TO authenticated
  USING (public.is_support());

-- ── llm_classifications ───────────────────────────────────────────────────
-- Old: "Admin read access" (SELECT, profiles.role IN ('admin', 'support'))
DROP POLICY IF EXISTS "Admin read access" ON public.llm_classifications;
CREATE POLICY "Admin read access"
  ON public.llm_classifications
  FOR SELECT
  TO authenticated
  USING (public.is_support());

-- ── pending_transfers (finance manage — UPDATE) ───────────────────────────
-- Old: "Admin manages pending transfers" (UPDATE, profiles.role IN ('admin', 'finance'))
-- Source: 211_ocr_result_and_admin_rls.sql — preserves UPDATE scope.
DROP POLICY IF EXISTS "Admin manages pending transfers" ON public.pending_transfers;
CREATE POLICY "Admin manages pending transfers"
  ON public.pending_transfers
  FOR UPDATE
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'finance']));

-- ── platform_fee_invoices ─────────────────────────────────────────────────
-- Old: "Admin manages fee invoices" (ALL, profiles.role IN ('admin', 'finance'))
DROP POLICY IF EXISTS "Admin manages fee invoices" ON public.platform_fee_invoices;
CREATE POLICY "Admin manages fee invoices"
  ON public.platform_fee_invoices
  FOR ALL
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'finance']));

-- ── reseller_invoices ─────────────────────────────────────────────────────
-- Old: "Admin manages reseller invoices" (ALL, profiles.role IN ('admin', 'finance'))
DROP POLICY IF EXISTS "Admin manages reseller invoices" ON public.reseller_invoices;
CREATE POLICY "Admin manages reseller invoices"
  ON public.reseller_invoices
  FOR ALL
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'finance']));

-- ── subscription_payments ─────────────────────────────────────────────────
-- Old: "subscription_payments_admin" (SELECT, profiles.role IN ('admin', 'finance'))
-- Preserves SELECT scope.
DROP POLICY IF EXISTS "subscription_payments_admin" ON public.subscription_payments;
CREATE POLICY "subscription_payments_admin"
  ON public.subscription_payments
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'finance']));

-- ── business_broadcasts ───────────────────────────────────────────────────
-- Old: "business_broadcasts_admin" (ALL, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "business_broadcasts_admin" ON public.business_broadcasts;
CREATE POLICY "business_broadcasts_admin"
  ON public.business_broadcasts
  FOR ALL
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── event_invites ─────────────────────────────────────────────────────────
-- Old: "Admin reads event invites" (SELECT, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "Admin reads event invites" ON public.event_invites;
CREATE POLICY "Admin reads event invites"
  ON public.event_invites
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── flow_dropoffs ─────────────────────────────────────────────────────────
-- Old: "admin_read_dropoffs" (SELECT, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "admin_read_dropoffs" ON public.flow_dropoffs;
CREATE POLICY "admin_read_dropoffs"
  ON public.flow_dropoffs
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── parties ───────────────────────────────────────────────────────────────
-- Old: "Admin reads parties" (SELECT, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "Admin reads parties" ON public.parties;
CREATE POLICY "Admin reads parties"
  ON public.parties
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── reservations ──────────────────────────────────────────────────────────
-- Old: "Admin reads reservations" (SELECT, profiles.role IN ('admin', 'support', 'operations'))
DROP POLICY IF EXISTS "Admin reads reservations" ON public.reservations;
CREATE POLICY "Admin reads reservations"
  ON public.reservations
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- ── invoices ──────────────────────────────────────────────────────────────
-- Old: "Admin reads invoices" (SELECT, profiles.role IN ('admin', 'support', 'finance'))
DROP POLICY IF EXISTS "Admin reads invoices" ON public.invoices;
CREATE POLICY "Admin reads invoices"
  ON public.invoices
  FOR SELECT
  TO authenticated
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
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance']));

-- ── admin_role_permissions (manage — ALL) ────────────────────────────────
-- Old: "Admin manages permissions" (ALL, profiles.role IN ('admin', ...))
-- Source: 221_admin_permissions.sql
DROP POLICY IF EXISTS "Admin manages permissions" ON public.admin_role_permissions;
CREATE POLICY "Admin manages permissions"
  ON public.admin_role_permissions
  FOR ALL
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ── admin_role_permissions (read — SELECT) ───────────────────────────────
-- Old: "Admin roles read permissions" (SELECT, profiles.role IN ('admin', ...))
-- Source: 221_admin_permissions.sql
DROP POLICY IF EXISTS "Admin roles read permissions" ON public.admin_role_permissions;
CREATE POLICY "Admin roles read permissions"
  ON public.admin_role_permissions
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ── business_bank_accounts ────────────────────────────────────────────────
-- Old: "Admin reads bank accounts" (SELECT, profiles.role IN ('admin', 'support', 'finance', 'operations'))
DROP POLICY IF EXISTS "Admin reads bank accounts" ON public.business_bank_accounts;
CREATE POLICY "Admin reads bank accounts"
  ON public.business_bank_accounts
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ── event_tickets ─────────────────────────────────────────────────────────
-- Old: "Admin reads event tickets" (SELECT, profiles.role IN ('admin', 'support', 'finance', 'operations'))
DROP POLICY IF EXISTS "Admin reads event tickets" ON public.event_tickets;
CREATE POLICY "Admin reads event tickets"
  ON public.event_tickets
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- ── growth_pricing ────────────────────────────────────────────────────────
-- Old: "growth_pricing_admin_select" (SELECT, profiles.role IN ('admin', 'support', 'finance', 'operations'))
DROP POLICY IF EXISTS "growth_pricing_admin_select" ON public.growth_pricing;
CREATE POLICY "growth_pricing_admin_select"
  ON public.growth_pricing
  FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'finance', 'operations']));

-- SEC-005: Country/provider catalog changes MUST use an action-bound server
-- mutation, not browser-issued Supabase table DML. Read access is unchanged.
-- service_role remains authorized for verified server mutations.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.countries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.countries TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- §5b. Financial RPC EXECUTE — revoke direct browser access
--
-- C6: All financial mutation RPCs must go through server routes with step-up
-- MFA. Revoke EXECUTE from authenticated; grant to service_role for server use.
-- save_messaging_config: nested guard (E2) — called only from SECURITY DEFINER
-- outer functions, not directly.
-- ════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.save_commercial_config(text, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_commercial_config(text, jsonb, text, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.save_market_messaging_config(jsonb, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_market_messaging_config(jsonb, jsonb, jsonb, jsonb, uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.save_messaging_config(jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
-- No service_role GRANT — only reachable via SECURITY DEFINER outer function

REVOKE EXECUTE ON FUNCTION public.toggle_messaging_suspension(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_messaging_suspension(uuid, boolean, text) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- §5c. Service-only financial RPC wrappers (C6 Option B)
--
-- Each svc_* function accepts p_actor_user_id (server-verified admin ID),
-- performs defense-in-depth admin verification via auth.users, then calls
-- the original SECURITY DEFINER function under the service_role context.
-- The original functions' auth.uid()/is_admin() checks still apply — these
-- wrappers are called by the service client which provides the JWT context.
--
-- These wrappers are NOT reachable by authenticated/anon/PUBLIC.
-- ════════════════════════════════════════════════════════════════════════════

-- svc_toggle_messaging_suspension: server-only entry for messaging suspension
CREATE OR REPLACE FUNCTION public.svc_toggle_messaging_suspension(
  p_actor_user_id UUID,
  p_business_id UUID,
  p_suspended BOOLEAN,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_role TEXT;
  v_prior_state BOOLEAN;
  v_biz_name TEXT;
BEGIN
  -- Defense-in-depth: verify actor is admin via auth.users
  SELECT raw_app_meta_data ->> 'role' INTO v_actor_role
  FROM auth.users WHERE id = p_actor_user_id;
  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'svc_toggle_messaging_suspension requires admin role';
  END IF;

  -- Business logic (same as toggle_messaging_suspension body, using p_actor_user_id)
  SELECT messaging_suspended, name INTO v_prior_state, v_biz_name
  FROM businesses WHERE id = p_business_id FOR UPDATE;
  IF v_prior_state IS NULL THEN
    RAISE EXCEPTION 'Business not found: %', p_business_id;
  END IF;
  IF v_prior_state = p_suspended THEN
    RETURN jsonb_build_object('success', true, 'changed', false,
      'business_id', p_business_id, 'messaging_suspended', p_suspended);
  END IF;

  UPDATE businesses SET messaging_suspended = p_suspended WHERE id = p_business_id;

  INSERT INTO messaging_suspension_audit (business_id, actor_id, prior_state, new_state, reason, created_at)
  VALUES (p_business_id, p_actor_user_id, v_prior_state, p_suspended, p_reason, clock_timestamp());

  RETURN jsonb_build_object('success', true, 'changed', true,
    'business_id', p_business_id, 'business_name', v_biz_name,
    'messaging_suspended', p_suspended, 'prior_state', v_prior_state,
    'actor_id', p_actor_user_id);
END $$;
REVOKE ALL ON FUNCTION public.svc_toggle_messaging_suspension(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_toggle_messaging_suspension(uuid, uuid, boolean, text) TO service_role;

-- svc_save_commercial_config: server-only entry for commercial platform settings
-- Calls the original save_commercial_config which has full CAS/validation logic.
-- The original function checks auth.uid() and is_admin() — under service_role
-- these would fail. So this wrapper inlines the validation/mutation logic
-- with p_actor_user_id substituted for auth.uid().
CREATE OR REPLACE FUNCTION public.svc_save_commercial_config(
  p_actor_user_id UUID,
  p_key TEXT,
  p_value JSONB,
  p_description TEXT DEFAULT NULL,
  p_expected_version_id UUID DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_actor_role TEXT;
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency', 'subscription_included_minor_by_tier_currency',
    'fee_policy_enabled', 'category_fee_rates', 'messaging_pricing', 'messaging_topup_packages'
  ];
  v_bundle_only_keys TEXT[] := ARRAY[
    'messaging_pricing', 'trial_credit_minor_by_currency', 'subscription_included_minor_by_tier_currency'
  ];
  v_snapshot JSONB; v_version_id UUID; v_now TIMESTAMPTZ; v_latest_version_id UUID;
  v_key TEXT; v_val JSONB; v_tier_key TEXT; v_tier_val JSONB;
  v_cur_key TEXT; v_cur_val JSONB; v_cat_key TEXT; v_cat_val JSONB; v_rate_key TEXT;
  v_pkg JSONB; v_pkg_idx INTEGER;
BEGIN
  -- Defense-in-depth: verify actor is admin
  SELECT raw_app_meta_data ->> 'role' INTO v_actor_role
  FROM auth.users WHERE id = p_actor_user_id;
  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'svc_save_commercial_config requires admin role';
  END IF;

  -- Key validation (same as save_commercial_config)
  IF NOT (p_key = ANY(v_commercial_keys)) THEN
    RAISE EXCEPTION 'Key "%" is not a commercial config key', p_key;
  END IF;
  IF p_key = ANY(v_bundle_only_keys) THEN
    RAISE EXCEPTION 'Key "%" is a bundle-only messaging key', p_key;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- CAS version check
  IF p_expected_version_id IS NOT NULL THEN
    SELECT id INTO v_latest_version_id FROM platform_config_versions
    ORDER BY effective_from DESC LIMIT 1;
    IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
      RAISE EXCEPTION 'Config version conflict: expected %, got %', p_expected_version_id, v_latest_version_id;
    END IF;
  END IF;

  -- Upsert (using p_actor_user_id for actor attribution)
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, COALESCE(p_description, ''), p_actor_user_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(NULLIF(p_description, ''), platform_settings.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  -- Snapshot + version
  v_now := clock_timestamp();
  SELECT jsonb_object_agg(key, value) INTO v_snapshot
  FROM platform_settings WHERE key = ANY(v_commercial_keys);
  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found';
  END IF;
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by)
  VALUES (v_version_id, v_snapshot, v_now, p_actor_user_id);

  RETURN v_version_id;
END $$;
REVOKE ALL ON FUNCTION public.svc_save_commercial_config(uuid, text, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_save_commercial_config(uuid, text, jsonb, text, uuid) TO service_role;

-- Note: svc_save_market_messaging_config is not created here because
-- save_market_messaging_config calls save_messaging_config internally,
-- which also requires auth.uid(). The full _impl extraction for this
-- function chain requires careful tracing of the ~300 lines of validation,
-- Paystack plan code handling, and nested config writes. This will be
-- addressed in a follow-up commit if the CTO agrees to scope it separately,
-- or inline here after CTO review of the toggle/commercial patterns.
-- For now, save_market_messaging_config EXECUTE is revoked from authenticated
-- (preventing direct browser calls) and the server route is prepared.

-- ════════════════════════════════════════════════════════════════════════════
-- §6. cleanup_expired_step_ups() — cron housekeeping
--
-- Deletes rows that expired more than 1 hour ago.
-- Called by the scheduled cron job; no application code calls this directly.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.cleanup_expired_step_ups()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.admin_step_up_authorizations
  WHERE expires_at < now() - interval '1 hour';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_step_ups() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_step_ups() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_step_ups() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_step_ups() TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- §6b. check_session_exists(p_session_id UUID) — session revocation check
--
-- Called by requirePlatformAdmin to verify the JWT's session still exists
-- in auth.sessions. Catches the window between session revocation and
-- JWT expiry where getUser may not reject the token.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_session_exists(p_session_id uuid)
RETURNS TABLE (session_exists boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY SELECT EXISTS (
    SELECT 1 FROM auth.sessions WHERE id = p_session_id
  ) AS session_exists;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_session_exists(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_session_exists(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_session_exists(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_session_exists(uuid) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- §7. Self-verification
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_fn   text;
  v_fns  text[] := ARRAY[
    'has_admin_role(text[])',
    'has_platform_role(text[])',
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
      RAISE EXCEPTION 'M439 verification FAILED: function % not found in public schema', v_fn;
    END IF;
  END LOOP;

  -- Verify admin_step_up_authorizations table exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'admin_step_up_authorizations'
  ) THEN
    RAISE EXCEPTION 'M439 verification FAILED: admin_step_up_authorizations table not found';
  END IF;

  -- Verify RLS is enabled on admin_step_up_authorizations
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'admin_step_up_authorizations'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'M439 verification FAILED: RLS not enabled on admin_step_up_authorizations';
  END IF;

  RAISE NOTICE 'M439 self-verification PASSED: SEC-005 admin MFA enforcement applied';
END $$;
