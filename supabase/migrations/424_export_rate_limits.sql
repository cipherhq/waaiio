-- 424: Move export rate-limit state out of platform_settings
--
-- app/api/account/export/route.ts currently stores export:{userId}
-- timestamps in platform_settings via service_role upsert. This is
-- ephemeral per-user state that does not belong in the config table.
--
-- Creates a dedicated export_rate_limits table with:
-- - user_id as primary key (one rate limit per user)
-- - last_export_at timestamp
-- - service_role-only access (matches the route's createServiceClient usage)
-- - RLS enabled with service-role-only policy

CREATE TABLE IF NOT EXISTS public.export_rate_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_export_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.export_rate_limits ENABLE ROW LEVEL SECURITY;

-- Service role only
CREATE POLICY export_rate_limits_service_only ON public.export_rate_limits
  FOR ALL USING (auth.role() = 'service_role');

-- Least-privilege grants
REVOKE ALL ON TABLE public.export_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.export_rate_limits TO service_role;

-- ══════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- 1. Table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'export_rate_limits'
  ) THEN
    RAISE EXCEPTION 'M424: export_rate_limits table must exist';
  END IF;

  -- 2. RLS enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'export_rate_limits') THEN
    RAISE EXCEPTION 'M424: RLS must be enabled on export_rate_limits';
  END IF;

  -- 3. service_role has SELECT + INSERT + UPDATE
  IF NOT has_table_privilege('service_role', 'public.export_rate_limits', 'SELECT') THEN
    RAISE EXCEPTION 'M424: service_role must have SELECT on export_rate_limits';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.export_rate_limits', 'INSERT') THEN
    RAISE EXCEPTION 'M424: service_role must have INSERT on export_rate_limits';
  END IF;

  -- 4. anon/authenticated have NO access
  IF has_table_privilege('anon', 'public.export_rate_limits', 'SELECT') THEN
    RAISE EXCEPTION 'M424: anon must NOT have SELECT on export_rate_limits';
  END IF;
  IF has_table_privilege('authenticated', 'public.export_rate_limits', 'SELECT') THEN
    RAISE EXCEPTION 'M424: authenticated must NOT have SELECT on export_rate_limits';
  END IF;

  RAISE NOTICE 'M424: All checks passed — export_rate_limits table created';
END $$;
