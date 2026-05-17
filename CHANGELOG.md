# Changelog

All notable bot flow, security, and infrastructure changes are tracked here.
If something breaks, check this log to find what changed and when.

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

### Replace raw tel inputs with shared PhoneInput component
- **8 dashboard pages updated**: invoices, staff, locations, events/invites, parties, payment-request, settings, whatsapp/connect
- Replaced raw `<input type="tel">` with `<PhoneInput>` component (`components/auth/PhoneInput.tsx`) — adds country flag selector, dialing code, digit validation
- **Contracts edit modal bug fix**: when editing a signer phone (e.g. +15712746425), the country dropdown now correctly detects US from the `+1` prefix instead of defaulting to NG. Added `detectCountryFromPhone()` helper. Also added `countryCode` prop to all 4 PhoneInput instances in the contracts create modal.
- **Payment request page**: separated customer search (text input with autocomplete) from phone entry (PhoneInput) — autocomplete dropdown preserved above the PhoneInput
- Cleaned up unused `getPhonePlaceholder` imports from invoices, staff, locations pages
- **Impact**: All phone inputs now have consistent UX with country-aware formatting. Build passes.
- **Could break**: Pages that read phone values before PhoneInput returns E.164 (only returns value when all digits filled). Payment request autocomplete UX slightly changed (search is now separate from phone entry).

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
