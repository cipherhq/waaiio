# Changelog

All notable bot flow, security, and infrastructure changes are tracked here.
If something breaks, check this log to find what changed and when.

---

## 2026-08-07

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
