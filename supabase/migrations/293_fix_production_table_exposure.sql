-- Migration 293: Remove public access to sensitive platform tables
--
-- Supersedes the security intent of migration 223 which was never applied.
-- Does NOT modify historical migration 223.
-- Does NOT null or delete existing credential values.
--
-- Addresses 4 production exposures discovered during Issue #53 preflight:
--   1. whatsapp_channels: shared_channels_public_read exposes Meta API tokens to anon
--   2. processed_webhook_events: service_all policy grants full R/W to anon
--   3. businesses: public_read_active_businesses exposes all columns to anon
--   4. bot_keywords: anyone_read_system_category allows anon to read routing logic
--
-- All changes are idempotent (IF EXISTS / IF NOT EXISTS guards on drops).
-- Policies are explicitly DROP + CREATE (not IF NOT EXISTS) to guarantee exact definitions.
--
-- Deployment: application code MUST be deployed and verified BEFORE this migration runs.
-- The application uses safe-view-query.ts fallback helpers that handle the pre-migration state.
-- If the application deployment fails, do NOT apply this migration.

-- ════════════════════════════════════════════════════════════
-- 1. whatsapp_channels: Remove anonymous access to Meta tokens
-- ════════════════════════════════════════════════════════════

-- Drop the policy that exposes ALL columns (including meta_access_token,
-- waba_id, phone_number_id) to anon users for shared channels.
DROP POLICY IF EXISTS "shared_channels_public_read" ON public.whatsapp_channels;

-- Revoke direct table access from anon only.
REVOKE ALL ON public.whatsapp_channels FROM anon;

-- Ensure authenticated and service_role have required base-table privileges.
-- In Supabase production, these are provided by default privilege grants.
-- We make them explicit so the migration is self-contained.
GRANT SELECT ON public.whatsapp_channels TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.whatsapp_channels TO service_role;

-- Create a restricted public view exposing only safe fields.
-- security_barrier prevents information leakage through user-defined functions.
CREATE OR REPLACE VIEW public.whatsapp_channels_public
  WITH (security_barrier = true) AS
SELECT
  id,
  country_code,
  phone_number,
  display_name,
  channel_type,
  is_active
FROM public.whatsapp_channels
WHERE channel_type = 'shared' AND is_active = true;

-- Revoke everything from the view first, then grant only SELECT.
REVOKE ALL ON public.whatsapp_channels_public FROM PUBLIC;
GRANT SELECT ON public.whatsapp_channels_public TO anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- 2. processed_webhook_events: Remove anon/authenticated access
-- ════════════════════════════════════════════════════════════

-- Drop the overly permissive USING(true) policy from migration 021.
DROP POLICY IF EXISTS "processed_webhook_events_service_all" ON public.processed_webhook_events;

-- Explicitly DROP then CREATE the service_role-only policy.
DROP POLICY IF EXISTS "processed_webhook_events_service_only" ON public.processed_webhook_events;
CREATE POLICY "processed_webhook_events_service_only"
  ON public.processed_webhook_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Revoke from PUBLIC, anon, and authenticated.
-- Only service_role should access this table (webhook dedup from server-side handlers).
-- Safe to REVOKE FROM PUBLIC here because no other role needs access.
REVOKE ALL ON public.processed_webhook_events FROM PUBLIC;
REVOKE ALL ON public.processed_webhook_events FROM anon;
REVOKE ALL ON public.processed_webhook_events FROM authenticated;

-- Grant only the privileges service_role actually needs:
--   SELECT — dedup check
--   INSERT — record new event / upsert
--   UPDATE — update status, attempts, completed_at (webhook handlers use .update() and .upsert())
--   DELETE — cleanup cron (app/api/cron/cleanup/route.ts)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.processed_webhook_events TO service_role;

-- ════════════════════════════════════════════════════════════
-- 3. businesses: Replace unrestricted anon policy with safe view
-- ════════════════════════════════════════════════════════════

-- The canonical "publicly visible business" predicate is: status = 'active'
-- The businesses table has a status column of type restaurant_status
-- (enum: 'pending', 'active', 'suspended'). There is NO is_active boolean
-- column on the businesses table. The status enum is the sole authority.

-- Drop the unrestricted anon SELECT policy
DROP POLICY IF EXISTS "public_read_active_businesses" ON public.businesses;

-- Revoke direct anon table access.
REVOKE ALL ON public.businesses FROM anon;

-- Ensure authenticated and service_role have required base-table privileges.
GRANT SELECT, INSERT, UPDATE ON public.businesses TO authenticated;
GRANT ALL ON public.businesses TO service_role;

-- Create a restricted public view with only safe columns.
-- Credential columns explicitly excluded:
--   google_calendar_token, google_calendar_refresh_token,
--   payment_channels, custom_fee_percentage, custom_fee_flat, metadata
CREATE OR REPLACE VIEW public.businesses_public
  WITH (security_barrier = true) AS
SELECT
  id,
  name,
  slug,
  description,
  address,
  city,
  state,
  country_code,
  phone,
  email,
  logo_url,
  cover_photo_url,
  category,
  flow_type,
  operating_hours,
  rating_avg,
  rating_count,
  total_bookings,
  instagram_handle,
  timezone,
  recurring_enabled,
  bot_code,
  status,
  created_at,
  updated_at
FROM public.businesses
WHERE status = 'active';

-- Revoke everything from the view first, then grant only SELECT.
REVOKE ALL ON public.businesses_public FROM PUBLIC;
GRANT SELECT ON public.businesses_public TO anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- 4. bot_keywords: Remove anonymous read access
-- ════════════════════════════════════════════════════════════

-- Drop the policy that allows anon to read system/category keywords
DROP POLICY IF EXISTS "anyone_read_system_category" ON public.bot_keywords;

-- Explicitly DROP then CREATE policies to guarantee exact definitions.
DROP POLICY IF EXISTS "bot_keywords_service_read" ON public.bot_keywords;
CREATE POLICY "bot_keywords_service_read"
  ON public.bot_keywords
  FOR SELECT
  TO service_role
  USING (true);

-- Owner read: scoped via subquery to businesses owned by the current authenticated user.
DROP POLICY IF EXISTS "bot_keywords_owner_read" ON public.bot_keywords;
CREATE POLICY "bot_keywords_owner_read"
  ON public.bot_keywords
  FOR SELECT
  TO authenticated
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_id = auth.uid()
    )
  );

-- Revoke direct anon access only.
REVOKE ALL ON public.bot_keywords FROM anon;

-- Ensure authenticated and service_role have SELECT privilege on the base table.
-- RLS policies (bot_keywords_owner_read, bot_keywords_service_read) require the
-- underlying table-level SELECT privilege to function. In Supabase production,
-- this is provided by default privilege grants. We make it explicit here so the
-- migration is self-contained and works in any PostgreSQL environment.
GRANT SELECT ON public.bot_keywords TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════
-- 5. Audit: verify no remaining unsafe policies or privileges
-- ════════════════════════════════════════════════════════════

DO $$
DECLARE
  unsafe_count integer;
  unsafe_details text;
  tbl text;
  sensitive_tables text[] := ARRAY['whatsapp_channels', 'processed_webhook_events', 'businesses', 'bot_keywords'];
BEGIN
  -- A. Check known unsafe policy names
  SELECT count(*), string_agg(policyname || ' on ' || tablename, ', ')
  INTO unsafe_count, unsafe_details
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = ANY(sensitive_tables)
    AND policyname IN (
      'shared_channels_public_read',
      'processed_webhook_events_service_all',
      'public_read_active_businesses',
      'anyone_read_system_category'
    );

  IF unsafe_count > 0 THEN
    RAISE EXCEPTION 'Migration 293 audit A failed: known unsafe policies still exist: %', unsafe_details;
  END IF;

  -- B. Check for ANY policy granting anon access on these base tables
  SELECT count(*), string_agg(policyname || ' on ' || tablename || ' (roles: ' || array_to_string(roles, ',') || ')', '; ')
  INTO unsafe_count, unsafe_details
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = ANY(sensitive_tables)
    AND (
      roles @> ARRAY['anon']::name[]
      OR roles = '{}'::name[]
    );

  IF unsafe_count > 0 THEN
    RAISE EXCEPTION 'Migration 293 audit B failed: policies granting anon access on sensitive tables: %', unsafe_details;
  END IF;

  -- C. Verify anon has no effective base-table privileges via has_table_privilege()
  FOREACH tbl IN ARRAY sensitive_tables LOOP
    IF has_table_privilege('anon', 'public.' || tbl, 'SELECT') THEN
      RAISE EXCEPTION 'Migration 293 audit C failed: anon has SELECT privilege on %', tbl;
    END IF;
    IF has_table_privilege('anon', 'public.' || tbl, 'INSERT') THEN
      RAISE EXCEPTION 'Migration 293 audit C failed: anon has INSERT privilege on %', tbl;
    END IF;
  END LOOP;

  -- D. Verify service_role has required privileges on processed_webhook_events
  IF NOT has_table_privilege('service_role', 'public.processed_webhook_events', 'SELECT') THEN
    RAISE EXCEPTION 'Migration 293 audit D failed: service_role missing SELECT on processed_webhook_events';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.processed_webhook_events', 'INSERT') THEN
    RAISE EXCEPTION 'Migration 293 audit D failed: service_role missing INSERT on processed_webhook_events';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.processed_webhook_events', 'UPDATE') THEN
    RAISE EXCEPTION 'Migration 293 audit D failed: service_role missing UPDATE on processed_webhook_events';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.processed_webhook_events', 'DELETE') THEN
    RAISE EXCEPTION 'Migration 293 audit D failed: service_role missing DELETE on processed_webhook_events';
  END IF;
END $$;
