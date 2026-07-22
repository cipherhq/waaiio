-- ══════════════════════════════════════════════════
-- Migration 247: Package Session Deduction Safety
-- Replaces the 1-param RPC with a fully atomic 4-param version
-- that does enrollment lookup + deduction + replay protection
-- in a single transaction.
-- ══════════════════════════════════════════════════

-- 1. Setup tables and drop old RPC (wrapped for single-statement compat)
DO $setup$ BEGIN
  CREATE TABLE IF NOT EXISTS public.package_session_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enrollment_id UUID NOT NULL REFERENCES public.package_enrollments(id) ON DELETE CASCADE,
    booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
    deducted_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(enrollment_id, booking_id)
  );
  ALTER TABLE public.package_session_log ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "service_only" ON public.package_session_log;
  CREATE POLICY "service_only" ON public.package_session_log
    FOR ALL USING (auth.role() = 'service_role');
  CREATE INDEX IF NOT EXISTS idx_package_session_log_booking ON public.package_session_log(booking_id);
  CREATE INDEX IF NOT EXISTS idx_package_session_log_enrollment ON public.package_session_log(enrollment_id);
  DROP FUNCTION IF EXISTS public.deduct_package_session(UUID);
END $setup$;

-- 2. Replace the RPC with fully atomic version
