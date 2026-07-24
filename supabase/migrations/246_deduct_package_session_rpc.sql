-- ══════════════════════════════════════════════════
-- Migration 245: Atomic Package Session Deduction RPC
-- ══════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION deduct_package_session(p_enrollment_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  rows_affected INTEGER;
BEGIN
  UPDATE public.package_enrollments
  SET sessions_used = sessions_used + 1
  WHERE id = p_enrollment_id
    AND is_active = true
    AND sessions_used < sessions_total
    AND (expires_at IS NULL OR expires_at > NOW());

  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  RETURN rows_affected > 0;
END;
$$;
