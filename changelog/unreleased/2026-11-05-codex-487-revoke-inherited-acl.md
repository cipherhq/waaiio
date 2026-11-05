## 2026-11-05 — M519: exact table grants on party_tables and seating_resources (#789)

- **What changed:** new migration `supabase/migrations/519_revoke_inherited_acl_party_seating.sql` (was M487, renumbered above the Release V3 lock). It removes every grant to PUBLIC, `anon`, `authenticated` and `service_role` on `public.party_tables` and `public.seating_resources`, then grants back exactly what the app uses:
  - `party_tables`: `authenticated` SELECT, INSERT, UPDATE, DELETE (dashboard Parties page, guest-to-table RPCs, invite triggers); `service_role` SELECT (party reminders, invite triggers fired by RSVP and bot writes).
  - `seating_resources`: `authenticated` and `service_role` SELECT, INSERT, UPDATE (dashboard Seating page, seating API, bot table reservation, admin route). No DELETE (archive only).
  - No anonymous access to either table. A self-check refuses to finish unless the grants are exactly this, there are no column-level grants and RLS is on.
- **Why the full reset:** production and staging start from different grants on these tables; resetting every API role gives the same final state on both and matches the catalog oracle. Staging also gains the `service_role` SELECT on `party_tables` that the reminder and RSVP paths need.
- **Unchanged:** RLS policies, columns, triggers, functions, application code.
- **Files:** the migration, `supabase/catalog-deltas/519_revoke_inherited_acl_party_seating.json` (catalog oracle output), `lib/__tests__/acl-party-seating-519.pg.test.ts` (real PostgreSQL, from both the production and the staging starting grants: exact grants, allow and deny for each role, seated-guest RSVP trigger path), `.github/workflows/ci.yml` (test required in the PG job, excluded from the plain unit run).
- **Apply:** staging, then production, each with its own Owner approval, as one whole-file statement.
- **Could break:** any code path that reads or writes these tables as `anon`, or writes `party_tables` as `service_role` outside the SECURITY DEFINER seating function. None exists on main as of 2026-11-05 (code trace and Graphify).
