Warning: truncated output (original token count: 139500)
Total output lines: 4832

# Changelog

All notable bot flow, security, and infrastructure changes are tracked here.
If something breaks, check this log to find what changed and when.

## 2026-10-03 — Paystack saved-card persistence (#530)

### What changed
- Paystack verify results and signed `charge.success` webhooks now normalize reusable authorization metadata. The shared persistence RPC atomically enriches the canonical platform payment before Save Card confirmation; completed webhook replays can add authorization metadata without replaying payment effects.
- Migration 427 repairs missing `service_role` CRUD grants on `saved_payment_methods` while retaining RLS and denying client-role access on the repair path. It adds a service-only RPC that validates provider, amount, currency, status, and platform origin, and allows only card metadata fields. A production-shaped table ACL with existing service-role SELECT is left unchanged; production client grants remain a separate hardening task.
- CI now runs M427 PostgreSQL ACL and persistence checks with the M426 database tests.

### What could break
- BYO/Connect Paystack payments remain ineligible for saved-card persistence under the accepted platform-origin policy. Persistence failures do not block successful payment confirmation.

## 2026-10-03 — M426 staging payment setup parity (#527)

### What changed
- **M426: `business_payment_credentials` restore + least-privilege ACLs** (`supabase/migrations/426_staging_payment_setup_parity.sql`) — Creates the table only if missing (staging), with the complete column contract, the gateway / connection_type / `chk_credentials_mode` CHECKs, and the `idx_bpc_active` partial unique index. RLS on; a single owner policy `bpc_owner_select` (SELECT only, `owner_id = auth.uid()`). Grants: service_role SELECT/INSERT/UPDATE (no DELETE); authenticated column-level SELECT on 9 non-secret metadata columns (never `secret_key` / `public_key`, no writes); anon nothing.
- **M426: bot sequence access matrix** — service_role SELECT on `bot_sequences` + `bot_sequence_steps`, SELECT/INSERT/UPDATE on `bot_sequence_enrollments`; authenticated SELECT/INSERT/UPDATE/DELETE on `bot_sequences` + `bot_sequence_steps`, SELECT on enrollments. Existing M040 RLS policies unchanged.
- **M426: golden payment journey grants** — service_role SELECT/INSERT on `platform_fees` (fee insert + verify-read in `process-success.ts` / `shared/payment.ts`); service_role SELECT on `payment_confirmation_deliveries` (status read in `send-confirmation.ts`; writes stay behind the M342 SECURITY DEFINER RPCs).
- No blanket or default-privilege grants. Every grant is additive; on a production-shaped database the migration is a no-op (proved by test). Self-verification block fails the migration if any positive or negative privilege is wrong.
- **Tests** (`lib/__tests__/staging-payment-parity-527-db.test.ts`) — 57 role-faithful PostgreSQL tests (`SET ROLE` service_role / authenticated / anon with JWT claims) driving the real classifier, routing authority, and `triggerSequences` code: privilege matrix, schema constraints, credential classification (empty/platform, subaccount, Connect, BYO, ambiguous, inactive), owner positive and cross-tenant negative paths, anon denial, sequence runtime + dashboard, fee + confirmation reads, idempotency, and RED baselines.
- **CI** (`.github/workflows/ci.yml`) — New migration-shard-b step "M426 staging payment setup parity DB tests" on a dedicated database; zero skips enforced.

### What could break
- Any authenticated client that selects `*`, `secret_key`, or `public_key` from `business_payment_credentials` now gets 42501. No current caller does (the settings GET route selects explicit metadata columns; all secret reads use the service client).
- Any service-role code path that DELETEs credentials, sequences, steps, enrollments, or platform_fees, or writes `payment_confirmation_deliveries` directly, gets 42501. No current golden-journey caller does; admin/cron/reseller platform_fees paths are out of scope (systemic ACL reconciliation follow-up).
- Not included: `fee_policy_enabled` staging config (separate canonical commercial-config gate), `saved_payment_methods`, production ACL hardening.

## 2026-10-02 — M425 export_rate_limits ACL normalization (#313)

### What changed
- **M425: `export_rate_limits` service_role ACL normalization** — Revokes all table privileges from service_role then re-grants exactly SELECT/INSERT/UPDATE. Closes residual DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN inherited from production's ALTER Default Privileges. 12-check migration verification (PG17-gated MAINTAIN check). No application code, RLS policy, or data changes.
- **Tests** (`lib/__tests__/issue-509-security-reconciliation.test.ts`) — 12 DB contract tests: proves service_role has exactly SELECT/INSERT/UPDATE, no DELETE/TRUNCATE/REFERENCES/TRIGGER, PG17-gated MAINTAIN = false, anon/authenticated retain no access, RLS enabled, service-only policy intact.

### What could break
- Nothing — service_role retains SELECT/INSERT/UPDATE (the only operations the export route uses). No application code references DELETE on this table.

## 2026-10-02 — M422 capability_overrides client correction (#313)

### What changed
- **`app/api/capabilities/configure/route.ts`** — Override read moved from authenticated client to service client. Business ownership still verified via authenticated client before the override read. Required because M422 revokes authenticated table-level SELECT on `capability_overrides`.
- **`app/dashboard/layout.tsx`** — Both impersonation and normal-flow override reads moved from authenticated client to service client. Admin impersonation and business ownership authorization unchanged.
- **Regression tests** (`lib/__tests__/m422-override-client-regression.test.ts`) — 4 tests: verifies service client used for overrides, authenticated client used for ownership, ownership denial short-circuits override read, and override data flows correctly to RPC snapshot.

### What could break
- If `createServiceClient()` is misconfigured or unavailable, override reads fail (fail-closed: returns 500 or empty overrides). Previously this would degrade to authenticated-client read; now it's an explicit failure.
- No other callers affected — all other override reads already use service client (api-guard.ts, bot.service.ts, capability-guard.ts).

## 2026-10-02 — Admin security reconciliation (#509)

### What changed
- **M421: platform_settings security reconciliation** — Grants anon+authenticated SELECT (for RLS reads), revokes INSERT/UPDATE/DELETE from both. Rewrites `admin_all_platform_settings` to target authenticated-only (fixes anon is_admin() execution error). Expands `public_read_config_settings` to 6 keys: adds `signup_open` + `maintenance_mode` (launch blocker fix). Grants service_role INSERT+DELETE for server routes.
- **M422: capability_overrides security reconciliation** — Revokes ALL from anon+authenticated. Replaces production's `capability_overrides_service_all USING(true)` with `USING(auth.role() = 'service_role')`. Retains service_role SELECT only per M419 contract.
- **M423: OTP challenges channel support** — Adds `channel varchar(16)` column (default 'phone') to `phone_otp_challenges`. Enables email and recurring OTP to reuse the secure challenge pattern.
- **M424: export_rate_limits table** — Moves `export:{userId}` ephemeral state out of `platform_settings` into a dedicated table with service_role-only access.
- **Admin platform-settings server API** (`app/api/admin/platform-settings/route.ts`) — Server-authorized CRUD for non-commercial settings. Uses `requirePlatformAdmin` + `createServiceClient`. Commercial keys rejected (must use `save_commercial_config` RPC).
- **PlatformSettings.tsx refactor** — Non-commercial key writes now route through the server API instead of direct browser `adminDb` writes. Commercial keys unchanged (still use RPC).
- **OTP migration** (`lib/otp-challenge.ts`) — Email and recurring OTP now use `phone_otp_challenges` table with HMAC-hashed storage, atomic consume via SECURITY DEFINER RPC, and 5-attempt lockout. Replaces plaintext `platform_settings` storage.
- **Email-otp + recurring/verify route updates** — Both routes now return `challengeId` on send and require it on verify. Client callers (BookingForm, EventPurchaseForm, recurring/manage) updated to pass challengeId.
- **Export route update** (`app/api/account/export/route.ts`) — Rate limit check/record uses `export_rate_limits` table instead of `platform_settings`.
- **Tests** (`lib/__tests__/issue-509-security-reconciliation.test.ts`) — 46 tests: DB ACL contract tests for all 4 migrations + route-level mock tests for admin settings API + middleware readability contract.

### What could break
- Admin panel PlatformSettings non-commercial key writes now go through the server API — if the API route is unreachable, saves will fail (previously went direct to DB).
- Email OTP and recurring verify now require `challengeId` in the verify request — any client not passing challengeId will get a 400 error.
- Export rate limit data in `platform_settings` (old `export:{userId}` keys) is orphaned — existing rate limits are effectively reset.

## 2026-10-01 — platform_settings service_role UPDATE grant (#502)

### What changed
- **M420: GRANT UPDATE** (`supabase/migrations/420_platform_settings_service_role_update.sql`) — Grants service_role UPDATE on `platform_settings`. Root cause: `PUT /api/admin/site-announcement` uses `createServiceClient()` to update the `site_announcement` row, but service_role only had SELECT (from M408), not UPDATE. No INSERT/DELETE granted. No authenticated/anon grants. RLS preserved. Includes verification block.
- **Tests** (`lib/__tests__/issue-502-platform-settings-acl.test.ts`) — 7 assertions: 5 DB ACL checks (service_role SELECT/UPDATE, anon no UPDATE, authenticated no UPDATE, RLS enabled) + 2 route-level mock tests (admin PUT succeeds, non-admin PUT denied).
- **CI wiring** (`.github/workflows/ci.yml`) — Added M420 DB test step in shard a, after M419 step.

### What could break
- Nothing. This is a strictly additive privilege grant. The row already exists (seeded in M414). No existing behavior is changed.

## 2026-09-30 — P0 staging post-deploy blockers (#496)

### What changed
- **M417: ACL reconciliation** (`supabase/migrations/417_staging_acl_authenticated_reconciliation.sql`) — Grants authenticated role table-level privileges on 5 tables missing them (parties S/I/U/D, category_templates S, event_tickets S, payment_links S, promo_codes S). Root cause: staging Supabase lacks ALTER DEFAULT PRIVILEGES.
- **M418: Pricing authority fix** (`supabase/migrations/418_fix_activation_pricing_authority.sql`) — `activate_paid_subscription` step 6b now validates payment amount against `subscription.amount` (the checkout-bound immutable quote set when the customer was charged) instead of `config_snapshot.pricing_tiers` which only stores entitlement/fee fields. This eliminates a price-change race between checkout and activation. Preserves SECURITY DEFINER + search_path + grant semantics.
- **QR routing code hardening** (`app/dashboard/qr-code/page.tsx`) — Bot code (routing token) is now read-only on QR page for shared-number businesses. "Pre-filled message" renamed to "WhatsApp routing code". Deep-link suffix auto-set by template selection. Routing token cannot be accidentally removed.
- **Tests** (`lib/__tests__/issue-496-staging-blockers.test.ts`) — 34 assertions for ACL grants, pricing activation, security attributes, country→processor authority, QR routing code, pending-business guards, directory eligibility, category config fallback.
- **Subscribe-now-db test update** (`lib/__tests__/subscribe-now-db.test.ts`) — Test helper aligns NG country pricing with test payment amounts to match M418's pricing source change.

### What could break
- If staging `countries.pricing` for a given country is missing or has NULL `price` for a tier, `activate_paid_subscription` will fail closed with `pricing_config_missing` (this is intentional — the old behavior also failed, just for a different reason).
- QR page no longer allows editing the routing code. Users who were manually customizing the pre-filled message to something other than their bot code will now see the read-only routing code instead. This is a safety improvement.
- Any code that expected `config_snapshot.pricing_tiers` to contain subscription prices should use `countries.pricing` instead.

## 2026-09-30 — Staging launch-readiness (#493)

### What changed
- **S1: Canonical payment gateway resolver** (`lib/payments/gateway-resolver.ts`) — New `resolveBusinessGateway()` and `resolveCountryGateway()` functions. Country is sole processor authority (NG→Paystack, US→Stripe, etc.). BYO/merchant credentials affect account selection only, never processor. Fails closed for unconfigured countries.
- **S1: Register route** (`app/api/onboarding/register/route.ts`) — New businesses now inherit `payment_gateway` from `countries.payment_gateway` at registration time. No hardcoded country/provider mappings.
- **S1: Scan to Pay** (`app/api/pay-link/pay/route.ts`) — Removed silent `|| 'paystack'` fallback. Uses canonical resolver. Returns 503 when no gateway is configured instead of misrouting.
- **S2: Paystack activation recovery** (`app/api/cron/subscription-renewal-recovery/route.ts`) — Added `processPaystackActivationRecovery` inside the renewal-recovery cron. Finds stuck `subscription_payments` with `status='success'` for `pending` subscriptions and replays `activate_paid_subscription` RPC + business status CAS transition.
- **S3: Admin launch-subscriber** (`admin/src/pages/LaunchSubscribers.tsx`, `app/api/admin/query/route.ts`) — Switched from direct `adminDb` query to server-side `adminApiFetch('/api/admin/query')`. Added `launch_subscribers` to ADMIN_TABLES whitelist. No broad `authenticated` grant.
- **S4: Party create** (`app/dashboard/parties/page.tsx`) — Insert/update errors now destructured and surfaced via `statusMessage`. Success only shown after confirmed persistence.
- **S5: Services label** (`components/dashboard/Sidebar.tsx`, `app/dashboard/services/page.tsx`) — Sidebar no longer renames "Services" to "Products" when `ordering` capability is active. PageHelp and EmptyState use dynamic `labels.serviceNamePlural`/`labels.serviceName`.
- **Tests** (`lib/__tests__/issue-493-staging-readiness.test.ts`) — Production-path handler tests: gateway country matrix (NG/GH/US/GB/CA), BYO does not change processor, Paystack recovery via extracted module, Poll/Giving/Admin/Scan-to-Pay actual route invocations, pending business guard, reconciliation endpoint.

### What could break
- Businesses registered before this change still have `payment_gateway = NULL`. Use the bounded admin endpoint `POST /api/admin/reconcile-gateways` to backfill from country config (dry-run by default, admin-only).
- Scan to Pay now returns 503 for businesses with NULL gateway (previously silently routed to Paystack). This is intentional — the prior behavior was a bug for non-NG countries.
- Admin launch-subscriber page now goes through `/api/admin/query` server-side. Requires VITE_API_URL configured in admin env.

## 2026-09-30 — Discovery + Settings wiring consistency (#485)

### What changed
- **Fix A: `BusinessTab.tsx`** — PlacesAutocomplete now captures `placeData` (lat/lng) from the second callback arg and persists `latitude`, `longitude`, `city` alongside `address` in handleSave. Manual text edits set lat/lng to null, invalidating stale coordinates.
- **Fix B: `discovery/page.tsx`** — `onManualChange` now sets `latitude: null, longitude: null` in state, preventing stale coordinates from being saved when the address is manually edited.
- **Fix C: All Settings tabs** — 20 save handlers across 7 files now destructure `{ error }` from Supabase/API responses. Success indicators (Saved!/toast) are only shown when there is no error. Handlers that reload immediately (time format) only reload after confirmed success.
- **Fix D: `lib/constants.ts` + discovery/page + marketplace/search** — Added `getDistanceUnit`, `kmToMiles`, `milesToKm`, `kmToDisplayUnit`, `displayUnitToKm`, `formatDistance` helpers. US/UK businesses see miles in the delivery radius UI and search results while retaining canonical km in the database.
- **Fix E: `discovery/page.tsx`** — Discovery description field relabeled to "Short Listing Summary" with helper text. One-time prefill from `businesses.description` on first focus when `discovery_description` is blank.
- **Fix F: `lib/bot/business-knowledge.ts`** — `supportsDelivery` now reads from top-level `biz.supports_delivery` column instead of `metadata.supports_delivery`. `deliveryArea` replaced with `deliveryRadius` reading from `biz.delivery_radius_km`.
- **`lib/__tests__/discovery-settings-wiring-485.test.ts`** — 40 regression tests covering all 6 fixes.

### Files changed
`BusinessTab.tsx`, `discovery/page.tsx`, `FeaturesTab.tsx`, `PaymentsTab.tsx`, `NotificationsTab.tsx`, `AccountTab.tsx`, `IntegrationsTab.tsx`, `lib/constants.ts`, `lib/marketplace/search.ts`, `lib/bot/business-knowledge.ts`

### What could break
- **Businesses with US/UK country_code** will see delivery radius in miles. The underlying DB value (`delivery_radius_km`) is unchanged — only the UI conversion is new. A round-trip precision loss of ~0.1 is possible due to float rounding.
- **Bot delivery responses** now show radius in km instead of the old free-form `deliveryArea` text. If a business had `metadata.delivery_area` set, that string is no longer surfaced (the field was rarely populated).
- **Settings address save** now writes lat/lng/city. If a business edits their address via Settings, coordinates will be set/cleared — this is the intended fix, not a regression.

## 2026-09-29 — Staging launch ACL repair (#478)

### What changed
- **`supabase/migrations/415_staging_launch_acl_repair.sql`:** Least-privilege grants for 34 postgres-only table operations confirmed missing on staging. 25 service_role grants + 9 authenticated grants. Includes route dependency closure — transitive deps (loyalty_transactions, waiver_templates, bookings, bot_sessions, audit_log) are covered. Does NOT grant ALL, anon, PUBLIC, TRUNCATE, TRIGGER, or REFERENCES. Does NOT change RLS or policies. Does NOT duplicate M410/M412/M413/M414 scopes. Does NOT re-grant already-sufficient tables (services, products, product_variants, orders, order_items, appointments, business_capabilities) or tables already owned by other migrations (businesses, whatsapp_channels, profiles, messaging_allowances, platform_settings, refunds).
- **`lib/__tests__/staging-acl-launch-478.test.ts`:** 55 regression tests proving safety invariants, dependency closure completeness, no scope duplication, already-sufficient/owned-elsewhere tables excluded, and every grant maps to an identified code path.

### What could break
- Nothing — GRANT is a no-op if privilege already exists. No existing privileges are modified or revoked.

## 2026-09-29 — Giving page read-only guard during admin impersonation (#472)

### What changed
- **`components/dashboard/DashboardProvider.tsx`:** Added `isImpersonating` boolean to dashboard context. Defaults to `false`. Passed through `DashboardContext.Provider` value.
- **`app/dashboard/layout.tsx`:** Impersonation path now passes `isImpersonating` prop to `DashboardProvider`. Normal (non-impersonation) path omits it (defaults to `false`).
- **`app/dashboard/giving/page.tsx`:** When `isImpersonating` is true: shows amber read-only banner explaining impersonation is view-only; hides Add/Edit/Toggle/Delete controls; disables save button in add/edit form. Normal owner flow unchanged.
- **`app/api/giving/save/route.ts`:** 403 response now includes `message: 'You do not have write access to this business.'` so the UI shows a meaningful error instead of generic "Failed to save."
- **`lib/__tests__/giving-impersonation-472.test.ts`:** 21 tests covering owner create, unauth 401, non-owner 403 with message, recurring/tier guards, isImpersonating context plumbing, UI guard assertions.

### What could break
- Nothing — `isImpersonating` defaults to `false`, so all non-impersonation flows are unchanged. The API ownership check is preserved. The 403 response adds a `message` field but retains the same `reason` and status code.

## 2026-09-29 — Fix promo code staging 500 + API corrections (#473)

### What changed
- **`supabase/migrations/413_promo_codes_service_role_grants.sql`:** Grants SELECT, INSERT, UPDATE, DELETE on `public.promo_codes` to `service_role`. Root cause of staging HTTP 500 — the table (created in migration 021) had RLS policies but zero table-level privileges for `service_role`. Same pattern as events #461/migration 412. Does NOT grant to anon, authenticated, or PUBLIC. Does NOT grant TRUNCATE, TRIGGER, or REFERENCES.
- **`app/api/promo-codes/route.ts`:** Four corrections: (1) All DB error paths now log sanitized error code/message via `console.error` for Vercel observability. (2) PUT handler now accepts both `isActive` (camelCase from list toggle) and `is_active` (snake_case from edit form) — previously the edit form's active toggle was silently ignored. (3) DELETE now checks the Supabase response and returns 500 on failure instead of unconditional success. (4) All bare `catch` blocks replaced with `catch (err)` + logging.
- **`app/dashboard/promo-codes/page.tsx`:** GET/list API errors now set `error=true` and show a retryable error banner instead of silently rendering "No promo codes yet" empty state.
- **`lib/__tests__/promo-codes-api-473.test.ts`:** 41 tests covering migration grants, all CRUD operations, auth/ownership gates, error surfacing, PUT isActive fix, DELETE error handling, and business scoping.
- **`lib/__tests__/console-error-cleanup.test.ts`:** Added `app/api/promo-codes/route.ts` (8 calls) to the server-side console.error allowlist.

### What could break
- Nothing — the GRANT is additive (idempotent no-op if privilege already exists). The API corrections are all backwards-compatible (PUT accepts both key names, error responses use existing status codes). Dashboard change only affects the failure path (success path unchanged).

## 2026-09-29 — Exact-origin Return to WhatsApp (#230/#231)

### What changed
- **`app/payment-success/page.tsx`:** WhatsApp-origin payments now resolve the Return to WhatsApp phone number from `payments.metadata._inbound_channel_id` (the exact channel that originated the transaction) instead of the business-level channel fallback chain. If the exact-origin channel is missing, inactive, or fails cross-tenant validation, the page shows "Please return to your WhatsApp conversation manually" instead of falling back to a potentially wrong number. Non-WhatsApp-origin payments (web, legacy) continue using the existing fallback chain unchanged.
- **`lib/__tests__/return-to-whatsapp-origin-230.test.ts`:** 10 source-analysis tests proving exact-origin resolution, fail-closed behavior, cross-tenant guard, manual return message, no hardcoded phone numbers, and ReturnToWhatsApp component unchanged.

### What could break
- Nothing for non-WhatsApp-origin payments (fallback chain unchanged). WhatsApp-origin payments where `_inbound_channel_id` was not persisted (pre-#219 payments) will now show a manual return message instead of the ReturnToWhatsApp button — this is the correct fail-closed behavior (better than sending to a wrong country's number).

## 2026-09-29 — Event creation ACL + error handling + ticket tier UX (#461)

### What changed
- **`supabase/migrations/412_events_authenticated_grants.sql`:** Grants SELECT, INSERT, UPDATE, DELETE on `events` and `event_ticket_types` to the `authenticated` role. Existing RLS policies enforce authorization. Fixes silent CRUD failures on staging where table-level privileges were missing.
- **`app/dashboard/events/page.tsx`:** All Supabase mutations (insert, update, delete on events and event_ticket_types) now check for errors and surface them via `alert()`. Previously, failures were silently swallowed.
- **`app/dashboard/events/page.tsx`:** Ticket types section now visible during initial event creation (add mode), not just edit mode. Uses a client-side buffer (`pendingTicketTypes`) that flushes after the event is created. Partial tier failure transitions to edit mode with the new event ID for retry.
- **`app/dashboard/events/page.tsx`:** `duplicateEvent` is now async and copies active ticket type definitions (name, price, total_tickets, sort_order, is_active) from the source event. `tickets_sold` always starts at 0. Source-tier load failure is surfaced.
- **`lib/__tests__/events-acl-assertions.test.ts`:** 6 tests verifying migration 412 grants correct privileges and does not over-grant (no anon, no TRUNCATE/TRIGGER/REFERENCES).
- **`lib/__tests__/events-error-handling-tiers.test.ts`:** Tests verifying error handling, pending tier buffer, duplication with complete field copy, partial-failure recovery, and cancel-event API preservation.

### What could break
- If RLS policies on `events` or `event_ticket_types` are missing or misconfigured, the new GRANT would allow authenticated users broader access than intended. Verified: existing RLS policies enforce `business_id = owner_id` isolation.
- `duplicateEvent` is now async; the `onClick` handlers calling it already handle async functions correctly (React event handlers support async).

## 2026-09-29 — Homepage simplification (#452)

### What changed
- **`app/(marketing)/HomeClient.tsx`:** Major rewrite — 17 sections reduced to ~10. Removed: unsourced statistics, fabricated testimonials, quantity-led clutter (89+/30/thousands), 10-card capability wall, problem/fear section, Why Waaiio cards, comparison table, industry showcase, repeated NL examples. Added: dashboard proof grid, compact 5-capability summary. Hero changed to "Your business, running on WhatsApp." with launch CTAs.
- **`app/(marketing)/page.tsx`:** FAQ reduced from 10 to 4 questions. JSON-LD cleaned (removed unverified Meta partnership claims, award, memberOf). Metadata updated. No server-side `platform_settings` read — preserves existing API/component boundary.
- **`components/marketing/Navbar.tsx` + `MobileMenu.tsx`:** CTA changed from "Get Started" → "Get Updates" linking to /launch.
- **Provider truth:** Homepage shows only Stripe + Paystack. Square/Flutterwave/PayPal removed from homepage.
- **Meta wording:** Changed to "Built on WhatsApp Business Platform" — removed "Meta Business Partner", "Official Technology Partner", "Meta Verified Technology Provider".
- **Pricing:** CTAs link to /pricing (Learn More) not /get-started. No new trial duration claims.

### What could break
- SEO: fewer FAQ entries means less indexed Q&A content (but removing low-quality content typically helps)
- Any external links pointing to homepage sections with anchor IDs (comparison, industry showcase) will no longer find those sections

## 2026-09-28 — Launch banner with country selector + WhatsApp QR (#446)

### What changed
- **`components/marketing/SiteAnnouncement.tsx`:** Upgraded `launch_countdown` announcements from a thin header strip to a prominent responsive launch banner with live countdown, country selector, WhatsApp button, and QR code. Non-launch announcements preserve compact behavior.
- **`lib/launch/shared.ts`:** New shared helpers extracted from LaunchClient — `buildWhatsAppLink`, `formatPhone`, `formatLaunchDate`, `detectCountryFromTimezone`, `computeTimeLeft`, `LaunchRegion` type. Used by both SiteAnnouncement and /launch page.
- **`app/(marketing)/launch/LaunchClient.tsx`:** Refactored to import from shared helpers instead of duplicating logic.
- **Country selector:** Uses `/api/launch/regions` (shared channels only). Best…125500 tokens truncated…les, payments, payout_accounts, audit_logs, impersonation_logs, etc. File: `app/api/admin/query/route.ts`

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
