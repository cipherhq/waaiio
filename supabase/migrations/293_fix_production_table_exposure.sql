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

-- Revoke direct table access from PUBLIC and anon.
REVOKE ALL ON public.whatsapp_channels FROM PUBLIC;
REVOKE ALL ON public.whatsapp_channels FROM anon;

-- Re-grant privileges to authenticated and service_role after REVOKE FROM PUBLIC
-- removed inherited grants. Existing owner/admin RLS policies on the base table
-- require these privileges to function.
GRANT SELECT ON public.whatsapp_channels TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.whatsapp_channels TO service_role;

-- Create a restricted public view exposing only safe fields.
-- The onboarding wizard (OnboardingWizard.tsx) needs phone_number from shared channels.
-- View ownership defaults to the migration-running role (typically postgres/supabase_admin).
-- Simple views on a single table without aggregation are automatically updatable in
-- PostgreSQL, but we explicitly revoke INSERT/UPDATE/DELETE below to prevent misuse.
-- security_barrier is added to prevent information leakage through user-defined functions
-- in WHERE clauses that might bypass the view's filter conditions.
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
-- This ensures no INSERT/UPDATE/DELETE is possible via the view.
REVOKE ALL ON public.whatsapp_channels_public FROM PUBLIC;
GRANT SELECT ON public.whatsapp_channels_public TO anon, authenticated;

-- ════════════════════════════════════════════════════════════
-- 2. processed_webhook_events: Remove anon/authenticated access
-- ════════════════════════════════════════════════════════════

-- Drop the overly permissive USING(true) policy from migration 021.
-- This policy has no role restriction, granting full R/W to anon.
DROP POLICY IF EXISTS "processed_webhook_events_service_all" ON public.processed_webhook_events;

-- Explicitly DROP then CREATE the service_role-only policy to guarantee exact definition.
-- Using DROP + CREATE (not IF NOT EXISTS) ensures the policy matches our intent exactly,
-- even if a prior partial migration left a stale version.
DROP POLICY IF EXISTS "processed_webhook_events_service_only" ON public.processed_webhook_events;
CREATE POLICY "processed_webhook_events_service_only"
  ON public.processed_webhook_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Revoke direct table access from PUBLIC, anon, and authenticated.
-- Only service_role should access this table (webhook dedup from server-side handlers).
REVOKE ALL ON public.processed_webhook_events FROM PUBLIC;
REVOKE ALL ON public.processed_webhook_events FROM anon;
REVOKE ALL ON public.processed_webhook_events FROM authenticated;

-- Grant only the privileges service_role actually needs.
-- service_role needs:
--   SELECT — dedup check (SELECT 1 FROM processed_webhook_events WHERE event_id = ...)
--   INSERT — record new event (.upsert() / INSERT)
--   UPDATE — update status, attempts, completed_at (.update() in webhook handlers)
--            Also required by .upsert() which does INSERT ... ON CONFLICT DO UPDATE
--   DELETE — cleanup cron (app/api/cron/cleanup/route.ts)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.processed_webhook_events TO service_role;

-- ════════════════════════════════════════════════════════════
-- 3. businesses: Replace unrestricted anon policy with safe view
-- ════════════════════════════════════════════════════════════

-- The existing public_read_active_businesses policy (migration 149) allows
-- anon users to SELECT ALL columns from active businesses, including:
--   google_calendar_token, google_calendar_refresh_token,
--   payment_channels, custom_fee_percentage, custom_fee_flat, metadata
--
-- Public pages only need the columns listed in the view below.
--
-- The canonical "publicly visible business" predicate is: status = 'active'
-- The businesses table has a status column of type restaurant_status
-- (enum: 'pending', 'active', 'suspended'). There is NO is_active boolean
-- column on the businesses table. The status enum is the sole authority.
--
-- Strategy: drop the anon base-table policy, create a restricted view,
-- keep the authenticated owner/admin/reseller policies on the base table.

-- Drop the unrestricted anon SELECT policy
DROP POLICY IF EXISTS "public_read_active_businesses" ON public.businesses;

-- Revoke direct table access from PUBLIC and anon before creating the view.
REVOKE ALL ON public.businesses FROM PUBLIC;
REVOKE ALL ON public.businesses FROM anon;

-- Re-grant privileges to authenticated and service_role after REVOKE FROM PUBLIC
-- removed inherited grants. Existing owner/admin/reseller RLS policies on the
-- base table require these privileges to function.
GRANT SELECT, INSERT, UPDATE ON public.businesses TO authenticated;
GRANT ALL ON public.businesses TO service_role;

-- Create a restricted public view with only safe columns.
-- Uses security_barrier to prevent information leakage through
-- user-defined functions that might bypass the WHERE filter.
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
-- service_role read: bot engine runs as service_role and needs full keyword access.
DROP POLICY IF EXISTS "bot_keywords_service_read" ON public.bot_keywords;
CREATE POLICY "bot_keywords_service_read"
  ON public.bot_keywords
  FOR SELECT
  TO service_role
  USING (true);

-- Owner read: business owners need to read their own keywords (dashboard keywords page).
-- Scoped via subquery to businesses owned by the current authenticated user.
-- Cross-business access is denied: owner_id = auth.uid() restricts to owned businesses only.
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

-- Revoke direct access from PUBLIC and anon.
REVOKE ALL ON public.bot_keywords FROM PUBLIC;
REVOKE ALL ON public.bot_keywords FROM anon;

-- Re-grant SELECT to authenticated and service_role.
-- After REVOKE ALL FROM PUBLIC, inherited privileges are removed.
-- Authenticated users are scoped by the bot_keywords_owner_read RLS policy.
-- service_role is scoped by the bot_keywords_service_read RLS policy.
GRANT SELECT ON public.bot_keywords TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════
-- 5. Audit: verify no remaining unsafe policies or privileges
-- ════════════════════════════════════════════════════════════

-- This verification block does three things:
--   A. Checks that none of the 4 known unsafe policy names survived
--   B. Checks that no OTHER policy on these tables grants access to anon or public
--   C. Verifies effective table privileges using has_table_privilege()
--
-- Scoped by schemaname = 'public' AND tablename for each table.
-- Fails the migration with RAISE EXCEPTION if any check fails.
DO $$
DECLARE
  unsafe_count integer;
  unsafe_details text;
  anon_priv text;
  public_priv text;
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

  -- B. Check for ANY policy granting anon or public access on these base tables
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

  -- C. Verify effective table privileges via has_table_privilege()
  --    anon should have NO direct base-table privileges on any sensitive table.
  --    PUBLIC should have NO direct base-table privileges on any sensitive table.
  FOREACH tbl IN ARRAY sensitive_tables LOOP
    -- Check anon effective privileges
    IF has_table_privilege('anon', 'public.' || tbl, 'SELECT') THEN
      RAISE EXCEPTION 'Migration 293 audit C failed: anon has SELECT privilege on %', tbl;
    END IF;
    IF has_table_privilege('anon', 'public.' || tbl, 'INSERT') THEN
      RAISE EXCEPTION 'Migration 293 audit C failed: anon has INSERT privilege on %', tbl;
    END IF;
    IF has_table_privilege('anon', 'public.' || tbl, 'UPDATE') THEN
      RAISE EXCEPTION 'Migration 293 audit C failed: anon has UPDATE privilege on %', tbl;
    END IF;
    IF has_table_privilege('anon', 'public.' || tbl, 'DELETE') THEN
      RAISE EXCEPTION 'Migration 293 audit C failed: anon has DELETE privilege on %', tbl;
    END IF;
  END LOOP;

  -- Verify service_role has exactly the required privileges:
  --   processed_webhook_events: SELECT, INSERT, UPDATE, DELETE
  --   bot_keywords: SELECT (via RLS policy, not direct grant beyond what owner policies need)
  --   whatsapp_channels, businesses: preserved for authenticated owner/admin RLS
  IF NOT has_table_privilege('service_role', 'public.processed_webhook_events', 'SELECT') THEN
    RAISE EXCEPTION 'Migration 293 audit C failed: service_role missing SELECT on processed_webhook_events';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.processed_webhook_events', 'INSERT') THEN
    RAISE EXCEPTION 'Migration 293 audit C failed: service_role missing INSERT on processed_webhook_events';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.processed_webhook_events', 'UPDATE') THEN
    RAISE EXCEPTION 'Migration 293 audit C failed: service_role missing UPDATE on processed_webhook_events';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.processed_webhook_events', 'DELETE') THEN
    RAISE EXCEPTION 'Migration 293 audit C failed: service_role missing DELETE on processed_webhook_events';
  END IF;
END $$;
