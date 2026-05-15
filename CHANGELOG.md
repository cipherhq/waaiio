# Changelog

All notable bot flow, security, and infrastructure changes are tracked here.
If something breaks, check this log to find what changed and when.

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
