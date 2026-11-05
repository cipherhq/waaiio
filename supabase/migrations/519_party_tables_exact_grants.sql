-- M519: exact table grants on party_tables
-- (PR #789, was M487; renumbered above the Release V3 lock).
--
-- Sets the full table ACL for every API role, so the result is the same on
-- production, staging and the catalog oracle whatever each had before.
-- Owner decision 2026-11-05: party_tables only. seating_resources is left
-- unchanged for a later grants clean-up (its production grants differ from
-- migration history, and the Release V3 gate cannot record that difference yet).
--
-- Access contract (traced 2026-11-05 against main):
--   anon / PUBLIC   none   (no anonymous caller; public RSVP and the bot use the server role)
--   authenticated   SELECT, INSERT, UPDATE, DELETE
--                   app/dashboard/parties/page.tsx (list, add, delete, reserve tag),
--                   assign_guest_to_table / bulk_assign_guests_to_table (SECURITY INVOKER),
--                   event_invites triggers that read the table (SECURITY INVOKER)
--   service_role    SELECT
--                   lib/parties/reminder-preview.ts (cron and party reminder routes),
--                   event_invites triggers fired by server-role writes (RSVP, bot, reminders).
--                   Seating saves go through party_seating_486 (SECURITY DEFINER, owner).
--
-- RLS stays enabled; policies, columns, triggers and functions are unchanged.
-- No BEGIN/COMMIT: applied as one whole-file statement (one implicit transaction).

REVOKE ALL ON TABLE public.party_tables FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.party_tables TO authenticated;
GRANT SELECT ON TABLE public.party_tables TO service_role;

-- Self-check: the API-role grants are exactly the contract, and RLS is on.
DO $$
DECLARE
  v_actual   text[];
  v_expected text[] := ARRAY[  -- sorted, as v_actual is aggregated
    'authenticated:DELETE', 'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE',
    'service_role:SELECT'];
BEGIN
  SELECT coalesce(array_agg(g ORDER BY g), '{}') INTO v_actual
  FROM (
    SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
           || ':' || a.privilege_type AS g
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.party_tables'::regclass
      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))
  ) s;

  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'M519 self-check failed: party_tables grants are %, expected %', v_actual, v_expected;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.party_tables'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'M519 self-check failed: party_tables has column-level grants';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.party_tables'::regclass) THEN
    RAISE EXCEPTION 'M519 self-check failed: RLS is off on party_tables';
  END IF;
END $$;
