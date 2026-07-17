-- ═══════════════════════════════════════════════════════
-- 251: Fix admin role enum usage after 161
-- ═══════════════════════════════════════════════════════
-- Migration 161 added 'finance' and 'operations' to user_role enum.
-- PostgreSQL disallows using new enum values as literals in the same
-- transaction. This separate migration safely uses them via text cast.

CREATE OR REPLACE FUNCTION public.is_admin_or_support()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role::text IN ('admin', 'support', 'finance', 'operations')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
