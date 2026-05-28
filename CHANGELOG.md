# Changelog

All notable bot flow, security, and infrastructure changes are tracked here.
If something breaks, check this log to find what changed and when.

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
