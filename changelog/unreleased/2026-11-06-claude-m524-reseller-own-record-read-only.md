## 2026-11-06 — M524: reseller record is read-only to the reseller

- **Owner decision 2026-11-06 ("free until paid").** `supabase/migrations/524_resellers_own_record_read_only.sql` makes these changes:
  - It replaces the policy "Resellers manage own record" (FOR ALL) with "Resellers read own record" (FOR SELECT to authenticated, `user_id = auth.uid()`).
  - It sets exact grants:
    - authenticated: SELECT/INSERT/UPDATE. Writes are still limited by RLS to the admin policy (`is_admin()`, aal2).
    - service_role: SELECT/INSERT/UPDATE.
    - anon and PUBLIC: nothing.
  - It keeps "Admin manages resellers" and "Service role manages resellers".
  - It self-checks the grants, RLS, and that the only non-service write policy is the admin one.
- **Effect:** a reseller can still read its own row (dashboard and API lookups). Changes to the row go through admins (aal2) and server routes only.
- **Precondition:** apply only after the app change in `claude/reseller-free-until-paid` (branding saved with the service client) is in the production build.
- **Files:**
  - the migration;
  - `lib/__tests__/resellers-own-record-read-only-524.pg.test.ts` (real PostgreSQL);
  - `.github/workflows/ci.yml` (adds the new `.pg` file to the required list and the main-suite exclude list);
  - `docs/MIGRATION_REGISTRY.md` (reserves 524).
- **Unchanged:** columns, triggers, functions and the admin and service policies. RLS stays on.
- **Could break:** any reseller path that still writes the row with the signed-in client. None remains after the precondition PR (checked with grep and Graphify).
