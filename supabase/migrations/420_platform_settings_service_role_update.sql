-- 420: Grant service_role UPDATE on platform_settings
--
-- Root cause (#502): PUT /api/admin/site-announcement uses
-- createServiceClient() to update the site_announcement row.
-- service_role has SELECT (from M408) but not UPDATE.
--
-- Fix: GRANT UPDATE only. No INSERT needed — the row already exists
-- (seeded in M414). No authenticated/anon grants — admin routes
-- use the server-side service client exclusively.
--
-- Idempotent: GRANT is a no-op if privilege already exists.

GRANT UPDATE ON public.platform_settings TO service_role;

-- Verification
DO $$
BEGIN
  -- service_role CAN SELECT (existing from M408)
  IF NOT has_table_privilege('service_role', 'public.platform_settings', 'SELECT') THEN
    RAISE EXCEPTION 'M420: service_role must have SELECT on platform_settings';
  END IF;

  -- service_role CAN UPDATE (this migration)
  IF NOT has_table_privilege('service_role', 'public.platform_settings', 'UPDATE') THEN
    RAISE EXCEPTION 'M420: service_role must have UPDATE on platform_settings';
  END IF;

  -- anon has NO UPDATE
  IF has_table_privilege('anon', 'public.platform_settings', 'UPDATE') THEN
    RAISE EXCEPTION 'M420: anon must NOT have UPDATE on platform_settings';
  END IF;

  -- authenticated has NO UPDATE
  IF has_table_privilege('authenticated', 'public.platform_settings', 'UPDATE') THEN
    RAISE EXCEPTION 'M420: authenticated must NOT have UPDATE on platform_settings';
  END IF;

  -- RLS still enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'platform_settings') THEN
    RAISE EXCEPTION 'M420: RLS must remain enabled on platform_settings';
  END IF;

  RAISE NOTICE 'M420: All checks passed — service_role UPDATE granted, no anon/authenticated UPDATE, RLS enabled';
END $$;
