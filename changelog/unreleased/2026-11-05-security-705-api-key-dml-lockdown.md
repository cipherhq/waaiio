## 2026-11-05 — M520: API keys are written only through the server (#705, #745)

- **What changed:** new migration `supabase/migrations/520_api_key_close_direct_writes.sql` (was M480, renumbered above the Release V3 lock). It removes every grant to PUBLIC, `anon`, `authenticated` and `service_role` on `public.api_keys`, then grants back exactly what the app uses:
  - `authenticated`: SELECT (the API-keys list in Settings, limited to the owner's keys by RLS);
  - `service_role`: SELECT, INSERT, UPDATE (API-key checks and `last_used_at`, and the M474 `issue_api_key` / `revoke_api_key` functions the routes call). Nothing deletes keys; revoking sets `revoked_at`.
  - No anonymous access. A self-check refuses to finish unless the grants are exactly this, there are no column-level grants and RLS is on.
- **Precondition met (read-only check 2026-11-05):** M474 is in the production and staging ledgers, and the app code that uses it (#740) is in the production merchant build, so no running app writes `api_keys` as a signed-in user.
- **Why the full reset:** production and staging start from different grants on this table; resetting every API role gives the same final state on both and matches the catalog oracle.
- **Unchanged:** the RLS policy, columns, M474 functions, application code.
- **Files:** the migration, `supabase/catalog-deltas/520_api_key_close_direct_writes.json` (catalog oracle output), `lib/__tests__/api-key-dml-lockdown-520.pg.test.ts` (real PostgreSQL, M474 and M520 applied from disk over both the production and the staging starting grants: exact grants, allow and deny for each role, both RPCs, key check, business delete cascade), `.github/workflows/ci.yml` (test required in the PG job, excluded from the plain unit run).
- **Apply:** staging, then production, each with its own Owner approval, as one whole-file statement. Rollback needs an Owner decision.
- **Could break:** any code that writes `api_keys` without the service client, or deletes keys as `service_role`. None exists on main as of 2026-11-05.
