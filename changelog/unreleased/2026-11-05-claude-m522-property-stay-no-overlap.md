## 2026-11-05 — M522: the database refuses two live stays on the same nights at one property (#922)

- **What changed:** new migration `supabase/migrations/522_property_stay_no_overlap.sql`. It adds the exclusion constraint `reservations_no_overlapping_stay` on `public.reservations`, keyed on `(business_id, property_id, nights)`.
  - **Which stays it covers:** within one business and property, two stays cannot share a night unless one is `cancelled`, `no_show`, `checked_out` or `completed`. The rule is a deny-list, so any other status holds its nights.
  - **Nights:** stored as `[check_in, check_out)`, so a check-out and a check-in on the same day are fine. A refused write fails with `23P01`.
  - **Not covered:** rows without `property_id`. These are 2 legacy production rows, both in the past.
  - **Nothing else changes:** no function, grant, RLS, policy or trigger change.
  - **Fails closed:** it installs nothing if `btree_gist` is missing, if live stays already overlap, or if a constraint with this name exists with a different definition. A re-run does nothing.
- **Files:**
  - the migration;
  - `supabase/catalog-deltas/522_property_stay_no_overlap.json` (catalog oracle output);
  - `lib/__tests__/property-stay-no-overlap-522.pg.test.ts`, on real PostgreSQL: parallel claims (exactly one wins), every status label, business isolation, finished-to-live status changes, idempotent, fail-closed cases, and ACL/RLS/policies/triggers unchanged;
  - `.github/workflows/ci.yml` (test required in the PG job, excluded from the plain unit run);
  - `docs/MIGRATION_REGISTRY.md` (M522 reserved).
- **Read-only check on 2026-11-05:** production and staging have 0 overlapping live stays under this key.
- **Unchanged:** app code. The bot change that answers a refusal with **Choose New Dates** ships separately (#922, PR 2) and works with or without M522. The unused M383 `create_reservation_atomic` is unchanged; its DB suite passes with M522 applied.
- **Apply:** staging, then production, each with its own Owner approval, as one whole-file statement.
- **Could break:** a dashboard or check-in status change that turns a cancelled, no-show or checked-out stay back into a live one over nights another stay holds is now refused. The dashboard does not show that error today. Any future code that creates overlapping stays gets `23P01`.
