## 2026-11-13 — M539: explicit service-role permissions on the admin passkey approvals table

- **Why:** M538 created `public.admin_passkey_approvals` and granted the service role SELECT, INSERT and DELETE. It did not first revoke the service role's default rights.
  - Production's defaults give the service role every table right; staging's give fewer.
  - So the final permissions would differ by environment, and Release V3 prepare would stop on the catalog mismatch, as it did for five M526/M535 tables in the last release.
  - The Owner chose to fix this on 2026-11-13. M538 is already on main and CI forbids editing a merged migration, so the fix is a separate migration (Owner: "Yes, use M539").
- **What changed:**
  - `supabase/migrations/539_admin_passkey_approvals_explicit_acl.sql`: revokes all rights on the table from the service role, then grants SELECT, INSERT and DELETE.
  - `lib/__tests__/admin-passkey-acl-539.pg.test.ts` (new): starts from production-like default privileges, applies M538 and then M539 twice, and proves the final rights are exactly SELECT, INSERT, DELETE.
  - CI registers the new pg test.
  - Catalog delta for M539.
- **Affects:** database permissions on one table, used only by the server.
- **Could break:** nothing in the app. The server uses only SELECT, INSERT and DELETE on this table. Apply M539 right after M538 (M537, M538, M539 in order, with the usual pause between them).
