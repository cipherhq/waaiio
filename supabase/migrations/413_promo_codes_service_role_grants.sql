-- 413: Grant service_role CRUD on promo_codes table
--
-- Root cause of #473 (P0 staging promo code creation HTTP 500).
-- The promo_codes table (created in migration 021) has RLS policies
-- but no table-level privileges for service_role. The API route
-- (app/api/promo-codes/route.ts) uses createServiceClient() for all
-- CRUD — BYPASSRLS does not replace table GRANTs.
--
-- Confirmed via staging information_schema.table_privileges:
-- only postgres had privileges; service_role had none.
--
-- Same pattern as #461 / migration 412 (events table).
--
-- Least privilege: SELECT, INSERT, UPDATE, DELETE only.
-- Does NOT grant TRUNCATE, TRIGGER, or REFERENCES.
-- Does NOT grant to anon, authenticated, or PUBLIC.
-- Idempotent: GRANT is a no-op if privilege already exists.

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.promo_codes
TO service_role;
