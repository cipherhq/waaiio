-- ═══════════════════════════════════════════════════════
-- 252: Forward repairs and cleanup
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- 1. Make service_id nullable (moved from migration 166)
  ALTER TABLE public.bookings ALTER COLUMN service_id DROP NOT NULL;

  -- 2. Drop obsolete book_slot_atomic overloads
  DROP FUNCTION IF EXISTS public.book_slot_atomic(
    uuid, uuid, uuid, uuid, date, text, int, int,
    text, int, text, text, text, text, text,
    text, text, date, jsonb, uuid, int, text
  );
  DROP FUNCTION IF EXISTS public.book_slot_atomic(
    uuid, uuid, uuid, uuid, date, text, int, int,
    text, int, text, text, text, text, text,
    text, text, date, jsonb, uuid, int, text, uuid, uuid
  );
  DROP FUNCTION IF EXISTS public.book_slot_atomic(
    uuid, uuid, uuid, uuid, date, text, int, int,
    text, int, text, text, text, text, text,
    text, text, date, jsonb, uuid, int, text, uuid
  );

  -- 3. Fix is_admin_or_support search_path
  CREATE OR REPLACE FUNCTION public.is_admin_or_support()
  RETURNS boolean AS $fn$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role::text IN ('admin', 'support', 'finance', 'operations')
    );
  $fn$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '';

  -- 4. Membership tier auto-upgrade trigger (moved from 245)
  DROP TRIGGER IF EXISTS trg_auto_upgrade_membership_tier ON public.customer_profiles;
  CREATE TRIGGER trg_auto_upgrade_membership_tier
    BEFORE UPDATE OF total_spent ON public.customer_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.auto_upgrade_membership_tier();
END $$;
