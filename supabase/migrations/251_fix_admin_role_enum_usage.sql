-- ═══════════════════════════════════════════════════════
-- 251: Forward repair for is_admin_or_support()
-- ═══════════════════════════════════════════════════════
-- If migration 161 was previously applied without the function definition
-- (an earlier version separated enum creation from function usage),
-- this ensures the function exists with the correct search_path.
-- CREATE OR REPLACE is idempotent — safe for both fresh and repair installs.

CREATE OR REPLACE FUNCTION public.is_admin_or_support()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role::text IN ('admin', 'support', 'finance', 'operations')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '';
