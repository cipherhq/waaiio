-- ═══════════════════════════════════════════════════════════════════════════
-- M448: business_bank_accounts — server-only writes
--
-- Revoke all DML from anon and authenticated on business_bank_accounts.
-- All writes go through the service client in the API route
-- (/api/dashboard/bank-account/route.ts) after owner verification.
-- The bot engine also reads via service client (bank-transfer.ts).
-- The admin panel reads via the browser's authenticated session (adminDb)
-- + the "Admin reads bank accounts" RLS policy (M439).
--
-- No browser-side code writes this table directly.
-- The admin panel is the only browser-side reader (via authenticated + RLS).
--
-- Final-state grants after this migration:
--   service_role: SELECT, INSERT, UPDATE  (from M415, kept)
--   authenticated: SELECT only (kept for admin panel RLS policy)
--   anon: (none)
--
-- Final-state RLS policies after this migration:
--   "Service role manages bank accounts" — FOR ALL TO service_role (M209, kept)
--   "Admin reads bank accounts"          — FOR SELECT TO authenticated
--                                           via has_admin_role() aal2 (M439, kept)
--
-- Dropped policies:
--   "Owners manage bank accounts"                  (FOR ALL — M209)
--   "Resellers manage sub-account bank accounts"   (FOR ALL — M209)
-- ═══════════════════════════════════════════════════════════════════════════

-- §1. Revoke write privileges from browser-accessible roles
REVOKE INSERT, UPDATE, DELETE ON TABLE public.business_bank_accounts FROM PUBLIC, anon, authenticated;
-- Revoke SELECT from anon (no anonymous access needed)
REVOKE SELECT ON TABLE public.business_bank_accounts FROM anon;
-- NOTE: authenticated keeps SELECT — required by "Admin reads bank accounts" RLS policy (M439).
-- Non-admin authenticated users get zero rows (no RLS policy grants them SELECT).

-- §2. Drop owner/reseller write policies (browser DML paths)
DROP POLICY IF EXISTS "Owners manage bank accounts" ON public.business_bank_accounts;
DROP POLICY IF EXISTS "Resellers manage sub-account bank accounts" ON public.business_bank_accounts;

-- §3. Self-check: fail if any write grant remains for anon or authenticated
DO $$
DECLARE
  v_priv text;
  v_role text;
  v_privs text[] := ARRAY['INSERT', 'UPDATE', 'DELETE'];
  v_roles text[] := ARRAY['anon', 'authenticated'];
BEGIN
  FOREACH v_role IN ARRAY v_roles LOOP
    FOREACH v_priv IN ARRAY v_privs LOOP
      IF has_table_privilege(v_role, 'public.business_bank_accounts', v_priv) THEN
        RAISE EXCEPTION 'M448 FAILED: % still has % on business_bank_accounts', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'M448 self-check PASSED: no write grants remain for anon/authenticated on business_bank_accounts';
END $$;
