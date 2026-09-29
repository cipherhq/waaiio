-- 412: Grant authenticated role CRUD on event tables
--
-- The dashboard events page uses createClient() (browser, authenticated role)
-- for all event and ticket-type CRUD. Staging lacks table-level privileges,
-- causing silent insert/update/delete failures.
--
-- Least privilege: SELECT, INSERT, UPDATE, DELETE under existing RLS.
-- RLS policies ("Owners manage own events", "public_read_published_events",
-- plus per-operation owner policies on event_ticket_types) enforce authorization.
--
-- Does NOT grant TRUNCATE, TRIGGER, or REFERENCES.
-- Does NOT grant anything to anon beyond existing SELECT policy.
-- Idempotent: GRANT is a no-op if privilege already exists.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_ticket_types TO authenticated;
