-- M519: exact table grants on party_tables and seating_resources
-- (was M487 in PR #789; renumbered above the Release V3 lock).
--
-- Sets the full table ACL for every API role, so the result is the same on
-- production, staging and the catalog oracle whatever each had before.
-- Access contract (traced 2026-11-05 against main):
--
--   party_tables
--     anon / PUBLIC   none   (no anonymous caller; public RSVP and the bot use the server role)
--     authenticated   SELECT, INSERT, UPDATE, DELETE
--                     app/dashboard/parties/page.tsx (list, add, delete, reserve tag),
--                     assign_guest_to_table / bulk_assign_guests_to_table (SECURITY INVOKER),
--                     event_invites triggers that read the table (SECURITY INVOKER)
--     service_role    SELECT
--                     lib/parties/reminder-preview.ts (cron and party reminder routes),
--                     event_invites triggers fired by server-role writes (RSVP, bot, reminders).
--                     Seating saves go through party_seating_486 (SECURITY DEFINER, owner).
--
--   seating_resources
--     anon / PUBLIC   none
--     authenticated   SELECT, INSERT, UPDATE   (dashboard seating page, /api/seating-resources,
--                     reservations list embed, onboarding checklist; archive, never delete)
--     service_role    SELECT, INSERT, UPDATE   (bot table-reservation flow, admin route,
--                     book_table_atomic SECURITY INVOKER)
--
-- RLS stays enabled; policies, columns, triggers and functions are unchanged.
-- No BEGIN/COMMIT: applied as one whole-file statement (one implicit transaction).

REVOKE ALL ON TABLE public.party_tables FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.party_tables TO authenticated;
GRANT SELECT ON TABLE public.party_tables TO service_role;

REVOKE ALL ON TABLE public.seating_resources FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.seating_resources TO authenticated, service_role;

-- Self-check: the API-role grants are exactly the contract, and RLS is on.
DO $$
DECLARE
  v_actual   text[];
  v_expected text[];
  v_table    text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['party_tables', 'seating_resources'] LOOP
    SELECT coalesce(array_agg(g ORDER BY g), '{}') INTO v_actual
    FROM (
      SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
             || ':' || a.privilege_type AS g
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relname = v_table
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))
    ) s;

    v_expected := CASE v_table
      WHEN 'party_tables' THEN ARRAY[
        'authenticated:DELETE', 'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE',
        'service_role:SELECT']
      ELSE ARRAY[
        'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE',
        'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE']
    END;  -- listed in sorted order, as v_actual is aggregated

    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'M519 self-check failed: % grants are %, expected %', v_table, v_actual, v_expected;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = format('public.%I', v_table)::regclass
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'M519 self-check failed: % has column-level grants', v_table;
    END IF;

    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = format('public.%I', v_table)::regclass) THEN
      RAISE EXCEPTION 'M519 self-check failed: RLS is off on %', v_table;
    END IF;
  END LOOP;
END $$;
