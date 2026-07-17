-- ═══════════════════════════════════════════════════════
-- 252: Booking function cleanup + forward repairs
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- 1. Make service_id nullable (moved from migration 166 for single-statement compat)
  ALTER TABLE public.bookings ALTER COLUMN service_id DROP NOT NULL;

  -- 2. Drop obsolete book_slot_atomic overloads
  -- The app only calls the 26-param version (from migration 176).
  -- Older overloads with fewer params are dead code.

  -- 22-param version (from migrations 137/139/140/141)
  DROP FUNCTION IF EXISTS public.book_slot_atomic(
    uuid, uuid, uuid, uuid,
    date, text, int, int,
    text, int, text, text,
    text, text, text,
    text, text, date,
    jsonb, uuid, int, text
  );

  -- 24-param version (from migration 166 — replaced by 176)
  DROP FUNCTION IF EXISTS public.book_slot_atomic(
    uuid, uuid, uuid, uuid,
    date, text, int, int,
    text, int, text, text,
    text, text, text,
    text, text, date,
    jsonb, uuid, int, text,
    uuid, uuid
  );

  -- 23-param version (from migration 155 — if it exists)
  DROP FUNCTION IF EXISTS public.book_slot_atomic(
    uuid, uuid, uuid, uuid,
    date, text, int, int,
    text, int, text, text,
    text, text, text,
    text, text, date,
    jsonb, uuid, int, text,
    uuid
  );

  -- 3. Fix search_path on migration 251's is_admin_or_support function
  CREATE OR REPLACE FUNCTION public.is_admin_or_support()
  RETURNS boolean AS $fn$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role::text IN ('admin', 'support', 'finance', 'operations')
    );
  $fn$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '';
END $$;
