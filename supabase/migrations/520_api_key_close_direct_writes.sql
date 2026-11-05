-- M520: api_keys writes only through the server (Issue #705 follow-up; was M480 in PR #745,
-- renumbered above the Release V3 lock).
--
-- Precondition (checked 2026-11-05, read-only): M474 (issue_api_key / revoke_api_key,
-- service_role-only EXECUTE) is in the production and staging ledgers, and the app code
-- that calls them (#740) is in the production merchant build. No app path writes api_keys
-- as a signed-in user any more.
--
-- Sets the full table ACL for every API role, so the result is the same on production,
-- staging and the catalog oracle whatever each had before. Access contract (main, 2026-11-05):
--
--   anon / PUBLIC   none
--   authenticated   SELECT   GET /api/integrations/api-keys (server client; RLS owner policy)
--   service_role    SELECT, INSERT, UPDATE
--                   lib/api-keys.ts validateApiKey (lookup + last_used_at),
--                   issue_api_key (count + insert) and revoke_api_key (lookup + set revoked_at),
--                   both SECURITY INVOKER, called with the service client.
--                   Nothing deletes keys: revoking sets revoked_at.
--
-- RLS stays enabled; the policy, columns and functions are unchanged.
-- Rollback (Owner-approved only): GRANT INSERT, UPDATE, DELETE ON public.api_keys TO authenticated;
-- No BEGIN/COMMIT: applied as one whole-file statement (one implicit transaction).

REVOKE ALL ON TABLE public.api_keys FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.api_keys TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.api_keys TO service_role;

-- Self-check: the API-role grants are exactly the contract, and RLS is on.
DO $$
DECLARE
  v_actual   text[];
  v_expected text[] := ARRAY[  -- sorted, as v_actual is aggregated
    'authenticated:SELECT',
    'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'];
BEGIN
  SELECT coalesce(array_agg(g ORDER BY g), '{}') INTO v_actual
  FROM (
    SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
           || ':' || a.privilege_type AS g
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.api_keys'::regclass
      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))
  ) s;

  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'M520 self-check failed: api_keys grants are %, expected %', v_actual, v_expected;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.api_keys'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'M520 self-check failed: api_keys has column-level grants';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.api_keys'::regclass) THEN
    RAISE EXCEPTION 'M520 self-check failed: RLS is off on api_keys';
  END IF;
END $$;
