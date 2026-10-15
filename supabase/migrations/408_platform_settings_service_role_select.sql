-- 408: Grant SELECT on platform_settings to service_role
--
-- The health endpoint (GET /api/health) uses createServiceClient() to query
-- platform_settings. On a fresh/reconciled staging database, service_role
-- may lack the table-level SELECT privilege if it was not carried forward
-- from historical default ACLs.
--
-- This migration explicitly grants only SELECT — the minimum privilege
-- required by service-role server-side reads. It does not grant
-- INSERT/UPDATE/DELETE or any privilege to anon/authenticated.
--
-- Idempotent: GRANT SELECT is a no-op if the privilege already exists.

GRANT SELECT ON public.platform_settings TO service_role;
