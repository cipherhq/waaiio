## 2026-11-05 — Migration 517: table for scheduled form sends (#591, PR B)

**What changed**
- New table `public.form_sends` (`supabase/migrations/517_form_sends.sql`). It holds one row per form send: business, form, who created it, optional template, recipients (1–500), status (`scheduled` / `sending` / `sent` / `failed` / `cancelled`), schedule time, counts, per-recipient results and an error message.
- A new unique index `forms (id, business_id)` lets `form_sends` reference the form and its business in one foreign key. The database therefore refuses a send that pairs one business with another business's form. Deleting a form deletes its sends.
- RLS is on with one policy: owners can read their own sends.
  - `anon`: no privileges.
  - `authenticated`: SELECT only.
  - `service_role`: read and write.
  - Supabase's default "ALL" grants are revoked explicitly.
- A self-check fails the migration if RLS, the policy set, the grants or the tenant foreign key drift.
- Proved on real PostgreSQL (`lib/__tests__/form-sends-517.pg.test.ts`, run by CI's `.pg.test.ts` job). The fixture uses production's default privileges.
- Registry row added in `docs/MIGRATION_REGISTRY.md`. CI wiring is in `.github/workflows/ci.yml`. The catalog delta is in `supabase/catalog-deltas/517_form_sends.json`.

**What it affects:** nothing at runtime yet. The scheduled-sending app (PR C) uses this table, and it ships only after M517 is applied to staging and then production, each with Owner approval.

**What could break:** none for the live app, which doesn't read the table. Building the new index on `forms` takes a brief lock; production has a handful of forms.
