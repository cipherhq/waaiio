-- 182: Lock down server-only RPCs + fix business_capabilities permissive INSERT

-- ── Restrict server-only RPCs to service_role ──
-- These are only called from bot flows / API routes, never from the browser client

REVOKE ALL ON FUNCTION redeem_loyalty_points(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_loyalty_points(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION increment_campaign_donation(uuid, numeric, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION increment_campaign_donation(uuid, numeric, integer) TO service_role;

REVOKE ALL ON FUNCTION upsert_customer_profile(uuid, text, text, numeric, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_customer_profile(uuid, text, text, numeric, boolean, boolean) TO service_role;

-- ── Fix overly permissive INSERT on business_capabilities ──
-- Migration 008 created WITH CHECK(true) allowing any authenticated user to insert capabilities for any business
DROP POLICY IF EXISTS "business_capabilities_service_insert" ON business_capabilities;
-- Only service_role should INSERT capabilities (via API routes)
CREATE POLICY "business_capabilities_service_insert" ON business_capabilities
  FOR INSERT TO service_role WITH CHECK (true);
