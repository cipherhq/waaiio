-- M524: a reseller can read its own resellers row but no longer write it directly.
--
-- Owner decision 2026-11-06 ("free until paid"): plan, account cap, commission and
-- status on public.resellers are set by Waaiio (admin panel, server routes), not by
-- the reseller through the Data API.
--
-- Precondition: apply only after the app change that saves reseller branding with the service
-- client (PR "Resellers: plans start free and change only after payment",
-- branch claude/reseller-free-until-paid) is in the production merchant build. Before that,
-- the live branding save writes this row with the signed-in client and would be refused.
--
-- Access contract (main 091e1035, checked with grep and Graphify):
--
--   anon / PUBLIC   none. No anonymous reader exists.
--   authenticated   SELECT, INSERT, UPDATE. Rows are limited by RLS:
--                     "Resellers read own record" (new): SELECT where user_id = auth.uid().
--                       Callers: app/dashboard/layout.tsx; getReseller() in
--                       app/api/reseller/{accounts,subscription,branding,...}.
--                     "Admin manages resellers" (M439, unchanged): ALL for is_admin() (aal2).
--                       Caller: admin/src/pages/Resellers.tsx (adminDb select, insert, update).
--   service_role    SELECT, INSERT, UPDATE: app/api/reseller/{setup,invite,subscription,...},
--                   reseller crons, lib/payments/process-success.ts, and the branding PUT
--                   (now written with the service client after the owner check).
--                   No code path deletes a reseller row.
--
-- Replaces "Resellers manage own record" (M205: FOR ALL to PUBLIC, USING user_id = auth.uid(),
-- no WITH CHECK). "Service role manages resellers" and "Admin manages resellers" stay.
-- RLS stays enabled. Columns, triggers and functions are unchanged.
-- Rollback (Owner-approved only): restore the M205 policy and the previous grants.
-- No BEGIN/COMMIT: applied as one whole-file statement (one implicit transaction).

DROP POLICY IF EXISTS "Resellers manage own record" ON public.resellers;
DROP POLICY IF EXISTS "Resellers read own record" ON public.resellers;
CREATE POLICY "Resellers read own record"
  ON public.resellers
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON TABLE public.resellers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.resellers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.resellers TO service_role;

-- Self-check: exact API-role grants, RLS on, and no non-admin write policy.
DO $$
DECLARE
  v_actual   text[];
  v_expected text[] := ARRAY[  -- sorted, as v_actual is aggregated
    'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE',
    'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'];
  v_policies text[];
BEGIN
  SELECT coalesce(array_agg(g ORDER BY g), '{}') INTO v_actual
  FROM (
    SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
           || ':' || a.privilege_type AS g
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.resellers'::regclass
      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))
  ) s;

  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'M524 self-check failed: resellers grants are %, expected %', v_actual, v_expected;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'public.resellers'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'M524 self-check failed: resellers has column-level grants';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.resellers'::regclass) THEN
    RAISE EXCEPTION 'M524 self-check failed: RLS is off on resellers';
  END IF;

  -- Every policy that lets a non-service role write must be the admin policy.
  SELECT coalesce(array_agg(p.polname::text ORDER BY p.polname), '{}') INTO v_policies
  FROM pg_policy p
  WHERE p.polrelid = 'public.resellers'::regclass
    AND p.polcmd IN ('*', 'a', 'w', 'd')
    AND NOT (p.polroles = ARRAY['service_role'::regrole]::oid[]);

  IF v_policies IS DISTINCT FROM ARRAY['Admin manages resellers'] THEN
    RAISE EXCEPTION 'M524 self-check failed: write policies on resellers are %, expected only "Admin manages resellers"', v_policies;
  END IF;
END $$;
