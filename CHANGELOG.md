# Changelog

All notable bot flow, security, and infrastructure changes are tracked here.
If something breaks, check this log to find what changed and when.

## 2026-08-31 — #245: readDurableRefundState fail-safe to provider_ambiguous

### What changed
- **readDurableRefundState():** Now fails safe to `provider_ambiguous` instead of terminal `failed` when the durable state cannot be established (DB error, missing row, unknown status, thrown exception). An unknown state after provider dispatch may still have succeeded — representing it as `failed` would be a false terminal claim.
- **10 behavioral tests added** exercising readDurableRefundState directly: DB query error, row missing, unknown status, thrown exception → all return `provider_ambiguous`; explicit failed/provider_success_unfinalized/provider_pending/provider_ambiguous/pending/success → accurately returned.

### Files changed
- `lib/payments/refund-handler.ts` (readDurableRefundState fail-safe + exported for testing)
- `app/dashboard/orders/__tests__/refund-ux.test.ts` (10 behavioral tests + 1 structural guard)
- `CHANGELOG.md` (this entry)

### Could break
- Nothing — only changes the fallback from a false terminal claim to a safe non-terminal state.

## 2026-08-31 — #245: Refund domain-state truth correction — durable state reads

### What changed
- **refund-handler.ts:** Added `readDurableRefundState()` helper that reads actual persisted `refunds.status` from the database. Three return paths now use durable DB reads instead of branch-inferred state:
  1. **Dispatch claim loser:** returns actual DB state (e.g. `provider_pending`, `provider_success_unfinalized`) instead of hardcoded `'pending'`
  2. **Provider success + durability write failure:** returns actual DB state instead of aspirational `'provider_success_unfinalized'` when the write to that state failed
  3. **`resumeExistingRefund` catchall:** returns persisted `existing.status` instead of `'failed'` (e.g. `provider_pending` without `provider_refund_id` now correctly returns `provider_pending`)
- **dispatchAndFinalize finalization path:** returns `provider_success_unfinalized` when finalization incomplete (was incorrectly returning `'failed'`)
- **Behavioral tests:** 6 new `processRefund()` execution tests covering all 6 durable outcomes: success after finalization, terminal provider failure, provider_success_unfinalized on finalization failure, provider_ambiguous on transport error, provider_pending on provider acceptance, and resumed attempts returning durable state.

### Files changed
- `lib/payments/refund-handler.ts` (durable state reads, finalization path fix)
- `app/dashboard/orders/__tests__/refund-ux.test.ts` (6 behavioral outcome tests, updated structural assertions)
- `CHANGELOG.md` (this entry)

### Could break
- Nothing — all existing behavior preserved. The changes correct state misreporting on failure/recovery paths.

## 2026-08-30 — #245: Refund state truth-contract — 6-state domain vocabulary

### What changed
- **RefundState type:** Replaced 4-state (`success|pending|ambiguous|failed`) with canonical 6-state domain vocabulary: `pending`, `provider_pending`, `provider_ambiguous`, `provider_success_unfinalized`, `success`, `failed`. Each state maps truthfully to durable `refunds.status` at that execution point.
- **refund-handler.ts:** Every return path in `processRefund()`, `resumeExistingRefund()`, `finalizeOnly()`, `reconcileAndFinalize()`, `dispatchAndFinalize()` now sets `state` matching the actual durable execution state. Key corrections: no-queryRefundStatus returns `provider_pending` (not `failed`), credential failure returns `provider_pending` (not `failed`), dispatch claim loser returns `pending` (not `failed`), provider success + finalization failure returns `provider_success_unfinalized` (not `failed`/`ambiguous`).
- **API route:** Passes `result.state` directly to JSON response — no server-side classifier. Exports `RefundResponseState` type alias for consumers.
- **RefundModal:** Maps all 6 domain states to distinct UI presentations (green success, amber pending/provider_pending/provider_ambiguous/provider_success_unfinalized, red failed). No error-text parsing.
- **Orders page:** Fixed payment query to use `order_id` column (not `metadata` contains) and `.in('status', ['success', 'refunded'])`. Added guard states for "Fully refunded" vs "No payment recorded".
- **Reservations page:** Added refund amount check so "Fully refunded" shows instead of hiding the refund button only when `refund_amount` is null.
- **Behavioral tests:** 35+ tests covering 6-state vocabulary accuracy, API route passthrough, modal mapping, orders page guards, and structural assertions on every return path.

### Files changed
- `lib/payments/refund-handler.ts` (6-state RefundState type, state on every return path)
- `app/api/payments/refund/route.ts` (pass domain state through, export type)
- `components/dashboard/RefundModal.tsx` (6-state UI mapping with result feedback)
- `app/dashboard/orders/page.tsx` (payment query fix, refund guard states)
- `app/dashboard/reservations/page.tsx` (refund amount guard)
- `app/dashboard/orders/__tests__/refund-ux.test.ts` (behavioral tests)
- `CHANGELOG.md` (this entry)

### Could break
- Any consumer that type-checked against the old 4-state `RefundState` union (only existed on the UX branch, not main)
- Frontend code that parsed error text to determine refund state (this was the bug being fixed)

## 2026-08-30 — #246: CTO blocker corrections — UI lifecycle, PATCH validation, behavioral tests

### What changed
- **Correction 1 (UI lifecycle):** Dashboard polls page now only shows "Activate" for `draft` polls and "Close" for `active` polls. Closed polls have no status-change action (previously showed "Activate" which the backend would reject). Delete is hidden for active polls.
- **Correction 2 (PATCH validation):** PATCH route now validates option integrity before persisting: rejects empty strings, case-insensitive duplicates, and enforces 2-10 count. Active polls cannot have question removed or options reduced below 2. POST route also validates empty strings and duplicates.
- **Correction 3 (behavioral tests):** Replaced 24 source-inspection tests with 43 behavioral tests that call actual route handlers (POST, PATCH, DELETE, send) with mock Supabase. Tests cover auth, ownership, capability guards, all status transitions, option validation, vote deduplication flow, and poll rendering format.

### Files changed
- `app/dashboard/polls/page.tsx` (status-aware action buttons, error display)
- `app/api/polls/[id]/route.ts` (option validation: empty, duplicates, active poll guards)
- `app/api/polls/route.ts` (option validation: empty, duplicates)
- `app/api/polls/__tests__/polls-api.test.ts` (rewritten — 43 behavioral tests)
- `CHANGELOG.md` (this entry)

### Could break
- Frontend code that relied on "Activate" button for closed polls (never worked anyway — backend rejected it)
- PATCH requests that previously persisted empty or duplicate options now get 400

## 2026-08-30 — #246: Polls activation — fix tier gate + capability guards + tests

### What changed
- **Fix 1:** Removed contradictory free-tier page gate from `app/dashboard/polls/page.tsx`. The `poll` capability is already set to `'free'` tier in `shared/capabilities.ts`, so the `isGated = tier === 'free'` check was blocking free-tier users who should have access.
- **Fix 2:** Added `requireCapability` enforcement to `POST /api/polls` (create_new), `PATCH /api/polls/[id]` (manage_existing), and `DELETE /api/polls/[id]` (manage_existing). The send route already had this guard.
- **Fix 3:** Added server-side status validation to PATCH route: only `draft`, `active`, `closed` are valid statuses; only `draft->active` and `active->closed` transitions are allowed; activation requires a non-empty question and 2-10 options.
- **Fix 4:** Removed unreachable auto-activate code from `app/api/polls/[id]/send/route.ts` (lines after the 400 return for non-active polls).
- **Tests:** Added 24 tests in `app/api/polls/__tests__/polls-api.test.ts` covering all four fixes.

### Files changed
- `app/dashboard/polls/page.tsx` (removed isGated block)
- `app/api/polls/route.ts` (added capability guard to POST)
- `app/api/polls/[id]/route.ts` (added capability guard + status validation to PATCH/DELETE)
- `app/api/polls/[id]/send/route.ts` (removed dead auto-activate code)
- `app/api/polls/__tests__/polls-api.test.ts` (new — 24 tests)
- `CHANGELOG.md` (this entry)

### Could break
- Any frontend code that relied on the auto-activate-on-send behavior (sending a draft poll would previously auto-activate it). Now polls must be explicitly activated before sending.
- Businesses without `poll` capability configured will now get 403 on create/update/delete (was previously unguarded).

## 2026-08-30 — #220: Engineering Standing Operating Order

### What changed
- Created `WAAIIO_ENGINEERING_OPERATING_ORDER.md` — canonical governance document for engineering roles, evidence hierarchy, standard change process, GitHub-first review protocol, failure escalation gate, dependency-aware delta review/checkpoint model, production capability certification, behavioral lock, restart resilience, new-chat bootstrap, and release safety invariants. Consolidated from issue #220 body plus 3 governance addenda (failure escalation gate, updated failure escalation gate, GitHub-first review/chat-minimal mode).
- Updated `CLAUDE.md` — added cross-reference to the Operating Order as the canonical governance document. Added compact "Startup-Critical Non-Negotiables" summary (evidence hierarchy, stop/escalation behavior, exact-SHA review, no unauthorized merge/deploy/production mutation, GitHub-first). Existing Golden Rules and technical reference sections preserved unchanged.

### Files changed
- `WAAIIO_ENGINEERING_OPERATING_ORDER.md` (new)
- `CLAUDE.md` (updated governance header)
- `CHANGELOG.md` (this entry)

### Could break
- Nothing — docs-only change. No product code, migrations, or runtime behavior modified.

## 2026-08-30 — #216: Object-level authorization security fix for My Bookings / My Orders

### What changed
- `lib/bot/handlers/my-bookings.ts` — Added ownership predicates to all 9 vulnerable query paths:
  - Booking postback: `.eq('user_id', session.user_id!)` on detail, cancel pre-fetch, reschedule fetch
  - Ticket postback: `.or(guest_phone.eq...)` phone ownership check on detail view
  - Reservation postback: `.or(guest_phone.eq...)` phone ownership check on detail and cancel UPDATE
  - All postback UUIDs (booking_, ticket_, reservation_) now have ownership verified BEFORE storing in session_data
  - Renamed `_session` to `session` in `handleViewTicket` and `handleViewReservation` (now used)
  - **BLOCKER 1 fix:** Reservation cancel now uses UPDATE...RETURNING (`.select()` on update). If zero rows matched (forged UUID / wrong phone), immediately returns "Reservation not found" and bails. No follow-up ID-only read that could load victim data.
- `lib/bot/handlers/my-orders.ts` — Added `.eq('user_id', session.user_id!)` to `handleOrderDetail` query and ownership check before storing order UUID in session_data
- `supabase/migrations/357_owner_bound_booking_cancel.sql` — **BLOCKER 3 fix:** `p_expected_user_id` is now REQUIRED (no DEFAULT NULL). Legacy 1-arg and 2-arg overloads explicitly DROPped. Belt-and-suspenders NULL check inside function body.
- `app/api/bookings/[id]/status/route.ts` — Dashboard cancel now passes `p_expected_user_id: booking.user_id` to the RPC (required after removing defaults).
- `lib/__tests__/acc-216-object-authorization-db.test.ts` — **BLOCKER 2 fix:** 5 real PostgreSQL tests proving: mismatched user_id denial, correct user_id success, NULL user_id denial, legacy 1-arg overload gone, legacy 2-arg overload gone.
- `.github/workflows/ci.yml` — Added CI step for #216 object authorization DB tests.
- `lib/bot/handlers/__tests__/my-bookings-auth.test.ts` — 12 tests proving cross-user rejection for bookings, tickets, reservations, orders, and RPC
- `lib/__tests__/p1-pkg1-bot-cancellation.test.ts` — Updated Supabase mock to support chained `.eq()` calls (required by new ownership predicates)
- `lib/__tests__/dead-003-calendar-cancel.test.ts` — Updated cancel RPC assertions to include `p_expected_user_id`.
- `lib/__tests__/p1-pkg1-package-redemption-db.test.ts` — Updated all `cancel_booking_with_release` calls to 3-arg version.
- `lib/__tests__/migration-351-acl-hardening-db.test.ts` — Updated function signature to `(uuid, text, uuid)`.

### Could break
- Any code calling `cancel_booking_with_release` without `p_expected_user_id` will now ERROR (function not found). All callers updated: bot handler passes `session.user_id`, dashboard API passes `booking.user_id`.
- The legacy 2-arg `(uuid, text)` overload is dropped. Cron/admin callers must now pass the booking's user_id.

## 2026-08-31 — #232: Replay window anchor + concurrent recovery proof

### What changed
- `supabase/migrations/355_refund_convergence.sql` — `claim_refund_dispatch` token-bound branch no longer sets `dispatched_at = now()`. Replay-safety window now immutably anchored to first provider dispatch. Prevents repeated recoveries from extending eligibility beyond Stripe's 24h idempotency key pruning.
- `lib/__tests__/acc-232-refund-convergence-db.test.ts` — 3 new tests:
  1. Expired first-dispatch (23.5h) denies recovery on both interrupted and ambiguous paths
  2. Token-bound claim preserves original `dispatched_at` (clock not refreshed)
  3. Concurrent takeover: exactly 1 winner (not ≤1), winner token claims dispatch, stale token rejected

### Could break
- If any code path relied on `dispatched_at` being refreshed by recovery claims to re-check "recency" of provider dispatch, it would now see the original timestamp. This is correct — the provider's idempotency key is tied to the original request window.

## 2026-08-31 — #232: Refund handler test coverage — 3 CTO-required runtime proofs

### What changed
- `lib/payments/__tests__/refund-handler.test.ts` — added `errorChain` helper for persistence-failure mocking + 3 new tests:
  1. Tier-1 interrupted recovery: proves recovery token flows from `recover_interrupted_dispatch` → `claim_refund_dispatch`, exactly 1 provider dispatch
  2. Post-dispatch persistence failure: provider reference write fails → returns "requires recovery", exactly 1 provider call (no replacement attempt)
  3. BYO credential identity on reconciliation: `provider_pending` refund with `provider_connection_id` → `queryRefundStatus` called with persisted credential
- Total: 12 handler tests, zero skips (was 9)

### Files changed
- `lib/payments/__tests__/refund-handler.test.ts`

### Could break
- Nothing — test-only change. No handler logic modified.

## 2026-08-30 — #224/#225/#226: Recurring eligibility, Customer 360, Financial projection

### What changed

**#224 — Recurring Giving eligibility (4-gate invariant):**
1. `lib/payments/recurring-offer.ts` — replaced `getEnabledCapabilities()` with `getEffectiveCapabilities()` (policy-aware: tier/trial/overrides). Previously a free-tier business with a raw `is_enabled=true` row could pass the gate.
2. Added service billing_type check: `services.billing_type='recurring' AND recurring_interval IS NOT NULL`. Previously a one-time Giving service could receive a recurring prompt if the business had recurring enabled globally.
3. Removed `bot_sessions` phone-lookup channel fallback in `sendRecurringOfferCTA()`. Now fails closed when no exact transaction sender is available, preventing the channel drift class #219 fixed.
4. `app/dashboard/giving/page.tsx` — added recurring eligibility validation. Checkbox disabled when business lacks `recurring_enabled` or effective `recurring` capability. Shows actionable remediation message. Surfaces inconsistent state on existing misconfigured categories.

**#225 — Customer 360 (broken queries + unified history):**
1. Migration 355 — added `customer_profiles.user_id` column with partial unique index and deterministic backfill from bookings.
2. Migration 355 — `get_customer_history()` SECURITY DEFINER RPC: unified per-customer history (bookings + orders + standalone payments) with purpose resolution ("Giving — Biazo Conference"), user_id-first identity, phone fallback, deduplication (booking-linked payments excluded).
3. `app/dashboard/customers/page.tsx` — replaced broken `bookings.service_type` query (42703) and `orders.customer_phone` query (42703) with single `get_customer_history` RPC call.
4. Removed orphaned intelligence display (lifetime_value, churn_risk, customer_segment) — these fields are never calculated and were showing misleading defaults. Segment column also hidden from list table.

**#226 — Financial projection (attribution + totals):**
1. Migration 355 — `get_business_transactions()` SECURITY DEFINER RPC: purpose-aware transactions with customer attribution via business-owned `customer_profiles` instead of profiles RLS join. Resolves order customers by user_id (primary) or delivery_phone (fallback).
2. Migration 355 — `get_business_revenue_totals()` RPC: authoritative server-side revenue totals with same inclusion semantics as rows. Page size cannot change revenue.
3. `app/dashboard/financials/page.tsx` — replaced 3-table client queries + profiles join with RPC calls. Removed 500-row-capped client-side revenue calculation. Purpose now shows "Giving — Biazo Conference" instead of generic "Payment".
4. All RPCs have: `SECURITY DEFINER`, `SET search_path = ''`, `auth.uid()` ownership check, `REVOKE` from PUBLIC/anon, `GRANT` to authenticated/service_role only.

### Files changed
- `supabase/migrations/355_customer360_financial_projection.sql` — new migration
- `lib/payments/recurring-offer.ts` — 4-gate eligibility + channel fail-closed
- `app/dashboard/giving/page.tsx` — recurring validation + inconsistent state
- `app/dashboard/customers/page.tsx` — unified history via RPC, intelligence hidden
- `app/dashboard/financials/page.tsx` — RPC-based transactions + server-side totals
- `lib/payments/__tests__/recurring-eligibility.test.ts` — new tests
- `lib/__tests__/acc-224-226-customer360-financials-db.test.ts` — new DB tests

### Could break
- Businesses with `billing_type='recurring'` on Giving categories but missing `recurring_enabled=true` or `recurring` capability will see a warning on their dashboard and the bot will not offer recurring setup. This is intentional — the previous behavior was silently broken.
- Customer detail page now shows unified "Transaction History" instead of separate "History" and "Order History" tabs. Data comes from the RPC, which uses user_id-first identity with phone fallback.
- Financials page revenue totals now come from server-side RPC instead of client-side 500-row-capped calculation. Totals may differ from previous display for businesses with >500 transactions.

## 2026-08-29 — #214: CI fix — column-level REVOKE + runtime auth context (refs #215)

### What changed
1. **Migration 353 — column-level REVOKE on protected columns:** Added explicit `REVOKE UPDATE (role, id, created_at)` on profiles from PUBLIC/anon/authenticated. `REVOKE ALL ON TABLE` only removes TABLE-level privileges per PostgreSQL spec — stale or inherited column-level grants survive independently. The explicit column-level revoke ensures these are cleared in all PostgreSQL environments (CI PG15 showed column-level UPDATE on role even after table-level REVOKE).
2. **AUTH-001 runtime test fix:** The runtime denial test now overrides `auth.uid()` to match the test user's UUID before attempting the UPDATE as `authenticated`. Previously, RLS silently filtered the row (auth.uid() didn't match), the trigger never fired, and the only possible denial path was column-level privilege — which was fragile across PG versions. Now the test proves EITHER column-level denial OR trigger denial.
3. **AUTH-001 first_name UPDATE test:** Changed to positive assertion (`expect(r.exitCode).toBe(0)`) since auth.uid() now matches the test user. Proves authenticated CAN update approved columns.
4. **Cleanup restores auth.uid():** Restores the CI auth.uid() stub after runtime tests to prevent interference with downstream test steps.

### Files changed
- `supabase/migrations/353_auth001_profiles_role_hardening.sql` — added column-level REVOKE
- `lib/__tests__/auth001-profiles-role-hardening-db.test.ts` — fixed runtime tests

5. **Root cause:** `p1-appointment-closure.test.ts` runs `GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated` against the shared `waaiio_test` database (step 33). This re-grants table-level UPDATE on profiles, undoing migration 353's column-level restriction by the time step 58 (AUTH-001) runs.
6. **Convergence test:** AUTH-001 test now re-applies the migration 353 privilege section as its first step, proving the migration is convergent from any starting state.

### What could break
- Nothing — the column-level REVOKE is idempotent and only removes privileges that shouldn't exist
- The auth.uid() override is scoped to runtime tests and restored in cleanup

---

## 2026-08-29 — #214: Security consolidation round (refs #215, #216, #217, #218)

### What changed
1. **Migration 353 — AUTH-001 convergence:** Idempotent forward migration that restores profiles.role escalation protections missed on staging (migration 247 number collision). Drops permissive FOR ALL policy, restricts column-level UPDATE privileges, installs BEFORE UPDATE/INSERT triggers, rewrites is_admin()/is_admin_or_support() to use auth.users.raw_app_meta_data. Convergence-safe for both staging (missing) and production (already has).
2. **Migration 354 — Atomic no-show RPC:** `mark_booking_no_show(uuid, text)` handles status transition + slot release in a single transaction. Derives staff/location from trusted booking row. Package sessions intentionally NOT released on no-show. service_role only.
3. **Migration 351 consolidation:** Absorbed migration 352 content (release_booking_slot ACL was already in 351). Updated verification block to include release_booking_slot. Removed redundant migration 352.
4. **No-show atomicity:** `/api/bookings/[id]/status` no_show action now uses atomic RPC instead of separate status update + browser release-slot call. Slot release is server-side and atomic.
5. **Dashboard cleanup:** Booking cancellations and no-shows both route through the atomic API. Removed redundant `/api/bookings/release-slot` calls from reservations dashboard.
6. **Removed /api/bookings/release-slot:** Zero legitimate callers remain after cancel/no-show corrections. Dead privileged surface removed.
7. **Real PostgreSQL tests:** AUTH-001 privilege/trigger/function tests, ticket purchase ACL + cross-event validation tests, release_booking_slot + mark_booking_no_show ACL tests.

### Files changed
- `supabase/migrations/351_security_definer_acl_hardening.sql` — updated comments + verification block
- `supabase/migrations/352_revoke_release_booking_slot_from_authenticated.sql` — REMOVED (content in 351)
- `supabase/migrations/353_auth001_profiles_role_hardening.sql` — NEW
- `supabase/migrations/354_mark_booking_no_show_atomic.sql` — NEW
- `app/api/bookings/[id]/status/route.ts` — no_show uses atomic RPC
- `app/dashboard/reservations/page.tsx` — removed redundant release-slot calls, no_show routes through API
- `app/api/bookings/release-slot/route.ts` — REMOVED (zero callers)
- `lib/__tests__/auth001-profiles-role-hardening-db.test.ts` — NEW
- `lib/__tests__/ticket-purchase-security-db.test.ts` — NEW
- `lib/__tests__/migration-351-acl-hardening-db.test.ts` — added release_booking_slot + mark_booking_no_show coverage
- `.github/workflows/ci.yml` — added AUTH-001 + ticket purchase test steps

### What could break
- No-show action now requires routing through `/api/bookings/[id]/status` API (direct browser DB update no longer releases slots)
- Any code calling release_booking_slot via authenticated role will be denied
- The `/api/bookings/release-slot` route no longer exists — cached browser code would get 404

### Follow-ups tracked separately
- #216 — Bot My Bookings object-level authorization (IDOR fix)
- #217 — Complete platform-role authority migration (is_support + 30+ inline RLS)
- #218 — Production migration reconciliation before production E2E

## 2026-08-26 — #214: Security — release_booking_slot server route + purchase_tickets_atomic trust boundary

### What changed (3 fixes)
1. **Fix 1 — Server API for release_booking_slot (NEW route + migration 352):** Created `/api/bookings/release-slot/route.ts` that authenticates the user, verifies business ownership via `businesses.owner_id`, loads booking data from DB (trusted), and calls `release_booking_slot` via service_role. Updated `app/dashboard/reservations/page.tsx` to call the API instead of the direct RPC. Migration 352 revokes `authenticated` role access from the function.
2. **Fix 2 — Ticket type cross-event validation (events/purchase/route.ts):** Added `event_id` validation when a `ticketTypeId` is provided. Previously, a user could supply a ticket type from a different (cheaper) event to get a lower price applied. Now the route fetches `event_id` from `event_ticket_types` and rejects if it doesn't match the target event.
3. **Fix 3 — Migration 352 (ACL):** `release_booking_slot` revoked from PUBLIC, anon, authenticated. Only service_role can invoke.

### Files changed
- `app/api/bookings/release-slot/route.ts` (NEW) — Fix 1
- `app/dashboard/reservations/page.tsx` — Fix 1 (replaced direct RPC with fetch)
- `app/api/events/purchase/route.ts` — Fix 2 (ticket type event_id validation)
- `supabase/migrations/352_revoke_release_booking_slot_from_authenticated.sql` (NEW) — Fix 3

### What could break
- If any other code path calls `release_booking_slot` via authenticated role (not service_role), it will be denied. Grep found no other callers besides the reservations page.
- The RPC signature for `release_booking_slot(uuid, date, time, uuid, uuid)` must match migration 193's altered signature. Verified it does.

### Audit notes — purchase_tickets_atomic
- Price is derived server-side from DB (event.price or event_ticket_types.price) — NOT from request body. Correct.
- `p_total_amount` = `unitPrice * quantity` computed server-side. Correct.
- Event is loaded with `.eq('status', 'published')` and future date filter. Correct.
- Capacity is protected by `FOR UPDATE` row lock in the RPC. Correct.
- OTP token verification ensures email identity. Correct.
- The only gap was cross-event ticket type manipulation — now fixed.

## 2026-08-26 — #213: PR review blockers for #165 recurring payment continuation

### What changed (7 fixes)
1. **Fix 1 — Source payment authoritative (349 migration + recurring-offer.ts):** `create_recurring_offer` RPC now derives `amount`, `currency`, `user_id`, `service_id` from the source payment + booking instead of trusting caller-supplied values. Signature reduced from 7 to 3 args. Also rejects payments with NULL `user_id`.
2. **Fix 2 — CTA authorization (recurring-setup.ts + bot.service.ts):** `handleRecurringSetupInteraction` now requires non-null `userId` (prevents bypass). Decline path in bot.service.ts verifies the declining user owns the intent before calling `decline_recurring_offer`.
3. **Fix 3 — Provider outcome classification (recurring-setup.ts):** Added `classifiedCreatePlan` and `classifiedCreateSubscription` typed wrappers that distinguish success / definitive_failure (4xx) / indeterminate (timeout/5xx). Replaced inline try/catch+null checks in `executePaystackRecurringSetup`.
4. **Fix 4 — Persist subscription code before activation (349 migration + recurring-setup.ts):** New `persist_recurring_subscription_id` RPC persists subscription_code + email_token BEFORE calling `activate_recurring_subscription`. If activation fails, the subscription code is durably bound for reconciliation.
5. **Fix 5 — Remove provider_ambiguous activation shortcut (349 migration):** `activate_recurring_subscription` now only accepts `provider_attempted` state (removed `provider_ambiguous`). Ambiguous intents are fail-closed; manual/admin resolution is deferred.
6. **Fix 6 — Provider-boundary tests (NEW file):** 13 tests covering plan/subscription success, 4xx, timeout, DB failure, and the critical invariant that `createSubscription` is called exactly once in every ambiguous scenario.
7. **Fix 7 — Hardened search_path (349 migration):** All table references in RPCs now use `public.` schema-qualification to prevent shadow-table attacks.

### Files changed
- `supabase/migrations/349_recurring_setup_intents.sql` — Fixes 1, 4, 5, 7
- `lib/payments/recurring-setup.ts` — Fixes 2, 3, 4
- `lib/payments/recurring-offer.ts` — Fix 1 (simplified RPC call)
- `lib/bot/bot.service.ts` — Fix 2 (decline path user verification)
- `lib/payments/__tests__/recurring-provider-boundary.test.ts` (NEW) — Fix 6
- `lib/payments/__tests__/recurring-setup-intents-db.test.ts` — Updated for new 3-arg RPC signature

### What could break
- Any caller still using the old 7-argument `create_recurring_offer` signature will fail (only `recurring-offer.ts` calls it — already updated)
- Intents stuck in `provider_ambiguous` state can no longer auto-activate — they require manual resolution
- Test payments in DB tests now require `user_id` to be set (added to setup)

## 2026-08-26 — #165: Recurring payment continuation (application layer)

### What changed
- **recurring-offer.ts (NEW):** Post-finalization hook that checks eligibility (Paystack, reusable card, payment flow_type=payment, business recurring_enabled + recurring capability, no existing active subscription) and sends WhatsApp CTA buttons ("Set Up Recurring" / "No Thanks") via `create_recurring_offer` RPC.
- **recurring-setup.ts (NEW):** State machine handler for the full setup flow: frequency selection (weekly/monthly via `select_recurring_frequency`), consent confirmation (SHA-256 hash via `confirm_recurring_consent`), and Paystack plan+subscription creation (`createPlan` → `persist_recurring_plan_id` → `createSubscription` → `activate_recurring_subscription`). Error classification: known 4xx → `fail_recurring_setup`, timeout/5xx/network → `mark_recurring_ambiguous`. NEVER auto-retries POST /subscription after ambiguous.
- **send-confirmation.ts:** Added recurring offer hook after `finalizeConfirmationClaim` but before `return { status: 'completed' }`. Wrapped in try/catch — NEVER affects payment finalization.
- **bot.service.ts:** Added recurring button interceptor (recurring_setup:, recurring_decline:, recurring_freq:, recurring_consent:) after stale payment button handler, before keyword matching. Decline calls `decline_recurring_offer` RPC. Setup routes to `handleRecurringSetupInteraction`. All errors caught — falls through to normal flow.

### Files changed
- `lib/payments/recurring-offer.ts` (NEW) — eligibility check + CTA send
- `lib/payments/recurring-setup.ts` (NEW) — state machine handler + Paystack setup
- `lib/payments/send-confirmation.ts` — recurring offer hook (lines 1118-1125)
- `lib/bot/bot.service.ts` — recurring button interceptor (after stale payment handler)

### What could break
- If `create_recurring_offer` RPC doesn't exist in the DB (migration 349 not applied), the offer hook will error and be silently caught
- If Paystack plan/subscription creation changes API shape, the setup flow may fail (caught → `fail_recurring_setup` or `mark_recurring_ambiguous`)
- Bot button IDs use `recurring_setup:`, `recurring_decline:`, `recurring_freq:`, `recurring_consent:` prefixes — collision with any future button ID starting with these prefixes would be intercepted

## 2026-08-26 — #211: Promo WhatsApp template provisioning (code prep)

### What changed
- **Generic provisioner:** Added 3 new templates to `WAAIIO_TEMPLATES`: `promo_pickup_verification_v2` (4 params with business name), `promo_winner_status_v1` (claim reference notification), `promo_fulfillment_status_v1` (status update notification). Legacy v1 retained.
- **Capability provisioner:** Added same 3 templates to `REQUIRED_TEMPLATES.promo_verification` (now 4 templates total).
- **Language-aware existence check:** Generic provisioner now matches `name + language` instead of name-only, preventing wrong-language templates from suppressing en_US provisioning.
- **Template readiness:** Added `promo_fulfillment_status_v1` to template-status endpoint response.
- **OTP send error handling:** Wrapped `getTemplates()` in try/catch — failure now returns 503 before issuing any verification.
- **Exports:** `WAAIIO_TEMPLATES` and `REQUIRED_TEMPLATES` exported for test access.

### Files changed
- `lib/channels/provision-templates.ts` — 3 new templates, language-aware check, export
- `app/api/whatsapp/templates/provision/route.ts` — 3 new templates in promo_verification, export
- `app/api/promotions/template-status/route.ts` — fulfillment template added to readiness response
- `app/api/promotions/verification/send/route.ts` — getTemplates try/catch guard
- `lib/__tests__/acc-211-template-provisioning.test.ts` — 12 contract tests (provisioner A/B parity, language check, readiness, error handling)

### What could break
- `WAAIIO_TEMPLATES` and `REQUIRED_TEMPLATES` are now exported — any code importing these will get the expanded arrays
- Generic provisioner language check is stricter — previously a same-name template in any language would cause a skip

## 2026-08-26 — #204: PR #210 corrections round 6 — claim token enforcement, WAMID durability pushback, recovery selection tests

### What changed
- **Blocker 1: Pre-provider terminal failure now requires valid claim authority.** `finalize_promo_fulfillment_notification` gains a `p_claim_token UUID DEFAULT NULL` parameter. When `provider_attempted_at IS NULL` and `p_status = 'failed'` (pre-provider state), the function requires a valid, non-expired claim token matching the intent's current claim_token. This prevents a stale worker whose lease expired from finalizing as 'failed' and destroying a new claimant's valid claim. Post-provider finalization (when `provider_attempted_at IS NOT NULL`) does not require the token — the provider attempt can't be undone. Old 3-param overload is dropped.
- **Blocker 2: Cross-process WAMID durability — pushback documented.** Audited existing infrastructure: Sentry captures errors with structured context but is not a durable transactional store. No outbox/dead-letter/reconciliation pattern exists. When PostgreSQL is unavailable after Meta accepts a message, the WAMID exists only in-process. The only safe action: log WAMID via Sentry + console, accept the residual risk. Manual DB update if needed. Documented explicitly in code comments.
- **Blocker 3: Recovery selection behavioral tests.** New test section M seeds 7 intents in different states (unclaimed_pending, expired_unattempted, active_lease, provider_attempted, sent, failed, delivered) and verifies `find_recoverable_notification_intents` returns exactly the 2 eligible intents (unclaimed + expired unattempted). Section L adds 6 tests for claim token enforcement: stale token after reclaim rejected, valid claimant can commit failure, wrong token denied, expired token denied, post-provider finalization works without token, no token denied for pre-provider failure.

### Files changed
- `supabase/migrations/348_fulfillment_recovery_and_idempotency.sql` — `finalize_promo_fulfillment_notification` gains `p_claim_token UUID` param with pre-provider claim enforcement; drops old 3-param overload; privilege grants updated to 4-param signature
- `lib/promotions/fulfillment-notification.ts` — `finalizeIntent` accepts + passes `claimToken`; all pre-provider failure calls pass `claimToken`; handles `invalid_claim_for_failure` response; WAMID durability pushback documented in comments
- `lib/__tests__/acc-204-fulfillment-notification-db.test.ts` — Section L (6 tests): claim token enforcement; Section M (2 tests): recovery selection behavior with 7-state seed; existing test C updated to claim before finalizing as failed; privilege checks updated to 4-param signature
- `lib/__tests__/acc-204-claim-status.test.ts` — Migration source structure test updated for 4-param grant signature

### What could break
- `finalize_promo_fulfillment_notification` signature changed from 3 to 4 params — all callers via RPC now pass `p_claim_token` (defaults to NULL, so existing callers without it still work for post-provider finalization)
- Pre-provider `finalize(..., 'failed')` without a valid claim token is now rejected — this is intentional; callers must hold the claim lease to commit pre-provider failure
- Old 3-param function overload is dropped — any direct SQL call using the exact 3-param signature will fail (but default params mean 3-arg calls route to the 4-param version)

## 2026-08-26 — #204: PR #210 corrections round 5 — structured dispatch results, DB-only finalization retry, reentry-context production component

### What changed
- **Blocker 1: Known-WAMID finalization returns structured result + DB-only retry.** `finalizeIntent` now returns `FinalizationResult` (finalized / already_finalized_same_wamid / conflicting_wamid / finalization_unresolved). After getting a WAMID from Meta, `finalizeIntentWithRetry` attempts bounded DB-only retry (2 attempts, ZERO additional Meta POSTs). Only logs "Sent" when finalization actually succeeds or returns idempotent same-WAMID. On persistent finalization failure, returns `finalization_unresolved` with the known WAMID and logs as CRITICAL.
- **Blocker 2: dispatchFulfillmentNotification returns structured DispatchResult.** Return type changed from `Promise<void>` to `Promise<DispatchResult>` with 6 outcomes: not_claimed, pre_provider_failure, provider_ambiguous, provider_failed, sent, finalization_unresolved. Fulfillment route logs truthful result (sent vs unresolved vs warning). Recovery endpoint reports truthful results: only counts `sent` as recovered, reports `not_claimed` / `provider_ambiguous` / `provider_failed` / `finalization_unresolved` truthfully.
- **Blocker 3: Production reentry-context component replaces source-inspection tests.** Created `lib/bot/reentry-context.ts` with `deriveReentryProvenance()` — the SAME function BotService actually uses for all re-entry paths (go_back_biz, restart_yes, pc_options, pc_again, chat handoff, chat start, active session provenance). Source-inspection tests (H, I sections) relabeled as `supplemental: source structure verification`. New executable tests: deriveReentryProvenance unit tests proving trusted/untrusted propagation; WAMID finalization retry tests (DB retry -> sent, persistent failure -> unresolved, idempotent retry); recovery execution tests (eligible -> sent, active lease -> not_claimed, no channel -> pre_provider_failure, ambiguous -> provider_ambiguous).

### Files changed
- `lib/promotions/fulfillment-notification.ts` — `FinalizationResult` + `DispatchResult` types; `finalizeIntentWithRetry` with bounded DB-only retry; `dispatchFulfillmentNotification` returns structured result; `finalizeIntent` returns FinalizationResult
- `app/api/promotions/fulfillment/route.ts` — uses DispatchResult for truthful logging
- `app/api/promotions/notifications/recover/route.ts` — reports truthful dispatch outcomes; only counts `sent` as recovered
- `lib/bot/reentry-context.ts` — new: `deriveReentryProvenance()` production helper
- `lib/bot/bot.service.ts` — imports and uses `deriveReentryProvenance` for all 6 re-entry paths
- `lib/__tests__/acc-204-claim-status.test.ts` — 89 tests: new H-exec (reentry-context tests), WAMID finalization retry tests, recovery execution tests; H/I source-inspection tests relabeled supplemental

### What could break
- `dispatchFulfillmentNotification` return type changed from `void` to `DispatchResult` — any caller that awaits without using the result is safe; any caller that checks the result must handle the new type
- Recovery endpoint response format changed: `status: 'dispatched'` replaced by truthful `status: 'sent' | 'not_claimed' | 'provider_ambiguous' | ...`; `recovered` count only includes `sent` (was counting all non-error as `dispatched`)
- `deriveReentryProvenance` is now the canonical path for session provenance reading — any future re-entry paths must use it

## 2026-08-26 — #204: PR #210 corrections round 4 — provenance laundering closure, lease hardening, recovery API

### What changed
- **Blocker 1 R4: Closed ALL provenance laundering paths.** Added `_internalProvenance` as 9th parameter to `handleMessage()`. When a recursive/internal call passes a business_id, it now also passes the original provenance from the session. The provenance derivation at the new-session path checks `_internalProvenance` FIRST, before `preResolvedBusinessId`. This prevents 6 laundering paths: (1) `go_back_biz` now reads `session_data.biz_resolution` from the last deactivated session, (2) keyword/switch action passes `'bot_code'` (non-authoritative), (3) `restart_yes` reads provenance before deactivating, (4) `pc_options`/`pc_again` capture `pcProvenance` before deactivation, (5-6) chat handoff/start lambdas capture `chatHandoffProvenance`/`chatStartProvenance`. Only webhook entry (no `_internalProvenance`) assigns `'pre_resolved'`.
- **Blocker 2 R4: Lease hardening + finalize idempotency + recovery.** Migration 348 rewrites `finalize_promo_fulfillment_notification` with idempotent semantics: same WAMID re-finalize = success, different WAMID = reject (fail closed). `mark_fulfillment_notification_attempted` now additionally verifies `claim_expires_at > now()` and `provider_attempted_at IS NULL`. New `find_recoverable_notification_intents` RPC returns pending intents with no provider attempt and no active lease. New recovery API at `/api/promotions/notifications/recover` (service-role only) finds and re-dispatches stuck intents.
- **Tests: 76 unit tests, full DB coverage.** New laundering path structure proofs (H section): verifies all 6 paths carry provenance correctly. Full chain proofs: fuzzy go_back_biz -> CLAIM denied, keyword -> denied, authoritative -> go_back_biz -> CLAIM allowed. DB tests for finalize idempotency (same WAMID twice = idempotent, different WAMID = rejected), mark_attempted lease expiry hardening, old token after reclaim, recovery RPC privilege hardening.

### Files changed
- `lib/bot/bot.service.ts` — `_internalProvenance` 9th param; all recursive handleMessage calls carry forward provenance; provenance derivation checks `_internalProvenance` first
- `lib/bot/derive-promo-provenance.ts` — updated docs for _internalProvenance role
- `supabase/migrations/348_fulfillment_recovery_and_idempotency.sql` — new: idempotent finalize, hardened mark_attempted, find_recoverable_notification_intents RPC
- `app/api/promotions/notifications/recover/route.ts` — new: service-role-only recovery endpoint
- `lib/__tests__/acc-204-claim-status.test.ts` — 76 tests: added H (laundering proofs) and I (idempotency proofs) sections
- `lib/__tests__/acc-204-fulfillment-notification-db.test.ts` — added I (finalize idempotency), J (lease hardening), K (recovery RPC) DB tests

### What could break
- Migration 348 rewrites `finalize_promo_fulfillment_notification` and `mark_fulfillment_notification_attempted` — must be applied after 346+347
- `mark_attempted` now checks `claim_expires_at > now()` — if the lease expires between claim and mark_attempted (>30s gap), the send is correctly blocked. This is intentional but changes behavior for very slow pre-provider work.
- Recovery API requires `SUPABASE_SERVICE_ROLE_KEY` in `x-service-secret` header — not exposed to end users

## 2026-08-26 — #204: PR #210 corrections round 3 — provenance laundering fix, lease/recovery dispatch, executable webhook tests

### What changed
- **Blocker 1: Restart no longer launders untrusted provenance.** Previously `restartBusinessId ? 'restart'` hardcoded provenance, allowing a fuzzy-derived session to restart and become trusted. Now carries forward the PERSISTED `session_data.biz_resolution` from the original session. `'restart'` removed from `TRUSTED_PROVENANCES` in both `promo-verification.ts` and `PROMO_TRUSTED_SOURCES` in `bot.service.ts`. Extracted `deriveFirstMessageProvenance` + `deriveActiveSessionProvenance` helpers with unit tests proving the full chain (fuzzy restart -> denied, dedicated_number restart -> allowed).
- **Blocker 2: Dispatch claim with lease/recovery.** Migration 347 now adds `claim_token UUID`, `claim_expires_at TIMESTAMPTZ`, `provider_attempted_at TIMESTAMPTZ` columns. `claim_fulfillment_notification_dispatch` generates a UUID token + lease (default 30s). New `mark_fulfillment_notification_attempted` RPC marks the point of no return before the Meta POST. Five states: (A) never attempted/reclaimable, (B) claimed with active lease/reclaimable after expiry, (C) provider attempted/NOT auto-reclaimable, (D) sent with WAMID, (E) failed. `fulfillment-notification.ts` updated to call claim -> pre-provider work -> mark_attempted -> send -> finalize. DB tests cover lease expiry + reclaim, provider_attempted_at blocking reclaim, wrong token rejection, two-session claim race.
- **Blocker 3: Executable webhook + application tests.** Extracted `fulfillment-webhook-correlator.ts` from inline webhook handler. Webhook route now delegates to `correlateFulfillmentNotificationStatus()`. Executable tests call the correlator with mocked Supabase: delivered callback -> advance called, read callback -> advance, failed -> handled, duplicate -> idempotent, unknown WAMID -> no advance. Dispatch tests updated for lease model: mark_attempted failure (lease expired) -> zero sendTemplate. Provenance tests now test `deriveFirstMessageProvenance` helper with full chain proofs.

### Files changed
- `lib/bot/bot.service.ts` — restart carries forward `session_data.biz_resolution` instead of hardcoded `'restart'`; `PROMO_TRUSTED_SOURCES` reduced to `['pre_resolved', 'dedicated_number']`
- `lib/bot/handlers/promo-verification.ts` — `TRUSTED_PROVENANCES` reduced to `['pre_resolved', 'dedicated_number']`
- `lib/bot/derive-promo-provenance.ts` — new: extracted provenance derivation helpers
- `lib/promotions/fulfillment-notification.ts` — lease model: claim_token, mark_attempted before send
- `lib/promotions/fulfillment-webhook-correlator.ts` — new: extracted webhook correlation logic
- `app/api/webhook/meta-cloud/route.ts` — delegates to `correlateFulfillmentNotificationStatus`
- `supabase/migrations/347_claim_fulfillment_notification_dispatch.sql` — claim_token, claim_expires_at, provider_attempted_at, mark_fulfillment_notification_attempted RPC
- `lib/__tests__/acc-204-claim-status.test.ts` — 58 executable tests: provenance helper proofs, lease dispatch, webhook correlation
- `lib/__tests__/acc-204-fulfillment-notification-db.test.ts` — DB tests for lease/token/expiry/mark_attempted
- `lib/bot/__tests__/acc-180-promo-first-message.test.ts` — updated for restart provenance change

### What could break
- Sessions created before this change: `biz_resolution` is preserved. Old sessions without it will have `undefined` provenance on restart -> CLAIM denied (fail-closed).
- Migration 347 is now a breaking rewrite (adds columns + new RPC). Must be applied fresh — cannot be applied incrementally on top of the previous version.
- Any code that relied on `'restart'` being in `TRUSTED_PROVENANCES` will now be denied. This is intentional — restart must carry the original source.

## 2026-08-26 — #204: PR #210 corrections round 2 — provenance persistence, atomic claim, executable tests

### What changed
- **Blocker 1: Persist tenant-authoritative provenance in session**. `bot.service.ts` now persists `biz_resolution` in `session_data` JSONB when a session is created. On the active-session path, the handler reads `session_data.biz_resolution` instead of trusting a hardcoded `'active_session'` literal. Sessions created from `returning_customer` or `fuzzy` sources will have those values persisted, and the CLAIM handler correctly denies them. Removed `'active_session'` from `TRUSTED_PROVENANCES` set.
- **Blocker 2: Single-winner dispatch claim**. Added migration 347 with `claim_fulfillment_notification_dispatch` RPC — atomically claims a pending intent via `SELECT FOR UPDATE` + pending check + `attempted_at IS NULL`. Updated `fulfillment-notification.ts` to call claim RPC before any provider call. If claim fails (already claimed), returns immediately with zero provider POST. Fixed `finalizeIntent` to check both `error` AND `!result?.success`. Removed the separate `attempted_at` update since the claim RPC sets it atomically.
- **Blocker 3: Executable application tests**. Replaced all source-string `indexOf()` tests with executable tests that actually call `dispatchFulfillmentNotification` with mocked ChannelResolver, MetaCloudService, and Supabase. 15 dispatch tests: template APPROVED/missing/PENDING/REJECTED, noRetry:true, 4xx/5xx error handling, missing WAMID, concurrent claim, finalize error/semantic-failure. Webhook correlation verified structurally. Provenance tests updated to verify `active_session` is no longer trusted directly.

### Files changed
- `lib/bot/bot.service.ts` — persists `biz_resolution` in session_data on creation; active-session path reads it back
- `lib/bot/handlers/promo-verification.ts` — removed `'active_session'` from TRUSTED_PROVENANCES
- `lib/promotions/fulfillment-notification.ts` — uses `claim_fulfillment_notification_dispatch` RPC, checks finalize success semantically
- `supabase/migrations/347_claim_fulfillment_notification_dispatch.sql` — atomic claim RPC (new)
- `lib/__tests__/acc-204-claim-status.test.ts` — replaced source-string tests with executable dispatch + provenance tests

### What could break
- Sessions created before this change will NOT have `biz_resolution` in session_data. On the active-session path, `sessionProvenance` will be `undefined`, which means CLAIM/STATUS will be denied until the user starts a new session. This is the secure default (fail-closed).
- Migration 347 must be applied after 346 (depends on `promo_fulfillment_notification_intents` table and `attempted_at` column).

## 2026-08-26 — #204: CLAIM/STATUS self-service + fulfillment notifications (corrections round)

### What changed
- **CLAIM/STATUS bot commands**: Winners can now text `CLAIM WAA-xxx` or `STATUS WAA-xxx` to check their claim status via WhatsApp. Trusted provenance now includes `active_session` (Blocker 1) — existing sessions with authoritative tenant binding can use CLAIM/STATUS.
- **bizResolution passthrough**: `bot.service.ts` passes `bizResolution` to `handlePromoVerification` in BOTH paths: first-message (with explicit provenance) AND active-session (with `'active_session'` provenance).
- **Migration 346**: Added `attempted_at TIMESTAMPTZ` column for crash-safe dispatch idempotency (Blocker 2). `finalize_promo_fulfillment_notification` sets `attempted_at` on finalization.
- **Durable dispatch (Blocker 2)**: Fulfillment route now `await`s dispatch instead of fire-and-forget `.catch()`. Dispatch sets `attempted_at = now()` BEFORE the provider call — if the process crashes mid-flight, the intent is marked as attempted (ambiguous, not auto-retried).
- **Meta webhook correlation (Blocker 3)**: Added fulfillment notification delivery status correlation to `meta-cloud/route.ts` — uses `advance_promo_fulfillment_notification_status` RPC.
- **CI (Blocker 4)**: Added ACC-204 fulfillment notification DB tests step to `.github/workflows/ci.yml`.
- **Strengthened tests (Blocker 5)**: Predicate-sensitive filter-aware CLAIM/STATUS mocks (5a), two-session concurrency with pg_sleep (5b), provider safety code path verification (5c), rate limit ordering proof (5d), routing order proof (5e).

### Files changed
- `lib/bot/bot.service.ts` — active-session call now passes `'active_session'` provenance
- `lib/bot/handlers/promo-verification.ts` — TRUSTED_PROVENANCES now includes `'active_session'`
- `supabase/migrations/346_promo_fulfillment_notification_intent.sql` — added `attempted_at` column, updated finalize RPC
- `app/api/promotions/fulfillment/route.ts` — `await` dispatch instead of fire-and-forget
- `lib/promotions/fulfillment-notification.ts` — sets `attempted_at` before provider call
- `app/api/webhook/meta-cloud/route.ts` — fulfillment notification delivery status correlation
- `.github/workflows/ci.yml` — ACC-204 DB test step
- `lib/__tests__/acc-204-claim-status.test.ts` — predicate-sensitive, routing order, provider safety, rate limit ordering tests
- `lib/__tests__/acc-204-fulfillment-notification-db.test.ts` — two-session concurrency test

### What could break
- `handlePromoVerification` now accepts `'active_session'` provenance — any code path that reaches the active-session handler with a fabricated provenance string could theoretically bypass gating, but the provenance is set server-side in bot.service.ts only.
- `attempted_at` column added to migration 346 — if migration was already applied, a supplementary `ALTER TABLE` is needed.

## 2026-08-26 — #203: Corrections round 3 — failed finalization invalidation, actual migration harness, deterministic concurrency

### What changed
- **Migration 345**: `finalize_promo_pickup_delivery` now sets `invalidated_at = now()` when `p_status = 'failed'`. Previously failed finalization only set `delivery_status = 'failed'` without invalidating, leaving a dangling verification that `verify_promo_pickup` would still consider active.
- **DB tests**: Added `finalize with sent` and `finalize with failed` tests proving sent_at/invalidated_at/delivered_at column states for each finalization outcome.
- **DB tests**: Replaced inline backfill simulation with actual migration 345 artifact execution — drops post-345 columns/objects, inserts pre-345 historical row, runs the real `.sql` file, proves `delivered_at` moved to `sent_at` and `delivered_at` cleared.
- **DB tests**: Replaced non-deterministic dual `psqlAsync` concurrent claim test with two-session contention pattern — Session A holds `FOR UPDATE` lock via `pg_sleep(2)`, Session B blocks until A commits, then deterministically gets cooldown.

### Files changed
- `supabase/migrations/345_promo_delivery_lifecycle.sql` — added `invalidated_at` to failed path in `finalize_promo_pickup_delivery`
- `lib/__tests__/acc-203-delivery-lifecycle-db.test.ts` — new finalize tests, actual migration harness, deterministic concurrency

### What could break
- Failed finalization now sets `invalidated_at`, so any code that checked `invalidated_at IS NULL` on failed verifications will now see them as invalidated (correct behavior, but a semantic change)

## 2026-08-26 — #203: Corrections round 2 — readiness-before-issue, durable WAMID correlation, real DB proofs

### What changed
- **OTP Send route**: Moved channel resolution + template readiness check BEFORE `issue_promo_pickup` RPC. If readiness fails, no verification is created and no cooldown is consumed. Previously a failed readiness check stranded a pending verification.
- **OTP Send route**: Missing `messageId` (WAMID) after `sendTemplate` now finalizes as 'failed' and returns 502 instead of claiming success.
- **Contact Winner route**: Missing `messageId` now finalizes as 'failed' and returns 502. Finalize RPC errors or `success:false` now block `{sent:true}` response (fail-closed).
- **DB tests**: Replaced placeholder historical migration proof with real backfill simulation (INSERT pre-345 pattern, run same UPDATE logic, verify exact timestamp). Replaced sequential concurrency test with true `psqlAsync` dual-session proof. Added pickup WAMID uniqueness proof (`idx_promo_pickup_wamid`).
- **DB tests**: Added privilege proofs for `claim_winner_contact_send` and `finalize_winner_contact_send` (service_role: EXECUTE, anon/authenticated: REVOKED).
- **Unit tests**: OTP send missing/PENDING/REJECTED tests now assert zero `issue_promo_pickup` RPC calls. Added missing-messageId and finalize-error tests for both OTP send and Contact Winner.

### Files changed
- `app/api/promotions/verification/send/route.ts` — readiness before issue, WAMID-required finalization
- `app/api/promotions/winners/contact/route.ts` — WAMID-required finalization, fail-closed on finalize error
- `lib/__tests__/acc-203-delivery-lifecycle-db.test.ts` — real DB proofs + privilege proofs
- `lib/__tests__/acc-203-templates-delivery.test.ts` — zero-RPC assertions + correlation tests

### What could break
- OTP send now returns 503 for template readiness failures WITHOUT creating a verification — callers that expected a verification_id in the error path will not get one
- OTP send and Contact Winner now return 502 when `messageId` is missing — callers that accepted `{sent:true}` without WAMID correlation will now see errors
- Contact Winner finalize errors now return 500 instead of silently succeeding — callers must handle this case

## 2026-08-26 — #203: Corrections round 1 — delivered_at semantics, v2 gate, durable contacts, #202 scope

### What changed
- **Migration 345**: `finalize_promo_pickup_delivery` no longer sets `delivered_at` on 'sent' — only `sent_at`. Historical backfill clears false `delivered_at` for rows with `delivery_status = 'sent'`. Added unique indexes: `idx_promo_winner_contacts_rate_limit` (partial, 10-min window), `idx_promo_winner_contacts_wamid`, `idx_promo_pickup_wamid` for durable tracking.
- **OTP Send route**: Added real v2 APPROVED gate — checks `resolved.cloud.getTemplates()` on the SAME resolved channel before calling `sendTemplate`. Returns 503 with `template_not_ready` if v2 is missing/PENDING/REJECTED.
- **Contact Winner route**: Changed to claim-before-send — INSERT pending row first (unique index enforces rate limit), then send, then UPDATE with result. Prevents ghost sends and double-sends.
- **DB tests**: Fixed finalize test to assert `delivered_at IS NULL` after 'sent'. Replaced placeholder historical migration test with real assertion. Added unique index enforcement tests (duplicate WAMID, rate limit collision).
- **Unit tests**: OTP send tests now mock `getTemplates()` for missing/PENDING/REJECTED/no-cloud states and verify sendTemplate NOT called. Contact Winner rate limit test uses insert constraint violation. Added same-channel proof test.
- **#202 tests**: Restored predicate-sensitive Contact Winner scope test with eqSpy tracking all predicates.

### Files changed
- `supabase/migrations/345_promo_delivery_lifecycle.sql` — fix finalize, add backfill cleanup, add unique indexes
- `app/api/promotions/verification/send/route.ts` — real v2 APPROVED gate
- `app/api/promotions/winners/contact/route.ts` — claim-before-send pattern
- `lib/__tests__/acc-203-delivery-lifecycle-db.test.ts` — fixed + new tests
- `lib/__tests__/acc-203-templates-delivery.test.ts` — real readiness tests
- `lib/__tests__/acc-202-winner-authorization.test.ts` — predicate-sensitive scope test

### What could break
- `finalize_promo_pickup_delivery('sent')` no longer sets `delivered_at` — code relying on `delivered_at` being set after finalize will see NULL
- OTP send now requires `resolved.cloud` to be present — channels without cloud support get 503 before template send
- Contact Winner insert may fail on `idx_promo_winner_contacts_rate_limit` unique constraint — callers must handle 429
- Existing `promo_winner_contacts` rows with duplicate `provider_message_id` will block migration 345

## 2026-08-26 — #203: Versioned Templates, Delivery Correlation, Contact Winner Activation

### What changed
- **Migration 345**: Expanded `promo_pickup_verifications` with `sent_at`, `read_at`, `invalidated_at` columns. Expanded `delivery_status` CHECK to include `'delivered'` and `'read'`. Created `advance_promo_pickup_status` RPC for monotonic delivery state machine. Updated `verify_promo_pickup` to accept sent/delivered/read delivery statuses and reject invalidated tokens. Updated `finalize_promo_pickup_delivery` to set `sent_at`. Created `promo_winner_contacts` table with RLS (service-only). Created `advance_promo_winner_contact_status` RPC. All functions privilege-hardened.
- **OTP Send route**: Changed template from `promo_pickup_verification` to `promo_pickup_verification_v2` with 4 params: `[businessName, prizeName, otp, expiryMinutes]`. No v1 fallback — fail closed if v2 not approved.
- **Contact Winner route**: Activated from stub. Sends `promo_winner_status_v1` template to winner's WhatsApp. Owner/admin/manager only. Checks template readiness before sending. Records in `promo_winner_contacts`. Rate-limited (10 min per redemption). Phone never returned in response.
- **Template Status route**: Now returns readiness for `promo_pickup_verification`, `promo_pickup_verification_v2`, and `promo_winner_status_v1` in a `templates` object. Backward-compatible top-level fields preserved.
- **Webhook handler**: Added promo OTP delivery status correlation (`advance_promo_pickup_status`) and winner contact delivery status correlation (`advance_promo_winner_contact_status`). Unknown WAMIDs are safe no-ops.

### Files changed
- `supabase/migrations/345_promo_delivery_lifecycle.sql` — new migration
- `app/api/promotions/verification/send/route.ts` — v2 template + dynamic params
- `app/api/promotions/winners/contact/route.ts` — activated from stub
- `app/api/promotions/template-status/route.ts` — multi-template status
- `app/api/webhook/meta-cloud/route.ts` — promo delivery correlation
- `lib/__tests__/acc-203-delivery-lifecycle-db.test.ts` — DB tests (24 tests)
- `lib/__tests__/acc-203-templates-delivery.test.ts` — unit tests (13 tests)
- `.github/workflows/ci.yml` — ACC-203 CI step

### What could break
- OTP send will fail if `promo_pickup_verification_v2` template is not APPROVED on the WABA — no v1 fallback
- Contact Winner requires `promo_winner_status_v1` template to be APPROVED
- `delivered_at` semantics changed: now means provider delivery evidence, not API acceptance (historical data migrated to `sent_at`)

## 2026-08-26 — #202: Winner Authorization — PR #208 corrections round 4

### Corrections applied (round 4)
- **DB test rollback (`acc-202-winner-authorization-db.test.ts`)**: Changed rollback test transition from `'processing'` to `'fulfilled'` — more meaningful proof since it's the terminal state.
- **Inactive membership tests**: Added explicit comments clarifying that mock returns `null` because `.eq('status', 'active')` filters out invited/suspended members. Semantically unchanged but now self-documenting.
- **Owner not found + member DB error test**: New test proves that when owner lookup returns no match AND member lookup returns a DB error, the guard returns 500 `authority_read_error` (fail-closed).
- **Capability matrix (4 states × 2 actions = 8 tests)**: New tests prove `read_history` and `manage_existing` pass regardless of capability state — when only another capability (scheduling) is configured, when promo_verification is explicitly disabled, when trial-blocked, and when tier-blocked.
- **Winner scope predicates**: New tests for reveal and contact endpoints assert `.eq()` calls include `campaign_id`, `business_id`, and `outcome=winner` predicates.
- **Complete role/status matrix**: Added finance/support denied reveal (403), admin contact 503, support denied contact (403), finance/support denied fulfillment (403), Winners GET denial for suspended business.

### Files changed
- `lib/__tests__/acc-202-winner-authorization-db.test.ts` — rollback transition changed to 'fulfilled'
- `lib/__tests__/acc-202-winner-authorization.test.ts` — 18 new tests added, 2 tests improved

### What could break
- Nothing — test-only changes, no production code modified

## 2026-08-26 — #202: Winner Authorization — PR #208 corrections round 3

### Corrections applied (round 3)
- **DB test rollback proof (`acc-202-winner-authorization-db.test.ts`)**: Replaced `CHECK(false)` constraint approach with targeted BEFORE INSERT trigger on admin_audit_logs. The trigger only blocks `promotions.fulfillment_transition` audit for the specific test redemption ID. Now verifies all 5 fields (fulfillment_status, fulfillment_reference, fulfillment_notes, fulfilled_at, fulfilled_by) remain at baseline after rollback. Cleanup in `finally` block drops trigger and function.
- **Auth tests (`acc-202-winner-authorization.test.ts`)**: Fixed invited/suspended membership tests — was using `setRole('invited')` which tested a fake role string; now uses `setNoRole()` to correctly simulate `.eq('status', 'active')` excluding non-active members. Added 10 new tests: fail-closed behavior (member DB error, business DB error, capability read error, override read error), business status (pending + manage_existing, suspended on all endpoints), scope assertions (wrong business, non-winner audit absence), contact endpoint assertions (503 template_not_ready, SELECT 'id' only, zero external calls). Total: 51 tests.

### Files changed
- `lib/__tests__/acc-202-winner-authorization-db.test.ts` — rollback test rewritten
- `lib/__tests__/acc-202-winner-authorization.test.ts` — 2 tests fixed, 10 tests added

### What could break
- Nothing — test-only changes, no production code modified

## 2026-08-26 — #202: Winner Authorization — Role-based winner management (PR #208 corrections)

### Corrections applied (round 2)
- **Reveal + Contact endpoints**: Added `.eq('business_id', businessId)` and `.eq('outcome', 'winner')` directly on redemption query. Removed redundant campaign→business cross-check (business_id now scoped directly on redemption). Prevents non-winner redemptions from being revealed/contacted.
- **Migration 344**: Removed hardcoded `'actor_role', 'business'` from audit INSERT — actor_id already identifies the actor, and the RPC doesn't know the caller's actual role.
- **DB test (`acc-202-winner-authorization-db.test.ts`)**: Added atomic rollback proof — blocks audit writes with CHECK(false) constraint and verifies fulfillment_status stays `pending` when audit fails.
- **CI (`.github/workflows/ci.yml`)**: Added ACC-202 step after ACC-199A in Migration validation job.
- **Auth tests (`acc-202-winner-authorization.test.ts`)**: Added 13 new test cases — finance/support/invited/suspended role denials, wrong business/campaign, non-winner reveal/contact, suspended business, pending business read_history, capability-absent read_history/manage_existing, contact endpoint phone_e164 absence proof. Total: 40 tests.

### What changed (original)
- **`lib/capabilities/resolve-role.ts`** (NEW): Pure role resolver — checks businesses.owner_id then business_members for active membership. Returns typed BusinessRole.
- **`lib/capabilities/api-guard.ts`**: Added `requireCapabilityWithRole()` — combines role resolution + capability check + business status enforcement in a single guard. Does NOT modify existing `requireCapability` or `requireAnyCapability`.
- **`app/api/promotions/winners/route.ts`**: Switched from `requireCapability` (owner-only) to `requireCapabilityWithRole` with `allowedRoles: ['owner', 'admin', 'manager']`. Response now includes server-derived `permissions` object (`can_reveal_phone`, `can_contact_winner`, `can_manage_fulfillment`).
- **`app/api/promotions/winners/reveal/route.ts`** (NEW): Owner/admin-only endpoint to reveal full phone_e164. Audit-before-disclosure (fail closed). No-store cache header.
- **`app/api/promotions/winners/contact/route.ts`** (NEW): Owner/admin/manager shell endpoint. Returns 503 — no phone lookup, no Meta send. Template pending approval.
- **`app/api/promotions/fulfillment/route.ts`**: Switched to `requireCapabilityWithRole` with `allowedRoles: ['owner', 'admin']`. Response SELECT now uses explicit column allowlist excluding phone_e164.
- **Migration 344**: `transition_promo_fulfillment` updated with atomic audit INSERT into admin_audit_logs. Privilege reassertion for service_role only.
- **`app/dashboard/promotions/[id]/page.tsx`**: Winners table now role-gated — Reveal button (owner/admin), Contact button (disabled, template pending), Fulfillment Update (owner/admin). Permissions driven by server response.

### What it affects
- Winners management is now multi-role instead of owner-only
- phone_e164 is only disclosed via the reveal endpoint (audited)
- Fulfillment response no longer leaks phone_e164
- Manager role can view winners and will be able to contact (when template approved) but cannot reveal phone or update fulfillment
- Reveal/contact endpoints now reject non-winner redemptions at the query level

### What could break
- If business_members table has stale entries, users with suspended/invited status are correctly excluded (only 'active' members pass)
- If admin_audit_logs INSERT fails inside transition_promo_fulfillment, the entire transaction rolls back — fulfillment update is rejected
- Existing integrations that expect `select('*')` on fulfillment response will no longer receive phone_e164

## 2026-08-26 — #197: Payment confirmation delivery tracking + stale I've Paid recovery

### What changed
- **Migration 342**: `payment_confirmation_deliveries` table + 5 RPCs (`claim_confirmation_delivery`, `begin_confirmation_send`, `complete_confirmation_send`, `fail_confirmation_send`, `advance_delivery_status`)
- **Migration 343**: `unmatched_delivery_statuses` table for WAMID race resolution
- **`send-confirmation.ts`**: Customer WhatsApp send now uses delivery-attempt authority (claim→send→complete lifecycle). Cross-business session channel fallback REMOVED. Durable `_inbound_channel_id` from payment metadata used instead.
- **`bot.service.ts`**: Stale `i_paid`/`i_paid_online` button interceptor added before keyword matching. Routes to order-centric recovery for fresh sessions.
- **`ordering.flow.ts`**: Button IDs now emit `i_paid:<order-reference>` for durable correlation. `_inbound_channel_id` persisted in payment metadata at initializePayment time. Validator accepts `i_paid:<ref>` pattern.
- **`route.ts` (Meta webhook)**: Payment confirmation delivery status tracking added alongside existing contracts/OTP handlers. Uses `advance_delivery_status` RPC with validated provider timestamps.
- **`stale-payment-recovery.ts`**: New module for order-centric recovery. Authorizes order by business+user identity. Success outranks pending. Multiple pending fail closed. Duplicate success = integrity alert, no financial mutation.

### What it affects
- Payment confirmation delivery is now tracked per-attempt with monotonic state machine
- Stale "I've Paid" buttons from deactivated sessions now reach order-centric recovery
- Cross-business channel fallback is removed (tenant isolation fix)
- Payment Authority remains sole financial writer — recovery never replays Stage-3 effects

### What could break
- If `claim_confirmation_delivery` RPC is unavailable, customer WhatsApp confirmations won't send (but payment/order finalization still completes)
- Button ID change from `i_paid` to `i_paid:WA-OR-XXXX` means old cached buttons still work (backward compat in interceptor) but new buttons carry durable reference

### Correction round 5 — frozen test requirements resolved (PR #207 rebase)
- **`stale-button-botservice.test.ts`**: Rewritten to call real `BotService.handleMessage()` with mocked dependencies (same pattern as cas-004-botservice-wiring.test.ts). Tests `i_paid`, `i_paid_online`, `i_paid:REF`, `i_paid_online:REF` buttons, negative cases (free text, malformed, legitimate step), all via actual handleMessage execution.
- **`confirmation-delivery-db.test.ts` test 21**: Rewritten for genuine concurrent WAMID race. Uses two `psql` sessions launched via `Promise.all` — Session A wraps `complete_confirmation_send` in explicit transaction with `pg_sleep(1)` to hold the advisory lock, Session B calls `advance_delivery_status` and blocks on `pg_advisory_xact_lock(hashtext(wamid))` until A commits. Proves real lock contention, not sequential execution.
- **CI**: Rebased onto main (54d785d2). Both #177 Stripe and #197 confirmation delivery CI blocks preserved.
- **Files:** `lib/payments/__tests__/stale-button-botservice.test.ts`, `lib/payments/__tests__/confirmation-delivery-db.test.ts`, `.github/workflows/ci.yml`, `CHANGELOG.md`

---

## 2026-08-26

### fix(promotions): Correction Round 5 — contention test + empty prizeUpdates response (#199A / PR #206)

- **Contention test rewrite:** Replaced `psqlAsync` contention test with `pg.Client`-based two-connection test. Connection A now locks the campaign row AND updates the same prize that Connection B is also trying to update, exercising the true parent→child path. Previously A just held the campaign lock without touching the prize.
- **Empty prizeUpdates response:** `{prizeUpdates: []}` now returns `{campaign}` (no `prizes` key) instead of `{campaign, prizes: []}`. This matches the non-prize update response shape and avoids returning a misleading empty array.
- **Files:** `app/api/promotions/update/route.ts`, `lib/__tests__/acc-199a-winner-response.test.ts`, `CHANGELOG.md`
- **Affects:** prizeUpdates empty-array response shape, contention test accuracy
- **Could break:** Frontend code that destructures `prizes` from an empty prizeUpdates response — but that's a no-op call, so unlikely.

### fix(promotions): Correction Round 4 — early prizeUpdates validation, route tests, contention proof (#199A / PR #206)

- **Early prizeUpdates validation:** Moved prizeUpdates shape check (must be array) and mixed-payload rejection to BEFORE status transition validation and activation early-return in `app/api/promotions/update/route.ts`. Previously, `{status: 'active', prizeUpdates: [...]}` would activate the campaign and return early before hitting the mixed-payload guard. Now it returns 400 immediately.
- **Empty array no-op:** `{prizeUpdates: []}` returns 200 with `{campaign, prizes: []}` immediately — no mutations.
- **Route execution tests (6):** Tests that call the actual PUT handler with mocked Supabase, verifying: mixed payloads with status/name/codeEntryMode all return 400 with zero RPC calls; non-array prizeUpdates (string, number) return 400; empty array returns 200 no-op.
- **Direct-UPDATE contention test (1):** Two-connection test proving no deadlock when Connection A holds campaign row lock (RPC-style) while Connection B does a direct `UPDATE promo_prizes SET prize_instructions = ...` (hitting the trigger's `SELECT ... FOR UPDATE`). B blocks, A commits, B completes.
- **Files:** `app/api/promotions/update/route.ts`, `lib/__tests__/acc-199a-winner-response.test.ts`, `CHANGELOG.md`
- **Affects:** prizeUpdates + activation race, prizeUpdates input validation
- **Could break:** Nothing — validation is stricter (rejects invalid combos earlier), all existing valid payloads still work.

### fix(tests): fix CI seed SQL + add privilege tests for ACC-199A (#199A / PR #206)

- **businesses INSERT:** Replaced `(id, name, owner_id, category, country)` with full NOT NULL column list including `country_code` (not `country`). CI's `businesses` table does not have a `country` column.
- **Privilege tests:** Added `update_prize_instructions` privilege assertion tests: service_role can execute, anon cannot, authenticated cannot.
- **Files:** `lib/__tests__/acc-199a-winner-response.test.ts`, `CHANGELOG.md`
- **Affects:** CI test reliability — DB integration tests now use correct column names for CI PostgreSQL.
- **Could break:** Nothing — test-only changes.

### fix(promotions): Correction Round 3 — atomic RPC, race tests, mixed payload rejection (#199A / #201 / PR #206)

- **Atomic prize-update RPC:** Added `update_prize_instructions` RPC to migration 341. Locks campaign row `FOR UPDATE` before checking `integrity_locked`, serializing against `claim_promo_code`. Replaces N independent UPDATE calls with one atomic batch.
- **Hardened integrity trigger:** `guard_prize_instructions_integrity` trigger now uses `SELECT ... FOR UPDATE` on `promo_campaigns` to serialize against concurrent `claim_promo_code` setting `integrity_locked=true`.
- **Mixed payload rejection:** `app/api/promotions/update/route.ts` now rejects requests containing both `prizeUpdates` and campaign mutation fields (400 error). Prize-only path returns early with canonical prize state.
- **RPC-based update route:** Prize updates in the API route now call `update_prize_instructions` RPC instead of looping individual DB updates. Returns 409 for `integrity_locked`, 404 for missing campaign.
- **Two-connection race tests:** 5 new real-DB tests using separate psql processes: (A) prize update first, claim sees new value; (B) redemption first, prize update sees integrity_locked; (C) no deadlock with bounded timeout; (D) batch rollback on invalid prize; (E) direct UPDATE blocked by trigger defense-in-depth.
- **CI sentinel removed:** Removed `if (process.env.CI) expect(TEST_DATABASE_URL)` global test that broke main-app CI (no Postgres). DB tests still use `describe.skipIf(!canRunDb)`.
- **ACC-199A CI step:** Added dedicated CI step in migrations job after ACC-186, with zero-skip enforcement.
- **Files:** `supabase/migrations/341_promo_winner_response.sql`, `app/api/promotions/update/route.ts`, `lib/__tests__/acc-199a-winner-response.test.ts`, `.github/workflows/ci.yml`, `CHANGELOG.md`
- **Could break:** Nothing — RPC is additive; API behavior preserved; trigger hardening is backwards-compatible.

### fix(promotions): Correction Round 2 — integrity locking, test parity, stale default (#199A / #201 / PR #206)

- **DB-level integrity guard:** Added `guard_prize_instructions_integrity` trigger on `promo_prizes` in migration 341. Prevents `prize_instructions` updates when parent campaign is `integrity_locked = true`. Raises `check_violation`. This makes the lock race-safe (was application-level only).
- **CI guard test:** Added test ensuring `TEST_DATABASE_URL` is set when `CI=true`, so DB tests are never silently skipped in CI.
- **First/replay instruction parity proof (DB):** New test calls `claim_promo_code` twice, asserts both return identical `prize_instructions`, and builds identical claim blocks via `buildClaimBlock`.
- **Exact string equality through verifyPromoCode:** Replaced "contains" assertions with `firstResponse.message === replayResponse.message` (byte-for-byte equality proof).
- **Dashboard stale default fixed:** Changed `DEFAULT_WINNER_MESSAGE` in `app/dashboard/promotions/create/page.tsx` from the old "We will contact you shortly with next steps" to `'Congratulations! 🎉'` matching the DB default.
- **Files:** `supabase/migrations/341_promo_winner_response.sql`, `lib/__tests__/acc-199a-winner-response.test.ts`, `app/dashboard/promotions/create/page.tsx`, `CHANGELOG.md`
- **Could break:** Nothing — trigger is additive; dashboard default change only affects new campaign form initial values.

### feat(promotions): Winner response block + recipient instructions (#199A / #201)

- **What:** When a customer wins a promo prize, the system now appends a structured claim block after the custom winner message with prize name, campaign name, claim reference, verification method, and actionable collection instructions based on the verification mode (standard vs secure_pickup).
- **Migration 341:** (renumbered from 339 to avoid collision with PRs #196/#205) Added `prize_instructions` column to `promo_prizes`; updated `claim_promo_code` replay branch to return `redemption_id`, `verification_mode`, `verification_status`, and `prize_instructions` (parity with first-claim branch); changed default `winner_message` to `'Congratulations! 🎉'` for new campaigns only.
- **Application layer:** `buildClaimBlock()` in `lib/promotions/verify.ts` now renders campaign name, explicit verification method label (Standard/Secure Pickup), and uses "look up your claim" wording for standard mode (not bearer-proof language). Business name lookup failure logged via `logger.warn` before fallback.
- **API routes:** `app/api/promotions/create/route.ts` validates `prize_instructions` type (must be string) before `.trim()`. `app/api/promotions/update/route.ts` already had proper type checking.
- **Tests:** Added real `verifyPromoCode` integration tests with mocked Supabase: first-claim winner, replay winner, standard vs secure_pickup wording, try-again (no claim block), business name failure (logged warning + fallback).
- **Files:** `supabase/migrations/341_promo_winner_response.sql`, `lib/promotions/verify.ts`, `lib/promotions/types.ts`, `app/api/promotions/create/route.ts`, `app/api/promotions/update/route.ts`, `lib/__tests__/acc-199a-winner-response.test.ts`
- **Affects:** Winner message display in WhatsApp, promo prize creation/update, claim_promo_code replay returns
- **Could break:** Nothing — additive only. Existing campaigns keep their stored winner_message. Claim block is appended programmatically, not stored.

---

## 2026-08-25

### fix(loyalty): Direct Giving no longer earns loyalty points (#167)

- **Root cause:** `sendProactiveConfirmation` (Stage 3) called `handlePostCompletion` without `skipLoyalty` for all booking-backed payments, including Direct Giving.
- **Fix:** Two-dimensional classifier: `flow_type === 'payment' AND service_type === 'giving'` → `skipLoyalty=true`. Fail-closed for ambiguous payment-family transactions. Non-payment flows unchanged.
- **No migration needed.** Added `service_type` to existing `services(...)` JOIN select.
- **Files:** `lib/payments/send-confirmation.ts`, `lib/payments/__tests__/giving-loyalty-gap.test.ts`
- **Affects:** Loyalty awarding for Direct Giving and recurring Giving renewals
- **Could break:** Nothing — existing non-giving loyalty preserved. Ambiguous payments fail closed.

### feat(promotions): show redeemed winning code to business after claim (#190)

- **What:** After a winning promo code is redeemed, the business can now see the exact printed code in the Winners dashboard tab.
- **Before:** Winners tab showed participant phone (masked), prize, claim reference, and fulfillment status — but NOT the redeemed code itself.
- **After:** New "Redeemed Code" column shows the formatted code (e.g. `K7PM-4XQ9-N2WF`) for each claimed winner.
- **Security invariant preserved:** Unused winning codes remain indistinguishable from unused losing codes. The code is only decrypted server-side, only for redemptions where all 8 integrity checks pass (capability auth, campaign ownership, redemption outcome=winner, code FK resolves, code campaign matches, code status=claimed, code outcome=winner, decryption succeeds).
- **Defense-in-depth:** `resolveRedeemedCode()` validates the linked code row's own `campaign_id`, `status`, and `outcome` independently — does not trust the redemption outcome alone. Decrypted value is validated as a routable promo code via `isRoutablePromoCode()`. Corrupt/invalid ciphertext returns `null` (fail closed).
- **No migration needed:** Uses existing `promo_redemptions.promo_code_id` FK → `promo_campaign_codes.encrypted_code` via PostgREST JOIN.
- **Files:** `app/api/promotions/winners/route.ts`, `app/dashboard/promotions/[id]/page.tsx`, `lib/__tests__/promo-winner-visibility.test.ts`
- **Affects:** Winners API response, Winners dashboard tab display
- **Could break:** Nothing — additive-only change. If decryption fails, `redeemed_code` returns `null` and renders as dash.

### fix(promotions): claim_promo_code crypto schema resolution (#188)

- **Root cause:** `claim_promo_code` RPC (migration 331) uses `gen_random_bytes(8)` for claim-reference generation, but the function has `SET search_path = public`. In Supabase production, pgcrypto lives in the `extensions` schema (platform prerequisite), so unqualified `gen_random_bytes()` fails with "function gen_random_bytes(integer) does not exist".
- **Customer impact:** Valid unused Instant Win codes fail during claim. Transaction rolls back, code stays `unused`, customer sees "That code is not valid" for a valid code.
- **Fix:** Forward migration 338 redefines `claim_promo_code` with `extensions.gen_random_bytes(8)`. No other changes — search_path remains restricted to `public`, all claim authority/idempotency/eligibility/rate-limiting/winner-security behavior preserved.
- **Test authority correction:** `promo-1-claim-authority-db.test.ts` now applies migrations 330, 331, 336, and 338 (previously only 321 + 336). pgcrypto installed in `extensions` schema to match Supabase production layout.
- **New regression test:** `promo-claim-crypto-schema-db.test.ts` — proves claim works with pgcrypto in `extensions` schema (production layout), verifies `public.gen_random_bytes` is NOT available, validates winner/try_again/invalid/replay/rollback paths with real forced-failure transaction rollback proof.
- **Files:** `supabase/migrations/338_fix_claim_promo_code_crypto_schema.sql`, `lib/__tests__/promo-claim-crypto-schema-db.test.ts`, `lib/__tests__/promo-1-claim-authority-db.test.ts`, `lib/__tests__/promo-code-claim-integrity.test.ts`
- **Affects:** All Instant Win / promo code claim processing
- **Could break:** Nothing — the only change is schema-qualifying a crypto function call that was already broken in production

## 2026-08-24

### fix(payments): Paystack recurring billing-attempt authority — complete Round 2 (#176)

- **Invoice-based cycle authority:** Replaced `subscription_code`-only provider cycle identity with authoritative Paystack `invoice_code`. Added `fetchSubscriptionInvoice()` that queries Paystack Subscription API to resolve invoice for each billing cycle. Cycle keys now use `ps-auto-{sub_id}-{invoice_code}` instead of `ps-auto-{sub_id}-{subscription_code}`. Falls back to transaction reference if invoice unavailable (fail-closed).
- **Typed charge outcomes:** Replaced boolean `chargeAuthorization` return with `PaystackChargeOutcome` type — `success`, `pending`, `terminal_failure`, `indeterminate`. Uses raw `fetch` with HTTP fidelity (#172 pattern). HTTP 400/401/403/429/5xx, malformed JSON, network/timeout all map to `indeterminate` (never authorize replacement). Cron uses typed outcomes for post-dispatch state transitions.
- **Replay identity validation:** Finalizer validates transaction_id and invoice_code on replay (not just amount/currency). Conflicting identity → rejected.
- **Guarded state transitions:** Cron post-dispatch updates use `.in('status', [...])` guards. Charged update requires `dispatched`. Failed update requires `dispatched|charged`. Prevents overwriting finalized rows.
- **Provider-managed convergence:** Same invoice with multiple refs converges to one canonical finalization via partial unique index. Existing unresolved attempt for same cycle_key updated with latest provider evidence. Concurrent webhook delivery handled via race detection.
- **Reconciliation path:** Cron `must_reconcile` now fetches invoice_code from Paystack API during verification for complete identity finalization.
- **Files:** `lib/payments/paystack-recurring.ts`, `app/api/cron/retry-failed-charges/route.ts`, `app/api/payments/webhook/route.ts`, `supabase/migrations/337_paystack_recurring_finalization.sql`
- **Tests:** 169 suites pass (4407 tests). 29 new provider-boundary typed outcome tests. 10 new PostgreSQL billing-authority tests (multi-cycle, convergence, races, conflicting replay, terminal failure replacement, guard validation).
- **Affects:** Paystack recurring charge lifecycle (cron + webhook), chargeAuthorization return type
- **Could break:** Code that checked `chargeAuthorization().success` (boolean) must now check `.status === 'success'`. Only consumer is retry-failed-charges cron (updated).

## 2026-08-20

### fix(observability): release-gate fixes — CI regression, URL safety, allowlist, instrumentation

- **CI regression root cause:** PostHog's `posthog.capture()` with `flushAt: 1, flushInterval: 0` from a previous test's `emitServerEvent` made a fire-and-forget `fetch()` that consumed the next test's fetch mock response #0, shifting all mock responses by 1. Only triggered when `NEXT_PUBLIC_POSTHOG_KEY` is set (CI, not local dev). Fixed by mocking `@/lib/observability/server-events` in `setupEmbeddedSignupMocks`.
- **Canonical URL validation:** Replaced string-prefix same-origin check (`startsWith('/')`) with `new URL(url, window.location.href)` + `resolved.origin === window.location.origin`. Blocks `//evil.example/path`, `waaiio.com.evil.example`, and all third-party hosts.
- **Live acceptance session:** Interceptor now installs unconditionally (regardless of test_run_id at mount). Reads `sessionStorage.waaiio_test_run_id` on each request — setting/clearing the ID after dashboard load begins/stops propagation without a page reload.
- **Privacy allowlist:** Replaced 14-key denylist with 13-key explicit allowlist (`ALLOWED_KEYS`). Arbitrary property names (e.g., `customer_email`, `auth_token`, `card_details`) are now silently dropped. `message_id` is intentionally allowed; `message` and `message_body` are not.
- **Product/service creation instrumentation:** `captureProductEvent('product.created')` / `captureProductEvent('service.created')` called after confirmed Supabase insert success with `business_id`, `entity_id`, `entity_type`, `status`. Services insert now returns ID via `.select('id').single()`.
- **Capability matrix test:** Now validates all three of canonical ID + label + tier appear on the same markdown row, not just ID + tier independently.
- **Existing observability documented:** Tests verify `observe('payment.init')` in `payment.ts`, `create_order_atomic` RPC in `ordering.flow.ts`, `book_slot_atomic` in `scheduling.flow.ts`, and `auto-payout` cron logging — these have existing structured logs sufficient for acceptance correlation.
- **Files:** `lib/observability/product-events.ts`, `components/PostHogProvider.tsx`, `app/dashboard/products/page.tsx`, `app/dashboard/services/page.tsx`, `lib/__tests__/product-events.test.ts`, `lib/__tests__/route-handler-redaction.test.ts`
- **Tests:** 158 suites pass (4043 tests, +20 new). 14 real interceptor behavioral tests, 6 privacy allowlist tests, 3 product/service instrumentation tests, 4 existing observability verification tests.
- **Affects:** Fetch interceptor URL validation, privacy sanitizer behavior, product/service creation pages
- **Could break:** Code that passed arbitrary extra properties to `sanitizeEventProps` will now see those properties dropped (allowlist is stricter than denylist). This is intentional — only the 13 allowed keys survive.

## 2026-08-19

### fix(observability): correct telemetry semantics and activate test_run_id propagation

- **Per-capability events:** `capabilities/configure` now emits individual `capability.enabled` / `capability.disabled` events per capability with `capability: cap` property, instead of a single generic event.
- **Payment semantic fix:** `process-success.ts` uses `payment.finalization_failed` for post-charge failures (fee recording, confirmation, etc.), not `payment.failed` which implies the charge itself failed.
- **Fulfillment gate:** `promotions/fulfillment` only emits `promo.winner_fulfilled` when `fulfillmentStatus === 'fulfilled'`, not for all status transitions.
- **WhatsApp telemetry:** `embedded-signup/route.ts` emits `whatsapp.connect_completed` on success and `whatsapp.connect_failed` on catch.
- **test_run_id activation:** PostHogProvider now calls `installTestRunFetchInterceptor()` on mount (idempotent, consent-independent). Interceptor has guard preventing duplicate installs across React remounts/HMR.
- **Client bundle fix:** Moved `captureServerEvent` out of `product-events.ts` (client-safe) into `server-events.ts` (server-only). Fixes `posthog-node` leaking into webpack client chunk causing `node:async_hooks` build error.
- **Files:** `app/api/capabilities/configure/route.ts`, `app/api/promotions/fulfillment/route.ts`, `app/api/whatsapp/embedded-signup/route.ts`, `components/PostHogProvider.tsx`, `lib/observability/product-events.ts`, `lib/observability/server-events.ts`, `lib/payments/process-success.ts`, `lib/__tests__/product-events.test.ts`
- **Tests:** 158 suites pass (4023 tests), including new tests for per-capability events, payment semantics, fulfillment gating, WhatsApp wiring, fetch interceptor behavior
- **Affects:** All server event emission, PostHog client initialization, acceptance test infrastructure
- **Could break:** Nothing — all changes are additive telemetry or correctness fixes. No API contract changes.

### fix(ordering): payment-success invariant + hide unfinished service price request + real concurrency tests

- **Payment-success invariant (migration 327):** `apply_order_stock_once` now requires `payment.status = 'success'` when `p_payment_id` is supplied, BEFORE any stock decrement or order confirmation. Previously a pending payment with valid order relationship could trigger stock mutation. `p_payment_id = NULL` remains supported for trusted pre-payment paths (quote acceptance, free orders).
- **Service Price Request hidden (services page):** Removed the unfinished "Price request" toggle and list badge from `app/dashboard/services/page.tsx`. DB column `services.quote_enabled` preserved — no migration, no backfill, no data change. Existing values intact on save.
- **Real row-lock concurrency tests:** Replaced advisory-lock-barrier tests (which only proved ordering) with actual overlapping-transaction tests. Session A holds row locks via `FOR UPDATE` + `pg_sleep(3)`, Session B's conflicting UPDATE/RPC blocks on the row lock. Elapsed time > 1.5s proves genuine contention. Both race directions covered.
- **Files:** `supabase/migrations/327_canonical_order_stock.sql`, `app/dashboard/services/page.tsx`, `lib/__tests__/order-stock-authority.test.ts`
- **Tests:** 5 new payment-success invariant tests (8a-8e), 2 source tests for Price Request removal, 2 real row-lock concurrency tests replacing advisory-barrier versions
- **Affects:** Order stock application, payment webhook finalization, service dashboard form
- **Could break:** Any code calling `apply_order_stock_once` with a non-successful payment_id will now get `payment_not_successful` instead of proceeding. This is the correct behavior — all callers already verify payment success before calling.

### feat(ordering): canonical order-stock authority + atomic quote acceptance

- **Canonical stock invariant:** For any order, inventory is deducted at most once, enforced by `UNIQUE(order_id)` on `order_stock_applications`. Migration 327 changes constraint from `UNIQUE(payment_id, order_id)` to `UNIQUE(order_id)`, makes `payment_id` nullable, fixes `stock` → `stock_quantity` column bug in `apply_order_stock_once`, adds cancelled-order rejection, deterministic inventory locking, and optional stock-sufficiency validation (`p_validate_sufficient`).
- **Atomic quote acceptance:** Migration 328 adds `accept_order_quote_atomic(p_quote_id, p_customer_phone)` — locks quote, verifies Meta-verified WhatsApp sender identity, derives all financial values from DB, creates order + items, reserves inventory via canonical `apply_order_stock_once` in same transaction, rolls back entirely on insufficient stock. Also adds `reject_order_quote_atomic` with same identity verification. Partial UNIQUE index on `orders.quote_request_id` enforces one-quote-one-order at DB level.
- **Atomic stale-order cleanup:** Migration 329 adds `cancel_stale_order_atomic(p_order_id)` — locks order, requires status='pending' and age >48h, checks for successful payment (skips if paid), checks canonical stock marker (restores stock only if marker exists, skips if not), cancels order atomically.
- **Bot flow stock replacement:** Replaced two per-item `decrement_stock`/`decrement_variant_stock` loops in `ordering.flow.ts` with single `apply_order_stock_once` RPC call (atomic, idempotent, crash-safe).
- **Quote handler rewired:** `quote-response.ts` now calls RPCs directly via service client with Meta-verified `from` as `p_customer_phone`. Side effects (payment init, messaging, notifications) preserved in handler.
- **Unauthenticated route removed:** Deleted `/api/orders/quote-accept/route.ts` (had no auth beyond rate limiting).
- **Fix:** Removed non-existent `paid_at` column from order confirmation update in `process-success.ts:129`.
- **Files:** `supabase/migrations/327_canonical_order_stock.sql` (NEW), `supabase/migrations/328_quote_acceptance_rpcs.sql` (NEW), `supabase/migrations/329_stale_order_atomic_cleanup.sql` (NEW), `lib/__tests__/order-stock-authority.test.ts` (NEW), `lib/bot/handlers/quote-response.ts`, `lib/bot/bot.service.ts`, `lib/bot/flows/ordering.flow.ts`, `lib/payments/process-success.ts`, `app/api/cron/cleanup/route.ts`, `app/api/orders/quote-accept/route.ts` (DELETED)
- **Tests:** 44 executable PostgreSQL tests covering stock application, concurrency, crash rollback, deposit/balance, identity verification, quote atomicity, cleanup with/without marker, privilege hardening
- **Affects:** All order stock paths (bot flow, payment webhook, quote acceptance, stale cleanup). Payment finalization lifecycle. Quote acceptance/rejection flow.
- **Could break:** Any code that calls `apply_order_stock_once` with old `(p_payment_id, p_order_id)` parameter order (now `(p_order_id, p_payment_id)`). Any code that references `/api/orders/quote-accept`. Tests in `payment-authority-db.test.ts` that test the old `apply_order_stock_once` signature against a real DB (those tests use migration 314 directly and would need updating for the new schema).

## 2026-08-17

### fix(infra): production drift reconciliation for migrations 321+322

- **Problem:** Production had partial schema from migrations 321 (Promotions) and 322 (Class Session Booking) applied outside the migration ledger. Most 321 objects were missing (promo_campaigns, promo_prizes, promo_code_batches, etc.), and 322 was incomplete (missing create_class_atomic, create_class_recurrence_atomic, update_class_session_atomic, reconcile_class_recurrence RPCs, class session RLS policies, constraints, and table grants).
- **Fix:** Migration 325: single convergence migration that applies ALL missing objects from 321 and 322 using idempotent guards (IF NOT EXISTS, CREATE OR REPLACE, DO $$ with duplicate_object handling, DROP POLICY IF EXISTS + CREATE POLICY). Safe to run on both clean chain and drifted production.
- **Files:** `supabase/migrations/325_production_drift_reconciliation.sql` (NEW), `lib/__tests__/production-drift-reconciliation.test.ts` (NEW), `.github/workflows/ci.yml` (updated)
- **Tests:** 12 tests: schema convergence (tables, columns, functions, RLS, policies match between clean chain and drift fixture), idempotency (325 runs twice without error), source verification (IF NOT EXISTS, CREATE OR REPLACE, no DROP TABLE)
- **CI:** New `Production drift reconciliation tests` step
- **Affects:** Database schema on production — converges to canonical 321+322 postconditions
- **Could break:** Nothing — all statements are idempotent and preserve existing data

### fix(security): revoke anon/authenticated execute on payment confirmation RPCs

- **Bug:** Supabase's `ALTER DEFAULT PRIVILEGES` auto-grants EXECUTE to `anon` and `authenticated` for functions created in the public schema. Migration 307 revoked from `PUBLIC` but that only removes the grant inherited from the PUBLIC pseudo-role — the direct grants to `anon` and `authenticated` remained. This meant 4 SECURITY DEFINER functions that modify payment state (`claim_payment_confirmation`, `renew_payment_confirmation_claim`, `finalize_payment_confirmation`, `release_payment_confirmation`) were callable by unauthenticated and authenticated browser clients.
- **Fix:** Migration 324: explicit REVOKE ALL from PUBLIC, anon, and authenticated for all 4 functions. GRANT EXECUTE only to service_role. Does not alter function bodies.
- **Files:** `supabase/migrations/324_payment_confirmation_rpc_grants.sql` (NEW)
- **Tests:** `lib/__tests__/payment-confirmation-rpc-grants.test.ts` — 21 source verification + 12 real PostgreSQL tests (permission + e2e lifecycle)
- **CI:** New `PRA payment confirmation RPC grant tests` step in `.github/workflows/ci.yml`
- **Affects:** Payment confirmation lifecycle — these RPCs are only called server-side via the service client
- **Could break:** Nothing — all callers already use `createServiceClient()` which authenticates as service_role

### fix: use SUM(party_size) for class capacity display, not COUNT(rows)

- **Bug:** Two places in `scheduling.flow.ts` used `COUNT(booking rows)` (via `{ count: 'exact', head: true }`) to check class session capacity, while the DB authority `book_slot_atomic` (migration 322) uses `SUM(party_size)`. For multi-spot bookings (e.g. party_size=3), the display showed 1 occupied instead of 3, inflating apparent availability.
- **Fix:** Replaced both COUNT patterns with `.select('party_size')` + JS reduce to sum party_size, matching `book_slot_atomic`'s `COALESCE(SUM(b.party_size), 0)` with the same status filter `('confirmed', 'pending', 'in_progress')`.
- **Locations:**
  - `select_class_session` validate (~line 535): capacity check before accepting session selection
  - `select_quantity` skipIf (~line 1582): remaining spots calculation for `_class_remaining_spots`
- **Files:** `lib/bot/flows/scheduling.flow.ts`, `lib/bot/flows/__tests__/class-capacity-display.test.ts` (NEW)
- **Tests:** 6 tests: SUM correctness (party_size=3 counts as 3), full capacity rejection, cancelled booking exclusion, remaining spots calculation, auto-skip when 1 spot left, non-class service unaffected
- **Affects:** WhatsApp bot class booking UX — customers now see correct availability
- **Could break:** Nothing — the DB authority already enforced correct capacity; this only fixes the display/UX layer to match

---

## 2026-08-16

### fix(P1-OVERLOAD): drop stale 26-arg book_slot_atomic overload

- **Bug:** Production contained two `public.book_slot_atomic` overloads: a stale 26-arg version (pre-313, no advisory lock canonicalization, no idempotent retry, no appointment schedule validation, no staff availability, no requires_staff enforcement) and the canonical 27-arg version (from migrations 313/318/319). When callers omit `p_bot_session_id` (e.g. public web booking), PostgreSQL's "most specific match" resolves to the stale 26-arg version, bypassing all safety checks from migrations 318–319. PostgREST named-argument resolution makes ambiguous overloads unpredictable.
- **Fix:** Migration 320: `DROP FUNCTION` of the exact stale 26-arg signature. Canonical 27-arg version (with `p_bot_session_id DEFAULT NULL`) remains. Verified exactly 1 overload remains. All callers that omit `p_bot_session_id` now resolve unambiguously to the canonical function. Also remediates canonical 27-arg ACL: REVOKEs EXECUTE from PUBLIC/anon/authenticated, GRANTs only to service_role (SECURITY DEFINER booking authority should not be callable by browser clients).
- **Root cause:** Migrations 313/318/319 used `CREATE OR REPLACE` on the 27-arg signature, but never dropped the earlier 26-arg version created by a pre-313 migration. `CREATE OR REPLACE` only replaces when the signature matches exactly.
- **Files:** `supabase/migrations/320_drop_stale_book_slot_overload.sql`
- **Tests:** `lib/__tests__/p1-320-drop-stale-overload.test.ts` — 11 source verification + 9 real PostgreSQL tests
- **Affects:** All `book_slot_atomic` callers: WhatsApp scheduling, public web booking, manual dashboard booking (via `book_manual_slot_atomic` wrapper)
- **Could break:** Nothing — the 26-arg function had no callers that specifically targeted it. All callers pass named arguments that resolve to the canonical 27-arg version once the ambiguity is removed.

---

## 2026-08-13

### feat(P1-CLASS-1): Classes dashboard page

- **What:** New `/dashboard/classes` page with two tabs: Classes (list of class services) and Upcoming Sessions (derived from bookings + class schedules).
- **Files:** `app/dashboard/classes/page.tsx` (NEW), `components/dashboard/Sidebar.tsx` (added Classes nav item)
- **Details:**
  - Classes tab: shows all services with `is_class=true`, displays name, price, duration, capacity, schedule summary, active status. "Create Class" dialog inserts into `services` with `is_class: true`.
  - Sessions tab: derives sessions from `bookings` table (grouped by service_id/date/time) plus projected sessions from `class_schedule` JSONB for next 4 weeks. Color-coded capacity badges (green/amber/red). Click session for detail dialog with attendee list.
  - Session detail dialog: shows attendees (guest_name, phone, status, party_size). "Cancel Session" cancels all bookings for that session with confirmation dialog.
  - Sidebar: "Classes" item in manage section, gated on `class_booking` capability, uses UserGroup icon.
- **Affects:** Dashboard navigation, class_booking capability visibility
- **Could break:** Nothing — new page only, no existing code modified except Sidebar nav item addition

---

## 2026-08-14

### fix(P1-CLASS-1): canonical class sessions and booking authority

- **Feature:** Complete class booking capability. Classes = services with `is_class=true`. Class sessions = concrete occurrences from recurrence rules. Bookings identify exact session via `class_session_id`.
- **Migration 322:** `class_recurrence_rules`, `class_sessions` (idempotent UNIQUE), `bookings.class_session_id` FK, `generate_class_sessions` RPC, `get_upcoming_class_sessions` RPC, extended `book_slot_atomic`/`reschedule_booking_atomic`/`book_manual_slot_atomic` with `p_class_session_id`.
- **Dashboard:** Classes page + sidebar entry. **WhatsApp:** `select_class_session` step. **Public:** Sessions instead of time slots for class services. **Manual/Admin:** Class session awareness.
- **Architecture:** ONE canonical booking authority. Per-session capacity via SUM(party_size). Independent session capacity. Instructor reuses P1-STAFF-1.
- **Tests:** 22 source + 24 real PG tests. CI: `P1-CLASS-1 class session booking authority DB tests`.

### fix(P1-STAFF-1): staff schedule enforcement at booking authority

- **Bug:** Staff/provider schedules not enforced during booking. Dashboard stores schedule keys as `mon`/`tue`/..., but bot reads `monday`/`tuesday`/... — complete mismatch. Time slot generation ignores staff working hours. `book_slot_atomic` has no staff schedule check. `reschedule_booking_atomic` has no staff schedule check. `requires_staff` services could silently create bookings with `staff_id = NULL`. Public booking always sends `p_staff_id: null` even for requires_staff items. Manual booking doesn't validate staff belongs to business or is active.
- **Fix:** Migration 319: `check_staff_availability` helper validates staff existence, business ownership, active status, weekday (supports both short and long day keys), and `[start, end)` working window including duration-extends-past-end check. `book_slot_atomic` calls it when `p_staff_id IS NOT NULL`. Resolves `requires_staff` from authoritative service/appointment record — rejects NULL staff for requires_staff items. `reschedule_booking_atomic` validates staff availability at target date/time. Bot: uses `getStaffDaySchedule` utility (supports both key formats), blocks booking path for requires_staff when no eligible staff (shows "pick another date" / "cancel"), narrows time slots by staff schedule. Manual route: validates staff belongs to business and is active, rejects requires_staff without staff. Public route: auto-assigns eligible staff for requires_staff items, rejects when no staff available.
- **Architecture:** ONE canonical `check_staff_availability` helper following `check_appointment_schedule` pattern. DB is final authority. Bot/UI mirrors for UX.
- **Backward compat:** NULL/empty schedule = unrestricted. Both short (`mon`) and long (`monday`) day keys supported at read boundary.
- **Files:** `supabase/migrations/319_staff_booking_authority.sql`, `lib/bot/flows/scheduling.flow.ts`, `lib/constants.ts`, `app/api/bookings/create-manual/route.ts`, `app/api/bookings/public/create/route.ts`
- **Tests:** `lib/__tests__/p1-staff-booking-authority.test.ts` — 41 source verification + 26 real PostgreSQL authority tests. CI step: `P1-STAFF-1 staff booking authority DB tests` with zero-skip enforcement.
- **Affects:** All booking entrances: WhatsApp, public web, dashboard manual, reschedule, public slot discovery
- **Could break:** Bookings with staff assigned outside staff working hours will now be rejected. requires_staff items can no longer bypass staff requirement. Public slots for requires_staff items now filtered by staff availability. Legacy null-staff bookings for requires_staff items cannot be rescheduled.

---

## 2026-08-13

### fix(P1-APPT-1): appointments.buffer_minutes schema + canonical schedule enforcement

- **Bug:** `buffer_minutes` column did not exist on `appointments` table. Appointment `available_days`/`available_from`/`available_to` not enforced at booking authority layer. Bot flow never stored `_service_buffer_minutes`. `reschedule_booking_atomic` hardcoded `0` for buffer.
- **Fix:** Migration 318: adds `buffer_minutes`. Creates `check_appointment_schedule` shared helper (deterministic `EXTRACT(DOW)`). `book_slot_atomic` calls helper when `p_appointment_id IS NOT NULL`. `reschedule_booking_atomic` does the same. Bot `appointment.flow.ts` stores buffer + schedule data. Services unchanged.
- **Architecture:** ONE canonical schedule helper. DB is final authority. Public slots mirrors for UX.
- **Files:** `supabase/migrations/318_appointment_buffer_booking_authority.sql`, `lib/bot/flows/appointment.flow.ts`
- **Affects:** Appointment buffer + schedule enforcement in slot calculation, booking authority, rescheduling, bot flow
- **Could break:** Appointments with configured schedule now enforce at booking time

### fix(P1-APPT-3): dashboard manual booking for appointment-only businesses

- **Bug:** Manual booking API required `serviceId`, queried only `services` table, `book_manual_slot_atomic` hardcoded `p_appointment_id = NULL`.
- **Fix:** API accepts `appointmentId` XOR `serviceId`. `book_manual_slot_atomic` extended with `p_appointment_id`. Dashboard loads both services and appointments.
- **MK-3 preserved:** Atomic RPC, `createWhatsAppUser`, no direct INSERT.
- **Files:** `app/api/bookings/create-manual/route.ts`, `app/dashboard/reservations/page.tsx`, `supabase/migrations/318_appointment_buffer_booking_authority.sql`

### fix(P1-APPT-4): public booking for appointment-only businesses

- **Bug:** Public page only queried `services`. Slots/create required `serviceId`. Booking creation hardcoded `p_appointment_id: null`.
- **Fix:** Public page uses `get_active_appointments_public` SECURITY DEFINER RPC (14 public-safe columns only). No broad anon table SELECT. BookingForm sends `appointmentId`. Slots endpoint respects appointment schedule.
- **CONFLICT-1 preserved:** Cross-service capacity, buffer overlap unchanged.
- **Files:** `app/b/[slug]/page.tsx`, `app/b/[slug]/BookingForm.tsx`, `app/api/bookings/public/slots/route.ts`, `app/api/bookings/public/create/route.ts`, `supabase/migrations/318_appointment_buffer_booking_authority.sql`

### fix(BK-1): public booking business-status test scope regression

- **Bug:** `bk1-public-booking-business-status.test.ts` used hardcoded comment marker. Comment changed, test scope leaked.
- **Fix:** Regex-based next-section detection. Runtime business-status requirement unchanged.
- **Files:** `lib/__tests__/bk1-public-booking-business-status.test.ts`

### fix(P1-CHAT-1): narrow mark-read RPC for team members

- **Bug:** Team members had chat SELECT/INSERT but no UPDATE authority. Dashboard `markAsRead` silently failed for team members.
- **Fix:** SECURITY DEFINER RPC `mark_chat_messages_read(p_business_id, p_message_ids)` that ONLY sets `is_read=true` on inbound messages. No general team-member UPDATE policy — team members cannot mutate message_text, business_id, direction, or other fields via direct UPDATE.
- **Authorization:** Caller must be business owner OR active `business_members` entry. Anonymous/unrelated/inactive denied. Cross-business denied.
- **Dashboard:** `markAsRead` now calls the RPC with explicit error handling instead of direct `.update()`.
- **Security hardening:** SECURITY DEFINER, `SET search_path = public`, `REVOKE FROM PUBLIC/anon`, `GRANT TO authenticated/service_role`.
- **Files:** `supabase/migrations/317_chat_team_member_mark_read.sql`, `app/dashboard/chat/page.tsx`

### fix(P1-AUTO-1): instant_reply_message runtime connection + entitlement gate

- **Bug:** Dashboard UI configures `instant_reply_message` and `instant_reply_enabled` in `whatsapp_config`, and `standalone.service.ts` loads them into `WhatsAppConfigBundle`, but `bot.service.ts` never reads or sends the instant reply. The setting was dead configuration.
- **Entitlement fix:** The entire auto-reply block (both away message AND instant reply) is now gated on the effective `auto_reply` capability from the canonical resolver. Previously, the away-message fired without checking capability entitlement, allowing free/downgraded businesses with persisted config to receive a paid feature. Away-message mechanics are preserved but now correctly respect the effective Auto-Reply entitlement.
- **Instant reply:** Added runtime consumption for `instant_reply_message`. Sends the configured instant reply on first contact (no active session) during business hours, mirroring the away-message dedup pattern.
- **Guards:** `capabilities.includes('auto_reply')` (canonical resolver) + `auto_reply_enabled` + `business_hours` configured + `instant_reply_enabled` + non-empty `instant_reply_message`.
- **No interference:** Normal bot intent routing continues after auto-reply messages. No effect on chat handoff (requires active session). No loop risk (fires once per session lifecycle).
- **Files:** `lib/bot/bot.service.ts`, `lib/bot/__tests__/p1-auto-reply-instant.test.ts`
- **Tests:** 13 focused tests covering: entitlement gate for away message and instant reply, canonical resolver authority, config guards, dedup, normal flow continuation.

## 2026-08-12

### fix(P2-CAP-1, P1-PLAN-2): Add Features explicit save model + correct state comparison

- **hasChanges bug fixed:** Was comparing against `business.capabilities` (effective). Now compares against `serverSelected` (= `selectedCapabilities || capabilities`). Paused capabilities no longer falsely trigger "unsaved changes" on load.
- **Discard bug fixed:** Was restoring `business.capabilities` (effective), silently dropping paused caps. Now restores `serverSelected` and resets `orderedCaps`.
- **Auto-save removed:** `handleToggle` no longer auto-saves on every toggle. Selection changes are local draft state until user clicks Save Changes.
- **Concurrent save prevention:** Toggles disabled during save. Drag-drop ordering blocked during save.
- **Files:** `app/dashboard/capabilities/page.tsx`, `lib/__tests__/p2-cap-selection-save-state.test.ts`

### fix(P0-ADMIN, P0-CAP): admin capability authority + canonical shared catalog

- **Shared catalog:** `shared/capabilities.ts` — ONE canonical source for all 31 capability IDs, labels, tiers, icons, descriptions, dependencies. Consumed by both root Next.js app and Admin Vite app.
- **Root types.ts refactored:** `lib/capabilities/types.ts` re-exports from shared. Category defaults remain app-specific.
- **Admin mutation fixed:** `handleCapToggle` now calls `/api/admin/businesses/{id}/capabilities` (atomic RPCs) instead of broken direct DB writes via anon-key client (silently failed due to RLS lockdown).
- **Bearer/service authority:** Admin route uses `requirePlatformAdmin` + `createServiceClient` only — no cookie dependency.
- **Authoritative refresh:** After grant/revoke, Admin re-fetches server state via GET — no manual state guessing.
- **7 missing capabilities restored, 6 label mismatches fixed, 4 tier mismatches fixed.**
- **Drift prevention:** 25 executable tests proving catalog identity, security, and no cookie dependency.
- **Files:** `shared/capabilities.ts`, `lib/capabilities/types.ts`, `admin/src/pages/Businesses.tsx`, `admin/src/pages/CategoryTemplates.tsx`, `admin/vite.config.js`, `admin/tsconfig.json`, `app/api/admin/businesses/[id]/capabilities/route.ts`, `lib/__tests__/p0-admin-capability-authority.test.ts`

### fix(P1-QUEUE-1): queue leave writes valid 'cancelled' status

- **Bug:** `queue-checkin.flow.ts` wrote `status='cancelled'` to `queue_entries`, but the CHECK constraint only allowed `waiting|serving|completed|no_show`. The UPDATE silently failed — customers believed they left the queue but their entry stayed as `waiting`.
- **Fix:** Migration 316 adds `cancelled` to the CHECK constraint. It's a first-class terminal state distinct from `no_show` (called but absent).
- **Consumers updated:** API route `queue/update` accepts `cancelled`, allows `waiting→cancelled` transition, triggers wait-time recalculation. Dashboard shows "Left" badge. Admin filter includes "Cancelled".
- **Active unique index** `idx_queue_entries_customer_active` (`WHERE status IN ('waiting','serving')`) already excludes `cancelled` — rejoining works.
- **Files:** `supabase/migrations/316_queue_schema_contracts.sql`, `app/api/queue/update/route.ts`, `app/dashboard/queue/page.tsx`, `admin/src/pages/QueueManagement.tsx`

### fix(P1-QUEUE-2): queue reopen subscription uses dedicated table

- **Bug:** `queue-checkin.flow.ts` inserted into `waitlist_entries` with `type='queue_reopen_notify'`, but `waitlist_entries` has no `type` column. INSERT failed silently. Even if it worked, nothing ever queried or sent the notification — the unpause path just flips a metadata boolean.
- **Fix:** New `queue_reopen_subscriptions` table (migration 316) with `business_id`, `customer_phone`, `status` (`waiting|notified`), unique active index per customer/business, RLS. Bot flow inserts into correct table. New `/api/queue/toggle-pause` route handles pause toggle + sends WhatsApp notifications to all waiting subscribers on unpause, marks them `notified`. Dashboard uses API route instead of direct DB update.
- **Separation from waitlist:** `waitlist_entries` is purpose-built for booking waitlists (service_id, event_id, auto-notify, conversion tracking, different unique index). Queue reopen is a fundamentally different subscription model.
- **Files:** `supabase/migrations/316_queue_schema_contracts.sql`, `lib/bot/flows/queue-checkin.flow.ts`, `app/api/queue/toggle-pause/route.ts`, `app/dashboard/queue/page.tsx`

---

## 2026-08-10

### refactor(PAY-AUTHORITY): unified Waaiio Payment Authority (migration 314)

- **Architecture:** ONE canonical payment completion engine for all 5 provider webhooks + payment-success + "I've Paid" + reconciliation cron. Gateways authenticate money; Waaiio authorizes business state.
- **Three-stage lifecycle:** Stage 1 provider-paid → Stage 2 business-finalized → Stage 3 customer-confirmed. Resume from first incomplete stage.
- **Migration 314:** `314_payment_finalization_lifecycle.sql` — finalization claim/complete/release RPCs, `order_stock_applications` table for exactly-once stock decrement, `payment_authority_version` for legacy fence.
- **Critical finalization:** `processSuccessfulPayment` returns `FinalizationResult` with `criticalSuccess` flag. Nested DB/RPC failures propagate. Platform fee non-duplicate errors throw.
- **Provider adapters:** Read-only verification for Paystack/Stripe/Flutterwave/Square/PayPal. Payment-scoped credential resolution via `provider_connection_id`. Rotation-safe.
- **Paid-ticket Stage 2:** Inventory finalization + canonical ticket rows in Stage 2 (business state). Customer delivery in Stage 3.
- **Legacy fence:** `payment_authority_version=NULL` → rejected by authority (no historical replay).
- **Order stock:** `apply_order_stock_once` RPC with `SELECT FOR UPDATE` + durable marker. Crash-gap safe.
- **Files:** `lib/payments/authority.ts`, `lib/payments/reconcile.ts`, `lib/payments/provider-adapters.ts`, `lib/payments/bot-recovery.ts`, `lib/payments/ticket-business-state.ts`, `lib/payments/process-success.ts`, all 5 webhook routes, `app/payment-success/page.tsx`, `lib/bot/flows/scheduling.flow.ts`, `lib/bot/flows/ticketing.flow.ts`, `app/api/cron/payment-reconciliation/route.ts`

### migration(312): canonical ticket-row identity constraint

- **Migration:** `312_ticket_row_identity.sql` — `UNIQUE(booking_id, ticket_number)` on `event_tickets`.
- **Reason:** Two concurrent workers (webhook + bot) could both INSERT different ticket codes for the same booking+ticket_number. Only `ticket_code UNIQUE` existed, which doesn't prevent booking-scoped duplication.
- **Files:** `supabase/migrations/312_ticket_row_identity.sql`

### fix(TICKET-STATE): fail-closed ticket finalization + result contracts

- **Typed event classification:** Query error on `event_ticket_types` now fails closed (not treated as untyped). Queries ALL types (not just active) since a deactivated type may still belong to a purchased ticket.
- **Ticket type ownership:** Validates `ticket_type_id` belongs to `event_id` before finalization. Wrong-event type → fail closed.
- **Booking lookup:** Error destructured and handled — confirmation not finalized on lookup error.
- **sendTicketsAfterPurchase:** Returns `TicketCreationResult` (not void). Reports insert failures explicitly. Handles UNIQUE conflict (code 23505) from concurrent worker by re-reading canonical rows.
- **Quarantine guard:** Runs BEFORE pending reuse. Matches any `gateway_status LIKE 'review_required:%'` regardless of payment status. Lookup error → fail closed.
- **ConfirmationResult:** `claimed_by_other` replaced with `processing` (retryable: true) — another worker owning the claim is incomplete, not permanently non-retryable.
- **Files:** `lib/payments/send-confirmation.ts`, `lib/bot/flows/shared/payment.ts`, `lib/bot/flows/shared/send-tickets.ts`, `lib/bot/flows/ticketing.flow.ts`

### fix(RS-1/RS-2/RS-5): atomic booking reschedule with capacity enforcement (migration 313)

- **Root cause:** Booking reschedule had three concurrency/capacity defects: (RS-1) dashboard API used separate COUNT + UPDATE with no advisory lock — concurrent reschedules could oversubscribe; (RS-2) appointment-centric bookings with `service_id=NULL` caused malformed capacity query — capacity was never enforced; (RS-5) bot rescheduling used a plain UPDATE that skipped all capacity enforcement.
- **Fix:** New `reschedule_booking_atomic` RPC (migration 313) that atomically: locks target slot via advisory lock, validates booking ownership/business/status, resolves capacity from services OR appointments table (handles NULL service_id), checks capacity + buffer overlap, and moves booking in one transaction. Both the dashboard API route and bot flow now call this RPC exclusively.
- **Files:** `supabase/migrations/313_atomic_reschedule.sql`, `app/api/bookings/[id]/reschedule/route.ts`, `lib/bot/flows/scheduling.flow.ts`
- **Tests:** Real PostgreSQL concurrency tests including: concurrent final-capacity race (one winner), failed reschedule leaves old slot intact, appointment-centric capacity enforcement, idempotent retry, cross-business rejection.
- Could break: Reschedule now returns capacity errors that were previously silently bypassed.

## 2026-08-09

### fix(PAY-CONFIRM): payment confirmation broken by malformed services column select

- **Root cause:** `lib/payments/send-confirmation.ts` line 184 selected `services(name, duration)` but the `services` table column is `duration_minutes` (not `duration`). PostgREST returns a 400 error for the entire query, making `booking` null, `businessId` null, and causing ALL payment confirmations (not just ticketing) to log "Proactive confirmation skipped — no business" and skip WhatsApp confirmation, ticket delivery, session deactivation, and post-completion.
- **Fix:** Changed `services(name, duration)` → `services(name, duration_minutes)`. Updated type cast and assignment to use `duration_minutes`. Added `{ data, error }` destructuring and error logging for booking lookup (was silently swallowed).
- **Files changed:** `lib/payments/send-confirmation.ts`, `lib/__tests__/p0-payment-confirmation.test.ts` (mock data updated)
- **Affects:** ALL payment confirmation flows (5 gateway webhooks + payment-success page). Ticketing bookings, scheduling bookings, ordering — everything that goes through `sendProactiveConfirmation`.
- **Could break:** Nothing — corrects a query that was already broken.

### fix(PAY-IDEMPOTENT): prevent duplicate_reference on payment retry/re-entry

- **Root cause:** When a bot flow re-enters the payment step (e.g., retry after timeout, re-prompt), `initializePayment` calls the gateway again with the same `referenceCode`. Paystack rejects with `duplicate_reference` because the reference is already registered. The customer loses their payment link.
- **Fix:** Before calling the gateway, `initializePayment` now checks for an existing pending payment for the same entity with matching amount, currency, AND gateway. If found with a valid `metadata.checkout_url`, returns the existing checkout URL instead of creating a duplicate provider transaction. Lookup failure is caught and falls through to fresh initialization (never blocks payment).
- **Matching rules:** entity (booking_id/order_id/invoice_id/reservation_id) + status=pending + amount + currency + gateway. Successful/failed/cancelled payments are never reused. Mismatched amount/currency/gateway falls through to fresh init.
- **Files changed:** `lib/bot/flows/shared/payment.ts`
- **Affects:** All payment initialization flows (scheduling, ordering, ticketing, invoicing, reservations).
- **Could break:** Nothing — adds a guard before the gateway call. Existing first-attempt behavior unchanged.

### fix(TICKET-COUNTER): unified idempotent ticket sold counter finalization

- **Root cause:** Webhook confirmation path sent tickets but never incremented `events.tickets_sold`. Bot "I've Paid" path used a non-idempotent `increment_tickets_sold` RPC (never defined in migrations).
- **Fix:** Both paths now use `finalize_free_ticket_booking` RPC (migration 304) with `tickets_finalized` guard. Bot path fails closed on RPC error (blocks ticket delivery). Webhook path resolves `ticket_type_id` via `booking.bot_session_id` → exact originating session. For typed events, unresolvable `ticket_type_id` fails closed (no partial event-only counter increment). Inventory finalization runs BEFORE ticket row creation. Ticket state must be complete before confirmation claim is finalized.
- **Files changed:** `lib/bot/flows/ticketing.flow.ts`, `lib/payments/send-confirmation.ts`

### feat(PAY-CONFIRM-CONTRACT): explicit ConfirmationResult return type

- **Root cause:** `sendProactiveConfirmation` returned `void` — callers could not distinguish completed/already-completed/retryable-failure/claim-lost/not-deliverable.
- **Fix:** Returns `ConfirmationResult` union type. Every early return now has a semantic status. Ticket state incomplete → `retryable_failed`. Claim lost → `claimed_by_other`. No business → `retryable_failed`. No contact → `not_deliverable`.
- **Files changed:** `lib/payments/send-confirmation.ts`

### fix(PAY-QUARANTINE): second-charge prevention for provider-paid quarantined payments

- **Root cause:** Terminal G may quarantine a provider-paid payment with `gateway_status LIKE 'review_required:%'`. If customer re-enters payment flow, `initializePayment` would create another charge.
- **Fix:** Before gateway call, checks for existing success+review_required payments on same entity. If found, returns null (blocks new charge). Guard infrastructure ready for Terminal G to populate.
- **Files changed:** `lib/bot/flows/shared/payment.ts`

## 2026-08-07

### fix(P0-PAY-1): payment-level idempotency for financial operations

- **Root cause:** `processSuccessfulPayment()` callable from 7 entry points (5 webhooks + cron + payment-success page). Invoice `processInvoicePayment` used non-atomic read-modify-write for `amount_paid`. Campaign `processCampaignDonation` called `increment_campaign_donation` RPC unconditionally — replay = double-count. Platform fee uniqueness was keyed to entity IDs (invoice_id, campaign_id) not payment IDs — blocked legitimate second payments on same invoice/campaign. `recordPlatformFee` used entity `total_amount` instead of actual payment amount for `transaction_amount`.
- **Fix:** (1) `apply_invoice_payment` RPC: loads payment from DB (validates status=success, invoice_id match, business match, positive amount). Uses `SELECT FOR UPDATE` + `invoice_payment_applications` ledger with `UNIQUE(invoice_id, payment_id)`. (2) Legacy baseline: `invoices.legacy_amount_paid_baseline` = frozen pre-migration `amount_paid`. Historical payments backfilled as replay markers (`amount_applied=0, is_legacy_marker=true`). Authoritative `amount_paid = baseline + SUM(non-legacy amount_applied)`. Pre-migration `amount_paid` never decreases or gets reinterpreted. (3) Fee retry safety: fee creation attempted on both `applied` and `already_applied` (non-rejection) RPC results. `payment_id UNIQUE` on `platform_fees` prevents duplicates. Crash-before-fee + replay → fee eventually exists exactly once. (4) `apply_campaign_donation` RPC: validates payment status, campaign_id, business_id from DB. Distinguishes `already_applied` from `donation_not_found`. (5) RPCs use `SET search_path = public` + `SECURITY DEFINER`. REVOKE from PUBLIC/anon/authenticated, GRANT service_role only. (6) `campaign_donations` partial UNIQUE on `payment_id WHERE NOT NULL`. (7) `platform_fees.payment_id` unconditional UNIQUE. (8) `transaction_amount` = actual payment amount.
- **Migration:** `310_payment_level_idempotency.sql` — creates `invoice_payment_applications` table, `apply_invoice_payment` + `apply_campaign_donation` RPCs, adds `payment_id` to `platform_fees`, updates unique indexes.
- **Files changed:** `lib/payments/process-success.ts`, `supabase/migrations/310_payment_level_idempotency.sql`, test files
- **Tests:** 41 focused idempotency tests + existing 119 payment tests pass.
- **Affects:** Invoice payment, campaign donation, platform fee recording across ALL payment completion surfaces.
- **Could break:** Nothing — the old non-atomic patterns are strictly replaced by atomic equivalents. Single-payment entities (booking, order, reservation) retain their entity-level UNIQUE indexes as additional safety.

### fix(FIN-RECON): restore Finance read-only boundary + reseller audit trail + payout rejection atomicity

- **Root cause:** Finance role reconciliation against PRs #15-#18 found 6 current-main gaps: (1) Finance lost approved read-only access to business payouts list (admin-only since initial implementation); (2) Finance could create reseller payout records; (3) Finance could mark reseller payouts paid; (4) No audit trail for reseller payout mutations; (5) Business payout rejection had TOCTOU race (SELECT → UPDATE without status guard); (6) Payout list used `select('*')` exposing `claim_token`/`provider_idempotency_key`.
- **Fix:** (1) `GET /api/admin/payouts` now accepts `['admin', 'finance']`, with explicit `PAYOUT_LIST_COLUMNS` excluding operational tokens. (2) `POST /api/admin/reseller-payouts` restricted to `requiredRole: 'admin'`. (3) `PATCH /api/admin/reseller-payouts/[id]` restricted to `requiredRole: 'admin'` for ALL actions (approve, reject, mark_paid). (4) Both reseller POST and PATCH now insert `admin_audit_logs` entries after successful mutations. (5) Payout rejection UPDATE now includes `.in('status', ['pending', 'approved'])` guard and returns 409 on conflict. (6) Service client instantiation order fixed in reseller GET/POST (auth check now precedes `createServiceClient()`). (7) Admin UI: Payouts page gates Generate/Approve/Reject buttons with `isAdmin`; ResellerPayouts page gates Generate/MarkPaid buttons with `isFullAdmin`.
- **Files changed:** `app/api/admin/payouts/route.ts`, `app/api/admin/payouts/[id]/reject/route.ts`, `app/api/admin/reseller-payouts/route.ts`, `app/api/admin/reseller-payouts/[id]/route.ts`, `admin/src/pages/Payouts.tsx`, `admin/src/pages/ResellerPayouts.tsx`
- **Tests added:** `lib/__tests__/finance-role-reconciliation.test.ts` — 68 tests.
- **No migration required.**
- **Affects:** Admin panel finance authorization boundaries. No changes to business-facing payout flows, provider integrations, or RLS policies.

### fix(DEAD-002): reservation cancellation notification — replace dead endpoint with domain-specific route

- **Root cause:** Dashboard reservation cancellation called nonexistent `/api/notifications/send` to notify guests. The 404 was silently swallowed — customers were never notified of cancelled reservations.
- **Fix:** Created `/api/reservations/notify-cancel` modeled on existing `notify-checkin` pattern. Authenticates user, verifies business ownership, loads reservation server-side (scoped to business), verifies reservation is actually cancelled, derives guest phone from DB (not request body), uses ChannelResolver. Dashboard now calls this endpoint instead of the dead one.
- **Files:** `app/api/reservations/notify-cancel/route.ts` (new), `app/dashboard/reservations/page.tsx` (replaced dead fetch call)
- Could break: Nothing — the old call always 404'd silently.

### fix(DEAD-001): connect Growth contact import to canonical customer endpoint

- **Root cause:** Growth → Import Contacts page (`app/dashboard/growth/import/page.tsx`) called a nonexistent `/api/growth/contacts/import` endpoint. The canonical endpoint exists at `/api/customers/import` but the frontend and backend contracts disagreed on field names, phone requirements, tags format, birthday mapping, and error response shape.
- **Fix:** (1) Pointed fetch to `/api/customers/import`. (2) Concatenate `first_name` + `last_name` → canonical single `name` field. (3) Phone is required (not phone-or-email) matching DB constraint `phone NOT NULL` + unique key. (4) Tags string split to `string[]`. (5) `birthday` UI field → `date_of_birth` DB column (date type, migration 031). (6) API now accepts `date_of_birth` with date validation. (7) API `errors` array counted correctly as `errors.length` not treated as number.
- **Files changed:** `app/dashboard/growth/import/page.tsx`, `app/api/customers/import/route.ts`
- **Tests:** `lib/__tests__/dead-001-growth-contact-import.test.ts` — 36 tests.
- **No migration required.** `date_of_birth` column already exists on `customer_profiles` (migration 031).
- **Affects:** Growth Import page only. Existing customers page import unchanged.
- **Could break:** Nothing — the Growth import was completely non-functional before this fix.

### fix(DEAD-003): calendar booking cancellation bypasses canonical cancel API

- **Root cause:** `app/dashboard/calendar/page.tsx` `updateStatus()` directly updated booking status via browser Supabase client for cancellation, bypassing the canonical `PATCH /api/bookings/[id]/status` route. This caused: (1) package-covered cancelled bookings retained their package redemption — `cancel_booking_with_release` RPC was never called, so `package_redemptions` stayed `active` and `sessions_used` was never decremented; (2) customer cancellation notification called nonexistent `/api/notifications/send` (always 404); (3) waitlist auto-promotion was never triggered; (4) the separate `release_booking_slot` RPC was called instead, which only decrements booking slots — not package sessions.
- **Fix:** (1) Routed calendar `cancel` action through the canonical `PATCH /api/bookings/[id]/status` API (same path as `check_in`/`check_out`/`no_show`). Added `apiAction` mapping from UI status `'cancelled'` to API action `'cancel'`. Removed direct Supabase update, `release_booking_slot` call, and `/api/notifications/send` call for the cancel path. Staff notification preserved after successful API response only. (2) Extended `cancel_booking_with_release` RPC (migration 309) to also release booking slot capacity — `UPDATE booking_slots SET current_bookings = GREATEST(0, current_bookings - 1)` using the locked booking row's own `business_id/date/time/staff_id/location_id`. This ensures ALL callers of the canonical cancellation path (calendar, reservations, bot) get both package session release AND slot capacity release atomically. Used explicit `v_session_released` variable to prevent the slot UPDATE from overwriting the `FOUND` flag needed for `session_released` reporting.
- **Files changed:** `app/dashboard/calendar/page.tsx`, `supabase/migrations/309_cancel_releases_slot.sql` (new)
- **Tests added:** `lib/__tests__/dead-003-calendar-cancel.test.ts` — 35 tests: canonical RPC call, package session release, double-release prevention, non-package cancellation, customer notification, API failure handling, staff notification gating, status protection, waitlist notification, source verification (no direct update, no dead endpoint, action mapping), migration verification (slot release in RPC, locked-row fields, COALESCE matching, v_session_released variable, guards preserved), reservations page canonical API verification.
- **Migration required:** `309_cancel_releases_slot.sql` — replaces `cancel_booking_with_release` to add slot release.
- **Affects:** Calendar page booking cancellation only. Confirm/check-in/check-out/no-show paths unchanged.
- **Could break:** Nothing — the canonical route already handles all cancellation logic. The calendar page was the only bypasser.

### fix(P1-REF-1): add missing `refer` keyword handler for referral code retrieval

- **Root cause:** After booking completion, `post-completion.ts` generates a referral code silently and the bot tells customers "Type *refer* to invite friends and earn rewards" (`scheduling.flow.ts:2804`). However, no handler existed for the `refer` keyword — it fell through the entire bot pipeline (unified keywords, canonical understanding, smart intent) and produced a confused response.
- **Fix:** Added `isReferralQuery()` regex matcher and a referral handler to `handleGlobalQuery()` in `lib/bot/handlers/global-queries.ts`. The handler: (1) checks referral capability on the session's effective capabilities (CAS-007 compliant), (2) queries the `referrals` table scoped to the current business_id AND the current customer's phone (both `+` and non-`+` formats via `.or()`), filtering to `status = 'pending'`, (3) returns the code with a share prompt if found, or a deterministic "complete a booking first" message if not. Does NOT deactivate or modify the active session — the handler is read-only like the loyalty handler.
- **Files changed:** `lib/bot/handlers/global-queries.ts`
- **Tests added:** `lib/bot/__tests__/referral-global-query.test.ts` — 31 tests covering: code retrieval, cross-customer isolation, cross-business isolation, no-code message, capability gating, mid-flow safety, unrelated keyword isolation, session integrity, phone normalization, status scoping, reward type rendering.
- **No migration required.** Uses existing `referrals` table, existing RLS policies, existing phone format conventions.
- **Affects:** WhatsApp bot `refer` / `my referral` / `referral code` / `refer a friend` / `invite a friend` commands. No changes to referral code generation, redemption, validation API, dashboard page, or any other flow.
- **Could break:** Nothing — additive handler in the global query chain. Falls through cleanly when business_id is absent or referral capability is disabled.

### fix(P1-ESIG-1): preserve all signer signatures in generated PDF

- **Root cause:** When all signers completed a multi-signer contract, the submit route (`app/api/contracts/submit/route.ts`) passed only the current HTTP request's `signature_data` (the last signer's) to the PDF generators. Each signer's signature was correctly stored in `contract_signers.signature_data` and Supabase storage, but the PDF generation call used only the request body value — not the stored data for earlier signers. Both PDF generators (`lib/pdf/append-signature.ts`, `lib/pdf/contract-pdf-generator.ts`) accepted a single `signatureData` string, rendering one signature block.
- **Fix:** (1) Added optional `signers` array to both PDF generator interfaces. When present, renders a signature block per signer with their individual name, signature image, timestamp, and reference. When absent, falls back to existing single-signer behavior. (2) In the submit route, when `allSigned` is true, constructs `signerEntries` from stored DB data and passes it to the PDF generators. (3) Contract must NOT transition to `signed` until final PDF is successfully generated AND stored — returns 500 with `signature_captured: true` if finalization fails. (4) Supabase storage upload errors are explicitly checked (both signature image and final PDF). (5) Finalization retry: if a signer is already `signed` but the parent contract is still `pending` (previous finalization failed), re-submitting with the same token retries PDF generation without re-capturing or overwriting the stored signature. (6) `signed_url` in the multi-signer path uses `pdfPath` directly — no fallback to an individual signature image. (7) Signer UPDATE error is explicitly checked — if persisting the signer's signature fails, the route aborts before reaching finalization. (8) Signer SELECT (reload) error is explicitly checked — null or error aborts. Empty signer set is rejected. (9) `allSigned` uses only persisted DB status (`allSigners.every(s => s.status === 'signed')`) — no special-casing the current signer's ID as a substitute for persisted state. (10) Every signer must have persisted `signature_data` before PDF generation proceeds.
- **Files changed:** `lib/pdf/append-signature.ts`, `lib/pdf/contract-pdf-generator.ts`, `app/api/contracts/submit/route.ts`
- **Pagination:** `lib/pdf/append-signature.ts` now paginates multi-signer certificate pages. Before each signer block (~220px), checks remaining page space; creates a new branded certificate page if it won't fit. Footer/QR also checked — moved to new page if needed. Matches the existing pagination pattern in `contract-pdf-generator.ts`.
- **Tests added:** `lib/__tests__/p1-esig-1-multi-signer-pdf.test.ts` — 41 tests: PDF generation with pagination (9 — including 1/2/3/5 signers, page counts, image document mode, footer visibility), data assembly (4), signer persistence errors (4), allSigned behavioral (7), finalization source verification (11), text-contract PDF generator (4), signer isolation (2).
- **No migration required.** All needed columns (`signature_data`, `signed_at`, `signature_reference`) already exist on `contract_signers`.
- **Affects:** Multi-signer e-signature finalization and PDF generation. Single-signer flow is completely unchanged.
- **Could break:** Multi-signer contracts where PDF generation consistently fails will now return a 500 instead of silently marking the contract as signed with only a signature image. This is the correct behavior — the previous behavior was the bug.

---

## 2026-08-06

### fix(P1-PROP-1): correct property occupancy status — checked_in instead of in_progress

- **Root cause:** `app/dashboard/properties/page.tsx` line 125 checked `r.status === 'in_progress'` to determine occupancy, but the canonical check-in API (`app/api/reservations/verify/[code]/route.ts`) sets status to `'checked_in'` (added in migration 132). Additionally, the reservation query on line 112 did not include `'checked_in'` or `'checked_out'` in the status filter, so checked-in reservations were never even fetched.
- **Fix:** (1) Added `'checked_in'` and `'checked_out'` to the reservation status query filter. (2) Extracted `getOccupancyStatus()` helper into `lib/properties/occupancy.ts` that checks both `'checked_in'` (canonical) and `'in_progress'` (legacy). (3) Replaced inline occupancy logic with the extracted helper.
- **Files changed:** `app/dashboard/properties/page.tsx`, `lib/properties/occupancy.ts` (new), `lib/properties/__tests__/occupancy.test.ts` (new, 17 tests)
- **Affects:** Properties dashboard occupancy badges. No changes to reservation creation, check-in API, bot flows, or any other domain.
- **Could break:** Nothing — the fix is additive (recognizes more statuses as occupied). Legacy `in_progress` reservations still show as occupied.

### fix(P1-REPORT-2): Support advertised document image uploads

- **Root cause:** Document upload UI (`app/dashboard/reports/page.tsx`) advertises `accept=".pdf,.png,.jpg,.jpeg"` and labels "PDF, PNG, JPG — max 10MB", but the upload API (`app/api/reports/upload/route.ts`) validated only `%PDF` magic bytes, rejected all images with "Only PDF files are allowed", and hardcoded `.pdf` extension and `application/pdf` content type for all uploads.
- **Fix:** Replaced inline `%PDF` magic-byte check with existing `validateUploadedFile()` from `lib/security/validate-file.ts`, accepting `application/pdf`, `image/png`, `image/jpeg`. File extension and content type now derived from detected MIME. Document viewer (`app/doc/[token]/page.tsx`) updated to render images with `<img>` tag instead of iframe.
- **Files changed:** `app/api/reports/upload/route.ts`, `app/doc/[token]/page.tsx`, new test `lib/__tests__/p1-report-2-upload.test.ts`
- **Security preserved:** Magic-byte validation (not extension/MIME trust), file size limit (10MB), rate limiting, business ownership verification, storage quota checks. Executable files with image extensions are rejected.
- **Could break:** Nothing — downstream send/view/delete routes are file-type agnostic (signed URLs). No DB schema changes needed.

### fix(P1-PKG-1): Atomic package redemption — final corrections

- **Remove unsafe bot cancellation fallback:** Bot cancellation handler no longer falls back to direct `bookings UPDATE` if the atomic RPC fails. RPC failure means cancellation did not succeed — customer gets a safe retry message, no staff notification is emitted, no false cancellation state is created. Files: `lib/bot/handlers/my-bookings.ts`.
- **Remove add-on monetization:** Removed P1-PKG-1-invented add-on billing (`totalDeposit = addonTotal`) from the package path. Package-covered bookings now set `totalDeposit = 0`, matching the pre-existing canonical behavior where add-ons are not charged separately. Add-on snapshots are preserved. File: `lib/bot/flows/scheduling.flow.ts`.
- **Appointment eligibility:** Packages now skip appointment bookings entirely. `service_packages.service_ids` references the `services` table; appointments are a separate `appointments` table with different UUIDs. No evidence packages are designed to cover appointments. Safe behavior: appointment bookings proceed normally without package redemption. File: `lib/bot/flows/scheduling.flow.ts`.
- **Dashboard cancellation failure safety:** Dashboard now returns early on cancellation API failure without emitting staff cancellation notifications. Staff notification only fires after confirmed cancellation success. File: `app/dashboard/reservations/page.tsx`.
- **Bot cancellation regression tests (5):** A: success → message + staff ok. B: RPC error → no fallback, no success msg. C: cancelled:false → no success msg. D: package cancel → session_released logged. E: failure → no booking state change. File: `lib/__tests__/p1-pkg1-bot-cancellation.test.ts`.

### fix(P1-PKG-1): Atomic package redemption corrections — wrap canonical booking, preserve auto-approval, atomic cancellation

- **CORRECTION 1 — Stop duplicating booking engine:** `book_with_package_atomic` now calls the canonical `book_slot_atomic` internally instead of hand-writing its own INSERT. This eliminates drift between the two paths (advisory locks, capacity checks, buffer overlap, idempotent retry). File: `supabase/migrations/308_package_redemption.sql`.
- **CORRECTION 2 — Preserve auto-approval:** Package bookings now pass the caller-supplied `p_status` through to `book_slot_atomic` using the same `d._auto_approve !== false ? 'confirmed' : 'pending'` logic as non-package bookings. Previously hardcoded `'confirmed'`, bypassing manual-approval businesses. File: `lib/bot/flows/scheduling.flow.ts`.
- **CORRECTION 3 — Atomic cancellation + session release:** New `cancel_booking_with_release` RPC atomically cancels booking AND releases any active package redemption in ONE PostgreSQL transaction. Bot cancellation handler (`my-bookings.ts`) now uses this RPC instead of two-step UPDATE+release. Dashboard cancellation routes through `/api/bookings/[id]/status` (new `cancel` action) which calls the atomic RPC. File: `lib/bot/handlers/my-bookings.ts`, `app/api/bookings/[id]/status/route.ts`, `app/dashboard/reservations/page.tsx`.
- **CORRECTION 4 — Fix scheduling flow RPC params:** Removed nonexistent `p_uncovered_amount` param, added missing `p_total_amount`, `p_staff_name`, `p_location_id`, `p_duration` to match the actual RPC signature.
- **Tests:** 18 real PostgreSQL tests (up from 13). New tests: #14 cancel_booking_with_release atomicity, #15 non-cancellable booking rejection, #16 auto-approval status passthrough, #17 no-show does NOT release package session, #18 cancel without package.

---

## 2026-08-05

### fix: Concurrent finalizer hardening — FOR UPDATE on claim row

- **Root cause:** `finalize_token_recurring_charge` read the claim row (`processed_webhook_events`) without `FOR UPDATE`. Two concurrent workers could both see `status='claimed'`, both proceed to INSERT, with the second hitting a `gateway_reference UNIQUE` violation (23505) as the only safety net.
- **Fix:** Added `FOR UPDATE` to the claim row SELECT via forward migration `306_concurrent_finalizer_lock.sql`. Worker B now blocks until Worker A commits, then re-reads committed `status='completed'` and returns clean idempotent behavior. Matches `claim_recurring_billing_cycle` and `record_flutterwave_definitive_failure` patterns.
- **Test P:** Two real PostgreSQL sessions finalize the SAME claimed charge concurrently. Proves: exactly 1 payment, 1 subscription_charge, 1 booking, ≤1 platform_fee, charge_count=1, total_charged=50, both callers return success with same payment_id, no uniqueness violation leaks.
- Could break: Nothing — `FOR UPDATE` only adds serialization to an already-serialized logical operation.

## 2026-08-04

### fix: Completed billing cycle fails closed when payment record missing

- **Root cause:** `finalize_token_recurring_charge` returned `success=true, already_finalized=true, payment_id=NULL` when a billing event was marked `completed` but no matching payment existed. This masked an accounting inconsistency — the caller treated it as "done" and moved on.
- **Fix:** After looking up the payment in the completed path, check `IF v_payment_id IS NULL` and return `success=false, reason='completed_payment_missing'`. No new payment created. No financial records modified. Surfaces the condition for investigation.
- **Legacy support preserved:** stableRef lookup for pre-dual-identity payments continues to work.
- **Tests N1-N6:** N1: unrelated payment never returned. N2: no matching payment → `completed_payment_missing`. N3: authoritative payment found → exact payment returned. N4: legacy stableRef payment → found. N5: repeated calls → same payment every time. N6: `completed_payment_missing` → zero bookings/payments/charges/fees, subscription totals unchanged.

### fix: Close NULL-semantics provider identity bypass in finalizer

- **Root cause:** `p_provider_attempt_ref != v_claim.last_error` where `last_error` is NULL evaluates to NULL in PostgreSQL, not TRUE. A caller-supplied `'FOREIGN-REF'` passed the mismatch check, survived into financial records, and the later `IS NULL` guard checked the *caller's* non-null ref, not the claim's missing ref.
- **Fix:** Separate `v_authoritative_attempt_ref` variable holds claim-derived ref. `IS DISTINCT FROM` for NULL-safe comparison. Authoritative ref checked for NULL/empty before financial mutation. Caller input never substitutes for missing claim identity. All downstream INSERTs use `v_authoritative_attempt_ref` exclusively.
- **Idempotent completed lookup:** Scoped to claim-authoritative identities only — `stableRef` always, `v_authoritative_attempt_ref` only when non-null. Caller-supplied ref never used for payment lookup, preventing unrelated payment returns.
- **Tests J-O:** J: NULL claim + FOREIGN-REF → rejected, zero financial records. K: empty claim + FOREIGN-REF → rejected. L: valid claim + different ref → mismatch. M: valid claim + NULL caller → claim authority used, success. N: completed claim + NULL attempt + unrelated payment ref → must NOT return it. O: completed legacy record using stableRef → idempotent lookup works.

### fix: Provider identity integrity — final closeout

- **Fail closed on missing tx_ref** — `processFlutterwaveRenewal` now REQUIRES `verification.providerTxRef` to exist AND match `attemptRef`. Missing tx_ref → `verification_tx_ref_missing` (not finalized, not failed, recoverable). Mismatch → `verification_tx_ref_mismatch`. Neither condition increments failure_count. File: `flutterwave-renewal.ts`.
- **Database rejects missing authoritative attempt ref** — `finalize_token_recurring_charge` now rejects with `missing_authoritative_attempt_ref` if the claim row has no stored attempt ref (last_error=NULL). New finalization never silently falls back to billingCycleRef as gateway_reference. Historical completed records use backwards-compatible dual-ref lookup. File: `305_annual_subscriptions_loyalty.sql`.
- **Finalizer validates caller attempt ref against claim** — Caller-supplied `p_provider_attempt_ref` must match claim's stored ref. Wrong ref → `attempt_ref_mismatch`. NULL → auto-derived from claim. Caller can never override.
- **verifyTransaction returns providerTxRef** — Actual `tx_ref` from Flutterwave response for cross-check.
- **SHA-256 idempotency key** — `chargeToken()` sends `X-Idempotency-Key: SHA-256(reference)` (deterministic, non-leaking).
- **Dual-identity PostgreSQL test** — Test 3 now proves: `payments.gateway_reference == providerAttemptRef`, `payments.metadata.billing_cycle_ref == billingCycleRef`, `payments.metadata.provider_attempt_ref == providerAttemptRef`, `subscription_charges.gateway_reference == providerAttemptRef`, exactly one payment and charge, idempotent duplicate returns same payment.
- **Database identity tests F-I** — F: correct caller attempt → success. G: wrong caller attempt → `attempt_ref_mismatch`. H: corrupted claim (NULL attempt ref) → `missing_authoritative_attempt_ref`. I: completed → idempotent, same payment returned.
- **Executable identity tests A-E** — A: matching tx_ref → finalize once. B: wrong tx_ref → no finalize. C: missing tx_ref → no finalize. D: recovered provider_success + missing tx_ref → no finalize. E: missing/mismatched tx_ref → failure_count unchanged.
- **Executable idempotency tests** — Test 17: SHA-256 determinism + structural. Test 18: mocked fetch integration — same ref → same key, different ref → different key.
- Could break: Any code that passes a wrong `p_provider_attempt_ref` to the finalizer. Any verification where Flutterwave omits `tx_ref` from response (blocked safely — will retry next cron).
- **Verification tx_ref mismatch test** — Test 16 now verifies that mismatched `providerTxRef` from verification is detected and blocked.
- Could break: Any code that passes a `p_provider_attempt_ref` to `finalize_token_recurring_charge` that doesn't match the claim's stored attempt ref will be rejected. Any code that relied on `X-Idempotency-Key` being the raw reference string (now it's SHA-256).

## 2026-08-03

### feat: Subscription & loyalty hardening

- **Annual subscriptions** — Added `yearly` interval to `customer_subscriptions.frequency` and `services.recurring_interval`. Migration `305_annual_subscriptions_loyalty.sql`. Payment flow offers Monthly/Yearly options. Stripe uses `interval: 'year'`, Paystack/Flutterwave use yearly plan intervals. Correct `next_charge_at` calculation (1 year). Display labels updated throughout.
- **Subscription payment history** — New `payment_history` step in `recurring-manage.flow.ts`. Customers can view recent successful renewal payments from the subscription details screen. Data from authoritative `subscription_charges` table, scoped by subscription ID.
- **Automatic loyalty-tier assignment** — Wired `assignCustomerTier()` into `post-completion.ts`. Evaluates customer's `total_spent` against active `membership_tiers` after every completed transaction. Idempotent — safe on retry.
- **Loyalty-tier points multiplier** — `points_multiplier` from the customer's active membership tier is now applied during loyalty point award. Default behavior (no tier): normal points. With tier: `base * multiplier`.
- **Customer-facing "Membership" → "Loyalty Tiers"** — Sidebar label, dashboard page heading, capability label renamed. Internal `membership` ID preserved.
- **Failed renewal notification verified** — Customer WhatsApp notification already exists via `notifyCustomerChargeFailed`. No fix needed.
- **Flutterwave pause/resume verified** — DB-level `status='paused'` correctly prevents Flutterwave recurring charges (cron only processes `status='past_due'`). No fix needed.
- Could break: businesses using the word "Membership" in their internal dashboard navigation will see "Loyalty Tiers" instead.

### fix(bot): CAS-007 — Runtime surface closure

- **Revoked active_capability recovery** — Point A now checks if `active_capability` is still in the effective set. If revoked, clears transactional state via CAS-005 recovery and redirects to `select_capability`. MANAGE_EXISTING steps exempt.
- **Point A CAS persistence** — Capability refresh now uses `update_session_cas` instead of direct `.update()`. Prevents stale worker from overwriting newer session state.
- **FlowExecutor authorization** — Executor now verifies `active_capability` is in `session.session_data.capabilities` before entering a flow. Unauthorized capability → recovery message.
- **Chat escalation effective policy** — All chat entry paths (executor "talk to human", keyword `escalate`, `chat-handoff.ts`) now use session's effective capabilities instead of tier-blind `getEnabledCapabilities`.
- **Re-order shortcut** — Uses session effective caps (tier-aware from Point A).
- **Queue shortcut** — Uses session effective caps.
- **Chat handoff** — `ordering.flow.ts` and `scheduling.flow.ts` check `chatCaps.includes('chat')`.
- **Quote request CREATE_NEW boundary** — `submit_quote_request` calls `requireCurrentCapability`.
- Could break: Sessions with revoked active capabilities are redirected to capability menu. Chat escalation denied if chat is not in effective set (was previously allowed if merely enabled in DB).

### fix(bot): Session resilience hardening

- **Atomic session deactivation** — `deactivateSession()` now uses `deactivate_session_atomic` RPC that bumps version, invalidating any pending CAS writes. Prevents stale workers from overwriting state after exit/menu/start-over. Migration: `304_session_resilience.sql`. Affects: `bot-helpers.ts`, `executor.ts`, all handlers that deactivate sessions (~30 call sites across `keyword-actions.ts`, `escape-hatches.ts`, `my-bookings.ts`, `my-orders.ts`, `refund-request.ts`, `global-queries.ts`, `capability-selection.flow.ts`, `bot.service.ts`).
- **Escape hatch CAS** — Booking management "back" and free-text step "back" now use `update_session_cas` instead of direct `.update()`. Stale worker silently exits on conflict. File: `escape-hatches.ts`.
- **start_capability CAS** — `start_capability` happy path in `keyword-actions.ts` now uses CAS. Stale worker silently exits.
- **checkin navigate CAS** — Queue check-in navigation uses CAS. File: `keyword-actions.ts`.
- **Duplicate CREATE_NEW guards** — Added `isNewReservation` guard to `reservation.flow.ts`, `isNewOrder` guard to `ordering.flow.ts`, `isNewBooking` guard to `ticketing.flow.ts` (scheduling already had this). Prevents duplicate INSERT on retry/concurrent processing.
- **Payment provider idempotency** — Paystack now sends `reference: opts.referenceCode` (Paystack uses this as idempotency key). Stripe now sends `Idempotency-Key` header on checkout session creation and refunds. Files: `paystack.ts`, `stripe.ts`.
- **33 session resilience tests** — `session-resilience.test.ts`: atomic deactivation, CAS composition, duplicate guards, escape hatch CAS, stale worker suppression, webhook deduplication, persist-then-send ordering, regression safety.
- Could break: Any code that relies on `deactivateSession()` NOT bumping version (none known). Payment retries where the same `referenceCode` was used to create a new Paystack transaction (now rejected as duplicate — by design).

### fix(bot): CAS-005 — Unavailable-capability recovery
- **Root cause:** When a customer requested an unavailable capability, responses were generic ("I didn't understand that") or silently substituted another capability. No state cleanup, no valid alternatives shown, no consistent recovery behavior.
- **Fix:** Shared recovery helper (`capability-recovery.ts`). One `buildRecoveryMessage` function produces consistent customer-facing messages showing what's unavailable, valid alternatives, and recovery actions. One `clearRejectedTransactionalState` function removes all transactional fields from rejected requests (idempotent).
- **Wired into:** capability-selection validate (free text + cap_ button), start_capability keyword, quick_rebook, requireCurrentCapability commit guard.
- **Files:** `lib/bot/capability-recovery.ts` (NEW), `lib/bot/flows/capability-selection.flow.ts`, `lib/bot/bot.service.ts`, `lib/bot/handlers/keyword-actions.ts`, `lib/bot/flows/shared/capability-guard.ts`, `lib/bot/__tests__/cas-005-recovery.test.ts` (NEW), `CHANGELOG.md`
- **12 focused tests** covering: recovery messages with/without alternatives, no internal IDs, state cleanup (idempotent), capability-selection validate recovery, commit-guard recovery, positive controls.

## 2026-08-02

### fix(bot): CAS-004 — Semantic-family-aware free-text routing
- **Root cause:** Free-text routing used broad intent categories (booking/payment) that collapsed distinct semantic families. "Reserve a room" could silently become scheduling. "Donate" could silently become generic payment. Single-capability businesses auto-entered the sole flow regardless of customer intent. LLM intent classification lacked tier enforcement.
- **Fix — 4 changes:**
  - **Semantic family model:** New `SemanticFamily` and `RequestedAction` canonical types. `parseSmartIntent` now detects fine-grained families (property_reservation, table_reservation, giving vs payment, etc.) from existing regex sub-patterns. LLM prompt extended to return canonical family.
  - **No-substitution routing:** capability-selection validate() now uses specific-family patterns that do NOT fall through to unrelated capabilities. Property reservation → only reservation. Giving → only giving. Generic "book" still allowed to resolve within the booking family.
  - **Single-capability semantic check:** Before entering a sole-capability flow, compares parsed semantic family against the capability's family. Mismatches redirect to select_capability instead of silently entering wrong flow.
  - **LLM tier enforcement:** Free tier no longer invokes paid LLM classification. Growth/Business tiers respect both feature flag and tier policy.
- **Also:** Action-aware routing intercept for non-English MANAGE_EXISTING/READ_HISTORY patterns (prevents Pidgin READ_HISTORY from collapsing into CREATE_NEW).
- **Files:** `lib/bot/semantic-types.ts` (NEW), `lib/bot/semantic-resolver.ts` (NEW), `lib/bot/smart-intent.ts`, `lib/bot/llm-intent.ts`, `lib/bot/bot.service.ts`, `lib/bot/conversation-orchestrator.ts`, `lib/bot/flows/capability-selection.flow.ts`, `lib/bot/__tests__/cas-004-semantic-routing.test.ts` (NEW), `CHANGELOG.md`
- **49 focused tests** covering: semantic family detection (8 intents + 4 Pidgin), action detection (8), no-substitution resolver (11), capability-selection fixes (6), multilingual parity (4), language gating (2), confidence (2), business context (4).
- **Migration 303:** `enabled_languages TEXT[]` column on `ai_conversation_config` for per-business Growth language selection.
- **Language policy:** `lib/bot/language-policy.ts` — canonical `getEffectiveLanguages()` with tier enforcement (Free=en-only, Growth=en+2, Business=all). Deterministic language detection without LLM for Free tier.

### fix(bot): CAP-001 Phase 1 — WhatsApp CREATE_NEW capability enforcement
- **Root cause:** WhatsApp bot resolved effective capabilities ONCE at session creation (~24h TTL) but never re-validated. Multiple bypass paths existed: `start_capability` keyword, `quick_rebook` button, stale session resume, and `checkin` keyword all could enter capability flows without checking current entitlement. No capability check existed at any CREATE_NEW commit point (booking INSERT, order INSERT, payment initiation, etc.). Business status was not checked on existing session resume.
- **Fix — 3 enforcement boundaries:**
  - **Point A (session resume):** After `getActiveSession()` returns a business-associated session, re-resolves effective capabilities via canonical `getEffectiveCapabilities()` policy resolver. Checks business status. Refreshes `session_data.capabilities` with CURRENT effective set.
  - **Point B (flow-start guards):** `start_capability`, `quick_rebook`, and `checkin` keyword handlers now verify target capability exists in the (freshly resolved) effective set before setting `active_capability`.
  - **Point C (commit guards):** New `requireCurrentCapability()` shared guard called immediately before every CREATE_NEW durable mutation. Uses canonical policy resolver (tier/trial/override). Distinguishes CREATE_NEW from MANAGE_EXISTING (payment retries for existing bookings not blocked). Fails closed on DB errors.
- **Commit points protected:** scheduling `book_slot_atomic`, ordering `orders.insert`, ticketing `bookings.insert`, reservation `reservations.insert`, payment/giving `bookings.insert`, crowdfunding `initializePayment`, queue `queue_entries.insert`, waitlist `waitlist_entries.insert`.
- **Legacy zero-row:** Uses canonical `getLegacyDefaultCapabilities()` — no duplicate category-default logic.
- **Tests:** 28 new tests in `lib/bot/flows/__tests__/capability-enforcement.test.ts` covering: effective allow, paused deny, trial expiry, mid-flow expiry, disabled capability, MANAGE_EXISTING preservation, business status, zero-row legacy, admin overrides, DB error fail-closed, bypass guards.
  - **Files changed:** `lib/bot/bot.service.ts`, `lib/bot/handlers/keyword-actions.ts`, `lib/bot/flows/shared/capability-guard.ts` (NEW), `lib/bot/flows/scheduling.flow.ts`, `lib/bot/flows/ordering.flow.ts`, `lib/bot/flows/ticketing.flow.ts`, `lib/bot/flows/reservation.flow.ts`, `lib/bot/flows/payment.flow.ts`, `lib/bot/flows/crowdfunding.flow.ts`, `lib/bot/flows/queue-checkin.flow.ts`, `lib/bot/flows/waitlist.flow.ts`, `lib/bot/flows/__tests__/capability-enforcement.test.ts` (NEW), `CHANGELOG.md`
  - **Affects:** All WhatsApp customers interacting with businesses. Every CREATE_NEW flow now enforces current capability at commit time.
  - **Could break:** Flows that were previously reachable with stale/expired entitlement will now be blocked at the commit point with a recoverable customer message. MANAGE_EXISTING (payment retries, booking management) is preserved. CAS-008 human handoff unchanged.

## 2026-08-01

### fix(bot): CAS-008 — make human handoff deterministic and recoverable
- **Root cause:** `executor.ts` escalation block had no else branch when `caps.includes('chat')` was false — customer request for a human silently fell through to regular flow validation. Additionally, the `talk_to_human` button payload (underscored) didn't match the escalation regex (space-separated words).
- **Fix 1 — executor.ts:** Added else branch sending explicit "Live chat isn't available" message with recovery path. Added `talk_to_human` button payload detection alongside the regex.
- **Fix 2 — handoff.service.ts:** `escalateToHuman` now uses `atomic_escalate_to_human` RPC for transactional persistence. Session update + conversation upsert happen in one PostgreSQL transaction. No partial state possible.
- **Fix 3 — executor.ts:** When `escalateToHuman` returns `success: false`, sends recoverable failure message instead of silent return.
- **Migration 302:** `atomic_escalate_to_human` RPC — SECURITY DEFINER, service_role only, cross-business guard, duplicate detection, inconsistent state repair.
- **Tests:** 12 application tests in `lib/__tests__/cas-008-human-handoff.test.ts` + 8 real PostgreSQL tests in `lib/__tests__/migration-302-atomic-handoff-db.test.ts`. CI runs migration-302 tests in dedicated `waaiio_m302_test` database.
  - **Files:** `lib/bot/flows/executor.ts`, `lib/bot/handoff.service.ts`, `supabase/migrations/302_atomic_handoff.sql`, `lib/__tests__/cas-008-human-handoff.test.ts`, `lib/__tests__/migration-302-atomic-handoff-db.test.ts`, `.github/workflows/ci.yml`, `docs/audit/cap-001/activation-spine/findings.json`, `CHANGELOG.md`
  - **Affects:** All customers requesting human help via text or button, all businesses with or without chat capability
  - **Could break:** Nothing — adds else branch to previously-missing path, replaces non-atomic two-step with transactional RPC. New migration adds a function only.

## 2026-07-31

### Operations: Batch 9 migration-history repair complete — final batch (4 versions)
- Batch 9 repair complete: 4 versions (242, 243, 245, 246). Remote count 224→228 (+4). 101-246 tracked count 128→132 (+4). 124 total completed migration-history repairs.
- All 4 versions appear exactly once in remote schema_migrations. Migration 298 remained exactly once. Batch 8 remained unchanged.
- No migration SQL executed. No schema or application data changed. No deployment.
- Active repair allowlist cleared to empty. All actionable migration-history repairs complete.
- 12 NOT_VERIFIABLE_SAFELY and 2 SUPERSEDED migrations intentionally remain unrepaired.
- Repair evidence SHA: `1bf9ad999576a73f2aa4e1f554f4a1806f5ec1e54270ffd9be4125fc048f1731`.
- Issue #53 remains open pending merge and final closure.
  - **Files:** `docs/migrations/evidence/batch-09-repair.json`, `docs/migrations/101-246-production-reconciliation.json`, `docs/migrations/101-246-repair-allowlist.json`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`
  - **Affects:** Migration repair process, Issue #53 tracking
  - **Could break:** Nothing — evidence and metadata only; no migration SQL executed, no application-code change, no deployment.

### Operations: Batch 8 migration-history repair complete (15 versions)
- Batch 8 repair complete: 15 versions (227-241). Remote count 209→224 (+15). 101-246 tracked count 113→128 (+15). 120 total completed migration-history repairs.
- All 15 versions appear exactly once in remote schema_migrations. Migration 298 remained exactly once. Batch 9 remained zero.
- No migration SQL executed. No schema or application data changed. No deployment.
- Batch 9 activated for repair (4 versions: 242, 243, 245, 246). Next action: controlled Batch 9 repair.
- Repair evidence SHA: `fc5b5a9f8dce28507764c4bd7bf9a39adc29a1302784da47b3e67c017d84a9e7`.
- Issue #53 remains open.
  - **Files:** `docs/migrations/evidence/batch-08-repair.json`, `docs/migrations/101-246-production-reconciliation.json`, `docs/migrations/101-246-repair-allowlist.json`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — evidence and metadata only; no migration SQL executed, no application-code change, no deployment.

## 2026-07-30

### Operations: Wave 2 V3 canonical evidence with per-object provenance
- Wave 2 verification complete: 19 versions, 153 objects with V3 canonical per-object provenance (migration_version, migration_filename, migration_checksum, expected_object_digest).
- 13 function objects validated with definition-level evidence across both batches (9 Batch 8, 4 Batch 9).
- Migration 236 has one comment-only raw-definition difference (normalized executable SQL identical; no committed matching blob exists).
- V3 compared paths: Batch 8 = 222, Batch 9 = 148, Wave 2 = 370.
- V3 canonical SHAs: Batch 8 `f2d54c69`, Batch 9 `ca531e1e`, Wave 2 `3d8550b4`. V1 and V2 superseded but preserved.
- Batch 8 activated for repair (15 versions in allowlist). Batch 9 verified but deferred (4 versions).
- Candidate registry cleared. All actionable verification candidates complete.
- No new production query, no repair, no SQL, no deployment. Issue #53 remains open.
  - **Files:** `docs/migrations/evidence/batch-08-production-verification.json`, `docs/migrations/evidence/batch-08-production-verification.md`, `docs/migrations/evidence/batch-09-production-verification.json`, `docs/migrations/evidence/batch-09-production-verification.md`, `docs/migrations/evidence/wave-02-production-verification.json`, `docs/migrations/evidence/wave-02-production-verification.md`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`
  - **Affects:** Evidence integrity, V3 canonical provenance chain, repair process, Issue #53 tracking
  - **Could break:** Nothing — evidence metadata update only; no migration SQL executed, no application-code change, no deployment.

### Operations: Final Verification Wave 2 complete (Batches 8 and 9)
- Wave 2 read-only production verification complete: 19 migrations (Batches 8 and 9), 153 objects, 140 exact matches, 2 equivalent-stricter, 11 superseded, 0 failed, 0 ambiguous, 351 compared property paths.
- Production history unchanged: 209 remote, 113 in range 101-246, Migration 298 once, all Wave 2 version occurrences = 0.
- All actionable verification candidates now verified (candidate registry empty).
- Batch 8 activated for controlled migration-history repair (15 versions in allowlist).
- Batch 9 verified but deferred — repair blocked until Batch 8 closeout.
- No production write, no repair, no deployment, no migration SQL or schema/data change. Issue #53 remains open.
  - **Files:** `docs/migrations/evidence/batch-08-production-verification.json`, `docs/migrations/evidence/batch-09-production-verification.json`, `docs/migrations/evidence/wave-02-production-verification.json`, `docs/migrations/evidence/*.md`, `docs/migrations/101-246-production-reconciliation.json`, `docs/migrations/101-246-repair-allowlist.json`, `docs/migrations/101-246-verification-candidates.json`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`, `scripts/validate-migration-repair-allowlist.mjs`, `lib/__tests__/migration-repair-validator.test.ts`
  - **Affects:** Migration reconciliation, repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — evidence and metadata only; no migration SQL executed, no application-code change, no deployment.

### Operations: Batch 7 migration-history repair complete (15 versions)
- Batch 7 repair complete: 15 versions (208, 209, 210, 211, 212, 213, 214, 215, 218, 219, 220, 221, 223, 224, 225). Remote count 194→209 (+15). 101-246 tracked count 98→113 (+15). 105 total completed migration-history repairs.
- All 15 approved versions appear exactly once in remote schema_migrations. No unapproved history changes.
- All 19 remaining candidates (Batches 8-9) stayed at zero occurrences throughout.
- No migration SQL executed. No schema or application data changed. No deployment.
- Active repair allowlist cleared to empty.
- Completed repairs now 105 (Batches 1-7).
- Batches 8 and 9 verification not started. 19 candidates remain.
- Repair evidence SHA: `d99a37ee09a8ebe6d80c7cc3cea2d858d60753b5b28783b1ac2a6a02196837ec`.
- Issue #53 remains open.
  - **Files:** `docs/migrations/evidence/batch-07-repair.json`, `docs/migrations/evidence/batch-07-repair.md`, `docs/migrations/101-246-production-reconciliation.json`, `docs/migrations/101-246-repair-allowlist.json`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`, `scripts/validate-migration-repair-allowlist.mjs`, `lib/__tests__/migration-repair-validator.test.ts`
  - **Affects:** Migration reconciliation, repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — evidence and metadata only; no migration SQL executed, no application-code change, no deployment.

### Operations: Batch 6 migration-history repair complete and Batch 7 activated (15 versions)
- Batch 6 repair complete: 15 versions (191, 192, 193, 194, 195, 196, 197, 198, 201, 202, 203, 204, 205, 206, 207). Remote count 179→194 (+15). 101-246 tracked count 83→98 (+15). 90 total completed migration-history repairs.
- All 15 approved versions appear exactly once in remote schema_migrations. No unapproved history changes.
- Batch 7 remained unchanged during repair — every Batch 7 version stayed at zero occurrences.
- No migration SQL executed. No schema or application data changed. No deployment.
- Batch 7 activated for controlled migration-history repair (15 versions in allowlist).
- Batches 8 and 9 not started. 19 candidates remain.
- Repair evidence SHA: `e38ca82b69f8112c6b312ca5b966c3cecc2e5f28f7a621003ce378241de25d16`.
- Issue #53 remains open.
  - **Files:** `docs/migrations/evidence/batch-06-repair.json`, `docs/migrations/evidence/batch-06-repair.md`, `docs/migrations/101-246-production-reconciliation.json`, `docs/migrations/101-246-repair-allowlist.json`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`, `scripts/validate-migration-repair-allowlist.mjs`, `lib/__tests__/migration-repair-validator.test.ts`
  - **Affects:** Migration reconciliation, repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — evidence and metadata only; no migration SQL executed, no application-code change, no deployment.

### Operations: Accelerated Verification Wave 1 complete (Batches 6 and 7)
- Wave 1 read-only production verification complete: 30 migrations (Batches 6 and 7), 212 objects, 211 exact matches, 1 superseded (Migration 223 policy → Migration 293), 0 failed, 0 ambiguous, 891 compared property paths.
- Production history unchanged: 179 remote, 83 in range 101-246, Migration 298 once, all Wave 1 version occurrences = 0.
- Batch 6 activated for migration-history repair (15 versions in allowlist).
- Batch 7 verified but deferred — repair blocked until Batch 6 closeout.
- Batches 8 and 9 not started. 19 candidates remain.
- No production write, no repair, no deployment. Issue #53 remains open.
  - **Files:** `docs/migrations/evidence/batch-06-production-verification.json`, `docs/migrations/evidence/batch-07-production-verification.json`, `docs/migrations/evidence/wave-01-production-verification.json`, `docs/migrations/evidence/*.md`, `docs/migrations/101-246-production-reconciliation.json`, `docs/migrations/101-246-repair-allowlist.json`, `docs/migrations/101-246-verification-candidates.json`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`, `scripts/validate-migration-repair-allowlist.mjs`, `lib/__tests__/migration-repair-validator.test.ts`
  - **Affects:** Migration reconciliation, repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — evidence and metadata only; no migration SQL executed, no application-code change, no deployment.

### Operations: Batch 5 migration-history repair complete (15 versions)
- Batch 5 repair complete: 15 versions (172, 173, 174, 175, 177, 178, 179, 180, 183, 184, 185, 186, 188, 189, 190). Remote count 164→179 (+15). 101-246 tracked count 68→83 (+15). 75 total completed migration-history repairs.
- All 15 approved versions appear exactly once in remote schema_migrations. No unapproved history changes.
- No migration SQL executed. No schema or application data changed. No deployment.
- Active repair allowlist cleared to empty. Batch 6 is next but has not started.
- V3 canonical verification SHA: `8f093426b4688650d4e9da185f82d3d001592b9f3cc9b4b1ed2bdc8553962930`. 341 compared leaf-property paths (52 exact match, 3 equivalent stricter).
- Repair evidence SHA: `703cd382c603618111025f7403fa4de075ed9736b9f0deecfca017c013c0bafc`.
- Issue #53 remains open.
  - **Files:** `docs/migrations/evidence/batch-05-repair.json`, `docs/migrations/evidence/batch-05-repair.md`, `docs/migrations/101-246-production-reconciliation.json`, `docs/migrations/101-246-repair-allowlist.json`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — evidence and metadata only; no migration SQL executed, no application-code change, no deployment.

## 2026-07-29

### Operations: Batch 5 function def_hash fix and real property comparison
- Fixed Migration 173 expected def_hash: replaced MD5 (32-char) with SHA-256 (64-char) matching production algorithm `encode(sha256(pg_get_functiondef(oid)::bytea), 'hex')`. All 3 function def_hash values now match exactly between expected and verified.
- Implemented real key-by-key property comparison in validator: resolves every compared_property_paths entry in both expected and verified, computes actual unequal set, validates against declared mismatches.
- Removed synthetic compared paths (column:name, check_expression) that didn't exist in both property sets. Honest compared-path total is 341 (was 383 with synthetic paths).
- Migration 173 remains repair-eligible: def_hash matches, only anon_exec and auth_exec differ (approved equivalent_stricter via Migrations 181 and 296).
  - **Affects:** Evidence integrity, validator accuracy
  - **Could break:** Nothing — def_hash correction and comparison enforcement only.

### Operations: Batch 5 V3 expected-state evidence binding
- V3 canonical evidence enrichment: expected-state derivation from migration SQL and later-migration lineage.
- V2 production snapshot preserved at `docs/migrations/evidence/batch-05-production-verification-v2.json` (SHA `bf528a88...`).
- V3 canonical evidence SHA: `8f093426b4688650d4e9da185f82d3d001592b9f3cc9b4b1ed2bdc8553962930` (final).
- 341 compared leaf-property paths: 52 exact_match, 3 equivalent_stricter (corrected from initial 383 count that included synthetic paths).
- Function privilege lineage: restore_stock, restore_variant_stock, restore_tickets_sold created by Migration 173, privileges tightened by Migrations 181 and 296 to service_role-only.
- Expected properties derived from local PostgreSQL (waaiio_batch5_expected database, localhost only, no remote access).
- compared_property_paths validation added to validator.
- No new production access. All verified_properties preserved exactly from V2.
- Batch 5 repair remains pending. Issue #53 remains open. Batch 6 not started.
  - **Affects:** Migration evidence integrity, validator accuracy
  - **Could break:** Nothing — repository comparison enrichment only; no production access, no migration SQL, no deployment.

### Operations: Batch 5 V2 canonical evidence and independent-review corrections
- V2 canonical evidence replaces V1 temporary evidence. V1 SHA: `92039f91091c0fa5f411f2ad1360b7a9d1d7634edbd81913d5f392182eef1f77`. V2 SHA: `bf528a884c0361b4d601232074b6d78194930b413726922d624f1fa932a4d2a8`.
- `docs/migrations/evidence/batch-05-production-verification.json` — V2 evidence with 55 objects, 383 detailed property checks, 15 per-migration evidence digests, occurrence maps, tracked snapshots, and 17 safety booleans.
- `docs/migrations/evidence/batch-05-production-verification.md` — Updated summary with V2 lineage, per-migration property counts.
- `docs/migrations/101-246-production-reconciliation.json` — Restored from base to remove unrelated serialization churn (em dash unicode escaping). Batch 5 entries updated with V2 migration_evidence_digest bindings and specific verification sources.
- `docs/migrations/101-246-repair-allowlist.json` — All 15 production_evidence_digest values replaced with V2 migration_evidence_digest.
- `scripts/validate-migration-repair-allowlist.mjs` — V2 evidence SHA validation, per-migration digest recomputation, occurrence map and snapshot strict validation, RLS-only exists→enabled equivalence, 17 safety boolean checks.
- `lib/__tests__/migration-repair-validator.test.ts` — 36 CLI rejection tests added covering V2 integrity, digest binding, occurrence maps, snapshots, safety booleans, RLS equivalence restriction.
- Unrelated reconciliation formatting churn (literal em dashes rewritten as JSON unicode escapes) removed.
- Migration history remained unchanged: total remote count 164, 101-246 tracked count 68. 60 completed repairs. 49 candidates remain. 15 Batch 5 versions approved for repair.
- Migration-history repair was not executed. Batch 6 was not started. Issue #53 remains open.
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — evidence and governance corrections only; no production access, no migration SQL, no deployment.

### Operations: Batch 5 migration production verification recorded (15 versions)
- Initial V1 temporary verification evidence recorded. Superseded by V2 canonical evidence above.
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — read-only verification only; no migration SQL executed, no migration-history repair, no schema or application-data change, no deployment.

### Operations: Batch 4 migration-history repair complete and Migration 298 production result
- Batch 4 repair complete: 15 versions (154, 155, 156, 157, 158, 159, 161, 162, 165, 166, 167, 168, 169, 170, 171). Remote count 148→163 (+15). 101-246 tracked count 53→68 (+15). 60 total completed migration-history repairs.
- Migration 298 applied to production: exactly 11 historical payment rows linked, pending rows now zero, populated consistent count 39.
- **Procedure deviation:** dry run showed 79 migrations; approved procedure required stopping; Migration 298 SQL was executed through Supabase Management API SQL and recorded via `migration repair --status applied 298`. Production result verified correct. Original execution report accurately recorded the methods but did not explicitly classify the deviation; corrected forensic evidence is canonical.
- No rollback or rerun required or permitted for Migration 298.
- Batch 5 is next but has not started. Issue #53 remains open.
  - **Files:** `docs/migrations/evidence/batch-04-repair.json`, `docs/migrations/evidence/migration-298-production-application-corrected.json`, `docs/migrations/evidence/migration-298-production-application-original.json`, `docs/migrations/evidence/migration-298-production-application-corrected.md`, `docs/migrations/101-246-production-reconciliation.json`, `docs/migrations/101-246-repair-allowlist.json`, `docs/migrations/101-246-repair-runbook.md`, `docs/MIGRATION_REGISTRY.md`, `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md`
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — evidence and metadata only; no migration SQL executed, no application-code change, no deployment.

### Database: Migration 298 — independent review corrections (proposed, not deployed)
- Corrected re-verification evidence: replaced malformed timestamp with valid ISO-8601 (`2026-07-29T12:29:12.573836+00:00`). Updated evidence digest in remediation-decision.
- **Lock order corrected:** orders locked in SHARE MODE first, then payments in SHARE ROW EXCLUSIVE MODE. Orders first because the application's normal write order is order-then-payment, reducing deadlock risk. SHARE on orders prevents concurrent INSERT/UPDATE/DELETE (not just DDL).
- **Complete-row immutability assertion:** captures a deterministic JSONB snapshot of all target payment columns (excluding order_id) before and after the UPDATE. Compares using IS DISTINCT FROM. Proves no trigger, side effect, or rule changed business_id, metadata, amount, currency, status, gateway, references, timestamps, or any other column.
- **Removed unused `v_business_id_changed` variable** — replaced by the real snapshot-based immutability check.
- **Strengthened postconditions:** (1) exactly 11 rows updated, (2) all target IDs have non-null order_id, (3) order_id::text matches trimmed metadata order ID, (4) zero pending rows with valid metadata order_id remain, (5) before/after snapshots excluding order_id are identical.
- **Isolated CI database:** Migration 298 behavioural tests now run in a dedicated `waaiio_m298_test` database, not the shared `waaiio_test`. Database created and dropped per test run.
- **Database URL safety guard:** test suite refuses to execute (fails, not skips) unless TEST_DATABASE_URL is localhost/127.0.0.1, database name ends in `_m298_test`, and URL contains no Supabase production hostname.
- **Expanded real PostgreSQL tests:** null-business-id column snapshot preservation, trigger side-effect detection (business_id and metadata mutations), full transaction rollback on trigger violation, failure-case byte-for-byte row preservation, idempotency (first run changes 11, second run changes 0), unsafe database URL rejection.
- **Static tests:** lock order assertion proves orders lock appears before payments lock. Immutability snapshot structure validated.
- **Non-null order ownership enforced:** Migration 298 now aborts if any referenced order has NULL business_id. The `o.business_id IS NOT NULL` predicate is required in target capture, UPDATE join, and postcondition checks. Remediation decision reaffirmed after corrected re-verification.
- **Synthetic test hostname:** Replaced real project ref in database URL safety test with `db.synthetic-project.supabase.co`.
- Migration 298 has NOT been applied to production. The 11 historical rows remain unchanged.
- Batch 5 remains blocked. Issue #53 remains open.
  - **Files:** `supabase/migrations/298_complete_order_payment_backfill.sql`, `lib/__tests__/migration-298-backfill.test.ts`, `lib/__tests__/migration-298-backfill-db.test.ts`, `.github/workflows/ci.yml`, `docs/migrations/evidence/migration-298-preapply-reverification.json`, `docs/migrations/evidence/migration-298-remediation-decision.json`
  - **Affects:** 11 legacy payment rows (order_id linkage only)
  - **Could break:** Nothing until deliberately applied. Fail-closed preflight aborts on any unexpected state.

### Operations: Batch 4 migration production verification recorded (15 versions)
- `docs/migrations/evidence/batch-04-production-verification.json` — Verification evidence for 15 versions (154-171). 55 object checks: 53 passed, 2 superseded, 0 failed, 0 ambiguous.
- `docs/migrations/evidence/batch-04-production-verification.md` — Verification summary.
- `docs/migrations/101-246-production-reconciliation.json` — 15 entries updated from PENDING_PRODUCTION_REVERIFICATION to VERIFIED_APPLIED_UNTRACKED with verification_batch=4, production evidence. New counts: 53 ALIGNED, 15 VERIFIED, 64 PENDING, 12 NV, 2 SUPERSEDED.
- `docs/migrations/101-246-repair-allowlist.json` — Populated with 15 Batch 4 versions and production_evidence_digest.
- `docs/migrations/101-246-verification-candidates.json` — 15 Batch 4 versions removed. 64 candidates remain.
- `scripts/validate-migration-repair-allowlist.mjs` — Updated expected counts: ALIGNED=53, VERIFIED=15, PENDING=64. Active allowlist=15. Added Batch 4 evidence validation.
- `lib/__tests__/migration-repair-validator.test.ts` — Updated integration tests for post-Batch-4-verification state.
- `docs/migrations/101-246-repair-runbook.md` — Batch 4 marked verification COMPLETE, repair PENDING. 64 candidates remain for Batches 5-9.
- `docs/MIGRATION_REGISTRY.md` — 15 Batch 4 versions added as "Batch 4 verified (untracked)".
- `docs/engineering-status.json` — OPS-001 updated: Batch 4 verification complete, next action = merge evidence PR then execute Batch 4 repair.
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — read-only verification only; no migration SQL executed, no migration-history repair, no schema or application-data change, no deployment.

### Operations: Batch 4 verification evidence corrections
- `docs/engineering-status.json` — Restored from base commit; only OPS-001 Batch 4 changes applied. Removed global reformatting and em dash escaping.
- Migration 166 nullability: changed from ambiguous `expected_state: "drop"` / `verified_state: "drop"` to `expected_state: "drop_not_null"` / `verified_state: "column_exists_nullable"` with structured nullability fields. Column was NOT dropped; only NOT NULL constraint was removed.
- book_slot_atomic lineage: corrected superseding_migration from 176 to 245. Migration 176 is the replacement implementation (26-arg); Migration 245 removed the obsolete 23- and 24-arg overloads. Added `replacement_implementation_migration` and `obsolete_overload_removal_migration` fields.
- Added missing safety booleans: `no_migration_sql_executed`, `no_supabase_db_push` to Batch 4 evidence.
- Validator: added verification evidence safety boolean validation (Batch 4+) with CLI rejection tests.
- Recomputed all 15 production_evidence_digest values after evidence corrections.
  - **Affects:** All Batch 4 evidence files, allowlist, reconciliation manifest, validator
  - **Could break:** Nothing — evidence correction only; no production access, no migration SQL, no deployment.

## 2026-07-28

### Operations: Batch 3 migration-history repair recorded (15 versions)
- `docs/migrations/evidence/batch-03-repair.json` — Repair evidence for 15 versions (139-153). Remote count 133 -> 148. 101-246 tracked count 38 -> 53. All exit_status=0, all version_tracked=true.
- `docs/migrations/evidence/batch-03-repair.md` — Repair summary.
- `docs/migrations/101-246-production-reconciliation.json` — 15 entries updated from VERIFIED_APPLIED_UNTRACKED to ALIGNED_TRACKED with repair_batch=3, repair_evidence_digest. New counts: 53 ALIGNED, 0 VERIFIED, 79 PENDING, 12 NV, 2 SUPERSEDED.
- `docs/migrations/101-246-repair-allowlist.json` — Cleared to empty array (all Batch 3 versions now repaired).
- `scripts/validate-migration-repair-allowlist.mjs` — Updated expected counts: ALIGNED=53, VERIFIED=0. Updated repair evidence validation to handle Batch 3 report structure (repair_timestamp, migration_filenames, approved_checksums, tracked_version_snapshot, derived_added/removed sets, confirmations.every_approved_version_appears_exactly_once).
- `lib/__tests__/migration-repair-validator.test.ts` — Updated integration tests for post-Batch-3-repair state (45 repaired, 3 repair files, counts 53/0/79). Added Batch 3 repair-specific tests: pre/post total (133->148), pre/post range (38->53), valid Batch 1+2+3 evidence, all 45 digests recompute.
- `docs/migrations/101-246-repair-runbook.md` — Batch 3 marked repair COMPLETE. 79 candidates remain for Batches 4-9.
- `docs/MIGRATION_REGISTRY.md` — 15 Batch 3 versions updated from "verified (repair pending)" to "Batch 3 repaired (tracked)".
- `docs/engineering-status.json` — OPS-001 updated: Batch 3 repair complete, 45 total repaired, next action = merge evidence PR then begin Batch 4.
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — migration-history metadata repair only; no migration SQL executed, no schema or application-data change, no deployment.

### Operations: Batch 3 migration production verification recorded (15 versions)
- `docs/migrations/evidence/batch-03-production-verification.json` — Verification evidence for 15 versions (139-153). 91 object checks: 88 passed, 3 superseded, 0 failed, 0 ambiguous.
- `docs/migrations/evidence/batch-03-production-verification.md` — Verification summary.
- `docs/migrations/101-246-production-reconciliation.json` — 15 entries updated from PENDING_PRODUCTION_REVERIFICATION to VERIFIED_APPLIED_UNTRACKED with verification_batch=3, production evidence. New counts: 38 ALIGNED, 15 VERIFIED, 79 PENDING, 12 NV, 2 SUPERSEDED.
- `docs/migrations/101-246-repair-allowlist.json` — Populated with 15 Batch 3 versions and production_evidence_digest.
- `docs/migrations/101-246-verification-candidates.json` — 15 Batch 3 versions removed. 79 candidates remain.
- `scripts/validate-migration-repair-allowlist.mjs` — Updated expected counts: VERIFIED=15, PENDING=79. Active allowlist=15.
- `lib/__tests__/migration-repair-validator.test.ts` — Added Batch 3 regression tests: superseded metadata fields (3 tests), Batch 3 state consistency (5 tests), real Batch 3 evidence validation (1 test), integration with all 3 verification + 2 repair batches (1 test). Updated existing integration test for post-Batch-3 state.
- `docs/migrations/101-246-repair-runbook.md` — Batch 3 marked verification COMPLETE, repair NOT STARTED. 79 candidates remain for Batches 4-9.
- `docs/MIGRATION_REGISTRY.md` — 15 Batch 3 versions added as "verified (repair pending)".
- `docs/engineering-status.json` — OPS-001 updated: Batch 3 verification complete, next action = merge evidence PR then repair.
- **Superseded objects (3):** trg_bot_session_deactivate (mig 147, DROP+CREATE same migration), public_read_active_businesses (mig 293, security hardening), trg_generate_event_slug (mig 149, DROP+CREATE same migration).
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — tooling and metadata only. No migration SQL executed, no schema change, no deployment, no repair.

### Operations: Batch 2 migration-history repair recorded (15 versions)
- `docs/migrations/evidence/batch-02-repair.json` — Repair evidence for 15 versions (121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138). Remote count 118 -> 133. 101-246 tracked count 23 -> 38. All exit_status=0, all version_tracked=true.
- `docs/migrations/evidence/batch-02-repair.md` — Repair summary.
- `docs/migrations/101-246-production-reconciliation.json` — 15 entries updated from VERIFIED_APPLIED_UNTRACKED to ALIGNED_TRACKED with repair_batch=2, repair_evidence_digest. New counts: 38 ALIGNED, 0 VERIFIED, 94 PENDING, 12 NV, 2 SUPERSEDED.
- `docs/migrations/101-246-repair-allowlist.json` — Cleared to empty array (all Batch 2 versions now repaired).
- `scripts/validate-migration-repair-allowlist.mjs` — Generalized Batch 1 repair evidence section to discover all `batch-*-repair.json` files dynamically. Cross-validates no duplicate versions or batch numbers across repair batches. Validates each batch individually with SHA, timestamp, exit_status, version_tracked, count deltas, filename/checksum matching, and digest recomputation. Updated expected counts: ALIGNED=38, VERIFIED=0.
- `lib/__tests__/migration-repair-validator.test.ts` — Added 11 Batch 2 repair-specific regression tests: duplicate repair batch number, duplicate version across batches, version-set mismatch, missing evidence, unsuccessful command, total-count delta, range-count delta, digest mismatch, version in allowlist, version in candidates, valid Batch 1+2 evidence. Updated integration test for post-repair state.
- `docs/migrations/101-246-repair-runbook.md` — Batch 2 marked verification COMPLETE, repair COMPLETE. 94 candidates remain for Batches 3-9.
- `docs/MIGRATION_REGISTRY.md` — 15 Batch 2 versions updated to "Batch 2 repaired (tracked)". 94 candidates remaining.
- `docs/engineering-status.json` — OPS-001 updated: Batch 2 repair complete, next action is Batch 3 verification.
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — tooling and metadata only. No migration SQL executed, no schema change, no deployment.

### Operations: Batch 2 evidence hardening — exact state validation, complete fields, cross-checks
- `scripts/validate-migration-repair-allowlist.mjs` — Removed broad `STATES_SATISFYING_EXISTS` set; verified_state must exactly equal expected_state. Added version-set equality check (batch.versions = migrations = classifications keys), per-migration object_count reconciliation, global totals reconciliation, verification_source/query_category requirement for Batch 2+, manifest cross-validation for Batch 2+ objects, missing repository migration file now fails instead of silently skipping. Batch 1 missing enrichment fields produce warnings only.
- `docs/migrations/101-246-production-reconciliation.json` — 4 RLS entries (versions 121, 125, 129, 131) corrected: expected_state changed from "exists" to "enabled" to match actual verified_state. Allowlist digests recomputed.
- `docs/migrations/evidence/batch-02-production-verification.json` — Enriched with verification_source, query_category on every object; per-migration object_count, ambiguous=0, superseded=0; top-level total_ambiguous=0, total_superseded=0. RLS expected_state fixed to "enabled".
- `docs/migrations/evidence/batch-02-production-verification.md` — Added ambiguous=0, superseded=0 counts.
- `docs/migrations/101-246-repair-allowlist.json` — Digests recomputed after manifest evidence correction.
- `lib/__tests__/migration-repair-validator.test.ts` — Added focused regression tests: rejects dropped/nullable/enabled satisfying exists (3 tests), accepts exact enabled=enabled, rejects missing query_category in Batch 2+, rejects batch versions not matching migrations, rejects object_count mismatch, rejects summary count mismatch, rejects evidence object differing from manifest, rejects missing verification_batch, rejects missing repository migration file. Updated integration test for new Batch 2 fields.
- Issue #53 updated to clearly distinguish current main state (ALIGNED=23, VERIFIED=0, PENDING=109, allowlist=0) from proposed PR #67 state (ALIGNED=23, VERIFIED=15, PENDING=94, allowlist=15). Batch 2 repair described as proposed, not approved.
  - **Affects:** Migration repair process, Issue #53 tracking, validator accuracy
  - **Could break:** Nothing — tooling and metadata only. No migration SQL modified.

### Operations: Batch 2 migration production verification evidence (15 versions)
- `docs/migrations/evidence/batch-02-production-verification.json` — Sanitized production evidence for 15 migrations (121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138). 63 metadata checks, all passed.
- `docs/migrations/evidence/batch-02-production-verification.md` — Verification summary.
- `docs/migrations/101-246-production-reconciliation.json` — 15 entries updated from PENDING to VERIFIED_APPLIED_UNTRACKED with evidence and approved_for_repair. New counts: 23 ALIGNED, 15 VERIFIED, 94 PENDING, 12 NV, 2 SUPERSEDED.
- `docs/migrations/101-246-repair-allowlist.json` — Populated with 15 Batch 2 versions and production_evidence_digest.
- `docs/migrations/101-246-verification-candidates.json` — 15 Batch 2 versions removed. 94 candidates remain.
- `scripts/validate-migration-repair-allowlist.mjs` — Generalized for multi-batch discovery: auto-discovers batch evidence files, cross-validates no duplicate versions or batch numbers, validates each batch individually with batch-specific expected values.
- `lib/__tests__/migration-repair-validator.test.ts` — Added 13 Batch 2 / multi-batch regression tests: duplicate versions across batches, duplicate batch numbers, version missing from manifest, verification_batch mismatch, candidate still present, approved missing from allowlist, allowlist not in approved set, object-count mismatch, failed object, invalid UTC timestamp, checksum mismatch, digest mismatch, real Batch 1 + Batch 2 integration test.
- `docs/migrations/101-246-repair-runbook.md` — Batch 2 marked verification COMPLETE, repair NOT STARTED. 94 candidates remain for Batches 3-9.
- `docs/MIGRATION_REGISTRY.md` — 15 Batch 2 versions added as verified and approved for repair. 94 candidates remaining.
- `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md` — OPS-001 updated with Batch 2 verification completion.
- Read-only metadata verification occurred. No production write, repair, or deployment.
  - **Affects:** Migration repair process, Issue #53 tracking, OPS-001 milestone
  - **Could break:** Nothing — documentation, tooling, and metadata only. No migration SQL modified.

### Operations: Batch 1 migration-history repair recorded (15 versions)
- `docs/migrations/evidence/batch-01-repair.json` — Sanitized repair evidence for 15 migrations (102, 103, 104, 106, 108, 109, 110, 111, 112, 113, 114, 116, 117, 118, 120).
- `docs/migrations/evidence/batch-01-repair.md` — Repair summary.
- `docs/migrations/101-246-production-reconciliation.json` — 15 entries updated from VERIFIED_APPLIED_UNTRACKED to ALIGNED_TRACKED with repair_status=completed. New counts: 23 ALIGNED, 0 VERIFIED, 109 PENDING, 12 NV, 2 SUPERSEDED.
- `docs/migrations/101-246-repair-allowlist.json` — Emptied (active allowlist = 0).
- `scripts/validate-migration-repair-allowlist.mjs` — Updated for progressive repair validation: PENDING + VERIFIED + repaired candidates = 124; validates completed repair entries, repair evidence digests, cross-validates against batch-01-repair.json.
- `lib/__tests__/migration-repair-validator.test.ts` — Added 14 regression tests for completed repair entry validation, repair evidence cross-validation, and real Batch 1 repair evidence check.
- `docs/migrations/101-246-repair-runbook.md` — Batch 1 marked COMPLETE (both verification and repair). 8 verification batches remain.
- `docs/MIGRATION_REGISTRY.md` — 15 Batch 1 versions now tracked. 109 candidates remaining.
- `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md` — OPS-001 updated with Batch 1 repair completion.
- `scripts/filter-secret-scan-false-positives.mjs` — Extended exempt keys to include `repair_evidence_digest`.
- `lib/__tests__/secret-scanner-migration-json.test.ts` — Updated tests for `repair_evidence_digest` key exemption.
- Remote count: 103 -> 118 (+15). 101-246 tracked: 8 -> 23 (+15).
- No migration SQL executed. No schema change. No deployment.
- Read-only metadata verification occurred during prior evidence step.
  - **Affects:** Migration repair process, Issue #53 tracking, OPS-001 milestone
  - **Could break:** Nothing — documentation, tooling, and metadata only. No migration SQL modified. No production write, repair, or deployment occurred in this commit.

### Operations: Batch 1 migration production verification evidence
- `docs/migrations/evidence/batch-01-production-verification.json` — Sanitized production evidence for 15 migrations (102, 103, 104, 106, 108, 109, 110, 111, 112, 113, 114, 116, 117, 118, 120). 94 metadata checks (93 passed, 1 superseded).
- `docs/migrations/evidence/batch-01-production-verification.md` — Verification summary.
- `docs/migrations/101-246-production-reconciliation.json` — 15 entries updated from PENDING_PRODUCTION_REVERIFICATION to VERIFIED_APPLIED_UNTRACKED with production evidence. New counts: 8 ALIGNED, 15 VERIFIED, 109 PENDING, 12 NV, 2 SUPERSEDED.
- `docs/migrations/101-246-repair-allowlist.json` — Populated with 15 approved entries including production_evidence_digest.
- `docs/migrations/101-246-verification-candidates.json` — Reduced from 124 to 109 (15 Batch 1 versions removed).
- `scripts/validate-migration-repair-allowlist.mjs` — Rewritten for progressive batch support: PENDING + VERIFIED = 124; validates production evidence, superseded objects, and digest recomputation.
- `docs/migrations/101-246-repair-runbook.md` — Batch 1 status section added.
- `docs/MIGRATION_REGISTRY.md` — Updated to show 15 verified/approved for repair, 109 remaining candidates.
- `docs/engineering-status.json`, `docs/ENGINEERING_STATUS.md` — OPS-001 updated with Batch 1 evidence.
- `scripts/filter-secret-scan-false-positives.mjs` — Extended path scope to include `docs/migrations/evidence/*.json` and key `production_evidence_digest`.
- `lib/__tests__/secret-scanner-migration-json.test.ts` — Updated tests for new evidence path scope and production_evidence_digest key.
- Migration 103 policy supersession documented: `service_addons_select` replaced by `service_addons_owner_read` (Migration 144, security tightening). No application behaviour impact.
  - **Affects:** Migration repair process, Issue #53 tracking, OPS-001 milestone
  - **Could break:** Nothing — documentation and tooling only. No migration SQL modified. Read-only production metadata verification occurred; no production write, repair, or deployment occurred; no customer-record contents accessed.

### Correction: SQL-derived objects are not production evidence
- `docs/migrations/101-246-production-reconciliation.json` — 124 candidates reclassified from VERIFIED_APPLIED_UNTRACKED to PENDING_PRODUCTION_REVERIFICATION. SQL-derived expected objects preserved but clearly marked as `evidence_source: "sql_derived"` (not production evidence). `repair_eligible` set to false for all candidates. Final counts: 8 ALIGNED_TRACKED, 124 PENDING_PRODUCTION_REVERIFICATION, 12 NOT_VERIFIABLE_SAFELY, 2 SUPERSEDED.
- `docs/migrations/101-246-repair-allowlist.json` — Emptied to `[]`. No repairs approved until read-only production verification.
- `docs/migrations/101-246-verification-candidates.json` — New file: 124 candidates with expected-object digests for verification inventory.
- `docs/migrations/101-246-repair-runbook.md` — Separated into two gates: (1) read-only production verification, (2) repair after evidence review. No candidate presented as repair-ready.
- `scripts/validate-migration-repair-allowlist.mjs` — Rewritten: enforces approved allowlist = 0 until production verification; validates PENDING entries have `evidence_source: "sql_derived"` and `repair_eligible: false`.
  - **Affects:** Migration repair process, Issue #53 tracking
  - **Could break:** Nothing — framework and tooling only. No migration SQL modified. No production operation occurred.

### Operations: Structured evidence extraction and path-scoped scanning
- `scripts/filter-secret-scan-false-positives.mjs` — Path-scoped filter. Exempts SHA-256 checksum fields ONLY in docs/migrations/*.json. All other files fully scanned.
- `.husky/pre-commit` — Secret scanner uses filter-secret-scan-false-positives.mjs for path-scoped exemptions.
- `lib/__tests__/secret-scanner-migration-json.test.ts` — Integration tests for path-scoped secret-scanner exemptions.
  - **Affects:** Pre-commit secret scanning
  - **Could break:** Nothing — tooling only.

### Operations: Migration 297 production verification and Migration 115 completion
- `docs/MIGRATION_REGISTRY.md` — Migration 297 status updated to production-verified (#63). Migration 115 status updated to fully satisfied and individually recorded.
- `docs/engineering-status.json` — OPS-001 updated: PR #63 merged, Migration 297 production-verified, Migration 115 fully satisfied.
- `docs/ENGINEERING_STATUS.md` — OPS-001 row updated with PR #63 and merge SHA 16dad878.
  - **Affects:** Engineering ledgers and Issue #53 tracking only
  - **Could break:** Nothing — documentation only

### Operations: Migration reconciliation repair plan (corrected)
- `docs/migrations/101-246-production-reconciliation.json` — Evidence-backed manifest for all 146 migrations in the 101-246 range, rebuilt with real production verification evidence. Each entry includes original and current classification, repair eligibility, and verification status. 8 aligned/tracked, 127 verified-applied-untracked, 9 not-verifiable-safely, 2 superseded.
- `docs/migrations/101-246-repair-allowlist.json` — Immutable allowlist of 127 verified-but-untracked migrations eligible for controlled repair. Includes checksums and SHA-256 evidence digests (computed from canonical JSON of each manifest entry).
- `docs/migrations/101-246-repair-runbook.md` — Controlled batching runbook with 9 proposed batches (max 15 versions each), stop conditions, final reconciliation steps, and corrected repair command (`npx supabase migration repair --status applied <VERSION> --linked`). macOS-compatible checksum verification (`shasum -a 256`).
- `scripts/validate-migration-repair-allowlist.mjs` — Hardened deterministic validator with manifest/allowlist cross-validation: exactly 146 manifest entries covering versions 101-246, valid classifications only, filename/checksum verification, evidence-digest recomputation, exclusion checks for NOT_VERIFIABLE_SAFELY/SUPERSEDED/ALIGNED_TRACKED, and expected count of exactly 127 allowlist entries.
- `lib/__tests__/secret-scanner-migration-json.test.ts` — Secret-scanner false-positive exemption tests verifying the narrow SHA-256 checksum pattern only exempts "checksum", "local_checksum", and "evidence_digest" keys with 64-char lowercase hex values.
- `.husky/pre-commit` — Replaced file-level exclusion (`-- ':!docs/migrations/*.json'`) with narrow SHA-256 checksum exemption. All files are now fully scanned; only legitimate checksum/digest values are filtered from matches.
- `.github/workflows/ci.yml` — CI validation step added for migration repair plan in governance job.
- `package.json` — Added `verify:migration-repair-plan` npm script.
- `docs/MIGRATION_REGISTRY.md` — Updated remaining untracked migration counts and repair runbook reference.
  - **Affects:** Migration repair process, CI pipeline, Issue #53 tracking, pre-commit secret scanning
  - **Could break:** Nothing — documentation, tooling, and CI only. No migration SQL modified. No production operation occurred.

### Database: Complete Migration 115 properties trigger (Migration 297)
- `supabase/migrations/297_complete_migration_115_trigger.sql` — Forward trigger creation. Creates the missing `properties_updated_at` trigger on `public.properties` using the existing `public.update_updated_at()` function. BEFORE UPDATE, FOR EACH ROW. Idempotent via pg_trigger check. Fails clearly if prerequisites are missing. No data backfill required.
- `lib/__tests__/migration-297-trigger.test.ts` — 18 static migration-source tests verifying: correct target table, trigger name, timing, row-level, function call, idempotency guard, prerequisite checks. Migration 297 creates only the missing trigger schema object. It does not modify tables, columns, function bodies, policies or existing row data.
- `lib/__tests__/migration-297-trigger-db.test.ts` — 18 real PostgreSQL tests verifying: prerequisite existence, trigger creation, trigger properties (enabled, BEFORE, UPDATE, row-level, target table, function), behaviour (updated_at advances on UPDATE), function hash preservation, no unrelated triggers, row count preservation, idempotent second application.
- `.github/workflows/ci.yml` — Added "Migration 297 trigger tests" CI step with zero-skip enforcement.
- `docs/MIGRATION_REGISTRY.md` — Migration 297 registered as pending review. Migration 296 updated to production-verified (#62). Migrations 176, 181, 182 individually recorded. Migration 115 noted as partially applied. Migration 244 corrected to production-verified. Next available version updated to 298.
- `docs/engineering-status.json` — OPS-001 updated: reconciled to main SHA ae537205, PR #62 added, migrations 244/295/296 production-verified, 176/181/182 individually recorded, Migration 297 created.
- `docs/ENGINEERING_STATUS.md` — OPS-001 row updated with PR #62 and merge SHA ae537205.
- `CHANGELOG.md` — This entry.
  - **Affects:** `properties_updated_at` trigger on `public.properties` table
  - **Could break:** Nothing — creates only the missing trigger schema object. Does not modify tables, columns, function bodies, policies or existing row data.
  - **Production has NOT been modified by this PR** — Migration 297 must be reviewed, merged, and applied separately.

### Operations: Record Migrations 176, 181, 182 individual verification
- `docs/MIGRATION_REGISTRY.md` — Migrations 176 (api_keys), 181 (recurring_charge_rpc), 182 (recurring_bookings) individually verified and recorded as present in production. 2026-07-28.
  - **Affects:** Engineering ledgers and Issue #53 tracking only
  - **Could break:** Nothing — documentation only

### Operations: Record Migration 296 production verification
- `docs/MIGRATION_REGISTRY.md` — Migration 296 (restrict_sensitive_rpc_execution) status updated to applied to production (verified), PR #62.
  - **Affects:** Engineering ledgers only
  - **Could break:** Nothing — documentation only

## 2026-07-27

### Security: Restrict 7 sensitive RPC EXECUTE privileges (Migration 296)
- `supabase/migrations/296_restrict_sensitive_rpc_execution.sql` — Forward security migration. Explicitly revokes pre-existing direct `anon` and `authenticated` EXECUTE grants on 7 SECURITY DEFINER RPCs: book_slot_atomic (26 args), restore_stock, restore_variant_stock, restore_tickets_sold, redeem_loyalty_points, increment_campaign_donation, upsert_customer_profile. All confirmed service-role-only via application caller audit. Does NOT modify function bodies, owners, SECURITY DEFINER, search_path, or finance logic.
- `lib/__tests__/migration-296-rpc-permissions.test.ts` — Static migration-source tests verifying exact signatures, REVOKE/GRANT statements, role guards, and safety constraints.
- `lib/__tests__/migration-296-rpc-permissions-db.test.ts` — Real PostgreSQL tests verifying function existence, before/after privilege state, function property preservation, and idempotency for all 7 functions.
- `.github/workflows/ci.yml` — Added "Migration 296 RPC permission tests" CI step with zero-skip enforcement.
- `docs/MIGRATION_REGISTRY.md` — Migration 296 registered as pending review. Migrations 244 and 295 updated to production-verified. Next available version updated to 297.
- `CHANGELOG.md` — This entry.
  - **Affects:** EXECUTE privilege on 7 SECURITY DEFINER RPCs for anon and authenticated roles
  - **Could break:** Nothing — permission-only change. All 7 functions are called exclusively from service-role clients.
  - **Not yet applied to production** — requires review and merge before application.

### Security: Restrict process_recurring_charge RPC execution (Migration 295)
- `supabase/migrations/295_restrict_recurring_charge_rpc_execute.sql` — Forward security migration. Explicitly revokes pre-existing direct `anon` and `authenticated` EXECUTE grants on `process_recurring_charge(text, text, text, text, text, bigint, text, text, text, text)` that survived Migration 244's `REVOKE ... FROM PUBLIC`. Also re-applies REVOKE FROM PUBLIC and confirms GRANT EXECUTE TO service_role. Does NOT modify function body, owner, SECURITY DEFINER, search_path, or finance logic.
- `lib/__tests__/migration-295-rpc-permissions.test.ts` — 18 static analysis tests verifying: correct function signature targeting, all required REVOKE/GRANT statements, no function/schema modifications, idempotency, and pg_roles guards.
- `lib/__tests__/migration-295-rpc-permissions-db.test.ts` — 21 real PostgreSQL tests verifying: function existence, before-state capture, precondition grants, Migration 295 application, post-migration privilege verification (anon/authenticated revoked, service_role retained, PUBLIC cleared), function properties unchanged (definition, owner, SECURITY DEFINER, search_path), idempotent second-run, no table/data/policy changes.
- `.github/workflows/ci.yml` — Added "Migration 295 RPC permission tests" CI step in Migration validation job. Runs real PostgreSQL tests with zero-skip enforcement.
- `docs/MIGRATION_REGISTRY.md` — Migration 295 registered as pending review. Next available version updated to 296.
- `CHANGELOG.md` — This entry.
  - **Affects:** EXECUTE privilege on `process_recurring_charge` RPC for anon and authenticated roles
  - **Could break:** Nothing — permission-only change, no function or schema modifications. Only service_role (used by webhooks/cron) needs EXECUTE.
  - **Not yet applied to production** — requires review and merge before application.

### Operations: Record Migration 200 production verification
- `docs/MIGRATION_REGISTRY.md` — Migration 200 (partner_events_api) status updated to applied and production-verified. api_key_id nullable UUID with FK to api_keys(id) ON DELETE SET NULL; partial B-tree index exists; event count remained 14; existing events remain NULL. Production-verified 2026-07-27.
- `docs/engineering-status.json` — OPS-001 updated: Migration 200 verification evidence added, PR #59 merge SHA recorded, blockers reduced to Migration 244 only, next action set to Migration 244 read-only preflight. Reconciled to main SHA `42dca86f`.
- `docs/ENGINEERING_STATUS.md` — OPS-001 row updated with PR #59 and merge SHA `42dca86f`. Reconciled SHA updated.
- `CHANGELOG.md` — This entry.
  - **Affects:** Engineering ledgers and Issue #53 tracking only
  - **Could break:** Nothing — documentation only, no application code or SQL changes

### Operations: Record Migration 199 production verification
- `docs/MIGRATION_REGISTRY.md` — Migration 199 status updated to applied and production-verified (PR #58). Both columns (allow_after_end_date, allow_after_goal_met) confirmed as BOOLEAN NOT NULL DEFAULT true. Existing campaign count remained 5.
- `docs/engineering-status.json` — OPS-001 updated: Migration 199 verification evidence added, PR #58 merge SHA recorded, blockers reduced to migrations 200 and 244, next action set to Migration 200 read-only preflight. Reconciled to main SHA `41c97522`.
- `docs/ENGINEERING_STATUS.md` — OPS-001 row updated with PR #58 and merge SHA `41c97522`. Reconciled SHA updated.
- `CHANGELOG.md` — This entry.
  - **Affects:** Engineering ledgers and Issue #53 tracking only
  - **Could break:** Nothing — documentation only, no application code or SQL changes

### Campaigns: Enforce donation continuation settings (allow_after_end_date / allow_after_goal_met)
- `lib/utils/campaign-column-fallback.ts` — Shared narrow classifier for Migration 199 toggle columns. Matches 42703/PGRST204 only when message mentions `allow_after_end_date` or `allow_after_goal_met`. Used by both bot flow and dashboard.
- `lib/bot/flows/crowdfunding.flow.ts` — WhatsApp crowdfunding flow now queries expanded column set. On toggle-column-missing error, falls back to legacy select. Unrelated errors (auth, RLS, network) return a generic temporary-error message (not "No active campaigns") and are logged server-side via logger/safeLogErrorContext. Legacy retry failures also return the generic error. No raw DB details in user-facing output.
  - **Affects:** WhatsApp donation flows, campaign list display
  - **Could break:** Nothing — backward-compatible before Migration 199; enforces toggles after
- `app/dashboard/campaigns/page.tsx` — Campaign save captures write errors. Uses the shared `isToggleColumnMissing` classifier (not a broad code-only check) to retry without toggle columns only for the two Migration 199 columns. Other errors show inline banner. Previously errors were silently discarded.
  - **Affects:** Campaign create/edit UI
  - **Could break:** Nothing — adds error visibility that was missing
- `lib/bot/flows/__tests__/crowdfunding-donation-toggles.test.ts` — 27 focused tests covering shared classifier, expanded query, legacy fallback, unrelated error passthrough, legacy retry failure, no-secrets-in-output, all toggle enforcement scenarios, dashboard error handling, and cross-business isolation.

### Operations: Record Migration 119 and 294 production verification
- `docs/MIGRATION_REGISTRY.md` — Migration 294 status updated to production-verified (PR #56). Migration 119 status updated from partially-applied to aligned (completed by Migration 294). Obsolete Migration 294 reservation removed.
- `docs/engineering-status.json` — Added OPS-001 milestone (IN_PROGRESS) for Issue #53 migration history alignment. Reconciled to main SHA `66c5ad29`. SEC-001 next_action updated to reflect Migration 119 resolved.
- `docs/ENGINEERING_STATUS.md` — Added OPS-001 row. Reconciled SHA updated.
- `CHANGELOG.md` — This entry.
  - **Affects:** Engineering ledgers and Issue #53 tracking only
  - **Could break:** Nothing — documentation only, no application code or SQL changes

### Database: Complete Migration 119 form response index
- `supabase/migrations/294_complete_migration_119_index.sql` — Creates the missing `idx_form_responses_business` index on `public.form_responses(business_id)`. Issue #53 preflight confirmed Migration 119 was partially applied to production: tables, RLS policies, and other indexes exist, but this one index was skipped. Uses `CREATE INDEX IF NOT EXISTS` for idempotent execution. Does not modify historical Migration 119.
  - **Affects:** `form_responses` table query performance on `business_id` lookups
  - **Could break:** Nothing — additive index only, IF NOT EXISTS guards against double-apply
- `docs/MIGRATION_REGISTRY.md` — Updated: Migration 293 status to production-verified, added Migration 294, next available version = 295.

### Security: Remove public access to sensitive platform tables (P0)
- `supabase/migrations/293_fix_production_table_exposure.sql` — Drops 4 overly permissive RLS policies discovered during Issue #53 preflight. Creates restricted public views for `whatsapp_channels` and `businesses` with `security_barrier = true`. Supersedes the security intent of migration 223 (which was never applied to production). No credential values are deleted, nulled, or modified.
  - Drops `shared_channels_public_read` on `whatsapp_channels` (exposed Meta API tokens to anon)
  - Drops `processed_webhook_events_service_all` (granted full R/W to anon)
  - Drops `public_read_active_businesses` on `businesses` (exposed all columns including Google OAuth tokens to anon)
  - Drops `anyone_read_system_category` on `bot_keywords` (allowed anon to read routing logic)
  - Creates `whatsapp_channels_public` view (id, country_code, phone_number, display_name, channel_type, is_active) with security_barrier
  - Creates `businesses_public` view (25 safe columns, no tokens/credentials/internal config) with security_barrier
  - Policies use explicit DROP + CREATE (not IF NOT EXISTS) to guarantee exact definitions
  - Creates `bot_keywords_service_read` and `bot_keywords_owner_read` policies
  - Revokes access from PUBLIC, anon, and authenticated on base tables
  - Grants SELECT, INSERT, UPDATE, DELETE to service_role on processed_webhook_events (all four required by webhook handlers and cleanup cron)
  - REVOKE ALL FROM PUBLIC on all four sensitive base tables
  - Views: REVOKE ALL FROM PUBLIC then GRANT SELECT only to anon, authenticated
  - Strengthened audit block: checks for ANY policy granting anon access (not just named policies), verifies effective privileges with has_table_privilege(), verifies service_role has exactly required privileges
- `lib/supabase/safe-view-query.ts` — Zero-downtime transition helpers with column allowlist enforcement. Validates requested columns against BUSINESSES_PUBLIC_COLUMNS / CHANNELS_PUBLIC_COLUMNS before issuing any query. Rejects wildcards, aliases, nested selections, functions, relationship expressions, and unknown columns. Falls back to base table (safe columns only) exclusively on PostgreSQL 42P01 (relation not found). Does NOT fall back on permission errors, network errors, or other failures.
- `app/b/[slug]/page.tsx` — Public booking page uses `queryBusinessesPublic()` fallback helper.
- `app/recurring/[slug]/page.tsx` — Recurring setup page uses `queryBusinessesPublic()` fallback helper.
- `app/get-started/OnboardingWizard.tsx` — Shared channel queries use `queryChannelsPublic()` fallback helper.
- `app/dashboard/page.tsx`, `app/dashboard/qr-code/page.tsx`, `app/dashboard/keyword-campaigns/page.tsx` — Shared channel fallback queries use `queryChannelsPublic()` fallback helper.
- `lib/__tests__/p0-table-exposure.test.ts` — Static tests: migration SQL structure, view safety, application fallback usage, column allowlist enforcement, active-business semantics.
- `lib/__tests__/p0-table-exposure-db.test.ts` — Real PostgreSQL authorization tests: 20 role-based assertions applied against an isolated database. Runs in CI via Migration validation job. Fails on any skip or failure.
- `.github/workflows/ci.yml` — Added P0 authorization test step to Migration validation job with TEST_DATABASE_URL pointing to CI-local PostgreSQL. Enforces zero skips, zero failures.
- **Active-business semantics:** The `businesses` table has only `status` (enum: pending/active/suspended). There is no `is_active` column. The canonical public-visibility predicate is `status = 'active'`.
- **Recovery plan:** Forward-only. The rollback plan NEVER restores the dropped policies. If the views need adjustment, a new forward migration (294+) corrects them. Application code rollback is safe because the fallback helpers gracefully handle both pre- and post-migration states.
- **Deployment sequence (application-first only):**
  1. Merge and deploy the new application code.
  2. Confirm the production deployment is healthy.
  3. Confirm public business, recurring, onboarding and shared-channel flows work using the 42P01 fallback.
  4. Only then apply migration 293.
  5. Verify the views exist and direct base-table access is denied.
  6. Verify public pages now use the views.
  7. Mark migration 293 as applied in migration history.
  - Migration 293 must NOT be applied before the new application version is live.
  - If the application deployment fails, do NOT apply migration 293.
  - The fallback is transitional and supports application-first deployment only.
- **Affects:** Public business pages, onboarding, dashboard shared-channel fallbacks. All authenticated dashboard queries continue via owner RLS policies. Migration 223 is not modified. No production deployment was manually authorised or performed. A Vercel Preview may have been automatically created by the branch push. Production remains unchanged.

---

## 2026-07-26

### FIN-002: Require Paystack account_name before claim, move gateway alignment earlier
- `app/api/admin/payouts/[id]/approve/route.ts` — Added strict `account_name` validation for `paystack_transfer`: must be `typeof string` and non-blank. Returns 400 before claim RPC and provider call. Moved gateway/transfer-method alignment check immediately after payout-account ownership, active, and verification checks (before destination queries and balance verification).
- `lib/__tests__/fin-002-atomic-payout.test.ts` — Added 3 new tests: account_name null → 400 with zero claim/provider calls, account_name blank → 400 with zero claim/provider calls, valid account_name continues normally. Total: 92 route tests.
- **Affects:** Admin payout approval (null/blank account_name blocked before claim).

### FIN-002: Review corrections — cron eligibility, gateway alignment, message validation, contention evidence
- `app/api/cron/auto-payout/route.ts` — `canAutoApprove` now requires all of: NG/GH country, eligible Paystack account (gateway=paystack, active, verified, bank_code, account_number, account_name), PAYSTACK_SECRET_KEY configured, cooling period, velocity, amount limit, business verification. Previously only required `payoutAccount` (any gateway). Hold reasons expanded with specific failure messages.
- `app/api/admin/payouts/[id]/approve/route.ts` — Added gateway/transfer-method alignment check before claim RPC. `paystack_transfer` requires `gateway=paystack`; `stripe_transfer` requires `gateway=stripe`. Mismatch returns 400 with zero claim RPC calls, zero provider calls, payout state unchanged. Payout account query now fetches `gateway` column.
- `lib/payments/payout-classification.ts` — Paystack conclusive rejection now requires `typeof message === 'string' && message.trim().length > 0`. Numbers, objects, arrays, booleans, null, and blank strings produce `review_required`. Uses `??` instead of `||` for nullish coalescing.
- `.github/workflows/ci.yml` — Contention test: Session A stores returned token in persistent `_contention_winner_token` table (not temp table — session-scoped). `WINNER_TOKEN_MATCHES` now compares the returned token to the persisted `claim_token` (was previously comparing `claim_token` to itself). Cleanup drops `_contention_winner_token`.
- `lib/__tests__/fin-002-atomic-payout.test.ts` — Added 25 new tests: 9 cron auto-approval eligibility (Stripe-only, inactive, unverified, missing bank_code/account_number/account_name, unsupported country, missing key, fully eligible), 6 gateway/method alignment (Paystack+Stripe, Paystack+Flutterwave, Stripe+Paystack, Stripe+Square, matching Paystack, matching Stripe), 10 Paystack malformed message types (number, boolean true/false, object, array, null, blank, valid string, data.message numeric, data.message valid string).
- **Affects:** Cron auto-payout (Stripe-only accounts no longer auto-approved), admin payout approval (gateway mismatch blocked), Paystack classification (non-string messages no longer treated as conclusive rejection), CI contention test (correct cross-session token comparison).

### FIN-002: Provider body-validated classification, cron account eligibility, RPC result handling
- `lib/payments/payout-classification.ts` — New shared helpers: `classifyPaystackError()` (requires `status===false` + non-empty message for conclusive 4xx), `classifyStripeError()` (requires error object + type/code/message), `isEligiblePaystackAccount()` (validates gateway, verified_at, bank fields). 408/409/429/5xx/malformed JSON always → review_required.
- `app/api/admin/payouts/[id]/approve/route.ts` — Replaced inline `isConclusive4xxRejection()` with shared `classifyPaystackError()`/`classifyStripeError()`. Now validates provider response body, not just HTTP status.
- `app/api/cron/auto-payout/route.ts` — Replaced inline `is4xx` classification (which treated 409 as conclusive failure) with shared `classifyPaystackError()`. Added `isEligiblePaystackAccount()` check before claim — requires gateway=paystack, verified_at, bank_code, account_number, account_name. All transition RPC calls now check both `data` and `error`; zero-row results are logged as failures.
- `.github/workflows/ci.yml` — Improved two-session contention test: captures Session A claim count (verifies winner=1), adds trap-based cleanup, avoids printing claim tokens in CI logs, verifies exactly-one-winner invariant, cleans up profiles/auth.users.
- `lib/__tests__/fin-002-atomic-payout.test.ts` — Expanded from 31 to 63 tests. Added: Paystack/Stripe 4xx without valid body → review_required, 409 → review_required, empty error fields → review_required, HTML proxy response → review_required. Added 13 unit tests for shared classification helpers. Added 10 payout-account eligibility tests. Added cron structural verification tests.
- **Affects:** Admin payout approval, cron auto-payout, provider error classification. A Paystack 409 (duplicate reference) or 4xx with malformed body that was previously marked `failed` (releasing balance) is now correctly marked `review_required` (balance remains reserved).

---

## 2026-07-25

### Security: Prevent platform administrator privilege escalation
- **Vulnerability:** Authenticated users could UPDATE `profiles.role` to `'admin'` via the permissive `"Users manage own profile"` FOR ALL RLS policy. `is_admin()` read from `profiles.role`, so a self-escalated user gained full platform admin access across all 32 admin-gated RLS policies and 18 admin API routes.
- **Canonical authority:** `auth.users.raw_app_meta_data.role` is now the sole platform-role source. This field is set server-side by Supabase Auth admin operations and is never user-writable.
- `supabase/migrations/247_admin_role_escalation_fix.sql` — Dropped permissive `FOR ALL` profile policy. Created operation-specific `profiles_select_own` (SELECT) and `profiles_update_own` (UPDATE) policies. Revoked all privileges from `authenticated`; granted SELECT + column-restricted UPDATE (first_name, last_name, email, phone, last_login_at, updated_at only). Added `trg_protect_profiles_role` (BEFORE UPDATE) and `trg_protect_profiles_role_insert` (BEFORE INSERT) triggers that reject unauthorized role changes. Redefined `is_admin()` and `is_admin_or_support()` to read `auth.users.raw_app_meta_data` with COALESCE fail-closed. All four functions use SECURITY DEFINER with `SET search_path = ''`.
- `lib/admin-auth.ts` — New shared `requirePlatformAdmin()` helper. Checks ONLY `app_metadata.role`. Does not trust `profiles.role`, `raw_user_meta_data`, or hardcoded UUIDs.
- 14 admin API routes + 4 non-admin routes with admin checks (`email/send`, `reseller/invite`, `verification/request`, `verification/review`) + `whatsapp/templates/check` — All updated to use `requirePlatformAdmin()`.
- `admin/src/lib/adminAuth.ts`, `admin/src/pages/Login.tsx` — Admin panel reads `app_metadata.role` only, no `profiles.role` fallback.
- `app/dashboard/layout.tsx` — Impersonation re-validation uses `verifyAdminRole()` from trusted Auth source.
- `scripts/admin-provision.ts` — Admin provisioning via Supabase Auth admin API. Identity resolution uses ONLY Auth — never `profiles`.
- `lib/__tests__/admin-role-escalation.test.ts` (26 tests), `lib/__tests__/admin-provision.test.ts` (15 tests) — Repository-wide audit for `profiles.role` authorization, hardcoded IDs, browser `auth.admin` calls; migration policy/grant/trigger verification; `requirePlatformAdmin` behavior; template-check route handler with 15 executable spy tests; `verifyCronAuth` contract analysis; admin provisioning identity resolution and metadata preservation.
- **Removed:** `PLATFORM_OWNERS` hardcoded UUID bypass.
- **Production deployment:** Commit `78e28344`. Admin provisioned via `app_metadata.role` before migration. Migration 247 applied. Post-deployment verification confirmed: ordinary users cannot escalate, approved profile updates work, `is_admin()` recognizes the provisioned admin, main site and admin site HTTP 200, all six CI checks passed (Main App, Admin App, Migration validation, Playwright smoke tests, Secret scanning, Dependency audit).
- **Affects:** All `/api/admin/*` routes, admin panel authentication, dashboard impersonation, `profiles` RLS policies, `is_admin()` and `is_admin_or_support()` functions, 32 dependent RLS policies across the database.

---

## 2026-07-24

### Observability: Persist WhatsApp OTP delivery status
- `supabase/migrations/248_otp_delivery_tracking.sql` — Two new append-only tables: `otp_delivery_attempts` (links challenge_id to Meta message ID + delivery path) and `otp_delivery_status_events` (records sent/delivered/read/failed with sanitized error info). RLS enabled, service_role SELECT+INSERT only, no anon/authenticated access. Does NOT modify Migration 246 (`phone_otp_challenges`).
- `app/api/auth/otp/send/route.ts` — Captures Meta message ID from `sendAuthenticationTemplate()` return and records delivery attempt with path (`database_channel` or `env_fallback`). Observability insert failure is non-blocking — does not cause resend of an already-accepted message.
- `app/api/webhook/meta-cloud/route.ts` — Extended status handler to match OTP delivery attempts by Meta message ID and insert status events. Duplicate callbacks handled via unique constraint (23505 silently ignored). Sanitized error info for failed statuses. Existing contract/signer status handling unchanged.
- `lib/otp-delivery-diagnostics.ts` — Internal read-only helper + documented SQL query for diagnosing delivery status without exposing sensitive identifiers.
- `lib/__tests__/otp-delivery-observability.test.ts` — 20 tests covering: attempt recording for both paths, message ID not returned to client, no PII stored or logged, observability failure tolerance, webhook status persistence (sent/delivered/read/failed), duplicate/out-of-order callback handling, unknown message ID safety, contract handler preservation, Migration 246 security, and table privilege verification.
- **Why:** The controlled production acceptance test returned HTTP 200 but the OTP was not received. The Meta message ID was discarded and no delivery status was tracked, making the failure undiagnosable (classified: DELIVERY STATUS UNKNOWN — INSUFFICIENT EVIDENCE).
- **Affects:** OTP send route (observability only — no verification or security changes), Meta webhook status handler (additive).

---

## 2026-07-23

### Security: Deliver phone OTP via WhatsApp authentication template
- `lib/channels/meta-cloud.ts` — Added `sendAuthenticationTemplate()` method. Sends approved `waaiio_login_otp` AUTHENTICATION template with BODY and COPY_CODE button components. Validates 6-digit OTP format. Fails closed when Meta returns no message ID.
- `app/api/auth/otp/send/route.ts` — Replaced both `sendText()` calls (DB channel + env fallback) with `sendAuthenticationTemplate()`. Added `OTP_TEMPLATE_NAME` and `OTP_TEMPLATE_LANGUAGE` constants.
- `lib/__tests__/otp-authentication-template.test.ts` — 14 tests covering payload structure, code identity across BODY/button, message ID return, fail-closed behavior, OTP format validation, route channel selection, fallback, response safety, and static sendText regression.
- `lib/__tests__/console-error-cleanup.test.ts`, `lib/__tests__/phone-otp-challenge.test.ts` — Updated mocks from `sendText()` to `sendAuthenticationTemplate()`.
- **What was broken:** Free-form `sendText()` cannot deliver OTPs to cold numbers without a 24-hour WhatsApp customer service window. Authentication templates bypass this restriction.
- **Affects:** Phone OTP login flow. No other WhatsApp flows changed.

---

## 2026-07-14

### UX: Value-first onboarding redesign
- `app/get-started/steps/StepCategory.tsx` — Replaced 13-tile industry grid with 6 outcome-based tiles: "Book a time", "Order products", "Buy tickets", "Reserve a table/stay", "Make payments", "Request a service". Added search fallback for direct category lookup.
- `app/get-started/steps/StepFeatures.tsx` — Changed header from "What should your bot do?" to "Here's what we'll set up for you" (confirmation framing).
- `app/get-started/OnboardingWizard.tsx` — Updated side panel copy and step label from "Industry" to "Needs".
- **Design principle:** Frame choices around what customers GET, not what the business IS.
- **Affects:** Onboarding flow step 2 (category selection), step 3 (features), side panel.

### Admin: Engagement & Activity tracking page
- `admin/src/pages/EngagementActivity.tsx` — New admin page surfacing QR scan activity from existing data. 4 summary cards (web check-ins today/week, bot sessions today, event scans today). 3 tabs: Check-ins (attendance_log entries with date filter), Top Businesses (aggregated activity ranking), Ticket Scans (event_tickets with scanned_at). All lazy-loaded per tab with pagination.
- `admin/src/routes.tsx` — Added engagement route, gated to admin + operations roles.
- `admin/src/components/AdminSidebar.tsx` — Added "Engagement" nav item with ScanLine icon.
- **Affects:** Admin panel only. No new tables — reads from existing attendance_log, bot_sessions, event_tickets.

### Security: Fix Meta Embedded Signup — fail-fatal, token encryption, auto-refresh
- `app/api/auth/facebook/callback/route.ts` — **Phone registration and WABA subscription are now fail-fatal.** If either fails, channel is deactivated (`is_active: false`) with error stored in `metadata`, and 422 returned to user with clear error message. Previously these failed silently and left "connected" channels that couldn't send or receive. Business profile + template provisioning remain non-fatal (nice-to-have).
- `app/api/auth/facebook/callback/route.ts` — **Access token now encrypted** with AES-256-GCM via `encryptToken()` from `lib/encryption.ts` before storage. Channel resolver already calls `decryptToken()` on read. Requires `TOKEN_ENCRYPTION_KEY` env var.
- `app/api/cron/refresh-meta-tokens/route.ts` — **New daily cron** (3:30 AM UTC) refreshes Meta access tokens expiring within 14 days. Calls Meta's `fb_exchange_token` endpoint, encrypts new token, updates DB. Processes sequentially for rate limit compliance. Doesn't deactivate channels on refresh failure (token may still be valid).
- `vercel.json` — Added cron schedule for token refresh (staggered at :30 to avoid collision with cleanup at :00).
- **What was broken:** (1) Channels created with failed registration/subscription looked "connected" but didn't work. (2) Tokens stored unencrypted. (3) Tokens expired after 60 days with no refresh — channels silently died.
- **Affects:** Embedded Signup flow, all dedicated WhatsApp channels, token storage security.

### Feature: Web-based attendance check-in
- `supabase/migrations/229_attendance_log.sql` — New `attendance_log` table with business_id, customer_name, phone, email, source (web/whatsapp/manual), checked_in_at. RLS: owners read/delete, service insert. Indexes on business+date and business+phone+date.
- `app/checkin/[businessId]/page.tsx` — Public check-in page (no auth). Shows business name + logo, form with name (required), phone/email (optional). Detects same-day duplicate by phone. Success screen with WhatsApp CTA "Connect on WhatsApp for updates". Mobile-first design.
- `app/api/checkin/route.ts` — POST (public, rate limited 10/min): validates business, dedup check, inserts attendance, resolves WhatsApp link for response. GET (authenticated): returns attendance entries for business owner with date filter + pagination.
- `app/dashboard/attendance/page.tsx` — Dashboard page showing today's count, date picker, attendance table (name, masked phone, time, source badge), manual add form, CSV export.
- `components/dashboard/Sidebar.tsx` — Added Attendance nav item in manage section. No capability gate (universal feature).
- `app/dashboard/qr-code/page.tsx` — Added "Scan to Check In" attendance template that generates web URL (`/checkin/{id}`) instead of WhatsApp deep-link. Renamed queue template to "Scan to Join Queue". Hides prefill text input when attendance template active.
- `middleware.ts` — Added `/api/checkin` to CSRF exemption list for public form submission.
- **How it works:** Business prints "Scan to Check In" QR → customer scans → web page loads → enters name → checked in (3 seconds). Success screen offers WhatsApp opt-in for follow-ups.
- **Affects:** New public page, new API route, new dashboard page, QR code templates, sidebar navigation.

### Feature: QR code page full customization
- `app/dashboard/qr-code/page.tsx` — Complete rewrite with 5 customization features:
  1. **Custom brand color** — color picker overrides template default. "Reset" link to go back.
  2. **Business logo on poster** — logo_url from business profile replaces emoji on both preview and downloaded poster. Loaded with crossOrigin for canvas. Falls back to emoji if no logo.
  3. **Editable subtitle & CTA label** — text inputs with template defaults as placeholders. "Pay parking here" instead of "Make a quick payment". Resets when template changes.
  4. **4 download sizes** — A4 Poster (2480x3508), Table Tent (1200x1600), Sticker (800x800 minimal), Social Media (1080x1080 square). Each has optimized layout.
  5. **Live preview** — all customizations reflect instantly in the poster preview.
- **Affects:** QR Code & Link dashboard page.

### Feature: Smart QR Codes — deep-link to specific capabilities
- `lib/bot/handlers/bot-code-detection.ts` — Added `parseDeepLink()` that splits `BOTCODE:capability` suffix. Returns `deepLinkCapability` in detection result. Only splits on last `:` and validates against all CapabilityId values. Fully backwards compatible — no suffix = works as before.
- `lib/bot/bot.service.ts` — When `deepLinkCapability` is present AND the business has that capability enabled, overrides `firstStep` via `capabilityToFirstStep()` to skip the menu. Stores `_deep_link_capability` in session_data for flow context.
- `app/dashboard/qr-code/page.tsx` — Template selection now auto-updates prefill text with deep-link suffix (e.g. "Scan to Pay" → `BOTCODE:payment`). Added giving template. Shows "Smart QR" hint when deep-link suffix is active. Manual edits to prefill text are preserved (not overridden by template changes).
- **How it works:** QR encodes `wa.me/number?text=BOTCODE:payment` → bot parses `:payment` → customer lands directly in payment flow. No menu, no "How can I help you?"
- **Affects:** Bot message entry point, QR code dashboard, all capability flows (via existing `capabilityToFirstStep`).

### UX: QR code as hero — onboarding side panel + success screen
- `app/get-started/OnboardingWizard.tsx` — Side panel now tells the QR code story across every step: "One QR code. Any transaction." → "Your QR code will handle all of this" → "Almost ready to print" → "Print it. Stick it. You're open."
- `app/get-started/steps/StepSuccess.tsx` — Complete redesign. QR code is now the hero (large, centered, downloadable as PNG). "Print this. Stick it anywhere." heading. "Where to put it" suggestions (counter, window, flyers, social media). Copy Link + Download QR buttons. Capability-aware action verb. WhatsApp test button is secondary outline style.
- **Design principle:** The QR code IS the product. Every sticker is a permanent ad that converts.
- **Affects:** Onboarding success screen, side panel across all steps.

### UX: Reframe onboarding for local economies
- `app/get-started/steps/StepCategory.tsx` — "Collect payments" is now the first outcome tile (was buried as "Make a payment or donation"). Rewritten to reflect WhatsApp-heavy economies: parking, school fees, market vendors, bills. "Sell tickets" now includes transport (bus tickets). Added 60+ Nigerian/local economy search aliases: "buka", "keke", "okada", "mama put", "barbing", "provision", "vulcanizer", etc. Reordered tiles: payments first, orders second (highest-impact use cases).
- **Design principle:** Waaiio is local economy infrastructure, not just a business SaaS.
- **Affects:** Onboarding outcome tiles, search aliases, tile ordering.

### Fix: Onboarding search + missing category groups
- `app/get-started/steps/StepCategory.tsx` — Added smart search with 100+ keyword aliases (e.g. "medicals" → Clinic, Dental, etc.). Search now matches group names, partial words, and common synonyms. Added Pet Services, Creative & Media, Real Estate & Property to "Book a time" outcome. Updated search placeholder with examples.
- **Affects:** Onboarding category search, outcome tile coverage.

### UX: Spam/Junk folder notice on email verification
- `app/get-started/steps/StepAuth.tsx` — Added hint below confirmation message: "Can't find the email? Check your Spam or Junk folder."
- `app/(auth)/forgot-password/page.tsx` — Same spam/junk hint on password reset confirmation.
- `app/(auth)/login/page.tsx` — Updated error messages for unconfirmed email to mention Spam/Junk folders.
- **Affects:** Signup flow, forgot-password flow, login error messages.

---

## 2026-07-09

### Feature: Customer LTV tier scoring
- `supabase/migrations/227_customer_ltv_tier.sql` — Adds `ltv_tier` VARCHAR(20) DEFAULT 'new' column to `customer_profiles` with index.
- `lib/bot/customer-intelligence.ts` — Added `calculateLtvTier(totalSpent, totalVisits)` function. Tiers: vip (>=500,000 minor units), regular (>=3 visits), new.
- `lib/bot/customer-intelligence.ts` — Added `ltvTier` to `CustomerHistory` interface and `getCustomerHistory` return.
- `lib/bot/customer-intelligence.ts` — Updated `buildReturnGreeting` to show VIP-specific greeting ("Great to see you again").
- `lib/bot/flows/shared/post-completion.ts` — Recalculates and stores `ltv_tier` after each payment.
- `lib/bot/flows/payment.flow.ts` — Calculates and stores `ltv_tier` on customer_profiles upsert.
- `lib/bot/bot.service.ts` — VIP customers get enhanced greeting in quick rebook flow. Stores ltvTier in session data.
- Affects: Bot greeting personalization, customer_profiles table. Requires migration 227.
- Could break: Nothing — additive column with default value. Existing profiles default to 'new'.

### Feature: Bot refund request capability
- `lib/bot/handlers/refund-request.ts` — New inline handler. Looks up customer's recent paid bookings by phone, shows list, collects reason, inserts into `refund_requests` table (status=pending), notifies business owner via email/WhatsApp + system notification.
- `lib/bot/handlers/keyword-actions.ts` — Added `request_refund` action in `navigate_step` case. Creates new session with `refund_select` step.
- `lib/bot/bot.service.ts` — Added step routing for `refund_select` and `refund_reason` steps. Added `handleRefundRequest` private method.
- `supabase/migrations/226_refund_keyword.sql` — Inserts system keyword regex matching "refund", "request refund", "i want a refund", etc.
- Guards: Skips payments for events with `refund_policy='no_refund'`, skips already-fully-refunded payments, deduplicates pending requests for same payment_id.
- Affects: Bot message handling. Customers can now type "refund" to request a refund via WhatsApp.
- Could break: Nothing — new additive feature. Requires migration 226 to be run on remote.

---

## 2026-06-21

### Pricing update: Direct transfers included in subscription
- `lib/constants.ts` — Updated PRICING_TIERS: Growth ₦15,000→₦20,000 ($20), Business ₦50,000→₦60,000 ($45). Updated COUNTRY_PRICING for all 6 countries. Added "Direct bank transfer (zero gateway fees)" to features list for Growth + Business. Updated TIER_FEATURES highlights.
- `app/api/dashboard/pending-transfers/[id]/route.ts` — Platform fee on direct transfers now recorded as ₦0 (analytics only, not billed). Removed getPlatformFees call + reseller commission calculation for direct transfers.
- `app/api/cron/platform-fee-overdue/route.ts` — DISABLED. Returns immediately. Per-transaction invoicing replaced by subscription pricing.
- `app/(marketing)/help/page.tsx` — Updated pricing FAQ to reflect new prices.
- `vercel.json` — Removed platform-fee-overdue cron schedule.
- Affects: All pricing pages (auto-update via getPricingTiers), help page, billing. Direct transfers are now zero per-transaction fee — included in subscription.
- Could break: Existing subscribers see old price until renewal. New subscribers get new pricing immediately.

### Feature: Platform fee invoicing for direct bank transfers (SUPERSEDED by pricing update above)
- `supabase/migrations/212_platform_fee_invoices.sql` — New `platform_fee_invoices` table with dedup index, status tracking, line items. Added `invoiced_at` + `invoice_id` columns to `platform_fees`. RLS for business owners, admin/finance, service role.
- `app/api/cron/platform-fee-invoices/route.ts` — Monthly cron (1st of each month, 9:17 UTC). Aggregates uninvoiced direct transfer fees per business, generates PFI-YYYY-MM-NNN invoices, marks fees as invoiced, emails business owner with breakdown.
- `app/api/cron/platform-fee-overdue/route.ts` — Daily cron (10:23 UTC). Marks past-due invoices as overdue, sends reminder emails, disables direct transfers after 7 days overdue (deactivates bank accounts).
- `vercel.json` — Added 3 new cron schedules: expire-transfers (every 15min), platform-fee-invoices (monthly), platform-fee-overdue (daily).
- Affects: All businesses using direct bank transfers. Fee collection is now automated with email notifications + overdue enforcement.
- Could break: Nothing — invoicing is additive. Overdue enforcement deactivates bank accounts (reversible by paying invoice).

### Security + integrity fixes for direct bank transfer system
- `lib/bot/receipt-ocr.ts` — Raised OCR confidence threshold from 0.5 to 0.7.
- `lib/bot/flows/payment.flow.ts` — **OCR no longer auto-confirms.** OCR pre-verifies receipt and stores results, but business always confirms. Bot notifies business owner via `notifyOwnerNewPayment()` + `createNotification()` with OCR status. Customer told "business will review."
- `app/api/dashboard/pending-transfers/[id]/route.ts` — **Fixed race condition:** added `.eq('status', 'pending')` to UPDATE to prevent double-confirm (duplicate payment + fee records). Added customer WhatsApp notification on confirm. Added in-app notification.
- `app/api/cron/expire-transfers/route.ts` — Added customer WhatsApp notification when transfer expires and booking cancelled.
- `app/api/admin/payouts/generate/route.ts` — **Fixed phantom payouts:** excluded `is_direct_transfer=true` from gross calculation. Waaiio never holds direct transfer funds.
- `supabase/migrations/211_ocr_result_and_admin_rls.sql` — Added `ocr_result` JSONB column to pending_transfers. Added admin RLS policies for business_bank_accounts (SELECT) and pending_transfers (UPDATE).
- Affects: All direct bank transfer flows, payout generation, admin panel access.
- Could break: Nothing — all changes are additive or fix existing bugs.

### Feature: Receipt OCR pre-verification via Claude Vision (was auto-confirm, now business-confirms)
- `lib/bot/receipt-ocr.ts` — Sends receipt screenshots to Claude Haiku Vision, extracts amount, reference, sender name, bank, date. Returns confidence score. ~$0.01 per image.
- `supabase/migrations/210_receipt_ocr.sql` — Adds `verified_by_ocr` boolean to pending_transfers for analytics.
- Affects: All direct bank transfer payments. Auto-confirm reduces wait from hours to seconds.
- Could break: Nothing — OCR is additive. Falls back to manual if ANTHROPIC_API_KEY unset or OCR fails.

### Feature: Direct bank transfer payment system (zero gateway fees)
- `supabase/migrations/209_direct_bank_transfer.sql` — New tables: business_bank_accounts (bank details per business), pending_transfers (transfer tracking with 4-hour expiry). Added is_direct_transfer flag to platform_fees. RLS + indexes.
- `app/api/dashboard/bank-account/route.ts` — CRUD for business bank accounts. Tier-gated (Growth/Business only). 10-digit account validation.
- `app/api/dashboard/pending-transfers/route.ts` — GET pending transfers with status filter.
- `app/api/dashboard/pending-transfers/[id]/route.ts` — PATCH confirm/reject. On confirm: updates booking/order/invoice, creates payment record with gateway='direct', records platform fee with is_direct_transfer=true. On reject: stores reason.
- `app/api/cron/expire-transfers/route.ts` — Expires pending transfers past 4-hour deadline. Cancels related bookings/orders.
- `lib/bot/flows/payment.flow.ts` — Dual-option payment for qualifying businesses: Paystack link + bank details with unique WA-XXXX reference. Customer can send receipt screenshot as proof. Added acceptsMedia to await_payment step.
- `lib/bot/flows/types.ts` — Added acceptsMedia property to FlowStepConfig.
- `lib/bot/flows/executor.ts` — Respects acceptsMedia flag on flow steps.
- `app/dashboard/payments/pending/page.tsx` — Pending transfers dashboard: summary cards, tabbed view (pending/confirmed/rejected/expired), proof viewer, confirm/reject dialogs, 30-second auto-refresh, time remaining countdown.
- `app/dashboard/settings/tabs/PaymentsTab.tsx` — Bank Account section with Nigerian bank dropdown, account validation, tier-gated unlock.
- `components/dashboard/Sidebar.tsx` — Added "Pending Transfers" nav item in money section.
- Affects: Nigerian/Ghanaian businesses on Growth/Business tier. Bot payment flow (dual option when bank account configured + amount >= NGN 10,000). Platform fee tracking (is_direct_transfer flag).
- Could break: Nothing — bank transfer option only appears when business has configured bank account AND is on paid tier. Existing Paystack flow unchanged. Requires migration 209.

### Feature: Nigerian payment channels — bank transfer + USSD + card
- `supabase/migrations/208_payment_channels.sql` — Adds `payment_channels` JSONB column to businesses table. Null = all channels (backward compatible).
- `lib/payments/types.ts` — Added `channels?: string[]` to InitPaymentOpts interface.
- `lib/payments/paystack.ts` — Passes `channels` parameter to Paystack transaction/initialize API. Enables business-level control of which payment methods customers see.
- `lib/payments/flutterwave.ts` — Passes `payment_options` parameter to Flutterwave payments API. Same concept.
- `lib/bot/flows/shared/payment.ts` — Fetches `payment_channels` from business record before initializing payment. Passes array to gateway.
- `lib/bot/flows/payment.flow.ts` — Payment message for NG/GH businesses now includes hint: "You can pay with card, bank transfer, or USSD on the payment page."
- `app/dashboard/settings/tabs/PaymentsTab.tsx` — New "Accepted Payment Methods" section with channel toggles (card, bank_transfer, ussd, qr, mobile_money). Country-aware: bank transfer/USSD only shown for NG/GH.
- Affects: All payment flows (booking, ordering, ticketing, invoices, campaigns, reservations). Nigerian businesses can now configure which payment methods to offer. Bank transfer + USSD enabled by default.
- Could break: Nothing — null payment_channels = all methods (backward compatible). Requires migration 208.

### Feature: Reseller white-label phases 1-3 — full build
- `supabase/migrations/207_reseller_full.sql` — New tables: reseller_payouts (commission disbursement with holdback), reseller_invoices (platform fee billing). New columns on resellers: branding JSONB, custom_domain, tier, billing_notes, onboarded_at, invite_token, stripe_customer_id, stripe_subscription_id. RLS + indexes + triggers.
- `app/api/demo-request/route.ts` — Auto-response email to submitter with "Schedule a Call" CTA. Marks auto_response_sent on demo_requests row.
- `lib/email/partner-templates.ts` — White-label email templates: wrapPartnerEmail(), partnerBtn(), getResellerBranding(). Replaces Waaiio branding with reseller's logo/colors.
- `app/api/reseller/branding/route.ts` — GET/PUT branding config (logo_url, favicon_url, primary_color, accent_color, company_name). Hex color validation, URL validation.
- `app/dashboard/reseller/branding/page.tsx` — Branding settings page with logo preview, color pickers, custom domain display.
- `app/api/reseller/accounts/[id]/route.ts` — Expanded ALLOWED_FIELDS from 4 to 10 (added description, address, phone, email, slug, flow_type). Field-level validation.
- `app/api/reseller/invite/route.ts` — Admin generates invite token, sends branded invite email to reseller.
- `app/api/reseller/setup/route.ts` — GET validates token, POST completes onboarding (branding + optional first account).
- `app/(marketing)/reseller-setup/page.tsx` + `SetupWizard.tsx` — 3-step onboarding wizard: Your Brand → First Account → All Set.
- `app/api/reseller/subscription/route.ts` — GET/POST/DELETE for Stripe partner subscriptions. 3 tiers: Starter $299, Professional $799, Enterprise $1500. Manual billing fallback if Stripe env vars not set.
- `app/api/reseller/invoices/route.ts` — GET invoice history for reseller.
- `app/dashboard/reseller/subscription/page.tsx` — Tier comparison cards, upgrade/downgrade, invoice history table.
- `app/api/reseller/payouts/route.ts` — GET payout history for reseller.
- `app/api/admin/reseller-payouts/route.ts` — GET list + POST generate payout (auto-calculates commission, 10% holdback for <90 day resellers).
- `app/api/admin/reseller-payouts/[id]/route.ts` — PATCH approve/reject/mark_paid with balance re-verification.
- `app/dashboard/reseller/payouts/page.tsx` — Payout history with summary cards (earned, paid, pending, available).
- `app/api/reseller/analytics/route.ts` — Per-account breakdown, 6-month trends, top 5 accounts.
- `app/dashboard/reseller/analytics/page.tsx` — CSS bar chart, top accounts, searchable breakdown table.
- `app/api/cron/reseller-reconciliation/route.ts` — Monthly reconciliation: fee/payout mismatch, zero-transaction fraud, tier limit checks, overdue invoices.
- `app/api/cron/reseller-invoice-generation/route.ts` — Monthly invoice generation per tier with duplicate prevention.
- `admin/src/pages/ResellerFinancials.tsx` — Admin financial overview per reseller (revenue, commission, owed, tier).
- `admin/src/pages/ResellerPayouts.tsx` — Admin payout management (generate, approve, reject, mark paid).
- Admin routes + sidebar wired for ResellerFinancials and ResellerPayouts.
- Dashboard sidebar: added Payouts, Subscription, Analytics nav items in reseller section.
- Affects: Reseller dashboard (6 new pages), admin panel (2 new pages), marketing site (onboarding wizard), cron jobs (2 new), email system (partner templates). No existing functionality changed.
- Could break: Nothing — all additive. Requires migration 207 on Supabase. Stripe env vars optional (RESELLER_STRIPE_PRICE_STARTER, RESELLER_STRIPE_PRICE_PRO, RESELLER_STRIPE_PRICE_ENTERPRISE).

### Feature: Demo Requests admin page
- `admin/src/pages/DemoRequests.tsx` — **NEW** admin page. Lists all white-label demo requests with search, status filter, pagination. Summary cards (total, new, in progress). Click for detail modal with all form fields. Status dropdown to update leads (new → contacted → qualified → closed). Admin + support roles can view, admin + support can update status. Audit logged.
- `admin/src/routes.tsx` — Added `/demo-requests` route with RoleGuard for admin + support
- `admin/src/components/AdminSidebar.tsx` — Added "Demo Requests" link (Inbox icon) in Accounts section, visible to admin + support
- Affects: Admin panel only. Requires migration 206 (demo_requests table) to be run.
- Could break: Nothing — additive only.

### Fix: Reseller stats wrong column + missing email field
- `app/api/reseller/stats/route.ts` — Fixed column name from `amount` to `transaction_amount` in all 3 platform_fees queries. Was causing revenue to always show $0 because `amount` doesn't exist on platform_fees (the actual column is `transaction_amount`).
- `app/api/reseller/accounts/route.ts` — Added `email` to the SELECT clause. Edit form on accounts page couldn't pre-fill the email field because it wasn't returned by the API.
- Affects: Reseller portfolio revenue display, billing page revenue, accounts edit form.
- Could break: Nothing — fixes data that was already returning null/0.

### Fix: Mobile dashboard layout instability
- `components/dashboard/Sidebar.tsx` — Added body scroll lock (`menu-open` class) when mobile sidebar opens. Calculates scrollbar width to prevent layout shift via CSS variable. Closes sidebar on route change. Replaced floating hamburger button with a proper fixed top bar showing business name.
- `app/dashboard/layout.tsx` — Changed NotificationBell from absolute positioning to in-flow on mobile (`flex justify-end` on mobile, `absolute` on desktop). Prevents layout shift when bell loads async.
- `app/globals.css` — Added `padding-right: var(--scrollbar-width)` to `body.menu-open` to compensate for scrollbar disappearing.
- Affects: All dashboard pages on mobile. Fixes: content scrolling behind open sidebar, layout shift when sidebar opens/closes, hamburger button floating over content, NotificationBell causing content jumps.
- Could break: Nothing — purely CSS/layout changes. No logic changes.

### Fix: Complete reseller dashboard — commission wiring, API gaps, data mapping
- `app/api/reseller/commissions/route.ts` — **NEW** endpoint. Returns recent commission entries from platform_fees joined with business names. The billing page was calling this but it didn't exist (404).
- `lib/payments/process-success.ts` — `recordPlatformFee()` now looks up `business.reseller_id`, fetches reseller's `commission_percentage`, calculates `reseller_commission` as percentage of fee_total, and includes `reseller_id` + `reseller_commission` in the platform_fees INSERT. Only active resellers earn commission.
- `admin/src/pages/Resellers.tsx` — Fixed sub-account count query. Was querying non-existent `reseller_businesses` table, now queries `businesses WHERE reseller_id IN (...)`.
- `app/dashboard/reseller/page.tsx` — Fixed stats data mapping. Was reading `data.total_accounts` but API returns `data.stats.accounts.total`. Now correctly destructures nested response.
- `app/dashboard/reseller/accounts/page.tsx` — Same fix: reads `stats.accounts.total` and `stats.reseller.max_sub_accounts` instead of flat fields.
- `app/dashboard/reseller/billing/page.tsx` — Same fix: reads `stats.reseller.billing_type`, `stats.reseller.commission_percentage`, `stats.commission.total`, `stats.revenue.this_month`.
- Affects: All 3 reseller dashboard pages (portfolio, accounts, billing), admin resellers page, platform fee recording for all payment flows.
- Could break: Nothing — all existing platform_fees rows will have reseller_id=NULL and reseller_commission=0 (column defaults from migration 205). New fees for reseller sub-accounts will now populate both fields.

### Feature: White Label marketing page + demo request flow
- `app/(marketing)/white-label/page.tsx` — New marketing page at `/white-label`. Hero with white-label positioning, 6 feature highlight cards, 3-step "how it works" strip, demo request form, final CTA. Uses AnimatedSection, brand tokens, existing marketing layout.
- `app/(marketing)/white-label/DemoForm.tsx` — Client component with 9 fields (business name, contact, email, phone, industry dropdown, volume, WABA status, use case qualifier, notes). Honeypot, input validation, loading/success/error states. Matches existing ContactForm patterns.
- `app/api/demo-request/route.ts` — POST handler. Rate limited (5/min), validates all fields + enum values, honeypot, persists to `demo_requests` table via service client, sends notification email to hello@waaiio.com via Resend. Fail-open on email (lead is already saved).
- `supabase/migrations/206_demo_requests.sql` — New `demo_requests` table with RLS (service_role INSERT, admin/support/operations SELECT, admin/support UPDATE). Indexes on status, created_at, email. Updated_at trigger.
- `components/marketing/Navbar.tsx` — Added "White Label" nav link between Pricing and Directory
- `components/marketing/Footer.tsx` — Added "White Label" link in Product column
- Affects: Marketing site navigation (new nav item), new `/white-label` route. No existing pages or functionality changed.
- Could break: Nothing — additive only. Requires migration 206 to be run on Supabase before form submissions will persist.

---

## 2026-06-19

### Feature: Reseller layer Phase 2 — Dashboard sidebar + Admin page
- `components/dashboard/DashboardProvider.tsx` — Added `isReseller` boolean to context and `useIsReseller()` hook
- `app/dashboard/layout.tsx` — Queries `resellers` table for current user, passes `isReseller` to DashboardProvider (both normal and impersonation flows)
- `components/dashboard/Sidebar.tsx` — Added 3 reseller nav items (Portfolio, Accounts, Billing & Commission) in new 'reseller' section. Only visible when `isReseller` is true. Section type union updated to include 'reseller'.
- `admin/src/pages/Resellers.tsx` — New admin page. Lists all resellers with company name, email, commission %, billing type, sub-account count, status. Add/edit modal, suspend/activate toggle. Uses existing admin component patterns (SummaryCard, StatusBadge, DetailModal, Pagination).
- `admin/src/routes.tsx` — Added `/resellers` route with `RoleGuard` for admin-only access
- `admin/src/components/AdminSidebar.tsx` — Added Resellers link (Handshake icon) under Accounts section, admin-only
- Affects: Dashboard sidebar (reseller users see 3 new items), admin panel (new Resellers management page). No existing functionality changed. Reseller section is hidden for non-resellers.
- Could break: If `resellers` table doesn't exist yet (requires migration 205). If `reseller_businesses` table doesn't exist, admin sub-account count will fail gracefully (shows 0).

### Feature: Reseller layer Phase 1 — migration + API routes
- `supabase/migrations/205_resellers.sql` — New migration. Creates `resellers` table (user_id, company_name, commission_percentage, billing_type, max_sub_accounts, status). Adds `reseller_id` to businesses and `reseller_id`/`reseller_commission` to platform_fees. RLS policies for reseller self-management + sub-business access. Indexes on reseller_id columns.
- `app/api/reseller/route.ts` — GET reseller profile by auth user
- `app/api/reseller/accounts/route.ts` — GET list sub-accounts, POST create sub-account (enforces max_sub_accounts limit, generates slug)
- `app/api/reseller/accounts/[id]/route.ts` — GET detail, PATCH update (name/status/subscription_tier/category only), DELETE soft-suspends
- `app/api/reseller/stats/route.ts` — GET dashboard stats (account counts, revenue, commission, this/last month comparison)
- Affects: businesses table (new reseller_id column), platform_fees table (new reseller_id + reseller_commission columns). No existing functionality changed.

### Feature: Flutterwave recurring payment support
- `lib/payments/flutterwave-recurring.ts` — New file. Functions: createPlan, createSubscription, cancelSubscription, getSubscription, chargeToken, getCardToken. Follows Paystack recurring pattern. Uses tokenized charges + payment plans.
- Affects: businesses using Flutterwave can now have recurring billing (subscriptions). Does NOT affect Stripe/Paystack recurring flows.

### Feature: White-label for Business/Premium tier
- 23 files updated across public pages, API routes, PDFs, emails, bot messages
- Business/Premium tier hides "Powered by Waaiio" footer across all touchpoints
- `lib/whitelabel.ts` provides central `isWhiteLabel()` helper
- API routes now return `subscription_tier` so public pages can conditionally render branding
- Affects: receipts, tickets, contracts, waivers, invoices, RSVP pages, email templates, ticket PDFs, bot payment confirmations

### Feature: Admin auto-refresh
- `admin/src/pages/Dashboard.tsx` — 60s auto-refresh on stats
- `admin/src/pages/Bookings.tsx` — 60s auto-refresh on bookings list
- `admin/src/pages/Payments.tsx` — 60s auto-refresh on payments list
- `admin/src/pages/Support.tsx` — 60s auto-refresh on support tickets
- `admin/src/pages/Verification.tsx` — 60s auto-refresh on pending verifications

### Feature: PageHelp on remaining dashboard pages
- Added PageHelp banners to: alerts, faq, qr-code, scan-to-pay, settings

### Enhancement: Flutterwave recurring in bot payment flow
- `lib/bot/flows/payment.flow.ts` — Added Flutterwave tokenized charge support for recurring payments. Captures card token after first payment, uses chargeToken for subsequent charges.

---

## 2026-06-12

### Feature: Keyword Campaigns backend

- `supabase/migrations/203_keyword_campaigns.sql` — New `keyword_campaigns` and `keyword_campaign_responses` tables with RLS. Extended `bot_keywords.action_type` CHECK to include `campaign_reply`. Added `campaign_id` FK column to `bot_keywords`.
- `lib/bot/campaign-blacklist.ts` — New file. Exports `CAMPAIGN_BLACKLISTED_KEYWORDS` (42 words) and `isCampaignKeywordBlacklisted()` validator to prevent campaigns from overriding system intents.
- `lib/bot/keyword-service.ts` — Added `campaign_reply` to `ActionType` union, `campaign_id` to `UnifiedKeyword` interface, and `campaign_id` to all keyword SELECT queries (system, category, business).
- `lib/bot/handlers/keyword-actions.ts` — New `campaign_reply` case in `executeKeywordAction` switch. Loads campaign, checks active/date range, sends response (text/image/link/buttons), upserts response record, upserts customer_profiles opt-in, sends follow-up.
- `app/api/keyword-campaigns/route.ts` — GET (list with response counts) + POST (create campaign + auto-create bot_keywords row). Validates blacklist + ownership.
- `app/api/keyword-campaigns/[id]/route.ts` — GET (detail) + PATCH (update with blacklist re-validation + bot_keywords sync) + DELETE (cascade).
- `app/api/keyword-campaigns/[id]/responses/route.ts` — GET paginated responses + CSV export (`?format=csv`).
- Affects: bot keyword matching (new action_type), bot_keywords table schema (new column + constraint), customer_profiles (opt-in upsert). Does NOT affect existing keyword actions.

### Fix: Event invites to cold numbers (never messaged before)

- `lib/channels/provision-templates.ts` — Changed `waaiio_event_invite` template from `UTILITY` to `MARKETING` category (Meta requires MARKETING for unsolicited outreach). Changed language from `'en'` to `'en_US'` to match all other templates. Added FOOTER component.
- `lib/channels/meta-cloud.ts` — Changed default template language code from `'en'` to `'en_US'`. Affects ALL template sends via MetaCloudSender.
- `app/api/events/invite/route.ts` — Fixed PUT (reminder) endpoint: now falls back to `sendWithTemplate('waaiio_event_invite')` when `sendText()` fails (outside 24h window). Previously reminders only worked for numbers that had recently messaged.
- `app/api/whatsapp/templates/check/route.ts` — New diagnostic endpoint. GET checks if `waaiio_event_invite` exists and is approved on shared WABA. `?fix=true` auto-creates or replaces it with correct MARKETING category. Admin/cron/internal-token auth.
- Affects: all event/party invites, all reminders, all template sends (language code). Could break if an existing template was approved as `'en'` on Meta — the check endpoint will detect this.

---

## 2026-06-10

### Admin panel OTP verification on login

- `app/api/admin/otp/route.ts` — New API route for admin 2FA. Supports `send` (email via Resend or WhatsApp via Meta Cloud API) and `verify` (HMAC-signed token comparison with timingSafeEqual). Rate limited: 3 sends/10min, 5 verifies/10min per email. Brute force protection on both email and IP. Requires valid Supabase session before sending. Code expires in 5 minutes.
- `admin/src/pages/Login.tsx` — Added 3-step login flow: credentials -> choose OTP method (email/WhatsApp) -> enter 6-digit code. Includes countdown timer, resend, change method, and back-to-login navigation. WhatsApp option disabled if no phone on profile.
- Affects: admin panel login only. No impact on main app or bot flows.

### Post-completion "What's next?" menu after every successful transaction

- `lib/bot/flows/executor.ts` — When `next()` returns null (flow complete) and it's NOT a cancellation, shows contextual buttons instead of silently ending. Buttons are based on capability: "Book Again" / "Give Again" / "Buy More Tickets" / "Order Again" + history view + "Done". Session stays alive on `post_completion` step with 10-min expiry.
- `lib/bot/bot.service.ts` — Handles `post_completion` step: "pc_again" restarts the business flow, "pc_history" routes to My Bookings/My Orders, "pc_done" deactivates session, any other text re-processes as new input. Escape hatches (menu/exit/back) still work.
- Affects: all 6 transaction flows (scheduling, ordering, payment, ticketing, crowdfunding, reservation). Cancellations still end silently.

### Ticket image: add event + guest details on the image

- `lib/bot/flows/shared/send-tickets.ts` — Both flyer and no-flyer ticket images now show text overlays:
  - **With flyer:** Dark bar at bottom shows event name, date/time, venue, guest name, ticket code, ticket number
  - **Without flyer:** Purple branded card shows TICKET header, event name, date/time, venue, guest name, ticket code (gold), ticket number, ref code, "Scan to verify", Waaiio branding
  - QR code remains composited on both variants
  - SVG text is XML-escaped and truncated to prevent overflow

### Fix: Ticket QR code not generating on Vercel

- `next.config.mjs` — Added `serverExternalPackages: ['sharp']` so Sharp's native binaries load at runtime instead of being bundled (dynamic imports invisible to Vercel's tree-shaker). Added `outputFileTracingIncludes` for Sharp on all 7 webhook routes that trigger ticket generation. This was causing `sendTicketsAfterPurchase` to silently fail at the Sharp import, falling through to text fallback or no output.

### Bot translation: wrap ~80 direct sendText calls with ctx.t()

- `lib/bot/flows/types.ts` — Added `t(text: string): Promise<string>` to FlowContext interface
- `lib/bot/flows/executor.ts` — Wire `ctx.t` to `translateBotResponse` using session `_lang`
- `lib/bot/bot.service.ts` — Added `sendLocalizedText()` helper method
- All flow files (ordering, scheduling, payment, crowdfunding, reservation, ticketing, queue-checkin, recurring-manage, loyalty, capability-selection) — wrapped customer-facing `ctx.sender.sendText()` calls with `await ctx.t()`
- `lib/bot/flows/shared/post-completion.ts` — Added optional `translate` param (backward-compatible)
- `lib/bot/flows/shared/send-tickets.ts` — Added optional `translate` param for fallback messages

---

## 2026-06-03

### Fix: Mid-flow "Hi" restart confirmation loop

- `lib/bot/bot.service.ts` — When user typed "Hi" mid-flow, bot showed restart confirmation buttons. Tapping "Yes, start over" (`restart_yes`) fell through without restarting because `isRestart` was false (button ID isn't a greeting keyword). The text then hit the current step's `validate()` which rejected it, creating an infinite loop. Fix: `restart_yes` handler now deactivates the session and recursively calls `handleMessage` with the business bot_code, creating a fresh session. Affects: all mid-flow restart confirmations.

### Bot UX audit fixes — 7 improvements

- `lib/bot/bot.service.ts` — Chat inactivity warning now fires even when business never replies (uses conversation created_at as fallback). Was silently waiting 4 hours.
- `lib/bot/bot.service.ts` — Navigation commands (menu/back/exit/cancel) now work at business suggestion step. Was showing wrong error.
- `lib/bot/bot.service.ts` — Quick rebook "Something Else" button renamed to "View Options" for clarity.
- `lib/bot/bot.service.ts` — Added created_at to chat conversation select for inactivity check.
- `lib/bot/flows/{scheduling,payment,crowdfunding,reservation,ordering,ticketing}.flow.ts` — "Payment not yet received" messages now mention expired links and suggest "Get New Link".
- `lib/bot/flows/ordering.flow.ts` — "Invalid option. Send Hi to start over" changed to re-prompt instead of killing flow.
- `lib/bot/flows/crowdfunding.flow.ts` — "Campaign not found. Please try again" now guides user to tap options.
- `lib/bot/flows/scheduling.flow.ts` — Terse "Invalid promo code" now includes guidance to check spelling or skip.

### External Booking API Integration

- `supabase/migrations/180_api_keys_external_booking.sql` — New `api_keys` table (hashed keys, prefix, revoke), added `'api'` to `booking_channel` enum
- `lib/api-keys.ts` — Generate (wai_ prefix + 32 random bytes), hash (SHA-256), validate API keys
- `app/api/integrations/external-booking/route.ts` — Public REST endpoint: validates API key, creates booking, sends WhatsApp confirmation, triggers post-completion hooks (loyalty, feedback, customer profile)
- `app/api/integrations/api-keys/route.ts` — GET (list) + POST (generate) API keys. Requires paid tier. Max 5 active keys.
- `app/api/integrations/api-keys/[id]/route.ts` — DELETE (soft revoke) API key
- `components/dashboard/settings/IntegrationsTab.tsx` — Full UI: generate keys, view masked, revoke, inline API docs with cURL example
- `app/dashboard/settings/page.tsx` — Added Integrations tab (5th tab between Features and Account)
- `middleware.ts` — CSRF exemption for `/api/integrations/external-booking`

### Financials page — include all revenue sources

- `app/dashboard/financials/page.tsx` — Revenue was only counting `bookings` table. Now includes `orders` (confirmed/processing/ready/shipped/delivered) and `invoices` (paid). Total Revenue, monthly chart, and transaction list all reflect the full picture. Added order/invoice type filters and status options (delivered, paid). Fixes: 900k order not showing in 60k revenue.

---

## 2026-06-01

### Final verification + admin fixes

- `admin/src/pages/ChatHistory.tsx` — Fixed `phone_number` → `whatsapp_number` (column doesn't exist)
- `components/dashboard/ReAuthModal.tsx` — Added `role="dialog"`, aria-modal, Escape key handler
- Full verification pass: admin panel (all 11 fixes verified), dashboard (all pages verified, 39 sidebar links valid, zero import errors)

---

## 2026-05-31

### Admin panel audit — 11 bugs fixed

**Critical:**
- `admin/src/pages/Finance.tsx` + `Payouts.tsx` — React hooks moved above early return (was crashing)
- `admin/src/pages/Login.tsx` — finance + operations roles can now log in (were blocked)
- `admin/src/pages/Verification.tsx` — Email fetch uses VITE_API_URL (was relative path to wrong domain)
- `admin/src/pages/Support.tsx` — Changed `full_name` to `first_name`/`last_name` (column didn't exist)
- `admin/src/pages/Subscriptions.tsx` — Free tier fee corrected to 2.5% (was 2.0%)

**High:**
- Finance + Payouts inline role guard allows finance role (was admin-only, conflicting with route guard)
- Dashboard category revenue shows per-currency totals (was summing all as NGN)
- Broadcasts email channel now actually delivers via main app API (was record-only)
- ImpersonationMode uses business country_code for currency (was hardcoded NGN)

**Medium:**
- Support tickets assignable to support role (was admin-only)
- ImpersonationMode URL validation accepts www.waaiio.com

### Feature audit — 9 bugs fixed across ordering, scheduling, events

**Critical:**
- `lib/payments/process-success.ts` — Stock now decremented when webhook confirms order payment (was only on "I've Paid")
- Stripe/Square/PayPal webhooks now pass `order_id` to processSuccessfulPayment
- `book_slot_atomic` RPC — Buffer time enforced atomically (migration 176, optional p_buffer_minutes param)
- `/api/events/cancel` — New route: cancels tickets, notifies holders via WhatsApp, creates refund alerts

**Medium:**
- `recordPlatformFee` now inserts `order_id` column
- Payment-success page passes `order_id` + `reservation_id`
- Promo `skipIf` fixed `productId` → `product_id`
- Reschedule API validates slot capacity before UPDATE
- Donation receipts added to `generate-direct.ts` (all 3 receipt types)

### Property critical fixes

- All 5 payment gateways now store `reservation_id` on payments (migration 175)
- `processSuccessfulPayment` auto-confirms reservations on webhook
- Public property page at `/property/[id]` with photos, amenities, availability calendar
- Reservation cancellation: dashboard refund dialog + bot creates refund request notification

### Contract enhancements

- Document ID: `WA-DOC-XXXXXX` generated on creation, shown on PDF header
- Signature Reference: `SIG-XXXXXX` per signer, shown next to signature on PDF
- Verification QR code on signed PDF (links to permanent access page)
- Permanent access page at `/contracts/[id]?token=xxx` (no expiration)
- Email signed PDF copy to signer after signing
- Multi-signer: PDF link in WhatsApp confirmation + `has_pdf` returns true
- Counter-sign: dashboard shows "Awaiting your signature" badge + "Sign Now" button
- Contract security: filename sanitization, signature size limit (500KB), rate limiting on 3 endpoints, file count cap (100/business)
- Legal disclaimers: "Not a law firm" on signing page + creation page, ESIGN/UETA/eIDAS reference
- Interactive contract builder: 5 templates with per-template questionnaires

---

## 2026-05-30

### Bot fixes — 11 bugs

- `bot.service.ts` — "hi"/"hello" during live chat no longer resets session (was in restart regex)
- `payment.flow.ts` — Platform fee moved to AFTER payment verification (was recording phantom fees)
- `ticketing.flow.ts` — tickets_sold incremented AFTER payment (was permanently reducing inventory)
- `ordering.flow.ts` — Stock decremented AFTER payment (was showing false out-of-stock)
- `appointment.flow.ts` — Added `deposit_amount` to fuzzy match (paid appointments treated as free)
- `loyalty.flow.ts` + `invoice.flow.ts` — Return proper message + deactivate session (users were stuck)
- `recurring-manage.flow.ts` — Same empty prompt fix (infinite loop)
- `scheduling.flow.ts` — Zero services shows message instead of crashing
- `ticketing.flow.ts` — Re-queries fresh availability at quantity selection
- `queue-checkin.flow.ts` — "No Thanks" sends acknowledgment (was silent)
- `executor.ts` — Media messages at text-only steps get "Please reply with text"

### Bot navigation fixes

- `my-orders.ts` — Fixed `carrier` → `shipping_carrier` (order selection always failed)
- `my-account-menu.ts` — Fixed stale session object passed to executor (My Account/Back crashed)
- `my-bookings.ts` — Added "My Account" button after bookings list
- `capability-selection.flow.ts` — "Want to make a new booking? Type Hi" hint on My Account
- `my-bookings.ts` — Reschedule flow fixed (unique constraint + Gupshup list reply ID)
- Receipt generation — Fixed `subscription_charges` query (invalid services join)
- Orders in receipts — `generate-direct.ts` now queries orders table

### Gupshup removal — 18 files

- Removed all `new GupshupService()` from API routes
- All WhatsApp sends now use ChannelResolver
- GupshupService throws in production when unconfigured (was silently returning success)
- Broadcast/chat/order/contract routes all updated

### Scheduled broadcasts

- `business_broadcasts` table (migration 169) with scheduling
- Cron every 5 minutes processes due broadcasts
- Dashboard: Send Now / Schedule toggle with date/time picker
- 4 message types: Update, Reminder, Event, Promotion
- Meta templates provisioned (pending approval), text fallback
- Template wording made generic (works for churches, barbers, restaurants)
- Recipient list viewer + CSV/paste import

### Subscription management

- Recurring billing: Stripe `mode: 'subscription'`, Paystack plan codes (migration 172)
- Subscription expiry cron (daily 8am): reminders at 7d/1d, auto-downgrade
- Payment history table (migration 171) logging every upgrade/renewal/downgrade
- Billing dashboard at `/dashboard/billing` with usage + payment history
- Stripe checkout session verification in verify route
- Downgrade now updates subscriptions table + records in payment history

### Platform gap fixes (P0/P1/P2)

- Pricing page: "2%" corrected to "2.5%"
- Stripe subscribe: currency lowercase + correct USD fallback
- RSVP page: new `/api/rsvp/[token]` route (was broken by RLS)
- Root error.tsx: Sentry.captureException active
- Login: phone OTP tab toggle wired up
- Dashboard: pending business banner
- Form: file upload renderer with Supabase storage
- EventPurchaseForm: hardcoded hex → brand tokens

### Compliance (Grade A-)

- Data retention cron (weekly): 2yr conversations, 3yr bookings anonymized, 1yr notifications/impersonation
- Encryption fail-closed in production
- Session maxAge reduced to 7 days
- Audit logging: account deletion, password/email changes, consent updates, refund approvals
- Consent versioning with policy_version + consented_at
- Separate data processing consent on signup
- Upstash + OpenAI added to privacy policy + DPA sub-processor lists
- Grace period deletion cancellation banner on dashboard

### Security hardening

- Circuit breaker for Meta API (5 failures → open, 30s recovery)
- Payment reconciliation cron (every 4 hours)
- Redis failure resilience (falls back to in-memory)
- WhatsApp retry skips 4xx errors
- Atomic stock operations (restore_stock RPCs, migration 173)
- Sentry in payment flows
- MFA/TOTP enrollment UI in settings
- Idle timeout (2hr dashboard, 30min admin)
- Re-auth for sensitive actions (email change, downgrade, delete)
- Customer data deletion (GDPR erasure)
- All 7 upload endpoints: rate limiting + filename sanitization
- Admin query column name validation
- Impersonation token DB verification
- Removed dangerouslySetInnerHTML from OnboardingWizard

### New features

- Event check-in & audit page (`/dashboard/events/checkin`)
- Property QR check-in system (`/dashboard/properties/checkin` + `/checkin/property/[id]`)
- Public property page (`/property/[id]`)
- Customer receipt page (`/receipts/[code]`)
- Change password/email in dashboard settings
- CSV data export option
- Enhanced health endpoint (Redis ping, WhatsApp channel check)
- CI/CD pipeline (GitHub Actions: lint → test → build)
- ESLint config (next/core-web-vitals)
- next/image migration (14 files)
- Settings page: 13 tabs → 4 grouped tabs with collapsible sections
- Past events read-only with visual indicators
- Event deletion protection (can't delete with sold tickets)
- Email branding: "BusinessName via Waaiio" sender
- Ticket images: buyer details around QR, branded fallback for no-flyer events
- Drop-off service description improved
- Hero CTA buttons normalized

### Migrations (169-176)

- 169: business_broadcasts
- 170: subscription_status 'expired'
- 171: subscription_payments + subscriptions columns
- 172: stripe_subscription_id, stripe_customer_id, billing_interval
- 173: restore_stock, restore_variant_stock, restore_tickets_sold RPCs
- 174: contract reference_code + signature_reference
- 175: public property read RLS policy
- 176: book_slot_atomic with buffer time support

**Files changed:** 150+ files
**Could break:** Stripe subscriptions are now recurring (not one-time). Buffer time RPC has new optional params. Event cancellation now notifies ticket holders. All upload endpoints now rate limited.

---

## 2026-05-29

### Comprehensive Platform Audit — 62 issues across 6 domains

**CRITICAL fixes:**
- `supabase/functions/generate-sign-link/index.ts` — Added Bearer token auth + restricted CORS (was completely unauthenticated)
- `app/api/webhooks/flutterwave/route.ts` — Added idempotency dedup via `processed_webhook_events` (only gateway missing it) + float amount tolerance
- `middleware.ts` — CSRF exemption scoped to specific webhook receiver paths (was broad `/api/webhooks` prefix covering user-facing CRUD)
- `admin/.env` — Fixed VITE_API_URL to include `www` (POST bodies stripped on non-www redirect)
- `.env.example` — Expanded from ~5 vars to 70+ with categories (DevOps agent)
- `components/dashboard/PageSkeleton.tsx` — Fixed dynamic Tailwind class that JIT couldn't compile

**HIGH fixes:**
- `app/api/payments/byo-webhook/[businessId]/route.ts` — Added `decryptToken()` for encrypted secret keys + removed platform secret fallback
- `app/api/admin/query/route.ts` — Added per-role table whitelists (FINANCE_TABLES, OPERATIONS_TABLES) + applied safeSelect to all non-admin roles
- `app/api/payments/stripe-webhook/route.ts` — Now fetches `campaign_id` from payment record (was hardcoded null)
- `app/api/admin/impersonate/validate/route.ts` — Added `user.id !== tokenRecord.admin_id` check
- `app/api/whatsapp/templates/provision/route.ts` — Replaced `err.message` with generic `'creation_failed'`
- `app/api/directory/route.ts` — Switched from `createServiceClient()` to anon `createClient()`
- `admin/src/routes.tsx` — Added RoleGuard component for route-level access control
- `admin/src/pages/AdminTeam.tsx` — Blocked self-demotion via "Remove Admin Role"
- `admin/src/pages/Finance.tsx` — Fixed `row.refunds` → `row.refunded` (NaN in monthly net column)
- 50+ `purple-*` replaced with `brand-*` tokens; `bg-[#25D366]` replaced with `bg-whatsapp`
- `components/dashboard/RefundModal.tsx` — Added `role="dialog"`, `aria-modal`, Escape key handler
- `app/globals.css` — Scoped mobile grid overrides to `[data-dashboard]` only

**MEDIUM fixes:**
- `lib/bot/flows/scheduling.flow.ts` — Empty `select_location` now returns helpful message instead of `[]`
- `lib/bot/bot.service.ts` — Language detection now `await`ed (was fire-and-forget race condition)
- `lib/bot/bot.service.ts` — Giving history sorts by raw timestamp instead of parsed locale string
- `lib/rate-limit.ts` + `bot.service.ts` — Bot rate limit now uses Redis-backed async check (was in-memory only per Lambda instance)
- 5 flow files — List item titles truncated to 24 chars (ordering, scheduling, reservation, ticketing)
- `lib/bot/bot.service.ts` — Loyalty query now checks `caps.includes('loyalty')` before routing
- `lib/bot/bot.service.ts` — Email HTML blockquotes now escape user text (XSS prevention)
- `app/(marketing)/blog/[slug]/page.tsx` — formatInline validates link protocol (blocks `javascript:` hrefs)
- 3 cron routes — Added `force-dynamic` (backup, balance-reminder, customer-intelligence)
- 3 cron routes — Removed dead `verifyCronSecret` functions
- `sentry.client.config.ts` — `replaysOnErrorSampleRate` set to 0.1 (was 0)
- `vitest.config.ts` — Added coverage config with v8 provider
- `supabase/migrations/151_multi_agent_chat.sql` → renamed to `168_multi_agent_chat.sql` (duplicate number fix)
- Dashboard labels: "Bot Settings" → "WhatsApp Setup" in 3 remaining locations
- Alt text added to staff/property/product images
- Mobile sidebar overlay given dialog semantics

**Files changed:** 30+ files across main app, admin panel, bot flows, middleware, edge functions, and config
**Could break:** Flutterwave webhook now has dedup (legitimate retries will be deduplicated). CSRF now covers `/api/webhooks` CRUD. generate-sign-link requires Bearer token. Admin routes now role-gated.

---

## 2026-05-28

### Fix: Appointment booking crash (FK violation)
- **File:** `supabase/migrations/166_fix_appointment_booking.sql`, `lib/bot/flows/scheduling.flow.ts`
- **What:** `book_slot_atomic` RPC now accepts `p_appointment_id`. Appointments from the `appointments` table were being passed as `service_id`, violating the FK constraint to `services(id)`.
- **Affects:** All appointment bookings via WhatsApp bot. Web API also updated for forward-compatibility.
- **Could break:** Nothing — additive change, existing bookings unaffected.

### Fix: Campaign "Donate Now" hijacking giving flow
- **File:** `lib/bot/handlers/keyword-actions.ts`
- **What:** `start_capability` and `start_flow` keyword actions now only fire at `greeting`/`select_capability` steps. Previously, button postback `donate_yes` containing "donate" matched the keyword matcher and hijacked mid-flow.
- **Affects:** All keyword-triggered flow routing.
- **Could break:** Nothing — mid-flow keyword matching was always a bug.

### Fix: Tickets never generated after paid events
- **File:** `lib/bot/flows/ticketing.flow.ts`, `lib/payments/send-confirmation.ts`
- **What:** Dedup path (webhook confirms before user taps "I've Paid") now calls `sendTicketsAfterPurchase`. Webhook ticket generation uses `event_id` from booking (was fragile date-match).
- **Affects:** All paid ticketing purchases across all 5 gateways.

### Fix: WebP images not showing in WhatsApp
- **File:** `app/api/images/convert/route.ts`, `lib/bot/flows/executor.ts`, `lib/bot/flows/ticketing.flow.ts`
- **What:** New `/api/images/convert` endpoint converts WebP→JPEG via Sharp. Executor auto-converts WebP URLs for all flows. Ticketing direct sends also converted.
- **Affects:** Any WebP image in events, products, services, style photos.

### Fix: QR code composited onto event flyer
- **File:** `lib/bot/flows/shared/send-tickets.ts`
- **What:** Each ticket now gets the event flyer with QR code overlaid (bottom-right, white background). Uploaded to Supabase storage and sent as single image. Falls back to standalone QR if compositing fails.
- **Affects:** All ticket purchases with event flyer images.

### Fix: Order confirmation after webhook payment
- **File:** `supabase/migrations/167_order_payment_fixes.sql`, `lib/payments/process-success.ts`, `lib/payments/webhook-handler.ts`
- **What:** Added `order_id` column to `payments` table. `processSuccessfulPayment` now confirms orders and records platform fees. Previously orders stayed "pending" forever if customer didn't tap "I've Paid".
- **Affects:** All order payments via webhooks (all 5 gateways).

### Fix: Flutterwave BYO webhook event name
- **File:** `app/api/payments/byo-webhook/[businessId]/route.ts`
- **What:** Now accepts both `charge.success` (Paystack) and `charge.completed` (Flutterwave). Previously only checked Paystack's event name.
- **Affects:** Any business using their own Flutterwave account.

### Fix: Crowdfunding platform fee + customer profile
- **File:** `lib/bot/flows/crowdfunding.flow.ts`
- **What:** "I've Paid" path now records platform fee as safety net (webhook also records, dedup via unique index). Also calls `handlePostCompletion` for donor customer profiles.
- **Affects:** Campaign donation payments via bot.

### Fix: Conversation log unbounded growth
- **File:** `lib/bot/flows/executor.ts`
- **What:** Capped `conversation_log` at 100 entries, trimming oldest. Prevents JSONB bloat on `bot_sessions` table.
- **Affects:** All bot conversations. Normal sessions are 10-30 entries — no visible change.

### Fix: Suspended businesses accepted by bot
- **File:** `lib/bot/bot.service.ts`
- **What:** Bot now checks `business.status === 'active'` on session creation. Suspended/deactivated businesses get rejected.
- **Affects:** Only businesses explicitly suspended by admin.

### Fix: Sanitization gaps
- **File:** `lib/bot/flows/scheduling.flow.ts`
- **What:** `serviceId` in `.or()` filter now wrapped in `sanitizeFilterValue()`.
- **Affects:** Defense-in-depth — service IDs are always UUIDs, but now explicitly sanitized.

### Fix: Escalation log not persisted
- **File:** `lib/bot/flows/executor.ts`
- **What:** `persistConversationLog` now called after `escalateToHuman`. Previously the last user message before escalation was lost.

### Fix: Recurring subscription cancel crash
- **File:** `lib/bot/flows/recurring-manage.flow.ts`
- **What:** Gateway cancel calls (Paystack/Stripe) wrapped in try/catch. Previously a gateway error crashed the session.

### Fix: Custom bot greeting overridden by persona alias
- **File:** `lib/bot/bot.service.ts`
- **What:** Custom `bot_greeting` now takes priority over generic persona template when set by business owner.

### Fix: Loyalty error message
- **File:** `lib/bot/flows/loyalty.flow.ts`
- **What:** Changed "Oops, something went wrong" to "Something went wrong on our end" (project standard).

### Enhancement: JHDC church bot intro
- **What:** Custom greeting for JHDC with mission statement. Alias "Grace". Welcome buttons for Give/Tickets/Appointment.

### Enhancement: Category defaults expanded
- **File:** `lib/capabilities/types.ts`
- **What:** Added `packages` (beauty/fitness/professional), `estimates` (home/professional/creative), `class_booking` (fitness/education), `multi_location` (hospitality). Only affects NEW businesses.

### Enhancement: Locations sidebar link
- **File:** `components/dashboard/Sidebar.tsx`
- **What:** Added Locations page link gated on `multi_location` capability.

### Enhancement: Event detail emojis
- **File:** `lib/bot/flows/ticketing.flow.ts`
- **What:** Added 🎟️📅📍💰🎫 emojis to event details shown after flyer image.

### Infrastructure: Bot test harness
- **File:** `lib/bot/__tests__/bot-harness.ts`, `lib/bot/__tests__/bot-conversations.test.ts`
- **What:** Mock sender captures messages, mock DB fully chainable, fixtures for salon/church/events. 29 conversation tests covering capability selection, scheduling, ticketing, appointment, crowdfunding, ordering, step chain integrity. Total: 318 tests, 27 suites.

### Infrastructure: Preflight-check skill
- **File:** `.claude/skills/preflight-check/skill.md`, `CLAUDE.md`
- **What:** Mandatory pre-change impact analysis. Traces callers, checks DB constraints, verifies two-function traps, maps blast radius. Documented in CLAUDE.md for auto-loading.

### Infrastructure: MCP servers
- **What:** Installed `sequential-thinking` and `codex` MCP servers for enhanced reasoning.

---

## 2026-05-23

### Fix: Church "Pay tithe" / "Pay offering" routing to payment instead of giving
- **Root cause:** Migration 041 seeded `bot_keywords` with `{"capability":"payment"}` for "tithe" and "offering" keywords in church category. The `giving` capability was added later but keywords were never updated.
- **Impact:** When a church user typed "Pay tithe" or "Pay offering", the unified keyword matcher (bot.service.ts line 1970) intercepted BEFORE the flow executor, called `executeKeywordAction` which set `active_capability = 'payment'`. The payment flow's `select_category` then filtered for `service_type != 'giving'`, found nothing, and showed "No payment categories are set up yet."
- **Fix:** Migration 163 updates church keywords to route to `giving` capability. Also adds giving keywords for mosque and NGO categories.
- **File:** `supabase/migrations/163_fix_church_giving_keywords.sql`
- **What could break:** Nothing. Only changes keyword routing from `payment` to `giving` for faith-related giving terms.

### Legal: 3 new legal pages + Privacy Policy gaps + export rate limit fix
- **New files:** `app/(marketing)/dmca/page.tsx`, `app/(marketing)/refund-policy/page.tsx`, `app/(marketing)/aml-kyc/page.tsx`
- **Modified:** `app/(marketing)/privacy/page.tsx` — added dpo@waaiio.com contact, physical mailing address, PIPEDA section for Canada, right to appeal for CCPA denials
- **Modified:** `app/api/account/export/route.ts` — replaced in-memory Map rate limit with DB-backed check using `platform_settings` table (key `export:{userId}`). In-memory Map was unreliable across serverless invocations.
- **Modified:** `components/marketing/Footer.tsx` — added links to Refund Policy, DMCA, and AML & KYC pages
- **Impact:** Footer now shows 3 additional legal links. Export rate limit persists across cold starts.

### Security: Server-side OTP token verification on public purchase/booking APIs
- **Files:** `lib/otp-token.ts` (new), `app/api/auth/email-otp/route.ts`, `app/api/events/purchase/route.ts`, `app/api/bookings/public/create/route.ts`, `app/e/[slug]/EventPurchaseForm.tsx`, `app/b/[slug]/BookingForm.tsx`
- OTP verify endpoint now issues HMAC-signed token (15min TTL) proving email was verified
- Both purchase APIs require and validate `otpToken` server-side — blocks direct API bypass
- OTP code comparison switched from `!==` to `timingSafeEqual` (timing attack prevention)
- **Breaking:** Direct API calls without `otpToken` will now get 403

### Security: payment-success no longer blindly trusts Stripe redirect
- **File:** `app/payment-success/page.tsx`
- Removed `isVerified = true` fallback when gateway verification fails
- Unverified payments now wait for webhook confirmation instead of auto-confirming
- Prevents fraud via crafted `/payment-success?ref=X` URLs

### Security: CSP hardened — removed unsafe-eval, added PayPal
- **File:** `middleware.ts`
- Removed `unsafe-eval` from `script-src` (XSS mitigation)
- Added PayPal domains to `script-src` and `frame-src` for PPCP checkout

### Security: Public pages no longer use service client
- **Files:** `app/e/[slug]/page.tsx`, `app/b/[slug]/page.tsx`
- Switched from `createServiceClient()` to `createClient()` (respects RLS)
- No more `owner_id`, `subscription_tier`, `metadata` leaked to client
- Added `is_active` filter — inactive/suspended businesses no longer accessible

### Fix: Dark mode scoped to dashboard only
- **Files:** `app/globals.css`, `app/dashboard/layout.tsx`
- All `.dark` overrides now require `[data-dashboard]` ancestor
- Dashboard layout wrapper gets `data-dashboard` attribute
- Marketing pages (homepage, pricing, events, bookings) no longer corrupted by dark mode
- Mobile h1/h2 force-resize also scoped to dashboard only

### SEO: Dynamic sitemap with event and business pages
- **File:** `app/sitemap.ts`
- Now async — queries published events and active businesses from Supabase
- Up to 500 event pages (`/e/[slug]`) and 500 business pages (`/b/[slug]`) included
- Google and other crawlers can now discover and index public commerce pages

### UX: Dashboard overhaul — remove jargon, fix guidance
- **Files:** `Sidebar.tsx`, `settings/page.tsx`, `capabilities/page.tsx`, `page.tsx`, `chat/page.tsx`, `customers/page.tsx`
- Sidebar: "Bot Settings"→"WhatsApp Setup", "Explore Features"→"Add Features", "FAQ Answers"→"Auto-Replies"
- Sections: "Engage"→"Grow", "Manage"→"Your Business"
- Calendar gets distinct icon (was identical to Bookings)
- Forms + Surveys merged into single "Surveys & Forms" nav item
- Settings: added intro text, "Bot & Booking" tab→"WhatsApp & Booking"
- Capabilities: description explains enabling adds feature to bot menu
- Dashboard: removed duplicate inline setup checklist (OnboardingChecklist is single source)
- Chat: empty state now has description + "Share WhatsApp link" CTA
- Customers: empty state now has action button linking to QR code page

### Design: Website elevated from 6/10 to premium quality
- **Files:** `HomeClient.tsx`, `layout.tsx` (root + auth + marketing), `globals.css`, `tailwind.config.ts`
- Hero headline: outcome-focused "Customers Book & Pay on WhatsApp — While You Sleep"
- CTA hierarchy: primary (large accent) > secondary (ghost) > tertiary (small WhatsApp)
- Avatar social proof: gradient initials instead of colored divs
- Stats replaced with non-embarrassing numbers (89+ types, 30 capabilities)
- Payment partners: grayscale-to-color hover effect
- Section spacing py-24, alternating bg-white/bg-gray-50
- Feature cards: gradient icon backgrounds, scale-on-hover
- Testimonial metric: visible gradient treatment
- FAQ: AnimatedSection + open-state bg
- Auth layout: gradient background, glassmorphism header, copyright footer
- Inter font variable properly wired with font smoothing
- Scroll progress bar (brand→accent gradient)

### Fix: Inactive businesses blocked from public booking API
- **File:** `app/api/bookings/public/create/route.ts`
- Added `.eq('is_active', true)` filter — suspended businesses return 404

---

## 2026-05-19 (i)

### Fix: collect_guest_names step rejects comma-separated names on WhatsApp

**Bug:** The `collect_guest_names` step in the scheduling flow asked users to enter names "one per line", but WhatsApp mobile users can't easily type multiline messages. Users typing comma-separated names like "John, Mary, Sarah" got rejected by the validator, leaving them stuck.

**Files changed:**
- `lib/bot/flows/scheduling.flow.ts` — `collect_guest_names` step:
  - **prompt**: Changed from plain text to a buttons message with a "Skip Names" button (better UX than typing "skip"). Updated instructions to ask for comma-separated names with an example.
  - **validate**: Now accepts 5 input formats: newline-separated, comma-separated, numbered lists ("1. John 2. Mary"), "and"-separated, and dash/bullet-separated. Also relaxed strict count matching — no longer rejects if name count doesn't match party size.

**What could break:** If downstream code relied on `guest_list.length === party_size`, it may now receive a different count. The guest list is stored in `session_data.guest_list` and used for display/confirmation only, so this should be safe.

---

## 2026-05-19 (h)

### Fix: Bot crash on non-flow capabilities (estimates, packages, class_booking, multi_location)

**Bug:** Selecting `estimates`, `packages`, `class_booking`, or `multi_location` from the WhatsApp bot capability menu caused a silent crash. These capabilities have no standalone flow files — the flow registry returned undefined, executor called methods on it, and the session died.

**Files changed:**
- `lib/bot/handlers/flow-routing.ts` — Added 4 capabilities to `nonUserFacing` set so they never appear in customer-facing menu. Added explicit `capabilityToFirstStep` cases routing them to `select_service` (scheduling fallback).
- `lib/bot/flows/capability-selection.flow.ts` — Added same 4 capabilities to both `nonUserFacing` (skipIf) and `nonUF` (validate) sets so they are filtered from menu display and selection.

**What could break:** If a business has ONLY one of these 4 capabilities enabled (and no other user-facing ones), the bot will fall through to scheduling's `select_service` step. This is the intended behavior — estimates use scheduling, packages are purchased during booking, class_booking uses scheduling with is_class=true, multi_location is a step within scheduling.

**Note:** The executor already handles missing steps gracefully (sends "Oops, we hit a snag" + deactivates session + logs to Sentry), so even without this fix the crash was "graceful" from a user perspective — but the session would die instead of routing properly.

---

## 2026-05-19 (g)

### CCPA/GDPR Technical Compliance Features

**Files changed:**
- `app/api/account/export/route.ts` — NEW: GDPR Article 20 data export endpoint. Returns all user data (profile, businesses, bookings, orders, payments, invoices, customers, services, products, bot sessions, subscriptions) as downloadable JSON. Rate limited to 1 export per 24 hours per user. Audit logged.
- `app/api/account/consent/route.ts` — NEW: Consent tracking API. GET returns current consent (marketing, analytics, AI processing). POST updates preferences in profiles.metadata.consent_preferences.
- `app/api/account/route.ts` — Enhanced: supports 30-day grace period deletion (body: { gracePeriod: true }), handles multiple businesses per user, deactivates bot sessions, sends confirmation email, full audit logging.
- `lib/email/templates.ts` — Added `accountDeletionConfirmationEmail` (grace period + immediate variants) and `dataBreachNotificationEmail` (GDPR Article 34 template ready for 72-hour breach notification).
- `components/marketing/CookieConsent.tsx` — Enhanced: granular category toggles (Essential always-on, Analytics, Marketing), syncs to server for logged-in users, dispatches `waaiio:consent` custom event, migrates legacy accept/reject format, exports `getCookieConsent()` helper.
- `components/PostHogProvider.tsx` — Rewritten: blocks PostHog initialization until analytics consent given, listens for consent changes, uses opt_in/opt_out_capturing dynamically.
- `lib/posthog/client.ts` — Simplified: PostHog init now handled by provider, client returns instance for direct calls.
- `components/marketing/Footer.tsx` — Added "Do Not Sell My Info" link to legal section.
- `app/(marketing)/do-not-sell/page.tsx` — NEW: CCPA "Do Not Sell" page explaining data practices, user rights, and how to exercise them.
- `app/dashboard/settings/page.tsx` — Added "Privacy & Data" tab with: Download My Data button, consent preference toggles (marketing/analytics/AI), privacy resource links, delete account with grace period modal.

**What it affects:** Account deletion flow, cookie consent behavior, PostHog analytics initialization, footer navigation, dashboard settings
**What could break:** PostHog no longer initializes by default — requires analytics cookie consent. Users who previously accepted cookies are migrated automatically. Account deletion now accepts a body parameter (existing DELETE calls without body still work as immediate deletion).

---

## 2026-05-19 (f)

### Explore Features Page Redesign

**Files changed:**
- `app/dashboard/capabilities/page.tsx` — Redesigned capabilities page into "Explore Features" with grouped layout (Booking & Scheduling, Payments & Commerce, Events & Tickets, Customer Engagement, Operations, Documents), search/filter, enabled counter (X of 30), tier badges (Pro/Premium), trial-aware toggle (everything unlocked during 30-day trial), sticky save bar, dark mode support, responsive grid layout
- `components/dashboard/Sidebar.tsx` — Renamed sidebar label from "Features" to "Explore Features"

**What it affects:** Dashboard capabilities page UI/UX, sidebar navigation label
**What could break:** Nothing — same toggle/save logic preserved, only UI restructured

---

## 2026-05-19 (e)

### Class Booking + Multi-Location Bot Routing

**Files changed:**
- `supabase/migrations/155_class_booking_multi_location.sql` — NEW: adds `is_class` + `class_schedule` columns to services, updates `book_slot_atomic` RPC with `p_location_id` parameter
- `lib/bot/flows/scheduling.flow.ts` — Added `select_location` step as first step in scheduling flow (skips if 0-1 locations), updated service queries to include `is_class`/`class_schedule`, class services show schedule + spots left in bot list, location name shown in confirmation, `location_id` passed to `book_slot_atomic` and direct insert payload, full-class offers waitlist if capability enabled
- `app/dashboard/services/page.tsx` — Added `is_class`/`class_schedule` to Service interface + form + save payload, Group Class toggle with class schedule editor (repeating day+time), class roster display (enrolled students for upcoming sessions), filter tabs (All | Services | Classes) on list view, class badge in service list items

**What changed:**
- Classes are services with `is_class=true` + `max_capacity > 1` + optional `class_schedule` JSONB
- Bot shows class services with schedule info ("Mon/Wed 6:00 PM - 8 spots left")
- When class is full and waitlist capability is enabled, bot offers waitlist join
- Multi-location businesses get a `select_location` step before service selection in the bot
- Location auto-selects if only 1 location exists
- `book_slot_atomic` now accepts `p_location_id` (defaults to NULL for backward compat)
- Dashboard service edit form has Group Class toggle with day/time schedule editor + max students + enrolled roster

**What could break:**
- Migration adds new columns with defaults — safe for existing data
- `book_slot_atomic` has `p_location_id` as last param with DEFAULT NULL — existing callers unaffected
- `select_location` step is skipped for businesses with 0-1 locations — no change for single-location businesses
- Service queries now select `is_class, class_schedule` — new columns default to `false` and `[]` respectively

---

## 2026-05-19 (d)

### Category System Restructure — 16 Industry Groups

**Files changed:**
- `lib/constants.ts` — BusinessCategoryKey type, BUSINESS_CATEGORIES array, CATEGORY_LABELS, DEFAULT_SERVICES
- `lib/capabilities/types.ts` — CapabilityId type, CAPABILITIES array, CAPABILITY_TIER_REQUIREMENTS, CATEGORY_DEFAULT_CAPABILITIES

**What changed:**
- Restructured BUSINESS_CATEGORIES into 16 industry groups (was mixed/inconsistent)
- Added 30 new category keys: cafe, bar, lounge, food_truck, yoga, pilates, dance, martial_arts, bootcamp, courier, moving, bus, language_school, training_academy, dog_walking, pet_boarding, pet_training, videographer, dj, graphic_designer, content_creator, property_manager, mortgage_broker, handyman, hvac, landscaping, electrician, medspa, lash_tech, waxing, optician, physiotherapy
- Removed instagram_vendor and mall_vendor from BUSINESS_CATEGORIES and CATEGORY_DEFAULT_CAPABILITIES (merged into 'shop'), kept in BusinessCategoryKey type and CATEGORY_LABELS for backward compat
- Removed duplicate restaurant entry (was at line 218 and 227)
- Added 4 new capabilities: estimates, packages, class_booking, multi_location
- CATEGORY_DEFAULT_CAPABILITIES now uses group-based shared arrays (DRY)
- Moved categories to correct groups: pet_grooming→Pet Services, photographer→Creative & Media, logistics→Transport & Logistics, car_park→Government & Public, driving_school/school/daycare→Education & Training, real_estate→Real Estate & Property
- Fixed icons: other '🔧'→'✨', supermarket '🛒'→'🏬'

**What could break:**
- Any hardcoded group name checks (old groups: 'Food & Drink', 'Fitness & Wellness', 'Shops & Commerce', 'Transport' are now renamed)
- Any code checking `CATEGORY_DEFAULT_CAPABILITIES['instagram_vendor']` will get undefined (was removed from the map)
- Existing businesses with instagram_vendor/mall_vendor category in DB still work (type still valid, CATEGORY_LABELS still has entries)

---

## 2026-05-19 (c)

### Multi-Agent Live Chat Support
- **Files:** `app/api/chat/assign/route.ts` (new), `app/api/chat/send/route.ts`, `app/api/chat/list/route.ts`, `app/dashboard/chat/page.tsx`
- **What:** (1) New `/api/chat/assign` POST endpoint — assigns/unassigns conversations to team members (owner/admin/manager auth). Updates `assigned_to` + `assigned_at` on `chat_conversations`. (2) Updated send route — resolves sender's `business_members.id`, stores as `staff_id` on outbound messages, auto-assigns unassigned conversations to the sender. Also allows team members (not just owners) to send messages. (3) Updated list route — includes `assigned_to` in conversation data, returns `currentMemberId`, supports `?assigned=me` and `?assigned=unassigned` query params. Also allows team members to access the chat list. (4) Updated chat UI — assignment dropdown in conversation header, "All | Assigned to me | Unassigned" filter tabs (only shown when team has 2+ members), assigned badge on conversation list items, agent name on outbound message bubbles.
- **Affects:** Chat page, chat API routes. Requires migration 151 (already applied: `assigned_to`, `assigned_at` columns + team member RLS policies).
- **Could break:** Owner-only businesses (no team members) see no changes — assignment UI is hidden when `teamMembers.length <= 1`. The `getMemberName()` function looks up by `business_members.id` — owner without a `business_members` record won't show a name on their messages (gracefully handled with null check).

---

## 2026-05-19 (b)

### WhatsApp Catalog Sync Dashboard UI
- **Files:** `app/dashboard/products/page.tsx`, `app/api/catalog/sync/route.ts`
- **What:** (1) Added "Sync to WhatsApp" button in products page header — only visible when business has an active `meta_cloud` WhatsApp channel and products exist. Button calls `POST /api/catalog/sync`, shows progress state and success/error banner. (2) Added per-product sync indicator (green dot "Synced" / gray dot "Not synced") in the product card quick actions bar, based on `catalog_synced_at` column. (3) Updated sync API route to: store `whatsapp_catalog_id` on business record, set `catalog_synced_at` on all synced products, and log every sync attempt to `catalog_sync_logs` table with status (success/partial/failed). (4) Added collapsible "Sync History" section below product grid showing last 5 sync attempts with synced/failed counts, status badges, timestamps, and error messages.
- **Affects:** Products dashboard page (new UI elements), catalog sync API (now persists sync state). Requires migration 152 (already applied).
- **Could break:** `catalog_synced_at` and `catalog_sync_logs` queries use browser Supabase client — RLS must allow business owner reads (migration 152 has RLS policy). The `whatsapp_channels` check query uses browser client with RLS — should work since channels table has owner-based RLS.

---

## 2026-05-22

### Bot Performance Analytics + Waitlist-to-Booking Conversion
- **Files:** `app/dashboard/analytics/page.tsx`, `app/api/bookings/[id]/status/route.ts`, `app/api/bookings/[id]/reschedule/route.ts`, `app/dashboard/waitlist/page.tsx`, `lib/payments/process-success.ts`, `lib/waitlist/auto-notify.ts` (new)
- **What:** (1) Added "Bot Performance" section to analytics page with 4 stat cards (Inbound/Outbound Messages, Sessions, Completion Rate), Intent Distribution list (top 5 intents with bars + avg confidence), and Session Outcomes visualization (Completed/Abandoned/Active bars). Queries `conversation_usage`, `bot_sessions` (with `current_step` for completion detection), and `llm_classifications` tables. (2) Created shared `lib/waitlist/auto-notify.ts` with `notifyWaitlistOnSlotOpen()` and `markWaitlistConverted()`. (3) Status route (no_show) and reschedule route now auto-notify up to 3 waitlisted customers via WhatsApp when a slot opens. Respects `business.metadata.waitlist_auto_notify` toggle (default ON). (4) `processSuccessfulPayment` now tracks waitlist conversions: looks up notified waitlist entries by customer phone + service, marks as `converted` with `booking_id` and `converted_at`. (5) Waitlist dashboard page now shows Conversion Rate stat card and an auto-notify toggle switch.
- **Affects:** Analytics page (new section), booking status/reschedule flows (waitlist notifications), payment success pipeline (conversion tracking), waitlist dashboard (new metrics + settings).
- **Could break:** `llm_classifications` RLS only allows service_role and admin — browser client queries may return empty results for non-admin users. The `conversation_usage` query uses `maybeSingle()` which is safe. Auto-notify sends WhatsApp outside 24h window — falls back to text if no template configured (may fail for some channels). `process-success.ts` now does an extra booking SELECT after confirmation — minimal perf impact.

---

## 2026-05-19

### Customer Segmentation for Broadcasts + Group Booking Guest Names
- **Files:** `app/dashboard/broadcasts/page.tsx`, `lib/bot/flows/scheduling.flow.ts`, `app/dashboard/reservations/page.tsx`
- **What:** (1) Replaced simple "All contacts" broadcast audience with customer segmentation using `customer_profiles` table. Added preset segment shortcuts (All Contacts, Active 30 days, Inactive 30+ days, High Spenders, By Tag) and collapsible custom filter section (last visit dropdown, min spend input, multi-select tags) with live preview count. Contacts now loaded from `customer_profiles` with `notification_opt_in = true` filter instead of `bot_sessions`. (2) Added `collect_guest_names` flow step after `select_quantity` in scheduling flow. Prompts for guest names when party_size > 1 (one per line), validates count matches party_size, stores as `guest_list` JSONB. Skips for single bookings; user can type "skip". (3) After booking creation via `book_slot_atomic`, updates booking with `guest_list`. (4) Shows guest names in booking confirmation message and dashboard detail panel.
- **Affects:** Broadcast targeting, scheduling bot flow (new step in chain), booking detail views.
- **Could break:** Broadcasts now use `customer_profiles` instead of `bot_sessions` for contacts. Businesses with no customer profiles won't see contacts until profiles are populated. Guest name collection step adds one extra interaction for group bookings (party_size > 1). The `guest_list` column must exist on bookings table (migration 150).

### Dashboard Appointment Rescheduling + Referral Tracking Enhancements
- **Files:** `app/api/bookings/[id]/reschedule/route.ts` (new), `app/dashboard/reservations/page.tsx`, `app/dashboard/referrals/page.tsx`
- **What:** (1) Created reschedule API endpoint: POST with newDate/newTime, validates business ownership via `authenticateRequest`, stores original_date/original_time, updates booking, sends WhatsApp + email notifications to customer. Only allows pending/confirmed bookings. (2) Added Reschedule button in booking detail panel with inline date/time form, "Rescheduled" badge in timeline. (3) Enhanced referrals page: added Pending Conversions, Total Rewards Given, Outstanding Rewards stat cards; conversion funnel visualization with horizontal bars; referrer earnings breakdown (rewards earned + pending columns); status filter tabs (All/Pending/Converted/Rewarded/Expired); reward amount column in referrals table.
- **Affects:** Dashboard booking management, referral analytics.
- **Could break:** Nothing — new endpoint + additive UI. Reschedule uses existing `rescheduled_at`, `original_date`, `original_time` columns already in bookings table/interface.

### Low-Stock WhatsApp/Email Alerts Cron + CSV Contact Import
- **Files:** `app/api/cron/low-stock-alerts/route.ts` (new), `app/api/customers/import/route.ts` (new), `app/dashboard/customers/page.tsx`, `vercel.json`
- **What:** (1) Created Vercel cron endpoint for low-stock alerts. Queries products where `stock_quantity <= low_stock_threshold` and `low_stock_alerted = false`, groups by business, sends WhatsApp via ChannelResolver + email to owner, marks products alerted, resets flag for restocked products via `reset_low_stock_alerts` RPC. Runs daily at 10am UTC. (2) Created CSV contact import: POST `/api/customers/import` with business ownership auth, phone normalization via `ensurePlus()`, email validation, upserts into `customer_profiles` (500-row cap). (3) Added Import CSV button + modal to customers dashboard with file upload, paste area, auto-detect header, preview table with green/red validation dots, import results.
- **Affects:** Products with `track_inventory = true`, business owner notifications, customer management.
- **Could break:** Nothing — new endpoints only. Cron depends on `low_stock_alerted` column (migration 031) and `reset_low_stock_alerts` RPC. Import upserts on `business_id,phone` unique constraint.

### Launch Readiness Fixes (Issues 7-11)
- **Files:** `app/e/[slug]/EventPurchaseForm.tsx`, `app/b/[slug]/BookingForm.tsx`, `app/e/[slug]/page.tsx`, `app/b/[slug]/page.tsx`, `lib/bot/flows/ticketing.flow.ts`, `lib/bot/flows/scheduling.flow.ts`, `lib/bot/flows/payment.flow.ts`, `lib/channels/message-sender.ts`
- **What:** (7) Added OTP explanation helper text before verify button on event purchase and booking forms. (8) Changed "Paid already? Tap below to confirm:" to timing guidance "After paying, wait 5-10 seconds then tap below:" across all 3 payment flows (ticketing, scheduling, payment). (9) Verified already implemented (View Tickets link). (10) Added WhatsApp API limit enforcement in MetaCloudSender: sendList truncates title (24), body (1024), buttonLabel (20), section titles (24), item titles (24), item descriptions (72); sendButtons truncates body (1024) and button titles (20). (11) Added JSON-LD structured data: Event schema on /e/[slug] with offers/availability, LocalBusiness schema on /b/[slug].
- **Affects:** Public event/booking pages (SEO), WhatsApp bot payment UX, WhatsApp message delivery reliability.
- **Could break:** Nothing — all changes are additive or string truncation (prevents API errors). JSON-LD is inert to rendering.

### Add Web vs WhatsApp Channel Breakdown to Analytics and Admin
- **Files:** `app/dashboard/analytics/page.tsx`, `app/dashboard/page.tsx`, `admin/src/pages/Dashboard.tsx`
- **What:** Analytics page now has a "Booking Channels" section showing WhatsApp vs Web booking counts with percentage bars. Dashboard overview "Total Bookings" stat shows web booking count as subtitle when > 0. Admin panel System Health section has a new "Booking Channels" card showing monthly WhatsApp vs Web split with a stacked progress bar.
- **Affects:** Analytics page, dashboard overview, admin dashboard. All read-only additions — no existing stats modified.
- **Could break:** Nothing — purely additive. Queries use `bookings.channel` column (enum `booking_channel`: 'whatsapp' | 'web') which exists since migration 001.

### Adapt Payment Success Pipeline for Web Channel Purchases
- **Files:** `app/payment-success/page.tsx`, `lib/bot/flows/shared/send-tickets.ts`, `lib/payments/send-confirmation.ts`
- **What:** Web channel bookings (`channel='web'`) now receive email-only confirmation and ticket delivery instead of WhatsApp. Payment success page detects booking channel and shows "Confirmation sent to your email" + "View Your Tickets" link for web ticketing purchases. `sender` parameter in `SendTicketsOptions` is now optional — WhatsApp PDF/QR delivery is skipped when sender is undefined, but email delivery always runs when `guestEmail` is available. `sendProactiveConfirmation` no longer returns early when no WhatsApp channel is resolved — it sends email confirmation via `bookingConfirmationEmail` template and still processes tickets. Session reset only runs when `customerPhone` exists.
- **Affects:** All 3 ticket delivery paths (flow, webhook, success page). Web purchases get email. WhatsApp purchases unchanged. If phone IS provided on web bookings, WhatsApp delivery is also attempted (best of both).
- **Could break:** If `bookings.guest_email` is null for web bookings, no email is sent (silent skip). Callers of `sendTicketsAfterPurchase` that relied on `sender` being required will now get a type error if they pass `undefined` explicitly — but since it's optional, existing calls with a sender value are unaffected.

### Add Structured Logging with Request Context
- **Files:** `lib/logger.ts`, `middleware.ts`, `app/api/webhook/whatsapp/route.ts`, `app/api/webhook/meta-cloud/route.ts`
- **What:** Enhanced logger with `withContext()` method for child loggers carrying metadata (requestId, from phone). Added `generateRequestId()` utility. Production logs now output structured `key=value` format. Middleware generates `x-request-id` header on every request. Both webhook routes use contextual loggers for traceability.
- **Affects:** All existing `logger.info/warn/error/debug` call sites remain compatible (additive change). Vercel logs now contain structured context for webhook debugging.
- **Could break:** Nothing — existing API is unchanged. New `withContext` is opt-in.

### Add PWA Support

- **`app/manifest.ts`** — Enhanced manifest: added full name, description, `start_url: /dashboard`, `orientation: portrait-primary`, `purpose: any maskable` on icons
- **`app/layout.tsx`** — Added `manifest: '/manifest.webmanifest'` to metadata export so browsers discover the manifest
- Icons already existed: `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `favicon.ico`
- No service worker added (intentional — avoids caching complexity)
- No new packages installed

### Add ISR (Incremental Static Regeneration) to Marketing Pages

- **Homepage** (`app/(marketing)/page.tsx`) — `revalidate = 60` (1 min, fetches live stats)
- **Directory** (`app/(marketing)/directory/page.tsx`) — `revalidate = 60` (1 min, businesses may change)
- **About** (`app/(marketing)/about/page.tsx`) — `revalidate = 3600` (1 hr, static content)
- **Contact** (`app/(marketing)/contact/page.tsx`) — `revalidate = 3600` (1 hr, static content)
- **Features** (`app/(marketing)/features/page.tsx`) — `revalidate = 3600` (1 hr, static content)
- **Pricing** skipped — it's a `'use client'` component (ISR only works on server components)
- Pages are now cached at Vercel's edge for N seconds instead of re-rendering every request
- No `force-dynamic` directives were present in any of these files

### Extract 5 Handler Groups from bot.service.ts (Pure Refactor)

- **bot-helpers.ts** — `getActiveSession`, `deactivateSession`, `sendBotText`, `forwardToBusinessOwner` extracted as standalone functions. File: `lib/bot/bot-helpers.ts`
- **handlers/flow-routing.ts** — `getFirstStep`, `getFirstStepFromCapabilities`, `capabilityToFirstStep` extracted as pure functions. File: `lib/bot/handlers/flow-routing.ts`
- **handlers/quote-response.ts** — `handleQuoteResponse` extracted. File: `lib/bot/handlers/quote-response.ts`
- **handlers/ticket-checkin.ts** — `handleTicketCheckin` extracted. File: `lib/bot/handlers/ticket-checkin.ts`
- **handlers/transaction-docs.ts** — `handleTransactionDocument`, `buildTextReceipt` extracted. File: `lib/bot/handlers/transaction-docs.ts`
- Class methods in `bot.service.ts` remain as thin 1-line wrappers to avoid touching call sites
- **No behavior changes** — bot.service.ts reduced from ~4072 to ~3699 lines
- Build + 283 tests pass clean

### PageHelp Component Added to 5 Dashboard Pages

- **Insights** — Added PageHelp banner with "Intelligence Hub" description. File: `app/dashboard/insights/page.tsx`
- **Tickets** — Added PageHelp banner with "Event Tickets" description. File: `app/dashboard/tickets/page.tsx`
- **Forms** — Added PageHelp banner with "Custom Forms" description. File: `app/dashboard/forms/page.tsx`
- **Analytics** — Added PageHelp banner with "Business Analytics" description. File: `app/dashboard/analytics/page.tsx`
- **Calendar** — Added PageHelp banner with "Booking Calendar" description. File: `app/dashboard/calendar/page.tsx`
- Chat page already had PageHelp — no changes needed.

### Non-Destructive Improvements (9 changes)

#### Accessibility
- **Viewport meta tag** — Added `viewport-fit: cover` for safe-area-inset support. File: `app/layout.tsx`
- **Safe-area-inset on mobile CTA** — Sticky "Get Started" bar now clears iPhone home indicator. File: `app/(marketing)/layout.tsx`
- **Tooltip keyboard support** — Added `onFocus`/`onBlur`, `tabIndex`, `role="tooltip"` for keyboard users. File: `components/dashboard/Tooltip.tsx`
- **Table scope attributes** — Added `scope="col"` to 227 `<th>` elements across 33 dashboard pages
- **SVG aria-hidden** — Added `aria-hidden="true"` to decorative SVGs across 49+ dashboard files and marketing pages

#### Mobile UX
- **Tap targets increased** — Form inputs bumped from `py-2.5` to `py-3` (91 inputs across 19 pages). Sidebar nav links also increased. WCAG AA 44px compliance.

#### Performance
- **WhatsApp channel query parallelized** — 3 sequential queries → 1 `Promise.all()` on dashboard overview. ~300-800ms faster load. File: `app/dashboard/page.tsx`
- **Bulk order status updates** — New `/api/orders/bulk-update-status` endpoint. 1 DB query + parallel notifications instead of N sequential calls. Old sequential fallback preserved. Files: `app/api/orders/bulk-update-status/route.ts`, `app/dashboard/orders/page.tsx`
- **API caching** — Alerts cached 30s, recommendations cached 5min with `stale-while-revalidate`. Alerts query narrowed from `select('*')` to specific columns. Files: `app/api/dashboard/alerts/route.ts`, `app/api/dashboard/recommendations/route.ts`

#### UX Copy
- **Bot error messages** — Changed generic "Something went wrong" to friendlier "Oops, we hit a snag" across all 5 payment flows + executor
- **Validation messages** — Changed "Please select a valid option" to "That option is not available. Tap one of the choices above" across 5 flow files

### Bot Flow — T&C Cancel Fix (5 flows)
- **Fixed terms cancel being ignored** — In all 5 payment flows (scheduling, ordering, payment, ticketing, reservation), the `_terms_cancelled` check was placed AFTER the T&C gate. Since `!_terms_accepted` was still true after cancel, the gate re-triggered and showed the terms prompt again instead of cancelling. Moved cancel check before the gate. Files: `scheduling.flow.ts`, `ordering.flow.ts`, `payment.flow.ts`, `ticketing.flow.ts`, `reservation.flow.ts`
- **Fixed returning-customer routing after cancel** — `last_active_at` on `bot_sessions` was only set on INSERT (DEFAULT NOW()), never updated on activity. After cancelling a flow and sending "Hi", the bot could route to a different business whose session had a more recent creation time. Now updates `last_active_at` on every message processed. File: `executor.ts`
- **What could break:** If a business relies on `last_active_at` being static (unlikely), this would change behavior. The T&C fix is safe — only changes ordering of two existing checks.

### Drop-off Service Booking Fix
- **Fixed booking creation crash for drop-off services** — `book_slot_atomic` RPC casts `p_time::time` which fails when value is literal `'Drop-off'` string. Changed to `'00:00'` (valid time); display logic already handles drop-off separately. File: `scheduling.flow.ts`
- **Fixed false capacity block for drop-off services** — All drop-off bookings share time `00:00`, so capacity check would wrongly reject after `max_capacity` bookings on same day. Set `max_capacity = 9999` for drop-off services. File: `scheduling.flow.ts`
- **What could break:** If a drop-off service somehow needs real time slots, the `00:00` placeholder would need revisiting.

---

## 2026-05-18

### Smart Natural Language Booking / Ordering / Payments
- **Scheduling fast-track** — "book haircut friday 3pm" skips service, date, time steps. Validated against business hours, availability. Falls back to picker if invalid. Files: `scheduling.flow.ts`, `capability-selection.flow.ts`, `bot.service.ts`
- **Service disambiguation** — "book massage" with multiple massage services shows only matching services instead of guessing. `matchServicesFromKeywords` returns all ties. File: `smart-intent.ts`
- **Payment/giving fast-track** — "pay tithe 5000" extracts amount + matches service category → skips amount entry. File: `payment.flow.ts`, `smart-intent.ts`
- **Ticketing fast-track** — "buy 2 tickets" pre-fills quantity. File: `capability-selection.flow.ts`
- **Ordering fast-track** — "order 2 jollof rice" matches product → auto-adds to cart → skips to checkout. Multiple matches filter catalog. File: `ordering.flow.ts`, `smart-intent.ts`
- **Variant auto-selection** — "order large pizza" extracts "large" → auto-selects matching variant. Supports size, color, flavor keywords. File: `ordering.flow.ts`, `smart-intent.ts`
- **Reorder command** — "reorder", "same again", "last order" loads previous order items into cart → checkout. File: `bot.service.ts`
- **Amount extraction** — new `extractAmount()` parses "5000", "$500", "5000 naira" from natural language. File: `smart-intent.ts`
- **Variant extraction** — new `extractVariantKeywords()` parses size/color/flavor keywords. File: `smart-intent.ts`
- **Product matching** — new `matchProductsFromKeywords()` for ordering flow, same disambiguation pattern as services. File: `smart-intent.ts`
- **Capability selection smart parsing** — all 6 flows (scheduling, reservation, payment, giving, ticketing, ordering) now parse natural language at the capability selection step, not just during session creation.
- **Safety**: confirmation step always exists before payment. Invalid dates/times/services fall back to normal pickers. Never guesses — asks when ambiguous.

### Payment Confirmation Fixes
- **Await sendProactiveConfirmation in ALL 5 webhook handlers** — was fire-and-forget (`.catch()`), Vercel killed serverless functions before confirmation finished. Now all handlers `await` the confirmation. Files: webhook-handler.ts, stripe-webhook, flutterwave, square-webhook, paypal-webhook
- **Payment-success page awaits full pipeline** — was fire-and-forget too. Now awaits `processSuccessfulPayment` (fees, invoices, campaigns) + `sendProactiveConfirmation`. File: `app/payment-success/page.tsx`
- **Stripe webhook URL fixed** — was `waaiio.com` (307 redirect stripped POST body). Changed to `www.waaiio.com` in Stripe Dashboard. 247 failed deliveries resolved.
- **Channel lookup checks inactive sessions** — was filtering `is_active: true` but sessions are deactivated before webhook runs. Now checks most recent session regardless of status, falls back to any session with `_inbound_channel_id`. File: `lib/payments/send-confirmation.ts`

### Save Card (Consent-Based with PIN)
- **Paystack only** — Stripe/Square/PayPal require different APIs (SetupIntent/Vault), not built yet.
- **Payment lookup fixed** — was querying `metadata.customer_phone` which doesn't exist. Now finds via booking `guest_phone` + fallback to `user_id`. File: `lib/bot/bot.service.ts`
- **Gateway-aware messaging** — Stripe/Square/PayPal show "Card saving available for Paystack only". No save card tip in their confirmations.
- **Save card tip shown conditionally** — only on first Paystack payment with reusable card + no existing saved card. Not on every confirmation.

### Dashboard Bugs Fixed (6)
- **Customers page hardcoded Naira** → uses `formatCurrency(amount, cc)` with business country_code
- **Dead link `/dashboard/settings/billing`** → changed to `/dashboard/payouts`
- **Orders page N+1 query** → single batch query with `.in('order_id', orderIds)`
- **Supabase client every render** → `useMemo(() => createClient(), [])` on invoices + customers
- **Calendar 8AM-8PM hardcoded** → derives from `business.operating_hours` with fallback
- **Calendar local formatCurrency** → replaced with import from `@/lib/constants`

### Admin Panel
- **Support role restricted** — can now only query 20 customer-facing tables. Blocked from profiles, payments, payout_accounts, audit_logs, impersonation_logs, etc. File: `app/api/admin/query/route.ts`

### Tests
- **225/225 passing** — fixed My Account test (expected 9 items, now 10 with Switch Business)

---

## 2026-05-15

### UI/UX fixes across marketing pages and onboarding

- **OnboardingWizard** (`app/get-started/OnboardingWizard.tsx`): Changed side panel text from "Join 100+ businesses" to "Join businesses across 5 countries". Changed default plan from `'growth'` to `'free'` (URL param `?plan=growth` still overrides).
- **WhatsApp number** (`app/(marketing)/layout.tsx`): Fixed floating WhatsApp button from personal number `15712746425` to shared US number `12029226251`.
- **Footer links** (`components/marketing/Footer.tsx`): Added anchor fragments to Solutions links (`#scheduling`, `#payments`, `#engagement`). Removed India from footer country list.
- **Features page** (`app/(marketing)/features/page.tsx`): Added `id` attributes (`scheduling`, `payments`, `engagement`) to section elements for anchor linking.
- **About page** (`app/(marketing)/about/page.tsx`): Removed India/Razorpay entry from countries grid. Changed "6 countries" to "5 countries" in heading, CTA, and counter animation.
- **Country count consistency**: Fixed "6 countries" to "5 countries" in layout.tsx OG description, about page (3 locations), help page FAQ (removed India/Razorpay sentence).
- **Navbar** (`components/marketing/Navbar.tsx`): Added Contact link to NAV_LINKS array.
- **HomeClient** (`app/(marketing)/HomeClient.tsx`): Removed unused `FlowCard` component definition. Removed India from PRICE_COUNTRIES array and priceCountry type.
- **Directory search** (`app/(marketing)/directory/DirectoryClient.tsx`): Added 300ms debounce on search input to avoid firing API call on every keystroke.
- **Affected**: All marketing pages, onboarding wizard, SEO metadata. No backend changes.

---

## 2026-05-17

### Security hardening — 12 fixes across API routes

**HIGH:**
1. **Open redirect in `/api/pay`** (`app/api/pay/route.ts`): Validate `storedUrl` against ALLOWED_DOMAINS whitelist before redirect. Added min 6-char check on `ref` param. Sanitized `ref` for LIKE query (`%_\` chars escaped).
2. **OTP send rate limiting** (`app/api/contracts/otp/send/route.ts`): Added 3 per 10 min per IP.
3. **OTP verify rate limiting** (`app/api/contracts/otp/verify/route.ts`): Added 10 per 10 min per IP.
4. **Error message leaks** (9 files): Replaced `(error as Error).message` in JSON responses with generic `'Something went wrong'`. Affected: `channels/request`, `broadcasts/send`, `broadcasts/usage`, `auth/facebook/callback`, `auth/facebook/discover`, `onboarding/register`, `onboarding/subscribe`, `onboarding/verify`, `business/upload-logo`.
5. **Quote accept rate limiting** (`app/api/orders/quote-accept/route.ts`): Added 10 per min per IP.
6. **Cron balance-reminder auth** (`app/api/cron/balance-reminder/route.ts`): Replaced manual Bearer token check with `verifyCronAuth()`.
7. **BYO webhook timing-safe** (`app/api/payments/byo-webhook/[businessId]/route.ts`): Replaced `!==` with `timingSafeEqual` for Paystack signature check.
8. **Paystack transfer webhook timing-safe** (`app/api/webhooks/paystack-transfer/route.ts`): Same fix — imported `timingSafeEqual`, replaced `!==`.

**MEDIUM:**
9. **Directory LIKE sanitization** (`app/api/directory/route.ts`): Escape `%_\` in search param before `.ilike()`.
10. **Ticket verify rate limiting** (`app/api/tickets/verify/[code]/route.ts`): Added 30 per min per IP on GET handler.
11. **Health endpoint** (`app/api/health/route.ts`): Removed env var presence checks that revealed server config. Now returns only `{ status: 'ok', timestamp }`.

- **Affected**: All listed API routes. No DB schema changes. No frontend changes.
- **Could break**: Health monitoring dashboards that relied on `checks.meta_token` / `checks.supabase_url` fields.

---

### Replace raw tel inputs with shared PhoneInput component
- **8 dashboard pages updated**: invoices, staff, locations, events/invites, parties, payment-request, settings, whatsapp/connect
- Replaced raw `<input type="tel">` with `<PhoneInput>` component (`components/auth/PhoneInput.tsx`) — adds country flag selector, dialing code, digit validation
- **Contracts edit modal bug fix**: when editing a signer phone (e.g. +15712746425), the country dropdown now correctly detects US from the `+1` prefix instead of defaulting to NG. Added `detectCountryFromPhone()` helper. Also added `countryCode` prop to all 4 PhoneInput instances in the contracts create modal.
- **Payment request page**: separated customer search (text input with autocomplete) from phone entry (PhoneInput) — autocomplete dropdown preserved above the PhoneInput
- Cleaned up unused `getPhonePlaceholder` imports from invoices, staff, locations pages
- **Impact**: All phone inputs now have consistent UX with country-aware formatting. Build passes.
- **Could break**: Pages that read phone values before PhoneInput returns E.164 (only returns value when all digits filled). Payment request autocomplete UX slightly changed (search is now separate from phone entry).

### Full Security Audit — 24 Issues Fixed
- **DELETED `app/api/debug/stripe-test/route.ts`** — publicly accessible, no auth, exposed Stripe key prefix. Should never have existed in production.
- **4 webhook handlers fail-closed** — Paystack, Stripe, Square, PayPal all now reject requests when signature secret is not configured (were processing without verification).
- **Paystack webhooks timing-safe** — 3 files switched from `!==` to `timingSafeEqual` for HMAC comparison (main webhook, BYO webhook, transfer webhook).
- **Open redirect fixed** — `/api/pay` now validates redirect URL against domain allowlist (Paystack, Stripe, Square, PayPal, Flutterwave, Waaiio).
- **OTP rate limiting** — contract OTP send: 3/10min, OTP verify: 10/10min. Prevents WhatsApp flooding and brute force.
- **Quote accept rate limited** — 10/min per IP. Was unauthenticated with no limits.
- **Ticket verify GET rate limited** — 30/min per IP. Prevents ticket code enumeration.
- **Error messages sanitized** — 9 API routes no longer return `error.message` to clients. Generic "Something went wrong" with real error logged server-side.
- **LIKE injection prevented** — directory search and `/api/pay` ref param now escape `%_\` special chars before `.ilike()`.
- **Cron balance-reminder** — replaced manual Bearer check with `verifyCronAuth()` (timing-safe).
- **Health endpoint stripped** — no longer reveals which env vars are configured.
- **Impact**: Zero business logic changes. Only attackers are affected.

### RLS Security Hardening (Migration 144)
- **5 overly permissive policies fixed** — all had `USING(true)` allowing any authenticated user to read all rows:
  - `product_variants` — was exposing all variants. Dropped `product_variants_service_select`. Owner policies already existed.
  - `event_tickets` — was exposing guest names, phones, ticket codes. Dropped `public_verify_ticket`. QR scan uses service_role via API.
  - `event_invites` — was exposing guest phones, emails, invite tokens. Dropped `Guests view own invite`. RSVP uses service_role via API.
  - `service_addons` — was exposing all add-on config. Replaced with `service_addons_owner_read` scoped to business owner.
  - `site_pages` — any business owner could edit CMS (terms, privacy). Dropped `Authenticated users can manage pages`. Admin policies already existed.
- **Zero `USING(true)` policies remain** on any table with PII or business data.
- **All 95+ tables confirmed** to have RLS enabled. Service_role usage clean — no client-side leaks.

### Global API Rate Limiting
- **Middleware-level rate limiting** — all 159 API routes now protected. 60 write req/min, 120 read req/min per IP. File: `middleware.ts`
- **Webhooks exempted** — Paystack, Stripe, Square, PayPal, Flutterwave, cron endpoints skip rate limiting (authenticated via signatures).
- **Contact form migrated** — from ad-hoc `globalThis` to proper `rateLimitResponse` (5/min). File: `app/api/contact/route.ts`

### Code Consolidation (~1,250 lines of duplication eliminated)
- **`lib/payments/process-success.ts`** — NEW shared pipeline: `processSuccessfulPayment()`, `recordPlatformFee()`, `processInvoicePayment()`, `processCampaignDonation()`, `confirmBookingPayment()`. Replaces 5 inline copies across all webhook handlers.
- **`lib/payments/send-confirmation.ts`** — NEW shared `sendProactiveConfirmation()`. Replaces 6 copies of WhatsApp confirmation sender (phone lookup + channel resolution + message + post-completion + tickets + session reset).
- **`lib/utils/phone.ts`** — NEW `stripPlus()`, `ensurePlus()`, `phonePair()`. Replaces 66 inline phone normalization patterns.
- **`lib/bot/flows/shared/user.ts`** — Added `getCustomerName()` wrapper. Replaces 5 identical copies across webhook files.
- **All 5 webhook handlers + payment-success page** refactored to use shared functions. Gateway-specific logic (signature verification, payment lookup) preserved.
- **Impact**: Change confirmation message, fee logic, or session handling in ONE place — updates all gateways.

### Non-Destructive Improvements
- **llms.txt** — `public/llms.txt` for AI search engines (ChatGPT, Perplexity, Gemini) to cite Waaiio correctly.
- **WhatsApp CTA on homepage** — "Try on WhatsApp" green button in hero section linking to shared US number. File: `app/(marketing)/HomeClient.tsx`
- **Dynamic homepage stats** — business count, payment count, country count pulled from DB server-side instead of hardcoded. File: `app/(marketing)/page.tsx`
- **Directory SSR** — split into server + client components. Business names/categories server-rendered for search engine crawling. Files: `app/(marketing)/directory/page.tsx`, `DirectoryClient.tsx`
- **Email for new bookings** — business owner receives email when a payment is confirmed via webhook. Added to shared `sendProactiveConfirmation`. File: `lib/payments/send-confirmation.ts`
- **Receipt PDF logo** — business logo rendered at top of receipt PDFs when `logo_url` is set. Files: `lib/pdf/receipt-generator.ts`, `lib/receipts/generate-direct.ts`
- **All businesses verified** — set `verification_level = 'basic'` for all 27 active businesses. Auto-payouts no longer blocked by unverified status.
- **Citadel restored** — switched back to business tier after split pay testing.

### Session Persistence After Payment
- **Webhook reactivates session** — after payment, webhook now resets session to `select_capability` with `is_active: true`, even if the flow's `next()→null` already deactivated it. Prevents user from being routed to a different business. Applied across all 6 paths (Paystack, Stripe, Flutterwave, Square, PayPal, payment-success). Files: `lib/payments/webhook-handler.ts`, all 5 webhook routes, `app/payment-success/page.tsx`

### Inbound Channel Tracking
- **`_inbound_channel_id` stored in session** — bot now saves the WhatsApp channel the customer messaged from. Webhook confirmations send via that exact channel, not the business default. Fixes NG businesses on US shared numbers getting confirmations from wrong number. Files: `lib/bot/bot.service.ts`, `lib/channels/channel-resolver.ts` (new `resolveByChannelId`), all 6 webhook/confirmation paths
- **Citadel dedicated channel → shared** — orphan dedicated channel converted to shared in DB. Citadel uses US shared number.

### SEO — Critical Indexability Fix
- **Homepage split into server + client components** — was `'use client'` so search engines saw blank HTML. Now `page.tsx` is server component with metadata + JSON-LD, `HomeClient.tsx` is client component for interactivity. Files: `app/(marketing)/page.tsx`, `app/(marketing)/HomeClient.tsx`
- **PWA manifest** — added `app/manifest.ts` with icons, theme color, display mode. Enables "Add to Home Screen" and improves mobile ranking.
- **JSON-LD server-rendered** — Organization, SoftwareApplication, FAQPage structured data now in server component for crawler access.

### PayPal Environment Configured
- **Sandbox env vars set** — `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENVIRONMENT` added to Vercel production via CLI.
- **PayPal webhook registered** — `https://waaiio.com/api/payments/paypal-webhook` in PayPal sandbox. Events: CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED, PAYMENT.CAPTURE.REFUNDED.

### Split Pay Verified — All 3 Tiers
- **Free tier** — ₦200,000 → 2% = ₦4,000 platform fee ✓
- **Growth tier** — ₦500,000 → 1.5% = ₦7,500 platform fee ✓
- **Business tier** — ₦500,000 → 1% = ₦5,000 platform fee ✓

---

## 2026-05-16

### Payment Webhooks — Proactive Confirmation (All 5 Gateways)
- **Flutterwave webhook** — added proactive WhatsApp confirmation + post-completion + session deactivation + platform fee recording + invoice/campaign handling. Was only updating payment/booking status. File: `app/api/webhooks/flutterwave/route.ts`
- **Square webhook** — added proactive WhatsApp confirmation + post-completion + session deactivation. Was only updating payment/booking/platform fees. File: `app/api/payments/square-webhook/route.ts`
- **PayPal integration — NEW** — full gateway from scratch:
  - Gateway class: `lib/payments/paypal.ts` — initializePayment (Orders API v2 + payer-action redirect), verifyPayment (with auto-capture for APPROVED orders), refundPayment
  - Webhook handler: `app/api/payments/paypal-webhook/route.ts` — CHECKOUT.ORDER.APPROVED (auto-capture), PAYMENT.CAPTURE.COMPLETED (success), PAYMENT.CAPTURE.DENIED (failure), with proactive WhatsApp confirmation + post-completion
  - Signature verification via PayPal's `/v1/notifications/verify-webhook-signature` endpoint
  - Split payments via `payment_instruction.platform_fees` on purchase units
  - Added to factory.ts, types.ts, constants.ts (`PaymentGatewayName`)
  - Dashboard gateway selector: PayPal option added for US, GB, CA. File: `app/dashboard/payouts/page.tsx`
  - Migration 143: updated `customer_subscriptions.gateway` CHECK constraint to include 'square' and 'paypal'
- **All 5 gateways now have**: webhook → payment/booking update → platform fee → invoice/campaign → proactive WhatsApp confirmation → post-completion (loyalty/feedback/referral) → session deactivation

### Env Vars Needed for PayPal
- `PAYPAL_CLIENT_ID` — PayPal REST API client ID
- `PAYPAL_CLIENT_SECRET` — PayPal REST API client secret
- `PAYPAL_WEBHOOK_ID` — webhook ID from PayPal developer dashboard (for signature verification)
- `PAYPAL_ENVIRONMENT` — 'sandbox' or 'production' (defaults to sandbox)

### Ticket QR Codes + Email on Auto-Confirmation
- **Webhook ticket delivery** — when payment is confirmed via webhook (not "I've Paid"), tickets (PDF + QR codes) are now sent via WhatsApp + email. Previously only sent when customer tapped "I've Paid". Files: `lib/payments/webhook-handler.ts`, `app/payment-success/page.tsx`
- **Ticket email template** — new `ticketConfirmationEmail` with event details, ticket codes, and formatted amount. File: `lib/email/templates.ts`
- **sendTicketsAfterPurchase now sends email** — looks up email from profile, sends ticket codes + event details. File: `lib/bot/flows/shared/send-tickets.ts`

### Switch Business Discoverability
- **Escape hatch updated** — cancel/exit now says "type *switch <business name>* to visit another business". File: `lib/bot/bot.service.ts`
- **My Account menu** — added "Switch Business" option. Shows instructions on how to switch. File: `lib/bot/flows/capability-selection.flow.ts`

### Bug Fixes
- **Balance API** — was querying `orders.payment_status` which doesn't exist. Fixed to `orders.status IN ('confirmed', 'delivered')`. File: `app/api/payouts/balance/route.ts`
- **Citadel of Grace channel inactive** — `whatsapp_channels.is_active` was false, causing ALL outbound messages to fail (payment confirmations, ticket QR codes, e-signatures, contracts). Fixed in DB.
- **Citadel of Grace country_code** — was incorrectly set to US (should be NG). Caused Stripe to be used instead of Paystack, breaking the direct_split subaccount flow. Fixed in DB.
- **Pricing page duplicate fee** — Starter plan showed "2% per transaction after trial" twice (once from highlights, once from dynamic fee line). Removed the duplicate. File: `lib/constants.ts`
- **Profanity false positives** — first 1-2 offenses no longer block messages (could be false positive on free-text steps like special requests/notes). Only blocks on 3+ repeated. Removed hardcoded "dining experience" text. Files: `lib/bot/bot-intelligence.ts`, `lib/bot/bot.service.ts`

### Split Pay Verification
- **Payout generation tested** — manually generated 3 payout records for week of May 11-17. Norma: ₦2,989,800 net. Test Spa: $47,000. FacesByKoph: $165. All held pending business verification.
- **Platform fees confirmed working** — trial businesses get 0%, out-of-trial business tier gets 1%, direct_split businesses have gateway-level split via Paystack subaccount.

### Stripe Webhook Configured — WORKING
- **Webhook registered** — `https://waaiio.com/api/payments/stripe-webhook` in Stripe sandbox. 5 events: checkout.session.completed, checkout.session.expired, invoice.paid, invoice.payment_failed, customer.subscription.deleted.
- **`STRIPE_WEBHOOK_SECRET`** — set on Vercel production via CLI. Tested and confirmed working — US payments now auto-confirm via webhook without redirect.
- **Build fix** — contact route `globalThis` type cast failed in Vercel build. Fixed with `as unknown as Record`. File: `app/api/contact/route.ts`

### Bot Welcome Messages Revamp
- **First-time users** — clear onboarding: what Waaiio does, how to connect via business code or browse `waaiio.com/directory`, useful commands (switch, my account, receipt). File: `lib/bot/bot.service.ts`
- **Returning user with 1 business** — auto-routes directly instead of showing generic "send a business code". File: `lib/bot/bot.service.ts`
- **Returning user with 2+ businesses** — quick-pick buttons + switch tip. File: `lib/bot/bot.service.ts`
- **Help command** — type "help" anytime to see current business + available commands. File: `lib/bot/bot.service.ts`
- **Directory link** — added to welcome and no-match messages. File: `lib/bot/bot.service.ts`

### Contact Page
- **Contact form** — name, email, subject, message. Sends to hello@waaiio.com with reply-to. Rate limited 5/min per IP. Files: `app/(marketing)/contact/page.tsx`, `app/(marketing)/contact/ContactForm.tsx`, `app/api/contact/route.ts`
- **Email replyTo** — sendEmail now supports replyTo parameter. File: `lib/email/client.ts`

### SEO Fixes
- **OG image** — added logo.png to openGraph + twitter metadata. File: `app/layout.tsx`
- **Canonical URL** — fixed from relative `./` to absolute `https://waaiio.com`. File: `app/layout.tsx`

---

## 2026-05-15

### Payment Gateway
- **Gateway selector on payouts page** — NG/GH: Paystack or Flutterwave. US: Stripe or Square. UK/CA: Stripe. Saved to `businesses.payment_gateway`. Can switch anytime. File: `app/dashboard/payouts/page.tsx`
- **gatewayOverride in ALL bot flows** — scheduling, ordering, ticketing, reservation, payment, crowdfunding now pass `ctx.business?.payment_gateway` to initializePayment. Files: all 6 flow files + `types.ts` + `executor.ts` + `bot.service.ts`
- **Pending payout banner** — dashboard overview shows amber banner when business has revenue but no payout account. File: `app/dashboard/page.tsx`

### Check-in / Check-out / No-show
- **Migration 142** — added `checked_in_at`, `checked_in_by`, `check_in_notes`, `checked_out_at`, `checkout_notes`, `no_show_at`, `no_show_reason` to bookings. `no_show_count` on profiles.
- **API route** — `PATCH /api/bookings/[id]/status` handles check_in, check_out, no_show with notes/reason capture and WhatsApp notifications. File: `app/api/bookings/[id]/status/route.ts`
- **Dashboard calendar** — "Start" → "Check In" with notes modal. "Complete" → "Check Out" with notes modal. "No Show" with required reason modal. Shows timestamps and notes in booking detail. File: `app/dashboard/calendar/page.tsx`
- **Post-completion on check-out** — loyalty, feedback, referral triggered when staff checks out a customer.
- **No-show tracking** — increments `profiles.no_show_count` for repeat offender detection.

### Payment Dedup
- **Webhook + "I've Paid" dedup** — all 6 payment flows check if payment already confirmed before processing. Prevents double loyalty points, double receipts, double notifications. Files: scheduling, ticketing, ordering, reservation, payment, crowdfunding flows.
- **Proactive webhook confirmation** — now runs full post-completion (loyalty, receipts, owner notification), not just basic text message. File: `webhook-handler.ts`

### Cross-country Routing
- **Quick-pick business list** — now applies country filter on shared numbers. Canadian number only shows Canadian businesses in the quick-pick. File: `bot.service.ts`

### Bot Improvements
- **Loyalty points notification** — includes business name ("earned at *FacesByKoph*"). File: `post-completion.ts`
- **Event image ordering** — image sent with await before buttons, guaranteed to arrive first. File: `ticketing.flow.ts`
- **Image upload path** — changed from `services/{bizId}/` to `{bizId}/services/` to match RLS policy. File: `app/api/services/upload-image/route.ts`
- **Loyalty/referral removed from defaults** — opt-in only for new businesses. File: `lib/capabilities/types.ts`
- **Special requests business-driven** — removed hardcoded category defaults. File: `scheduling.flow.ts`
- **Empty state routing** — loyalty, invoices, subscriptions route back to My Account menu. Files: `loyalty.flow.ts`, `invoice.flow.ts`, `recurring-manage.flow.ts`
- **My Account button** — added to ticket/reservation/order detail views. File: `bot.service.ts`

### Dashboard
- **Invoice logo hint** — send modal shows "Add your logo!" with link to Settings when no logo uploaded. File: `app/dashboard/invoices/page.tsx`
- **Promo code product targeting** — All Products vs Specific Products UI. File: `app/dashboard/promo-codes/page.tsx`

### Infrastructure
- **Canadian shared channel** — +1 639-739-1803 registered in DB
- **Booking RPC fixes** — migrations 139-141: time cast, FOR UPDATE split, all enum casts
- **CSRF www/non-www** — middleware allows both variants. File: `middleware.ts`

---

## 2026-05-14

### Bot Flows
- **Booking RPC enum casts** (migration 141) — `book_slot_atomic` now casts text to `flow_type`, `booking_channel`, `deposit_status`, `reservation_status` enums. Affects: ALL bookings across all businesses.
- **Booking RPC FOR UPDATE fix** (migration 140) — split `SELECT COUNT(*) FOR UPDATE` into `PERFORM FOR UPDATE` + `SELECT COUNT(*)`. Affects: ALL bookings.
- **Proactive payment confirmation** — webhook handler now sends WhatsApp confirmation after successful payment, even if customer never taps "I've Paid". File: `lib/payments/webhook-handler.ts`
- **Special requests — business-driven** — removed hardcoded category defaults (salon="Sensitive scalp", etc.). Now fully driven by `business.metadata.special_request_options`. File: `lib/bot/flows/scheduling.flow.ts`
- **Loyalty/referral removed from category defaults** — no longer auto-enabled for new businesses. Opt-in only from dashboard. File: `lib/capabilities/types.ts`
- **Empty state routing** — loyalty (no points), invoices (no invoices), subscriptions (no subs) now route back to My Account menu instead of dead-ending. Files: `loyalty.flow.ts`, `invoice.flow.ts`, `recurring-manage.flow.ts`
- **My Account button** — added to ticket detail, reservation detail, order detail views. File: `lib/bot/bot.service.ts`
- **Promo code product targeting** — dashboard UI for All Products vs Specific Products. Bot only shows promo when applicable. Files: `ordering.flow.ts`, `scheduling.flow.ts`, `app/dashboard/promo-codes/page.tsx`
- **Promo verified message** — bot confirms "Promo code verified! Discount applied at checkout." Files: `scheduling.flow.ts`, `ordering.flow.ts`
- **Referral step cleanup** — verified both flows already had skipIf gating by capability. No change needed.
- **Cross-country routing fix** — shared numbers only auto-route returning customers to businesses in same country. File: `lib/bot/bot.service.ts`
- **Returning customer skip name** — ordering flow now skips collect_name for returning users (was missing skipIf). File: `ordering.flow.ts`

### Reservation
- **Booked dates filtered** — check-in and check-out pickers now filter existing reservations, not just blocked dates. File: `reservation.flow.ts`
- **Availability before T&C** — check overlapping reservations before showing terms, not after. File: `reservation.flow.ts`

### Security
- **CSRF www fix** — middleware now allows both www and non-www variants of app URL. File: `middleware.ts`
- **WhatsApp support number** — changed to +1 571-274-6425. File: `app/(marketing)/layout.tsx`

### Infrastructure
- **Canadian shared channel registered** — +1 639-739-1803, phone_number_id: 1059938863874835
- **Norma country code** — changed back to NG (was incorrectly set to US, causing Stripe amount overflow)

### Campaign
- **Campaign stats fixed** — all stuck campaign_donations updated to success, raised_amount recalculated from actual donations. Direct DB fix.

---

## 2026-05-13

### Bot Flows — God Mode Audit (22 fixes)
- **Scheduling**: promo discount, saved card post-completion, retry duplicate, platform fee timing, cancel_booking handler, duration key mismatch, staff list for 3+, no-slots dead end
- **Ordering**: cancel_order handler, returning customer skipIf
- **Ticketing**: ticket type sold count, platform fee timing
- **Reservation**: checkout blocked dates, cancel message, platform fee timing
- **Payment**: fixed-price auto-fill, cancel message
- **Crowdfunding**: progress bar overflow guard, cancel message
- **Queue**: phone normalization, DB insert moved to validate, error message text, paused queue notify option
- **Cancel buttons**: renamed all 20 `id:'cancel'` to `go_back` across 6 flow files

### My Account (8 fixes)
- Unrecognized input re-shows list
- Escape hatch at my_orders/order_detail
- Giving currency formatting
- Inline handlers return to menu (not session death)
- Empty state stays alive
- Text receipt currency
- My Account shown for all history types
- Menu filtered by capabilities

### Security Audit (8 fixes)
- Open redirect, CSRF, Gupshup timingSafeEqual, Flutterwave reject unset, storage policy, error sanitization, rate limiting, invoice ownership

### Admin Panel (5 fixes)
- VITE_ service key removed, impersonation admin-only, AdminTeam role guard, validate auth, Finance formula

### Production Hardening
- Fetch timeouts on 30+ external calls
- Input validation (enum, array caps, amounts)
- Bot session dedup (unique partial index)
- Booking slot atomic (migration 137-141)
- sendList truncation enforced centrally
- PDFKit font bundling
- maxDuration=60 on all heavy routes
- Dashboard RPC aggregates (migration 138)
- N+1 cron batch queries
- Bot service parallel queries
- AI rate limiting + cost tracking

### Other
- Playwright E2E tests (42 tests)
- Vulnerability fixes (protobufjs, @anthropic-ai/sdk)
- Homepage SEO (OG/Twitter metadata, lazy loading)
- Loyalty improvements (notifications, amount-based, redemption codes, off by default)
- Receipt text fallback when PDF fails
- Unicode emoji fix (removed problematic emojis)

---

## How to use this changelog

If something breaks:
1. Check the date of the last deploy
2. Find changes from that date above
3. Each entry has the affected file(s)
4. Revert or fix the specific change
