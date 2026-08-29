-- ═══════════════════════════════════════════════════════
-- 352: Revoke release_booking_slot from authenticated role
-- ═══════════════════════════════════════════════════════
--
-- release_booking_slot is SECURITY DEFINER and was previously callable
-- from the browser (authenticated role). Migration 351 noted this as
-- a "known risk requiring a follow-up to route through a server API."
--
-- The dashboard now calls /api/bookings/release-slot which authenticates
-- the user, verifies business ownership, and calls the RPC via service_role.
--
-- Revoke direct access so only service_role can invoke.
-- ═══════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.release_booking_slot(uuid, date, time, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_booking_slot(uuid, date, time, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.release_booking_slot(uuid, date, time, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_booking_slot(uuid, date, time, uuid, uuid) TO service_role;
