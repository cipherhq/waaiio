## 2026-11-27 — Extend customer blocking to email: storage and shared check (#1166, slice 1 of 4)

- **What changed:** New migration M559 and a shared server-side check, the base for extending customer blocking (#1103) to email and website checkout (#1166 r7, Owner approval 2026-11-27).
  - M559 adds `public.customer_email_blocks`. It has one row per blocked email, stored trimmed and lower-cased, unique. Each row records the reason (3–500 characters), who blocked it, when, and optionally the canonical phone it was blocked with. There is no foreign key to `customer_suspensions`, so unblocking a phone never removes an email block. Access: RLS deny-all, service_role only.
  - M559 adds a nullable `public.bookings.email_verified_at`. A trigger (`private.bookings_email_verified_at_guard`, SECURITY INVOKER, empty `search_path`) refuses any real change to it by a database role other than service_role. Owners' other booking updates are unaffected.
  - M559 adds `public.svc_set_customer_block(...)` (SECURITY INVOKER, service_role only). It blocks or unblocks a phone and any number of emails in one transaction, with one `admin_audit_logs` row per changed item. `svc_set_customer_suspension` (M547) is unchanged. The migration ends with a self-check.
  - New `lib/customer-block.ts`, which only reads:
    - `webCheckoutBlocked` lets the request through on a read error and reports it.
    - `customerEmailSendBlocked` skips the send on a read error.
    - Logs `customer_block.refused` and `customer_block.email_skipped` without the phone or email.
  - `lookupKey` is now exported from `lib/customer-suspension.ts`, and `report-failure` gains the `customer_block` area.
- **Files:** `supabase/migrations/559_customer_email_blocks.sql`, `lib/customer-block.ts`, `lib/customer-suspension.ts`, `lib/observability/report-failure.ts`, `lib/__tests__/customer-email-blocks-559.pg.test.ts` (real PostgreSQL, applied twice), `lib/__tests__/customer-block-helper.test.ts`, `.github/workflows/ci.yml` (PG test in the security-acl-tests step, excluded from the unit run), `docs/MIGRATION_REGISTRY.md`.
- **What it affects:** Nothing at runtime yet. No route, admin page or email send calls the new check. Slices 2–4 wire it into the admin page, website checkouts and customer emails. Payments, refunds, payouts, settlement and payment confirmations do not read it.
- **What could break:** M559 must be applied before the app code of slices 2–4 is deployed. The email-send check skips on a read error, so without the table every email on the skip list would be skipped. Once M559 is applied, the Release V3 catalog check will see the new table, column, trigger and function.
