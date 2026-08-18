-- ══════════════════════════════════════════════════════════════
-- 326: Class ACL Reconciliation
-- ══════════════════════════════════════════════════════════════
-- Corrects two Supabase default-privilege issues discovered during
-- production migration 325 verification:
--
-- 1. book_slot_atomic(28 args): Supabase ALTER DEFAULT PRIVILEGES
--    auto-granted EXECUTE to anon/authenticated. Migration 325
--    (and canonical 322) revoked from PUBLIC but not from the
--    direct auto-grants. This migration explicitly revokes from
--    anon/authenticated, leaving only service_role.
--
-- 2. class_sessions + class_recurrence_rules table privileges:
--    Supabase default privileges granted ALL (including TRUNCATE,
--    REFERENCES, TRIGGER) to anon/authenticated/service_role.
--    Canonical 322 requires authenticated to have only
--    SELECT/INSERT/UPDATE/DELETE, and anon to have NONE.
--
-- Does NOT alter:
-- - Function bodies
-- - RLS policies
-- - get_upcoming_class_sessions discovery grants (intentionally public)
-- - Any other function's EXECUTE grants
-- - Promotions grants (already correct)
-- ══════════════════════════════════════════════════════════════

-- ── A. book_slot_atomic: service-role-only ──

REVOKE ALL ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text,
  integer, integer, text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer, uuid, uuid
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text,
  integer, integer, text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer, uuid, uuid
) FROM anon;

REVOKE ALL ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text,
  integer, integer, text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer, uuid, uuid
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text,
  integer, integer, text, integer, text, text, text, text, text,
  text, text, date, jsonb, uuid, integer, text,
  uuid, uuid, integer, integer, uuid, uuid
) TO service_role;

-- ── B. class_sessions: normalize table privileges ──

REVOKE ALL ON TABLE public.class_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.class_sessions FROM anon;
REVOKE ALL ON TABLE public.class_sessions FROM authenticated;

-- Re-grant canonical authenticated DML only
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.class_sessions TO authenticated;

-- Preserve service_role authority (Supabase default — do not remove)
GRANT ALL ON TABLE public.class_sessions TO service_role;

-- ── C. class_recurrence_rules: normalize table privileges ──

REVOKE ALL ON TABLE public.class_recurrence_rules FROM PUBLIC;
REVOKE ALL ON TABLE public.class_recurrence_rules FROM anon;
REVOKE ALL ON TABLE public.class_recurrence_rules FROM authenticated;

-- Re-grant canonical authenticated DML only
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.class_recurrence_rules TO authenticated;

-- Preserve service_role authority
GRANT ALL ON TABLE public.class_recurrence_rules TO service_role;
