## 2026-11-04 — M515: server-only owner consent answers on profiles (database only)

Owner decision (2026-11-04, #878 Bug 2, Option A). This is PR A of two: the database change only. The app change (point `/api/account/consent` and `/api/onboarding/activate-admin-invite` at the new column) follows in a stacked PR B and ships only after this migration is in production.

Why: both routes read and write `profiles.metadata.consent_preferences`, but `profiles.metadata` has never existed on staging or production. Settings → Account privacy preferences, the cookie banner's account sync and admin-assisted activation (#551) have always failed.

What changed (`supabase/migrations/515_profile_consent_preferences.sql`):
- New column `profiles.consent_preferences` (JSONB, nullable, no default) with a named check `profiles_consent_preferences_object_check` (NULL or a JSON object). Existing rows stay NULL.
- No `INSERT` or `UPDATE` on the column for PUBLIC, `anon` or `authenticated` (the M428 pattern). Owners read their own row through the existing SELECT grant and RLS; only trusted server code (`service_role`) writes it. M353's six named-column UPDATE grants, the table ACL and every RLS policy are unchanged.
- A self-check fails the migration if the column type, the check or the ACL contract drifts (for example a table-wide UPDATE grant to `authenticated`).
- Idempotent; applied as one whole-file statement.
- **Catalog delta:** `supabase/catalog-deltas/515_profile_consent_preferences.json`.
- **Tests:** `lib/__tests__/profile-consent-preferences-515.pg.test.ts` (real PostgreSQL), added to the `ci.yml` pg-file guard and the unit-job exclude. Registry row 515 in `docs/MIGRATION_REGISTRY.md`.

Affects: `public.profiles` only. The live app needs no change to keep working: no code reads or writes the new column yet, and none selects `profiles` `*` and writes the row back.

Could break:
- Any future client-side write that includes `consent_preferences` is refused (`42501`); that is intended.
- Admin and support staff who can read other profiles (`admin_select_profiles`) can also read this column, as for every other profile column.
