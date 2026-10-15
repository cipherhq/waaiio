-- #460: Explicit service_role grants for launch_subscribers table.
-- Fixes staging "permission denied for table launch_subscribers" error.
-- Mirrors established pattern from migration 367 (message_send_attempts).
--
-- service_role needs SELECT/INSERT/UPDATE to:
-- - INSERT opt-in subscribers via handleLaunchOptIn (bot webhook handler)
-- - UPDATE opt_in_status on STOP messages
-- - SELECT for launch notification delivery
--
-- No DELETE/TRUNCATE — admin cleanup happens via RLS admin_all policy.
-- No anon/authenticated grants — table is admin-only via RLS.
-- Idempotent: GRANT is safe to run multiple times.

GRANT SELECT, INSERT, UPDATE ON TABLE public.launch_subscribers TO service_role;
