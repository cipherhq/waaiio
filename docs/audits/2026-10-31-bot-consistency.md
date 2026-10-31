# Bot consistency corrections — 2026-10-31

Base: da9020670b856fda73dd05477d82859fdd460cf7. Branch: codex/bot-onboarding-consistency.

## Implemented

- Account-menu history lookup tries canonical +phone first, then legacy digits-only phone. Staging TestBiz evidence: latest session's canonical lookup missing, legacy profile exists with booking/order history. No customer identity data is included here.
- One renderable action no longer skips the account menu for returning customers. New-customer auto-selection, forced menus, promo-only contextual entry and pagination remain intact.
- Ordering and scheduling referral prompts use the current capability guard, including plan/trial rules, without session-recovery side effects. Existing reward accounting is unchanged.
- English product menu label is Browse Products; route IDs and merchant custom labels remain unchanged. Services retain Our Services.

## Evidence and limits

Independent evidence and diff review completed; its dual-phone ambiguity concern was addressed with canonical-first fallback. Targeted executable tests cover menu navigation and referral allow/deny. No CI or deployment certification is claimed. The completed targeted regression run is recorded below. Full repository TypeScript validation reports errors; release validation remains outstanding.

TestBiz has referral enabled and loyalty disabled in persisted settings. These corrections do not silently disable referral or claim to resolve why the merchant did not see its dashboard control. Loyalty-only account discovery and other pre-existing account-history limitations are not fixed here.

## Route traces

- Returning customer, sole action: select_capability.skipIf -> shared history predicate -> false -> prompt includes cap_my_account -> validate sets active_capability=my_account -> next=my_account_menu.
- New customer, sole action: no history -> existing automatic flow entry retained.
- Referral denied: ask_referral_code.skipIf -> current capability guard denies -> existing next-step skip behavior, no referral lookup or financial write.
- Referral allowed: current guard allows -> prior-conversion lookup -> existing referral prompt/skip behavior.
- Browse Products retains cap_ordering postback and ordering flow routing.

## Remaining scope implemented in this branch

- WhatsApp connection screens expose Back to Dashboard and Use shared Waaiio number, including OTP and pending review. Confirmation explains business codes, replacement links/QR codes, and that old dedicated chats are not forwarded. Copy requests a separate business bot number without country-specific SIM-price or provider promises.
- M491 fences pending connections when shared routing is chosen successfully. The business lock serializes with promotion; a persistent cancellation timestamp survives late provider status updates. Failed allocation leaves candidates untouched. This does not undo a Meta-side request already in flight.
- New team recipients receive a verified account setup link, password entry and policy consent. Established accounts retain their credentials and sign in to accept. Unconfirmed identities from expired/failed deliveries receive recovery setup links on resend. Pending invitations can be resent with a fresh token. Acceptance requires the verified recipient email and a token/status/expiry conditional update. Invitation creation and role edits restrict assignable roles; delivery/write failures no longer return false success. Login preserves the invitation destination for staff who own no business.
- Admin/manager permission entries now match the actual /dashboard/referrals path. TestBiz's stored referral setting remains enabled; no merchant settings were silently changed.
- Selected products send primary and gallery photos, including variants, quick-add and smart-intent cart additions. Invalid URLs and duplicate URLs within each presentation are filtered. The existing upload limit is one primary plus three gallery photos. Detailed selection and cart confirmation can repeat images; this is not an all-products-at-once catalog blast.
- Table Reservations requires Pro (internal tier growth), following existing trial/admin override policy. Existing reservation management survives downgrade. The seating page gives upgrade/enable guidance when unavailable. Lounge/bar/nightclub bot copy is Book a Table / VIP; restaurants retain their table-reservation wording. Existing lounge category is supported; no new nightclub category was created.
- Merchants can select three VIP tables (or any selected resources) and block/unblock them in one business-scoped write. Blocking lasts until manually undone and preserves existing reservations. Date/event-specific blocking is not implemented by this availability control.

## Validation

Local Vitest run: **304 passed, 0 failed, 0 skipped, 11 files**. This includes executable invitation route tests (new/existing/pending identity, resend, authorization, wrong/unverified email, expiry, concurrent acceptance and write failure); rendered staff login and bulk seating tests; product gallery/quick-add/smart-intent tests; Pro policy and existing management; account menu, referral enforcement and pagination; existing reservation dashboard regressions.

Command:
```sh
npx vitest run app/api/team/__tests__/invitations.test.ts lib/__tests__/invite-login-return.test.tsx lib/__tests__/onboarding-seating-consistency.test.tsx lib/bot/flows/__tests__/product-images.test.ts lib/bot/flows/__tests__/ordering.flow.test.ts lib/__tests__/product-gallery-images.test.ts lib/__tests__/table-reservation-730.test.ts lib/__tests__/table-reservation-730-dashboard.test.tsx lib/bot/flows/__tests__/capability-menu-correctness.test.ts lib/bot/flows/__tests__/capability-enforcement.test.ts lib/bot/flows/__tests__/capability-menu-pagination.test.ts --maxWorkers=2
```

The full TypeScript run returned 516 diagnostics, predominantly existing test/mock typing; it is **not green**. The changed table-reservation test also contains an existing unrelated type-destructuring diagnostic. Targeted ESLint passed using `--no-eslintrc --config .eslintrc.json` for the changed application paths, ordering flow and auth lookup helper. The initial `next lint` invocation hit duplicate parent/worktree plugin configuration; explicit configuration resolved it. `git diff --check` passed. No CI execution is claimed. These local results do not certify Meta, email delivery, or a deployed end-to-end journey.

Independent review identified the pending-candidate, staff-login and quick-add gaps; the resulting fixes were reviewed again. No current P0/P1 severity is asserted. Findings here are code corrections, with deployed behavior unverified. The reviewer additionally identified the failed-email identity recovery case, now covered by a regression test.

## Database and release prerequisites — not completed

Read-only schema checks on 2026-10-31 confirm `products.gallery_urls` exists in staging and is absent in production. **Production must receive existing M462 before this code is deployed.** Reconcile migration history and execute the full approved migration, including its constraint and verification; do not merely mark it applied.

M491 is prepared, **not applied to either environment**. Its executable disposable-database fixture is `supabase/tests/491_shared_recovery_candidate_fence.sql`. Local PostgreSQL initialization failed because sandbox shared-memory allocation was denied, so this SQL fixture was not run. Before release, execute it and two-session cancellation/promotion lock-order checks, verify service-role allow and anon/authenticated deny, apply to staging, then test the shared fallback UI with an in-flight candidate. The new fallback behavior depends on this migration.

Staging's saved WABA configuration was previously corrected to the actual messaging account while retaining separate staging and production credentials. Staging redeploy and live dedicated-number OTP/registration remain unverified. Read-only provider checks do not prove that a new number can register. No production configuration was copied wholesale, and no production deployment or merge was performed.

Release order: resolve repository validation gates; validate/apply the necessary migrations through the approved process; deploy staging; run new/existing/resend email journeys, dedicated OTP and shared recovery, gallery paths and VIP blocking; obtain Owner release decision before production. Old WhatsApp number links/chats cannot be represented as automatically redirecting to a new number.

## Follow-up verification

See [staging validation](2026-10-31-onboarding-staging-validation.md): local M491 fixture and two-session/grant tests now pass. The base-versus-branch typecheck comparison shows all 516 diagnostics predate this change. Hosted deployment, migration and provider acceptance remain separate outstanding steps.
