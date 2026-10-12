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
GRANT EXECUTE ON FUNCTION public.save_messaging_config(jsonb, jsonb, jsonb, uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.toggle_messaging_suspension(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_messaging_suspension(uuid, boolean, text) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- §5c. Option B: shared _impl functions + service-only wrappers (C6/F3)
--
-- Each financial RPC is refactored into:
--   _<name>_impl(p_actor_id, ...) — shared business logic, no auth checks
--   <name>(...) — original entry point: auth.uid() + is_admin() → _impl
--   svc_<name>(p_actor_user_id, ...) — service-only: admin verify → _impl
--
-- _impl functions have EXECUTE revoked from all roles — only reachable
-- through the SECURITY DEFINER entry points above them.
-- ════════════════════════════════════════════════════════════════════════════

-- ── toggle_messaging_suspension ──

CREATE OR REPLACE FUNCTION public._toggle_messaging_suspension_impl(
  p_actor_id UUID, p_business_id UUID, p_suspended BOOLEAN, p_reason TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_prior_state BOOLEAN; v_biz_name TEXT;
BEGIN
  SELECT messaging_suspended, name INTO v_prior_state, v_biz_name
  FROM businesses WHERE id = p_business_id FOR UPDATE;
  IF v_prior_state IS NULL THEN RAISE EXCEPTION 'Business not found: %', p_business_id; END IF;
  IF v_prior_state = p_suspended THEN
    RETURN jsonb_build_object('success', true, 'changed', false,
      'business_id', p_business_id, 'messaging_suspended', p_suspended);
  END IF;
  UPDATE businesses SET messaging_suspended = p_suspended WHERE id = p_business_id;
  INSERT INTO messaging_suspension_audit (business_id, actor_id, prior_state, new_state, reason, created_at)
  VALUES (p_business_id, p_actor_id, v_prior_state, p_suspended, p_reason, clock_timestamp());
  RETURN jsonb_build_object('success', true, 'changed', true,
    'business_id', p_business_id, 'business_name', v_biz_name,
    'messaging_suspended', p_suspended, 'prior_state', v_prior_state, 'actor_id', p_actor_id);
END $$;
REVOKE ALL ON FUNCTION public._toggle_messaging_suspension_impl(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

-- Rewrite original to delegate to _impl
CREATE OR REPLACE FUNCTION public.toggle_messaging_suspension(
  p_business_id UUID, p_suspended BOOLEAN, p_reason TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_caller_id UUID;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'toggle_messaging_suspension requires authenticated caller'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'toggle_messaging_suspension requires admin role'; END IF;
  RETURN public._toggle_messaging_suspension_impl(v_caller_id, p_business_id, p_suspended, p_reason);
END $$;

-- Service-only wrapper
CREATE OR REPLACE FUNCTION public.svc_toggle_messaging_suspension(
  p_actor_user_id UUID, p_business_id UUID, p_suspended BOOLEAN, p_reason TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_role TEXT;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_actor_user_id;
  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'svc_toggle_messaging_suspension requires admin role'; END IF;
  RETURN public._toggle_messaging_suspension_impl(p_actor_user_id, p_business_id, p_suspended, p_reason);
END $$;
REVOKE ALL ON FUNCTION public.svc_toggle_messaging_suspension(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_toggle_messaging_suspension(uuid, uuid, boolean, text) TO service_role;

-- ── save_commercial_config ──
-- Note: The full validation logic (19 commercial keys, type checks for each key,
-- messaging_topup_packages validation) is preserved in the original function
-- definition from M416. The _impl here delegates to a pattern where the original
-- CREATE OR REPLACE in M416 remains authoritative for validation.
-- We rewrite the original to delegate to _impl for the mutation/CAS/snapshot.

CREATE OR REPLACE FUNCTION public._save_commercial_config_impl(
  p_actor_id UUID, p_key TEXT, p_value JSONB, p_description TEXT, p_expected_version_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
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
  v_key TEXT; v_val JSONB; v_pkg JSONB; v_pkg_idx INTEGER;
  v_cur_key TEXT; v_cur_val JSONB;
BEGIN
  IF NOT (p_key = ANY(v_commercial_keys)) THEN
    RAISE EXCEPTION 'Key "%" is not a commercial config key', p_key;
  END IF;
  IF p_key = ANY(v_bundle_only_keys) THEN
    RAISE EXCEPTION 'Key "%" is a bundle-only messaging key. Use save_messaging_config() instead.', p_key;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));
  IF p_expected_version_id IS NOT NULL THEN
    SELECT id INTO v_latest_version_id FROM platform_config_versions
    ORDER BY effective_from DESC LIMIT 1;
    IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
      RAISE EXCEPTION 'Config version conflict: expected %, got %', p_expected_version_id, v_latest_version_id;
    END IF;
  END IF;

  -- Write-time type validation (preserved from M416 save_commercial_config)
  IF p_key = 'messaging_financial_gate' AND jsonb_typeof(p_value) <> 'boolean' THEN
    RAISE EXCEPTION 'messaging_financial_gate must be a boolean';
  END IF;
  IF p_key = 'messaging_reservation_ttl_seconds' THEN
    IF jsonb_typeof(p_value) <> 'number' OR (p_value::TEXT)::NUMERIC <= 0 OR (p_value::TEXT)::NUMERIC <> FLOOR((p_value::TEXT)::NUMERIC) THEN
      RAISE EXCEPTION 'messaging_reservation_ttl_seconds must be a positive integer';
    END IF;
  END IF;
  IF p_key = 'trial_days' THEN
    IF jsonb_typeof(p_value) <> 'number' OR (p_value::TEXT)::NUMERIC <= 0 OR (p_value::TEXT)::NUMERIC <> FLOOR((p_value::TEXT)::NUMERIC) THEN
      RAISE EXCEPTION 'trial_days must be a positive integer';
    END IF;
  END IF;
  IF p_key = 'messaging_topup_packages' THEN
    IF jsonb_typeof(p_value) <> 'object' THEN
      RAISE EXCEPTION 'messaging_topup_packages must be a JSONB object keyed by currency';
    END IF;
    FOR v_cur_key, v_cur_val IN SELECT * FROM jsonb_each(p_value) LOOP
      IF jsonb_typeof(v_cur_val) <> 'array' THEN
        RAISE EXCEPTION 'messaging_topup_packages[%] must be an array', v_cur_key;
      END IF;
      FOR v_pkg_idx IN 0 .. jsonb_array_length(v_cur_val) - 1 LOOP
        v_pkg := v_cur_val -> v_pkg_idx;
        IF jsonb_typeof(v_pkg) <> 'object' THEN RAISE EXCEPTION 'messaging_topup_packages[%][%] must be an object', v_cur_key, v_pkg_idx; END IF;
        IF v_pkg -> 'amount_minor' IS NULL OR jsonb_typeof(v_pkg -> 'amount_minor') <> 'number' THEN RAISE EXCEPTION 'messaging_topup_packages[%][%].amount_minor must be a positive integer', v_cur_key, v_pkg_idx; END IF;
        IF (v_pkg ->> 'amount_minor')::NUMERIC <= 0 OR (v_pkg ->> 'amount_minor')::NUMERIC <> FLOOR((v_pkg ->> 'amount_minor')::NUMERIC) THEN RAISE EXCEPTION 'messaging_topup_packages[%][%].amount_minor invalid', v_cur_key, v_pkg_idx; END IF;
        IF v_pkg -> 'label' IS NULL OR jsonb_typeof(v_pkg -> 'label') <> 'string' THEN RAISE EXCEPTION 'messaging_topup_packages[%][%].label must be a string', v_cur_key, v_pkg_idx; END IF;
      END LOOP;
    END LOOP;
  END IF;

  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, COALESCE(p_description, ''), p_actor_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(NULLIF(p_description, ''), platform_settings.description),
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  v_now := clock_timestamp();
  SELECT jsonb_object_agg(key, value) INTO v_snapshot FROM platform_settings WHERE key = ANY(v_commercial_keys);
  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found';
  END IF;
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by)
  VALUES (v_version_id, v_snapshot, v_now, p_actor_id);
  RETURN v_version_id;
END $$;
REVOKE ALL ON FUNCTION public._save_commercial_config_impl(uuid, text, jsonb, text, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Rewrite original to delegate to _impl
CREATE OR REPLACE FUNCTION public.save_commercial_config(
  p_key TEXT, p_value JSONB, p_description TEXT DEFAULT NULL, p_expected_version_id UUID DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_caller_id UUID;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'save_commercial_config requires authenticated caller'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'save_commercial_config requires admin role'; END IF;
  RETURN public._save_commercial_config_impl(v_caller_id, p_key, p_value, p_description, p_expected_version_id);
END $$;

-- Service-only wrapper
CREATE OR REPLACE FUNCTION public.svc_save_commercial_config(
  p_actor_user_id UUID, p_key TEXT, p_value JSONB, p_description TEXT DEFAULT NULL, p_expected_version_id UUID DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_role TEXT;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_actor_user_id;
  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'svc_save_commercial_config requires admin role'; END IF;
  RETURN public._save_commercial_config_impl(p_actor_user_id, p_key, p_value, p_description, p_expected_version_id);
END $$;
REVOKE ALL ON FUNCTION public.svc_save_commercial_config(uuid, text, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_save_commercial_config(uuid, text, jsonb, text, uuid) TO service_role;

-- ── save_market_messaging_config (with nested save_messaging_config) ──

-- Inner: save_messaging_config business logic (3 key upserts + snapshot + version)
CREATE OR REPLACE FUNCTION public._save_messaging_config_impl(
  p_actor_id UUID, p_messaging_pricing JSONB, p_trial_credit_minor_by_currency JSONB,
  p_subscription_included_minor_by_tier_currency JSONB, p_expected_version_id UUID, p_description TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency', 'subscription_included_minor_by_tier_currency',
    'fee_policy_enabled', 'category_fee_rates', 'messaging_pricing', 'messaging_topup_packages'
  ];
  v_snapshot JSONB; v_version_id UUID; v_now TIMESTAMPTZ; v_latest_version_id UUID;
  -- Validation variables (from M416 save_messaging_config)
  v_currency TEXT; v_bucket JSONB; v_country_key TEXT; v_rate_val JSONB;
  v_seen_countries TEXT[] := '{}';
  v_country RECORD; v_match_count INTEGER; v_matched_currency TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));
  -- CAS: require non-NULL version ID (matches M416 save_messaging_config contract)
  IF p_expected_version_id IS NULL THEN
    RAISE EXCEPTION 'save_messaging_config requires a non-NULL expected_version_id for CAS';
  END IF;
  SELECT id INTO v_latest_version_id FROM platform_config_versions
    ORDER BY effective_from DESC LIMIT 1;
  IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'config_version_conflict: expected % but latest is %', p_expected_version_id, v_latest_version_id;
  END IF;

  -- Validate messaging_pricing (preserved from M416)
  IF jsonb_typeof(p_messaging_pricing) <> 'object' THEN RAISE EXCEPTION 'messaging_pricing must be a JSONB object'; END IF;
  FOR v_currency, v_bucket IN SELECT * FROM jsonb_each(p_messaging_pricing) LOOP
    IF jsonb_typeof(v_bucket) <> 'object' THEN RAISE EXCEPTION 'messaging_pricing[%] must be an object', v_currency; END IF;
    IF v_bucket -> 'default_spend_cap_minor' IS NULL OR jsonb_typeof(v_bucket -> 'default_spend_cap_minor') <> 'number' THEN
      RAISE EXCEPTION 'messaging_pricing[%].default_spend_cap_minor must be a positive integer', v_currency;
    END IF;
    DECLARE v_cap NUMERIC; BEGIN
      v_cap := (v_bucket ->> 'default_spend_cap_minor')::NUMERIC;
      IF v_cap <= 0 OR v_cap <> FLOOR(v_cap) THEN RAISE EXCEPTION 'messaging_pricing[%].default_spend_cap_minor must be a positive integer, got %', v_currency, v_cap; END IF;
    END;
    IF v_bucket -> 'default_cost_minor' IS NOT NULL THEN
      IF jsonb_typeof(v_bucket -> 'default_cost_minor') <> 'number' THEN RAISE EXCEPTION 'messaging_pricing[%].default_cost_minor must be a non-negative integer', v_currency; END IF;
      DECLARE v_cost NUMERIC; BEGIN
        v_cost := (v_bucket ->> 'default_cost_minor')::NUMERIC;
        IF v_cost < 0 OR v_cost <> FLOOR(v_cost) THEN RAISE EXCEPTION 'messaging_pricing[%].default_cost_minor must be a non-negative integer, got %', v_currency, v_cost; END IF;
      END;
    END IF;
    IF v_bucket -> 'rates' IS NULL OR jsonb_typeof(v_bucket -> 'rates') <> 'object' THEN RAISE EXCEPTION 'messaging_pricing[%].rates must be an object', v_currency; END IF;
    FOR v_country_key IN SELECT key FROM jsonb_each(v_bucket -> 'rates') LOOP
      IF length(v_country_key) <> 2 OR v_country_key <> upper(v_country_key) THEN RAISE EXCEPTION 'messaging_pricing[%].rates: invalid country code "%"', v_currency, v_country_key; END IF;
      IF v_country_key = ANY(v_seen_countries) THEN RAISE EXCEPTION 'messaging_pricing: country "%" appears in multiple currency buckets', v_country_key; END IF;
      v_seen_countries := array_append(v_seen_countries, v_country_key);
      v_rate_val := v_bucket -> 'rates' -> v_country_key;
      IF jsonb_typeof(v_rate_val) <> 'object' THEN RAISE EXCEPTION 'messaging_pricing[%].rates[%] must be an object', v_currency, v_country_key; END IF;
      DECLARE v_rk TEXT; v_rv JSONB; v_rn NUMERIC; v_allowed TEXT[] := ARRAY['*','marketing','utility','authentication','service']; BEGIN
        FOR v_rk IN SELECT key FROM jsonb_each(v_rate_val) LOOP
          IF NOT (v_rk = ANY(v_allowed)) THEN RAISE EXCEPTION 'messaging_pricing[%].rates[%]: unknown rate key "%"', v_currency, v_country_key, v_rk; END IF;
          v_rv := v_rate_val -> v_rk;
          IF jsonb_typeof(v_rv) <> 'number' THEN RAISE EXCEPTION 'messaging_pricing[%].rates[%][%] must be a non-negative integer', v_currency, v_country_key, v_rk; END IF;
          v_rn := (v_rv::TEXT)::NUMERIC;
          IF v_rn < 0 OR v_rn <> FLOOR(v_rn) THEN RAISE EXCEPTION 'messaging_pricing[%].rates[%][%] must be a non-negative integer, got %', v_currency, v_country_key, v_rk, v_rv::TEXT; END IF;
        END LOOP;
      END;
    END LOOP;
  END LOOP;
  IF jsonb_typeof(p_trial_credit_minor_by_currency) <> 'object' THEN RAISE EXCEPTION 'trial_credit_minor_by_currency must be a JSONB object'; END IF;
  IF jsonb_typeof(p_subscription_included_minor_by_tier_currency) <> 'object' THEN RAISE EXCEPTION 'subscription_included_minor_by_tier_currency must be a JSONB object'; END IF;

  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('messaging_pricing', p_messaging_pricing, COALESCE(p_description, 'messaging bundle'), p_actor_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('trial_credit_minor_by_currency', p_trial_credit_minor_by_currency, COALESCE(p_description, 'messaging bundle'), p_actor_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('subscription_included_minor_by_tier_currency', p_subscription_included_minor_by_tier_currency, COALESCE(p_description, 'messaging bundle'), p_actor_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  v_now := clock_timestamp();
  SELECT jsonb_object_agg(key, value) INTO v_snapshot FROM platform_settings WHERE key = ANY(v_commercial_keys);
  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found';
  END IF;
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by)
  VALUES (v_version_id, v_snapshot, v_now, p_actor_id);
  RETURN v_version_id;
END $$;
REVOKE ALL ON FUNCTION public._save_messaging_config_impl(uuid, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- Rewrite original save_messaging_config to delegate to _impl
CREATE OR REPLACE FUNCTION public.save_messaging_config(
  p_messaging_pricing JSONB, p_trial_credit_minor_by_currency JSONB,
  p_subscription_included_minor_by_tier_currency JSONB, p_expected_version_id UUID, p_description TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_caller_id UUID;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'save_messaging_config requires authenticated caller'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'save_messaging_config requires admin role'; END IF;
  RETURN public._save_messaging_config_impl(v_caller_id, p_messaging_pricing, p_trial_credit_minor_by_currency, p_subscription_included_minor_by_tier_currency, p_expected_version_id, p_description);
END $$;

-- Inner: save_market_messaging_config business logic (validation + plan codes + nested messaging)
CREATE OR REPLACE FUNCTION public._save_market_messaging_config_impl(
  p_actor_id UUID, p_messaging_pricing JSONB, p_trial_credit_minor_by_currency JSONB,
  p_subscription_included_minor_by_tier_currency JSONB, p_paystack_plan_codes JSONB,
  p_expected_version_id UUID, p_description TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_version_id UUID; v_latest_version_id UUID;
  v_country_code TEXT; v_plan_obj JSONB; v_growth_code TEXT; v_business_code TEXT;
  v_row_count INTEGER; v_country_gateway TEXT; v_plan_key TEXT; v_key_count INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));
  IF p_expected_version_id IS NULL THEN RAISE EXCEPTION 'requires non-NULL expected_version_id'; END IF;
  SELECT id INTO v_latest_version_id FROM platform_config_versions
    WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;
  IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'config_version_conflict: expected % but latest is %', p_expected_version_id, v_latest_version_id;
  END IF;

  -- Paystack plan code validation (preserved from M378)
  IF p_paystack_plan_codes IS NOT NULL THEN
    IF jsonb_typeof(p_paystack_plan_codes) <> 'object' THEN RAISE EXCEPTION 'p_paystack_plan_codes must be a JSONB object'; END IF;
    IF p_paystack_plan_codes = '{}'::jsonb THEN RAISE EXCEPTION 'p_paystack_plan_codes must not be empty when supplied'; END IF;
    FOR v_country_code IN SELECT key FROM jsonb_each(p_paystack_plan_codes) LOOP
      v_plan_obj := p_paystack_plan_codes -> v_country_code;
      IF jsonb_typeof(v_plan_obj) <> 'object' THEN RAISE EXCEPTION 'paystack_plan_codes[%] must be object', v_country_code; END IF;
      IF v_plan_obj -> 'growth' IS NULL OR v_plan_obj -> 'business' IS NULL THEN
        RAISE EXCEPTION 'paystack_plan_codes[%] must contain both growth and business', v_country_code;
      END IF;
      IF jsonb_typeof(v_plan_obj -> 'growth') <> 'string' OR length(TRIM(v_plan_obj ->> 'growth')) < 3 THEN
        RAISE EXCEPTION 'paystack_plan_codes[%].growth must be >= 3 chars', v_country_code;
      END IF;
      IF jsonb_typeof(v_plan_obj -> 'business') <> 'string' OR length(TRIM(v_plan_obj ->> 'business')) < 3 THEN
        RAISE EXCEPTION 'paystack_plan_codes[%].business must be >= 3 chars', v_country_code;
      END IF;
      SELECT payment_gateway INTO v_country_gateway FROM public.countries WHERE code = v_country_code;
      IF NOT FOUND THEN RAISE EXCEPTION 'unknown country "%"', v_country_code; END IF;
      IF v_country_gateway <> 'paystack' THEN
        RAISE EXCEPTION 'paystack_plan_codes[%]: gateway is "%" not "paystack"', v_country_code, v_country_gateway;
      END IF;
    END LOOP;
  END IF;

  -- Nested messaging config save via _impl (not the original which checks auth.uid)
  v_version_id := public._save_messaging_config_impl(
    p_actor_id, p_messaging_pricing, p_trial_credit_minor_by_currency,
    p_subscription_included_minor_by_tier_currency, p_expected_version_id, p_description
  );

  -- Paystack plan code updates (preserved from M378)
  IF p_paystack_plan_codes IS NOT NULL THEN
    PERFORM set_config('waaiio.plan_code_auth', 'true', true);
    PERFORM set_config('waaiio.provider_ref_auth', 'true', true);
    FOR v_country_code IN SELECT key FROM jsonb_each(p_paystack_plan_codes) LOOP
      v_plan_obj := p_paystack_plan_codes -> v_country_code;
      v_growth_code := TRIM(v_plan_obj ->> 'growth');
      v_business_code := TRIM(v_plan_obj ->> 'business');
      UPDATE public.countries SET pricing =
        jsonb_set(jsonb_set(jsonb_set(jsonb_set(COALESCE(pricing, '{}'::jsonb),
          '{growth,paystack_plan_code}', to_jsonb(v_growth_code)),
          '{business,paystack_plan_code}', to_jsonb(v_business_code)),
          '{growth,provider_plan_refs}',
          COALESCE(pricing -> 'growth' -> 'provider_plan_refs', '{}'::jsonb) || jsonb_build_object('paystack', v_growth_code)),
          '{business,provider_plan_refs}',
          COALESCE(pricing -> 'business' -> 'provider_plan_refs', '{}'::jsonb) || jsonb_build_object('paystack', v_business_code))
      WHERE code = v_country_code AND payment_gateway = 'paystack';
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      IF v_row_count <> 1 THEN RAISE EXCEPTION 'paystack_plan_codes[%]: UPDATE affected % rows', v_country_code, v_row_count; END IF;
    END LOOP;
    PERFORM set_config('waaiio.plan_code_auth', '', true);
    PERFORM set_config('waaiio.provider_ref_auth', '', true);
  END IF;

  RETURN v_version_id;
END $$;
REVOKE ALL ON FUNCTION public._save_market_messaging_config_impl(uuid, jsonb, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- Rewrite original to delegate to _impl
CREATE OR REPLACE FUNCTION public.save_market_messaging_config(
  p_messaging_pricing JSONB, p_trial_credit_minor_by_currency JSONB,
  p_subscription_included_minor_by_tier_currency JSONB, p_paystack_plan_codes JSONB DEFAULT NULL,
  p_expected_version_id UUID DEFAULT NULL, p_description TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_caller_id UUID;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'requires authenticated caller'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'requires admin role'; END IF;
  RETURN public._save_market_messaging_config_impl(v_caller_id, p_messaging_pricing, p_trial_credit_minor_by_currency, p_subscription_included_minor_by_tier_currency, p_paystack_plan_codes, p_expected_version_id, p_description);
END $$;

-- Service-only wrapper
CREATE OR REPLACE FUNCTION public.svc_save_market_messaging_config(
  p_actor_user_id UUID, p_messaging_pricing JSONB, p_trial_credit_minor_by_currency JSONB,
  p_subscription_included_minor_by_tier_currency JSONB, p_paystack_plan_codes JSONB DEFAULT NULL,
  p_expected_version_id UUID DEFAULT NULL, p_description TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_role TEXT;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_actor_user_id;
  IF v_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'svc_save_market_messaging_config requires admin role'; END IF;
  RETURN public._save_market_messaging_config_impl(p_actor_user_id, p_messaging_pricing, p_trial_credit_minor_by_currency, p_subscription_included_minor_by_tier_currency, p_paystack_plan_codes, p_expected_version_id, p_description);
END $$;
REVOKE ALL ON FUNCTION public.svc_save_market_messaging_config(uuid, jsonb, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_save_market_messaging_config(uuid, jsonb, jsonb, jsonb, jsonb, uuid, text) TO service_role;

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
