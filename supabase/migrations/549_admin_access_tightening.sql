-- M549: Tighten admin panel database access.
--
-- §1. admin_role_permissions: every admin role may still read it (the admin
--     panel uses it for menu gating), but only a full admin (is_admin(), aal2)
--     may insert, update or delete. anon has no rights.
-- §2. payout_accounts and business_bank_accounts: browser sessions read the
--     last four digits of the account number (account_number_last4, a stored
--     generated column), never the full number. Server routes use
--     service_role and keep the full number for transfers.
-- §3. public.get_effective_commercial_config() is dropped. The admin Countries
--     page reads the effective config through the admin-only server route
--     GET /api/admin/countries/messaging-config instead.
BEGIN;

-- §1
DROP POLICY IF EXISTS "Admin manages permissions" ON public.admin_role_permissions;
DROP POLICY IF EXISTS "Admin inserts permissions" ON public.admin_role_permissions;
DROP POLICY IF EXISTS "Admin updates permissions" ON public.admin_role_permissions;
DROP POLICY IF EXISTS "Admin deletes permissions" ON public.admin_role_permissions;
CREATE POLICY "Admin inserts permissions" ON public.admin_role_permissions
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admin updates permissions" ON public.admin_role_permissions
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admin deletes permissions" ON public.admin_role_permissions
  FOR DELETE TO authenticated USING (public.is_admin());
-- "Admin roles read permissions" (SELECT, has_admin_role of the four roles, M439) is kept.

REVOKE ALL ON TABLE public.admin_role_permissions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_role_permissions TO authenticated;

-- §2
ALTER TABLE public.payout_accounts
  ADD COLUMN IF NOT EXISTS account_number_last4 text GENERATED ALWAYS AS (right(account_number, 4)) STORED;
ALTER TABLE public.business_bank_accounts
  ADD COLUMN IF NOT EXISTS account_number_last4 text GENERATED ALWAYS AS (right(account_number, 4)) STORED;

-- A table-level REVOKE also removes every column-level grant, so both tables
-- end with exactly the column list below whatever an environment held before.
REVOKE SELECT ON TABLE public.payout_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, business_id, gateway, bank_code, bank_name, account_number_last4, account_name,
  square_merchant_id, platform_percentage, is_active, verified_at, created_at, updated_at
) ON public.payout_accounts TO authenticated;

REVOKE SELECT ON TABLE public.business_bank_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, business_id, bank_name, account_number_last4, account_name, bank_code,
  is_default, is_active, created_at, updated_at
) ON public.business_bank_accounts TO authenticated;

-- §3
DROP FUNCTION IF EXISTS public.get_effective_commercial_config();

-- Self-check
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.admin_role_permissions', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'M549: anon still has rights on admin_role_permissions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_role_permissions'
             AND cmd <> 'SELECT'
             AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%is_admin()%') THEN
    RAISE EXCEPTION 'M549: an admin_role_permissions write policy is not limited to is_admin()';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_role_permissions'
             AND cmd <> 'SELECT'
             AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%has_admin_role%') THEN
    RAISE EXCEPTION 'M549: an admin_role_permissions write policy still admits non-admin roles';
  END IF;
  IF has_column_privilege('authenticated', 'public.payout_accounts', 'account_number', 'SELECT')
     OR has_column_privilege('authenticated', 'public.business_bank_accounts', 'account_number', 'SELECT') THEN
    RAISE EXCEPTION 'M549: authenticated can still read a full account number';
  END IF;
  IF to_regprocedure('public.get_effective_commercial_config()') IS NOT NULL THEN
    RAISE EXCEPTION 'M549: public.get_effective_commercial_config() still exists';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
