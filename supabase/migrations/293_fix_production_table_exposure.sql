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
-- All changes are idempotent (IF EXISTS / IF NOT EXISTS guards).

-- ════════════════════════════════════════════════════════════
-- 1. whatsapp_channels: Remove anonymous access to Meta tokens
-- ════════════════════════════════════════════════════════════

-- Drop the policy that exposes ALL columns (including meta_access_token,
-- waba_id, phone_number_id) to anon users for shared channels.
DROP POLICY IF EXISTS "shared_channels_public_read" ON public.whatsapp_channels;

-- Create a restricted public view exposing only safe fields.
-- The onboarding wizard (OnboardingWizard.tsx) needs phone_number from shared channels.
CREATE OR REPLACE VIEW public.whatsapp_channels_public AS
SELECT
  id,
  country_code,
  phone_number,
  display_name,
  channel_type,
  is_active
FROM public.whatsapp_channels
WHERE channel_type = 'shared' AND is_active = true;

-- Grant the view to anon/authenticated (replaces the dropped base-table policy)
GRANT SELECT ON public.whatsapp_channels_public TO anon, authenticated;

-- Revoke direct table access from anon (service_role and owner policies remain)
REVOKE ALL ON public.whatsapp_channels FROM anon;

-- ════════════════════════════════════════════════════════════
-- 2. processed_webhook_events: Remove anon/authenticated access
-- ════════════════════════════════════════════════════════════

-- Drop the overly permissive USING(true) policy from migration 021
-- that was never cleaned up by migration 023.
DROP POLICY IF EXISTS "processed_webhook_events_service_all" ON public.processed_webhook_events;

-- Verify the correct service_role-only policy exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'processed_webhook_events'
    AND policyname = 'processed_webhook_events_service_only'
  ) THEN
    CREATE POLICY "processed_webhook_events_service_only"
      ON public.processed_webhook_events
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- Revoke direct table access from anon and authenticated
REVOKE ALL ON public.processed_webhook_events FROM anon;
REVOKE ALL ON public.processed_webhook_events FROM authenticated;

-- ════════════════════════════════════════════════════════════
-- 3. businesses: Replace unrestricted anon policy with safe view
-- ════════════════════════════════════════════════════════════

-- The existing public_read_active_businesses policy (migration 149) allows
-- anon users to SELECT ALL columns from active businesses, including:
--   google_calendar_token, google_calendar_refresh_token,
--   payment_channels, custom_fee_percentage, custom_fee_flat, metadata
--
-- Public pages only need: id, name, slug, description, address, city, state,
-- country_code, phone, email, logo_url, cover_photo_url, category, flow_type,
-- operating_hours, rating_avg, rating_count, total_bookings, instagram_handle,
-- timezone, recurring_enabled, bot_code, status
--
-- Strategy: drop the anon base-table policy, create a restricted view,
-- keep the authenticated owner/admin/reseller policies on the base table.

-- Drop the unrestricted anon SELECT policy
DROP POLICY IF EXISTS "public_read_active_businesses" ON public.businesses;

-- Create a restricted public view with only safe columns
CREATE OR REPLACE VIEW public.businesses_public AS
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

GRANT SELECT ON public.businesses_public TO anon, authenticated;

-- Revoke direct anon table access (owner/admin/reseller policies remain)
REVOKE ALL ON public.businesses FROM anon;

-- ════════════════════════════════════════════════════════════
-- 4. bot_keywords: Remove anonymous read access
-- ════════════════════════════════════════════════════════════

-- Drop the policy that allows anon to read system/category keywords
DROP POLICY IF EXISTS "anyone_read_system_category" ON public.bot_keywords;

-- Create service_role-only read policy (bot engine runs as service_role)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bot_keywords'
    AND policyname = 'bot_keywords_service_read'
  ) THEN
    CREATE POLICY "bot_keywords_service_read"
      ON public.bot_keywords
      FOR SELECT
      TO service_role
      USING (true);
  END IF;
END $$;

-- Ensure business owners can read their own keywords (dashboard keywords page)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bot_keywords'
    AND policyname = 'bot_keywords_owner_read'
  ) THEN
    CREATE POLICY "bot_keywords_owner_read"
      ON public.bot_keywords
      FOR SELECT
      TO authenticated
      USING (
        business_id IN (
          SELECT id FROM public.businesses WHERE owner_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Revoke direct anon access
REVOKE ALL ON public.bot_keywords FROM anon;
