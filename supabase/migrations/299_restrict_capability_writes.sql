-- 299: Restrict direct browser writes to business_capabilities
-- All capability mutations now go through server API endpoints
-- that use the service_role client after server-side policy validation.
--
-- Rollback:
--   DROP POLICY IF EXISTS business_capabilities_server_only_update ON business_capabilities;
--   DROP POLICY IF EXISTS business_capabilities_server_only_delete ON business_capabilities;
--   CREATE POLICY business_capabilities_owner_update ON business_capabilities
--     FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
--   CREATE POLICY business_capabilities_owner_delete ON business_capabilities
--     FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Drop the owner-based UPDATE policy (was allowing direct browser writes)
DROP POLICY IF EXISTS business_capabilities_owner_update ON business_capabilities;

-- Drop the owner-based DELETE policy
DROP POLICY IF EXISTS business_capabilities_owner_delete ON business_capabilities;

-- Replace with service_role-only UPDATE policy
CREATE POLICY business_capabilities_server_only_update ON business_capabilities
  FOR UPDATE TO service_role
  USING (true)
  WITH CHECK (true);

-- Replace with service_role-only DELETE policy
CREATE POLICY business_capabilities_server_only_delete ON business_capabilities
  FOR DELETE TO service_role
  USING (true);

-- INSERT was already restricted to service_role by migration 182.
-- SELECT remains owner-accessible via business_capabilities_owner_select (migration 008).
-- No change to SELECT access.
