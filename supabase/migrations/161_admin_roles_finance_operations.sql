-- Add finance and operations roles to user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'finance';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'operations';

-- Update RLS function to include new roles.
-- Uses role::text comparison to avoid "unsafe use of new enum value" error
-- when enum values are added and used in the same transaction.
CREATE OR REPLACE FUNCTION public.is_admin_or_support()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role::text IN ('admin', 'support', 'finance', 'operations')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '';
