-- ============================================================
-- 069: Security Hardening & Admin Impersonation
-- 1. Fix overly permissive public_read_platform_settings policy
-- 2. Add 'support' role to user_role enum
-- 3. Create is_support() helper function
-- 4. Create admin_impersonation_tokens table for "Login As"
-- ============================================================

-- ============================================================
-- 1. FIX: Replace open public read policy with allowlist
-- The old policy (068) exposed ALL platform_settings rows
-- to unauthenticated users including maintenance_mode, etc.
-- ============================================================
DROP POLICY IF EXISTS "public_read_platform_settings" ON public.platform_settings;

CREATE POLICY "public_read_config_settings" ON public.platform_settings
  FOR SELECT USING (
    key IN ('pricing_tiers', 'broadcast_limits', 'trial_days', 'booking_defaults')
  );

-- ============================================================
-- 2. Add 'support' role to user_role enum
-- Support users can read data and impersonate businesses
-- but cannot approve payouts or perform destructive admin ops.
-- ============================================================
DO $$
BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'support';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 3. is_support() helper — returns true for admin OR support
-- Use for read access + impersonation. is_admin() stays
-- unchanged (admin only) for write/approve operations.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_support()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role::text IN ('admin', 'support')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- 4. admin_impersonation_tokens table
-- Short-lived tokens for the "Login As" impersonation flow.
-- Admin generates a token, opens a URL in a new tab,
-- that page validates the token and sets httpOnly cookies.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_impersonation_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES public.profiles(id),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  token VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_impersonation_tokens_token
  ON public.admin_impersonation_tokens(token);

CREATE INDEX IF NOT EXISTS idx_impersonation_tokens_admin
  ON public.admin_impersonation_tokens(admin_id);

ALTER TABLE public.admin_impersonation_tokens ENABLE ROW LEVEL SECURITY;

-- Only admins and support can access impersonation tokens
CREATE POLICY "support_all_impersonation_tokens" ON public.admin_impersonation_tokens
  FOR ALL USING (public.is_support());
