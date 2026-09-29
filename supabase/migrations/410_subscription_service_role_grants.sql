-- 410: Grant service_role table privileges for subscription verification/activation
--
-- The onboarding verify route and webhook handlers use createServiceClient()
-- to read, upsert, and update subscriptions, and to insert/read subscription
-- payments. On staging, service_role may lack these table-level privileges.
--
-- Least privilege based on actual code paths:
--   subscriptions:          SELECT, INSERT, UPDATE (upsert = insert + update)
--   subscription_payments:  SELECT, INSERT
--
-- Does NOT grant DELETE on either table.
-- Does NOT grant anything to anon or authenticated.
-- Idempotent: GRANT is a no-op if the privilege already exists.

GRANT SELECT, INSERT, UPDATE ON public.subscriptions TO service_role;
GRANT SELECT, INSERT ON public.subscription_payments TO service_role;
