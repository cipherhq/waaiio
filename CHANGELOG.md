# Changelog

All notable bot flow, security, and infrastructure changes are tracked here.
If something breaks, check this log to find what changed and when.

---

## 2026-07-19

### Phase 1 Close-out: Payment Routing & Connection Safety

- **A: OAuth replay safety** — Replaced platform_settings-based OAuth nonce storage with dedicated `oauth_states` table (migration 288). Consumption is now truly atomic via `consume_oauth_state` RPC (UPDATE...WHERE consumed=false RETURNING). Concurrent test proves exactly one consumer wins. `consumeOAuthState()` now returns the full stored payload (user, business, provider, account bindings) instead of boolean. Stripe callback validates provider mismatch and propagates DB errors. Files: `lib/payments/oauth-state.ts`, `app/api/payouts/stripe-callback/route.ts`, migration 288.
- **B: Authoritative routing** — Retired `gatewayOverride` parameter from `initializePayment()`. The resolver (`resolvePaymentRoute`) is now the sole authority for gateway selection. Removed `gatewayOverride` from all 13 callers (6 bot flows, 7 API routes). Added `is_active=true` filter to resolver query. Added provider-identifier fallback: managed connections without subaccount_code/stripe_account_id, connect without stripe_account_id, and flutterwave_mid without flutterwave_mid all safely fall back to platform with warning. Files: `lib/bot/flows/shared/payment.ts`, `lib/payments/route-resolver.ts`, all flow files, all payment API routes.
- **C: All payment boundaries** — `pay-link/pay` now routes through the shared `initializePayment` (removes duplicate payment INSERT that gateway also creates). `recurring/setup` now uses `resolvePaymentRoute` for provider selection instead of hardcoded country check. Recurring subscriptions explicitly use platform collection mode (connected-provider recurring is Phase 2). Files: `app/api/pay-link/pay/route.ts`, `app/api/recurring/setup/route.ts`.
- **D: Verification routing** — `verifyPayment()` now looks up the stored payment record's gateway instead of using the country default. For BYO payments, retrieves the merchant's decrypted credentials via the stored `payout_account_id`. Falls back to country default only if no payment record found. File: `lib/bot/flows/shared/payment.ts`.
- **E: Persist route identity** — All 5 gateway implementations (Stripe, Paystack, Flutterwave, Square, PayPal) + charge-saved now persist `collection_mode`, `fee_bearer`, `payout_account_id`, and `waaiio_fee` on every payment INSERT (both mock and production paths). Added `feeBearerMode`, `payoutAccountId`, `waaiioFee` to `InitPaymentOpts`. Files: all gateway files in `lib/payments/`, `lib/payments/types.ts`.
- **F: Sensitive-field authorization** — Created trigger `trg_payout_accounts_sensitive_fields` (migration 289) that blocks browser/authenticated clients from modifying `is_default`, `connection_status`, `connection_mode`, `health_status`, `verified_at`, `last_health_check_at`. Only service_role bypasses (for RPCs and admin routes). Addresses the gap where migration 285 had comments but no enforcement SQL.
- **G: Runtime tests** — New test file `lib/__tests__/payment-phase1-closeout.test.ts` covers: concurrent OAuth consumption (5 parallel, exactly 1 wins), expired OAuth rejection, resolver route winning (no gatewayOverride), inactive default fallback, missing provider ID fallback, BYO fee fields passed through, verification using stored gateway, Paystack outbound bearer=subaccount payload. Updated existing invariant tests for new `consumeOAuthState` return type.

**Could break:** Code that passes `gatewayOverride` to `initializePayment` will get a TypeScript error (parameter removed). Code that reads `consumed` as boolean from `consumeOAuthState` needs to check for null instead. `platform_settings`-based OAuth state rows will be orphaned (new states use `oauth_states` table).

---

## 2026-07-16

### Pre-Launch Finance Safety Hardening
- `app/api/admin/fee-invoices/[id]/route.ts` — **NEW** Server API for fee invoice mark-paid and waive actions with compare-and-set guards, mandatory audit logging, and audit-failure rollback
- `app/api/admin/payouts/account/route.ts` — **NEW** Server endpoint for payout account details; always returns masked account_number (`****1234`) so full bank numbers never reach the browser
- `admin/src/pages/FeeInvoices.tsx` — Rewired mark-paid and waive handlers from direct `adminDb.update()` to server API calls via `fetch()`. Removed `adminDb` and `logAudit` imports (audit now server-side only)
- `admin/src/pages/Payouts.tsx` — Rewired `loadApproveAccount()` from direct DB query to server API. Added `canApprove` role check (`isFullAdmin`): finance users see the payout list read-only but cannot see Approve/Reject buttons or modals. Account number display no longer double-masks (API returns pre-masked value)
- **Affects:** Fee invoice management, payout approval flow, payout account display. Finance role is now read-only on payouts. All fee invoice mutations are server-side with audit trail.

### ResellerPayouts: Replace Direct DB Mutations with Server API Calls
- `admin/src/pages/ResellerPayouts.tsx` — Security hardening:
  1. Replaced direct `adminDb.from('reseller_payouts').insert()` with `fetch(POST /api/admin/reseller-payouts)` — server now handles commission calculation, duplicate detection, and audit logging
  2. Replaced direct `adminDb.from('reseller_payouts').update()` with `fetch(PATCH /api/admin/reseller-payouts/[id])` — server now handles state validation, balance verification (mark_paid), and role enforcement
  3. Removed client-side `logAudit()` calls — the server API routes already audit-log all actions
  4. Action type renamed from `'pay'` to `'mark_paid'` to match API contract
  5. Added `getAccessToken()` helper and session expiry handling
  6. Approve/reject buttons already gated to `isFullAdmin` — matches server-side role enforcement (admin-only for approve/reject, admin+finance for mark_paid)
- **Affects:** Reseller payout creation & status changes. All mutations now go through authenticated server routes with proper auth, role checks, balance verification, and duplicate detection. Read-only queries (load data, calculate commission preview) remain as client-side RLS-gated queries.

### Admin UI Confirmation Dialogs & Audit Logging
- `admin/src/pages/Payouts.tsx` — Added `window.confirm()` to approve and reject handlers before API call
- `admin/src/pages/ResellerPayouts.tsx` — Added `window.confirm()` to approve, reject, and mark-as-paid actions
- `admin/src/pages/FeeInvoices.tsx` — Added `window.confirm()` to mark-as-paid and waive handlers
- `app/api/admin/reseller-payouts/[id]/route.ts` — Added `admin_audit_logs` insert after approve/reject/mark_paid status updates
- `app/api/admin/reseller-payouts/route.ts` — Added `admin_audit_logs` insert after payout creation (POST handler)
- **Affects:** All financial admin actions now require explicit confirmation. Reseller payout lifecycle fully audit-logged server-side.

### Payout Approval Idempotency & State Transition Fixes
- `app/api/admin/payouts/[id]/approve/route.ts` — 3 critical fixes:
  1. Removed 'approved' from approvable states (`['pending', 'held']` only) — prevents double-approval triggering duplicate transfers
  2. Added compare-and-set guard on UPDATE (`.in('status', ['pending', 'held'])` + `.maybeSingle()`) — returns 409 if another admin already processed it
  3. Added `gateway_transfer_code` pre-check — rejects if transfer was already initiated (409)
- `app/api/admin/payouts/route.ts` — Finance role access: `requireAdmin()` now accepts both 'admin' and 'finance' roles for GET (list payouts). Approve action remains admin-only.
- `app/api/admin/query/route.ts` — Account number masking: non-admin roles see `****XXXX` for `payout_accounts.account_number`
- **Affects:** Payout approval flow, admin panel payout list, admin query proxy. Prevents concurrent double-disbursement, adds finance role visibility, masks bank details for non-admin roles.

### Discovery/Marketplace Safety Fixes
- `lib/marketplace/search.ts` — 4 fixes:
  1. `discovery_enabled` filter changed from `.or('discovery_enabled.is.null,discovery_enabled.eq.true')` to `.eq('discovery_enabled', true)` — NULL no longer treated as discoverable
  2. Coordinate truthiness fix: `criteria.latitude &&` replaced with `criteria.latitude != null &&` (0 is a valid coordinate)
  3. `criteria.radiusKm &&` replaced with `criteria.radiusKm != null && criteria.radiusKm > 0 &&` (0 is falsy)
  4. `sanitizeFilterValue()` now used for both `category` and `query` params (was using manual regex only, missing PostgREST injection chars)
- `app/(marketing)/directory/page.tsx` — Added `.eq('discovery_enabled', true)` filter to SEO server query (was missing, only checked status/bot_code)
- `app/(marketing)/directory/DirectoryClient.tsx` — 2 fixes:
  1. Country-aware WhatsApp numbers: replaced single `SHARED_WHATSAPP_NUMBER` with `SHARED_WHATSAPP_NUMBERS` record keyed by country code (NG/US/GB/CA/GH)
  2. WhatsApp CTA button hidden when no number is configured for the business's country
- **Affects:** Marketplace search, directory page, WhatsApp CTA links. Prevents non-opted-in businesses from appearing, fixes coordinate 0 bug, adds PostgREST injection protection, routes WhatsApp to correct country number.

### Pre-Launch Finance & Booking Validation Hardening
- `app/api/invoices/route.ts` — 5 new validations:
  1. Percent discount > 100% rejected
  2. Negative total from flat discount rejected (floor check after computation)
  3. Recurring frequency validated against allowlist (weekly/biweekly/monthly/quarterly/yearly)
  4. Line item count capped at 200
  5. Item description length capped at 2000 characters
- `app/api/bookings/public/create/route.ts` — 4 improvements:
  1. Business status check added (`.eq('status', 'active')`) alongside existing `is_active`
  2. Time format regex hardened from `\d{2}:\d{2}` to `([01]\d|2[0-3]):[0-5]\d` (rejects 99:99 etc.)
  3. Date-in-past check now uses business timezone via `Intl.DateTimeFormat` instead of server UTC
  4. Capability check added: requires `scheduling` or `appointment` capability enabled
- **Affects:** Invoice creation, public booking creation. Prevents financial manipulation via oversized discounts, invalid recurring configs, and bookings on businesses without scheduling capability.

### Auto-Payout Financial Integrity Hardening
- `app/api/cron/auto-payout/route.ts` — Added comprehensive DB error handling across all queries and mutations:
  1. Business fetch query now throws on error (exits cron with 500)
  2. All 4 parallel batch queries (existing payouts, platform fees, adjustments, payout accounts) now check errors and throw on failure
  3. Payout insert checks for error/null — logs + Sentry + skips business instead of proceeding to transfer
  4. Adjustment update checks for error — logs inconsistency but does not skip (payout already created)
  5. Both success and failure status updates on Paystack transfer now check for DB errors
  6. Idempotent Paystack transfer: stores `transfer_reference` (payout_{id}) before calling Paystack, sends as `reference` field for dedup
  7. Auto-approve limit no longer silently falls back to US/1000 for unknown countries — logs warning and defaults to 0 (forces manual review)
  8. Added revenue comment clarifying `transaction_amount` is the fee-base amount from successful payments only
- **Affects:** All weekly auto-payout runs. Prevents silent money transfer on failed DB inserts, prevents duplicate Paystack transfers on retry, forces manual review for unconfigured countries.

### Package Session Deduction Safety Hardening
- `supabase/migrations/247_package_session_deduction_safety.sql` — Replaces 1-param RPC with fully atomic 4-param `deduct_package_session(business_id, phone, service_id, booking_id)`. Enrollment lookup + row lock + deduction + replay protection all in one transaction. Creates `package_session_log` table with UNIQUE(enrollment_id, booking_id) to prevent double-deductions on webhook replay. RPC revoked from public/anon/authenticated, granted only to service_role.
- `lib/payments/process-success.ts` — Simplified `deductPackageSession()` to call the new atomic RPC directly (no client-side enrollment lookup). Adds Sentry error capture. Internal try/catch so the function never throws.
- **Affects:** All booking payment confirmations that trigger package session deduction. Fixes race condition where concurrent webhooks could double-deduct. Fixes replay vulnerability. No breaking changes to callers.

### Auto-Deduct Package Sessions on Booking Confirmation
- `supabase/migrations/246_deduct_package_session_rpc.sql` — New SECURITY DEFINER RPC `deduct_package_session(p_enrollment_id)`. Atomically increments `sessions_used` only if `sessions_used < sessions_total`, `is_active = true`, and `expires_at > NOW()`. Returns boolean.
- `lib/payments/process-success.ts` — Added `deductPackageSession()` function. After booking confirmation, looks up the customer's active package enrollment (by business_id, guest_phone, service_id match in `service_packages.service_ids`). Uses soonest-expiring-first strategy. Calls RPC for atomic deduction. Non-blocking (errors caught and logged, never fails payment confirmation).
- **Affects:** All booking confirmations via payment webhooks. Package enrollments now auto-decrement when a covered service is booked and paid for. No manual session tracking needed.

### JSON-LD Structured Data for Event and Property Public Pages
- `app/e/[slug]/page.tsx` — Enhanced existing JSON-LD with: combined date+time for startDate/endDate (ISO 8601), eventStatus, eventAttendanceMode, organizer URL, location address, per-ticket-type offers array with availability and URL. Uses `getCurrencyCode()` instead of inline currencyMap.
- `app/property/[id]/page.tsx` — Added new JSON-LD `LodgingBusiness` schema with: name, description, image, address (PostalAddress), numberOfRooms, offer with price/currency/unitCode, brand organization link.
- **Affects:** SEO and AI discoverability for public event and property pages. No visual or functional changes.

### Auto-Upgrade Membership Tier on Spend Threshold
- `supabase/migrations/245_auto_upgrade_membership_tier.sql` — New BEFORE UPDATE trigger on `customer_profiles.total_spent`. When total_spent increases, finds the highest qualifying `membership_tiers` row (by min_spend) and upgrades the customer. Never downgrades. Handles NULL tier (new customers), businesses with no tiers (no-op), and same-tier (no-op). SECURITY DEFINER. Sets `tier_earned_at` on upgrade.
- **Affects:** Any code path that updates `customer_profiles.total_spent` (migration 165 `increment_customer_visit` RPC, any direct UPDATE). Membership tier changes are now automatic — no application-level code needed.

### Field-Level Server-Side Validation on Critical API Routes
- `app/api/bookings/public/create/route.ts` — Added UUID validation on serviceId, guestName max 200 chars, quantity positive integer with bounds (1-50), structured field-level error responses.
- `app/api/invoices/route.ts` — Added UUID validation on business_id, customer_name max 200 chars, per-item validation (description required, quantity positive, unit_price non-negative), due_date format, tax_rate 0-100 range, discount_value non-negative.
- `app/api/products/bulk/route.ts` — Added UUID validation on business_id, array type and emptiness checks with structured errors.
- `app/api/events/purchase/route.ts` — Added UUID validation on ticketTypeId, guestName max 200 chars, consolidated email/quantity validation with field-specific error messages.
- All routes now return `{ error: 'Validation failed', fields: { fieldName: 'message' } }` on 400 for client-friendly error handling.
- **Affects:** All public booking/purchase flows, invoice creation, bulk product import. No breaking changes — existing valid requests pass through unchanged.

### Pre-Launch Hardening: Ace AI Copilot (Critical Fix)
- `app/api/copilot/query/route.ts` — **Complete rewrite.** Fixed 10 bugs: bookings used `created_at` instead of `date` column; revenue had no currency; week/month used rolling days not calendar; no business timezone; unpaid included cancelled; top products had wrong column filter and showed no names; used nonexistent `payment_status` column.
- `lib/copilot/classify-intent.ts` — New file. Extracted intent classifier (20 report types, was 6). Supports: bookings (today/upcoming/week/month), orders (today/pending), revenue (today/week/month/compare), unpaid (bookings/invoices), top products, top services, new/returning customers, cancellation rate, check-ins, low stock, attention items.
- `components/dashboard/Copilot.tsx` — Honest UI ("Quick answers about..." not "Ask anything"), capability-aware quick questions, follow-up context, auto-scroll, mobile responsive, whitespace-pre-line.
- Role-based permissions: staff/support blocked from financial reports via `business_members` table.
- **Tests:** 49 new intent classification tests in `lib/copilot/__tests__/classify-intent.test.ts`.
- **Affects:** All dashboard copilot users. Team members can now access copilot with role-appropriate restrictions.

### Pre-Launch Hardening: Remove Hardcoded WhatsApp Fallbacks (Critical)
- `lib/support-contact.ts` — New centralized helper. `getSupportWhatsAppNumber()` and `getSupportWhatsAppLink()` read from `NEXT_PUBLIC_WHATSAPP_NUMBER_{country}` env vars. Returns empty string if not configured (safe).
- Removed hardcoded `12029226251` from 11 files: Footer, layout, HomeClient, contact, directory, OnboardingWizard, StepAuth, dashboard page, support page, whatsapp connect, ReturnToWhatsApp.
- `app/api/onboarding/subscribe/route.ts` — Uses `FALLBACK_EMAIL_DOMAIN` env var.
- **Production requirement:** Set `NEXT_PUBLIC_WHATSAPP_NUMBER_US` in Vercel.
- **Affects:** All marketing pages, onboarding, dashboard. WhatsApp buttons hidden if env var not set.

### Pre-Launch Hardening: Dashboard Capability Gating (Security)
- Added `useRequireCapability()` to 14 dashboard pages that were missing it. Users could bypass sidebar hiding by navigating directly to URLs like `/dashboard/invoices`.
- Pages gated: invoices, properties (3 pages), forms, surveys, packages, locations, waivers, staff, team, contracts, reports, campaigns.
- Redirects to `/dashboard/capabilities?upgrade={cap}` if capability missing.
- **Affects:** All growth/business-tier feature pages. Free-tier pages unchanged.

### Pre-Launch Hardening: API Capability Checks (Security)
- `lib/api-auth.ts` — Extended `authenticateRequest` with `requireCapability` option.
- Added capability verification to 12 POST API routes: invoices, broadcasts, surveys, packages, locations, waivers, contracts, staff, reports, campaigns, loyalty, referrals.
- Returns 403 with clear error if capability not enabled.
- **Affects:** All tier-gated API mutations. Prevents feature bleed via direct API calls.

### Pre-Launch Hardening: Dashboard Finance Timezone Fix
- `app/dashboard/financials/page.tsx` — Monthly revenue chart and date filters now use business timezone via `Intl.DateTimeFormat`. Was using UTC, causing late-night transactions to appear in wrong month.
- `app/dashboard/payouts/history/page.tsx` — Monthly totals and chart buckets now use business timezone.
- **Affects:** Financials and payout history for businesses in non-UTC timezones.

### Pre-Launch Hardening: Auto-Approve Limits Admin-Configurable
- `lib/platformSettings.ts` — Added `auto_approve_limits` to PlatformSettings interface and loader.
- `app/api/cron/auto-payout/route.ts` — Replaced hardcoded `AUTO_APPROVE_LIMIT_NGN`/`AUTO_APPROVE_LIMIT_USD` with `settings.auto_approve_limits[countryCode]`.
- `supabase/migrations/244_auto_approve_limits_setting.sql` — Seeds per-country limits in `platform_settings`.
- **Affects:** Auto-payout cron. Admin can now adjust limits via PlatformSettings page.

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
