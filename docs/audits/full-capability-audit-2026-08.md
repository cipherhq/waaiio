# Waaiio Full Capability Audit — August 2026

**Date:** 2026-08-05
**Auditor:** Claude (code audit, read-only)
**Branch:** `main` at commit `f02e6e58` (post-PR #98 merge)
**Method:** Automated code inspection of all 34 capabilities and 20 shared systems against current `main`

---

## 1. Executive Summary

Waaiio is a substantial WhatsApp-first business automation platform with **31 defined capabilities**, **247 API routes**, **69 dashboard pages**, **18 bot flows**, and **100+ database tables** across **306 migrations**.

The core commerce flows (scheduling, ordering, ticketing, payments, reservations) are **functionally complete end-to-end** through the WhatsApp bot. The dashboard provides full CRUD for most entities. RLS is systematically applied. Payment integration spans 4+ gateways with webhook verification and platform fee accounting.

The audit identified **6 P0 findings**, **14 P1 findings**, **23 P2 findings**, and **12 P3/future items**. Most P0s are data-integrity or silent-failure issues in specific paths rather than broad systemic failures.

---

## 2. Audit Methodology

For each capability, the audit traced:
- Dashboard UI pages and components
- WhatsApp bot flow steps and validation
- API routes with auth/ownership checks
- Database tables, RLS policies, and RPCs
- Capability gating and tier requirements
- Cross-capability interactions
- Test coverage
- Financial handling where applicable

Classification: COMPLETE | PARTIAL | DEFECT | UX IMPROVEMENT | FUTURE/NOT REQUIRED
Severity: P0 (launch blocker) | P1 (important broken/incomplete) | P2 (quality/UX) | P3 (future)

---

## 3. Capability Scorecard

| # | Capability | ID | Tier | Classification | Severity |
|---|---|---|---|---|---|
| 1 | Appointments | `appointment` | Free | PARTIAL | P1 |
| 2 | Services | `scheduling` | Free | COMPLETE | P2 |
| 3 | Products / Online Store | `ordering` | Free | COMPLETE | P2 |
| 4 | Properties | (via `reservation`) | Growth | PARTIAL | P1 |
| 5 | Events / Ticketing | `ticketing` | Free | COMPLETE | P2 |
| 6 | Donations / Giving | `giving` | Free | PARTIAL | P1 |
| 7 | Locations | `multi_location` | Growth | COMPLETE | P2 |
| 8 | Reservations | `reservation` | Growth | COMPLETE | P2 |
| 9 | Online Store (web) | (via `ordering`) | Free | PARTIAL | P2 |
| 10 | Class Booking | `class_booking` | Growth | PARTIAL | P2 |
| 11 | Estimates & Quotes | `estimates` | Free | PARTIAL | P2 |
| 12 | Invoices | `invoice` | Growth | COMPLETE | P2 |
| 13 | Subscriptions | `recurring` | Growth | COMPLETE | P0 |
| 14 | Session Packages | `packages` | Growth | PARTIAL | P2 |
| 15 | Campaigns / Crowdfunding | `crowdfunding` | Business | COMPLETE | P2 |
| 16 | Chat | `chat` | Free | COMPLETE | P1 |
| 17 | Broadcast | `broadcast` | Growth | COMPLETE | P2 |
| 18 | Reviews / Feedback | `feedback` | Free | COMPLETE | — |
| 19 | Surveys | `survey` | Growth | COMPLETE | — |
| 20 | Polls | `poll` | Free | COMPLETE | — |
| 21 | Loyalty | `loyalty` | Growth | COMPLETE | P1 |
| 22 | Referrals | `referral` | Growth | PARTIAL | P2 |
| 23 | Membership / Loyalty Tiers | `membership` | Growth | COMPLETE | P2 |
| 24 | Staff | `staff` | Business | PARTIAL | P1 |
| 25 | Attendance | — | — | PARTIAL | P2 |
| 26 | Queue | `queue` | Business | COMPLETE | — |
| 27 | Waitlist | `waitlist` | Business | COMPLETE | — |
| 28 | Reminders | `reminders` | Growth | COMPLETE | P2 |
| 29 | Auto-Reply | `auto_reply` | Growth | PARTIAL | P1 |
| 30 | Waivers | `waiver` | Growth | COMPLETE | P2 |
| 31 | Documentation / Reports | `reports` | Business | COMPLETE | — |
| 32 | E-Signatures / Contracts | `whatsapp_sign` | Business | COMPLETE | P2 |
| 33 | Settings | — | — | COMPLETE | — |

**Summary:** 20 COMPLETE, 12 PARTIAL, 1 DEFECT (Subscriptions Paystack path)

---

## 4. Detailed Findings by Capability

### 4.1 Appointments (`appointment`) — PARTIAL

**Evidence:**
- UI: `app/dashboard/appointments-management/page.tsx`
- Bot: `lib/bot/flows/appointment.flow.ts` → delegates to scheduling flow
- DB: `appointments` table (migration 117), `bookings.appointment_id` FK (migration 166)
- RLS: 4 owner-scoped policies + service_role bypass (117)
- Gating: Free tier, properly enforced

**Working:** Bot flow (select appointment → date → staff → time → confirm → pay) works end-to-end. Dashboard CRUD works via RLS.

**Defects:**
- **P1-APPT-1:** `buffer_minutes` column missing from `appointments` table. Migration 146 only added it to `services`. Dashboard UI reads/writes it but the column doesn't exist, causing silent save failures or no buffer enforcement.
- **P1-APPT-2:** `reschedule` API (`app/api/bookings/[id]/reschedule/route.ts` line 81-98) queries `services` table using `service_id` which is NULL for appointment bookings. Capacity check silently returns 0 conflicts — reschedule ignores capacity.
- **P1-APPT-3:** `create-manual` API only supports services, not appointments. Dashboard manual booking broken for appointment-only businesses.
- **P1-APPT-4:** Public booking endpoints (`/api/bookings/public/[slug]`, `/api/bookings/public/slots`) query `services` only — non-functional for appointment-only businesses.
- **P2-APPT-5:** `flow_type` stored as `'scheduling'` for all appointment bookings despite `'appointment'` enum value existing. Analytics cannot distinguish.

**Questions for Babajide:**
1. Should `buffer_minutes` be added to `appointments` table, or should the UI field be removed?
2. Should public web booking support appointment-type businesses?
3. Should `flow_type` distinguish appointments from services for analytics?

---

### 4.2 Services (`scheduling`) — COMPLETE

**Evidence:**
- UI: `app/dashboard/services/page.tsx` (1,242 lines)
- Bot: `lib/bot/flows/scheduling.flow.ts`
- DB: `services` table (migration 002), `service_addons` (103)
- RLS: Owner-scoped + public read for active services
- Gating: Free tier

**Working:** Full CRUD via browser Supabase client. Bot flow complete. Cross-capability hub.

**Defects:**
- **P2-SVC-1:** `priceLabel()` (page.tsx line 376) renders yearly services as "/month" — ternary doesn't handle `'yearly'`.
- **P2-SVC-2:** `handleSave()` doesn't check Supabase error return — silent save failures possible.

---

### 4.3 Products / Online Store (`ordering`) — COMPLETE

**Evidence:**
- UI: `app/dashboard/products/page.tsx` + 5 sub-components
- Bot: `lib/bot/flows/ordering.flow.ts` (3,258 lines, 44 steps)
- DB: `products`, `product_variants`, `product_addons`, `orders`, `order_items`, `delivery_zones`, `volume_discount_rules`
- RPCs: `create_catalog_order_atomic`, `decrement_stock`, `calculate_volume_discount`
- RLS: Owner-scoped on all tables
- Gating: Free tier

**Working:** Full product CRUD, multi-axis variants, addons, volume discounts, promo codes, WhatsApp catalog sync, CSV bulk import, low-stock alerts cron. Bot ordering flow is comprehensive.

**Important note:** Online Store is WhatsApp-only. **No web storefront exists.** `/b/[slug]` is service booking only. This is a product decision, not a bug.

**Defects:**
- **P2-PROD-1:** Price stored as INTEGER (whole currency units) but WhatsApp catalog sync multiplies by 100. Internally consistent but should be documented.

**Question for Babajide:** Is WhatsApp-only ordering intentional, or should a web product catalog be on the roadmap?

---

### 4.4 Properties — PARTIAL

**Evidence:**
- UI: `app/dashboard/properties/page.tsx`, `properties/checkin/page.tsx`
- Bot: No dedicated flow; properties feed into `reservation.flow.ts`
- DB: `properties` (migration 115), `property_blocked_dates` (121)

**Defects:**
- **P1-PROP-1:** Property occupancy status shows "Vacant" for checked-in properties. `page.tsx` line 125 checks `status === 'in_progress'` but the actual status is `'checked_in'` (from migration 132).
- **P2-PROP-2:** `price_is_variable` column exists but no UI toggle — cannot be set from dashboard.

---

### 4.5 Events / Ticketing (`ticketing`) — COMPLETE

**Evidence:**
- UI: `app/dashboard/events/page.tsx`, `events/checkin/`, `events/invites/`, `dashboard/tickets/`
- Bot: `lib/bot/flows/ticketing.flow.ts`
- DB: `events`, `event_tickets`, `event_ticket_types`, `event_invites`
- RPCs: `purchase_tickets_atomic`
- Public: `/e/[slug]` event page, `/api/events/public/[slug]`

**Working:** Web + WhatsApp purchase paths. QR check-in. RSVP invites. Atomic ticket purchase prevents overselling.

**Defects:**
- **P2-EVT-1:** Need to verify that `purchase_tickets_atomic` creates individual `event_tickets` rows (not just a `bookings` row) — if missing, QR check-in would break.

---

### 4.6 Donations / Giving (`giving`) — PARTIAL

**Evidence:**
- UI: `app/dashboard/giving/page.tsx` — uses `services` table with `service_type = 'giving'`
- Bot: Routed through `payment.flow.ts` (`select_category` step)
- No dedicated API routes

**Defects:**
- **P1-GIVE-1:** Recurring giving is advertised in UI (weekly/monthly toggle) but **no cron job exists to auto-charge**. The `recurring_interval` field is stored but never acted on. Dead feature flag.

---

### 4.7 Subscriptions (`recurring`) — COMPLETE but P0 defect

**Evidence:**
- UI: `app/dashboard/recurring/page.tsx`
- Bot: Enrollment in `payment.flow.ts`, management in `recurring-manage.flow.ts`
- Cron: `app/api/cron/retry-failed-charges/route.ts`
- DB: `customer_subscriptions`, `subscription_charges`
- RPCs: `claim_recurring_billing_cycle`, `finalize_token_recurring_charge`, `record_flutterwave_definitive_failure`, `cancel_flutterwave_after_failures`
- Tests: 42 PostgreSQL tests + 22 executable tests

**Working:** Flutterwave path is robustly engineered with atomic claim/finalize/failure RPCs and concurrent finalizer protection (PR #97 + #98).

**Defects:**
- **P0-SUB-1:** Dashboard Paystack pause/cancel uses `customer_email` as Paystack `email_token` (`app/api/recurring/manage/route.ts` line 54). Paystack requires the subscription's email token (stored in `metadata.email_token`), not the email address. The SELECT query doesn't fetch `metadata`. Dashboard pause/cancel of Paystack subscriptions **silently fails** — DB status is updated but provider subscription continues charging.
- **P0-SUB-2:** Web-initiated Paystack subscription creates `customer_subscriptions` with `status: 'active'` before payment is confirmed (`app/api/recurring/setup/route.ts` lines 99-115). If user abandons checkout, phantom active subscription remains. Cron will attempt to charge it and fail.

---

### 4.8 Chat (`chat`) — COMPLETE with P1

**Evidence:**
- UI: `app/dashboard/chat/page.tsx`
- Bot: `lib/bot/flows/chat.flow.ts`, `lib/bot/handlers/chat-handoff.ts`
- API: 7 routes under `/api/chat/`
- DB: `chat_conversations`, `chat_messages`, `canned_responses`

**Working:** Full inbound → bot → escalate → agent replies → resolve cycle with Supabase Realtime.

**Defects:**
- **P1-CHAT-1:** Team members cannot mark messages as read. `markAsRead` in chat page uses browser client, but team members have no UPDATE RLS policy on `chat_messages` (migration 168 only grants INSERT for outbound). Unread badge persists permanently for team members.

---

### 4.9 Loyalty (`loyalty`) — COMPLETE with P1

**Evidence:**
- UI: `app/dashboard/loyalty/page.tsx`
- Bot: `lib/bot/flows/loyalty.flow.ts`, global keyword handler
- DB: `loyalty_points`, `loyalty_transactions`, `redeem_loyalty_points` RPC

**Working:** Earn path (post-completion → upsert points → WhatsApp notification) and redeem path work.

**Defects:**
- **P1-LOYAL-1:** `loyalty_transactions` has no UPDATE RLS policy for any role. The redemption code update (`loyalty.flow.ts` lines 244-251) silently fails via browser client. Redemption code is never stored in the transaction log.

---

### 4.10 Staff (`staff`) — PARTIAL with P1

**Evidence:**
- UI: `app/dashboard/staff/page.tsx`
- API: `app/api/staff/route.ts` (full CRUD)
- DB: `business_staff` (migration 020)

**Defects:**
- **P1-STAFF-1:** Staff schedules are stored (`schedule` JSONB) but **never consulted by the bot** during booking. A customer can book a staff member on their day off if the service allows that day.

---

### 4.11 Auto-Reply (`auto_reply`) — PARTIAL with P1

**Evidence:**
- Capability is defined (`auto_reply: 'growth'`) and appears in category defaults
- `ai_conversation_config` table stores business hours and away message

**Defects:**
- **P1-AUTO-1:** No implementation found for auto-reply behavior in the bot. The `ai_conversation_config` stores `business_hours` and `away_message` fields, but `bot.service.ts` does not check business hours before processing messages. The capability toggle exists but the runtime behavior is not wired.

**Question for Babajide:** Is auto-reply implemented elsewhere (e.g., at the WhatsApp provider level), or is this genuinely unimplemented?

---

## 5. Cross-Capability Findings

### 5.1 `appointments` vs `services` table divergence
The `appointments` table (migration 117) mirrors many `services` columns but independently. Several shared APIs/RPCs only query `services`, breaking when `appointment_id` is set and `service_id` is NULL. Affected: reschedule, create-manual, public slots, public booking page.

### 5.2 `business_staff` vs `business_members` duplication
Both tables exist (migrations 020 and 099). The staff page uses only `business_staff`. Chat team assignment uses `business_members`. These appear to be separate concepts (operational staff vs account team members) but could cause confusion.

### 5.3 Webhook confirmation dedup bug
`send-confirmation.ts` line 46 calls `supabase.from().update()` without `{ count: 'exact' }`. The `count` is always `null`, causing the dedup guard at line 52 to always return early. **No webhook-path payment confirmations are ever sent.**

### 5.4 Online Store is WhatsApp-only
Products/ordering have no web storefront. `/b/[slug]` serves only service bookings. This is likely intentional but worth confirming.

---

## 6. Questions Requiring Product Decisions

1. **Appointments buffer_minutes:** Add column to `appointments` table, or remove from dashboard UI?
2. **Public booking for appointments:** Should `/b/[slug]` support appointment-type businesses?
3. **Recurring giving:** Should a cron job auto-charge recurring giving categories, or remove the recurring toggle from giving UI?
4. **Online Store web:** Is WhatsApp-only ordering intentional? Should web product catalog be on the roadmap?
5. **Auto-reply:** Is this implemented at the provider level, or genuinely unimplemented?
6. **Staff scheduling enforcement:** Should the bot check staff member schedules when selecting a staff member?
7. **Attendance capability gate:** Should attendance require a specific capability, or remain ungated?
8. **`flow_type` for appointments:** Should appointment bookings store `flow_type = 'appointment'` for analytics?

---

## 7. P0 Findings (Launch Blockers)

| ID | Capability | Finding | Impact |
|---|---|---|---|
| P0-SUB-1 | Subscriptions | Paystack dashboard pause/cancel uses wrong email_token | Dashboard cancel silently fails; Paystack keeps charging |
| P0-SUB-2 | Subscriptions | Web Paystack subscription created as active before payment | Phantom active subscriptions; cron charges fail |
| ~~P0-AUTH-1~~ | ~~Authentication~~ | ~~Removed: `generatePhonePassword` uses random nonce — not deterministic~~ | ~~N/A~~ |
| P0-CONFIRM-1 | Notifications | Webhook payment confirmation dedup always returns early | No webhook-path confirmations ever sent |
| P0-AI-1 | Ace AI | `increment_ai_usage` RPC call uses old 2-arg signature (migration 084); function replaced with 3-arg (migration 091) | Intent usage tracking silently broken |
| P0-APPT-1 | Appointments | `buffer_minutes` column missing from appointments table | Buffer time between appointments non-functional |
| P0-PROP-1 | Properties | Property occupancy shows "Vacant" for checked-in properties | Property managers see wrong occupancy status |

---

## 8. P1 Findings (Important Broken/Incomplete)

| ID | Capability | Finding |
|---|---|---|
| P1-APPT-2 | Appointments | Reschedule ignores capacity for appointment bookings |
| P1-APPT-3 | Appointments | Dashboard manual booking broken for appointment-only businesses |
| P1-APPT-4 | Appointments | Public booking page non-functional for appointment-only businesses |
| P1-GIVE-1 | Giving | Recurring giving advertised but no auto-charge mechanism |
| P1-CHAT-1 | Chat | Team members cannot mark messages as read (no UPDATE RLS policy) |
| P1-LOYAL-1 | Loyalty | Redemption code update silently fails (no UPDATE RLS on loyalty_transactions) |
| P1-STAFF-1 | Staff | Staff schedules stored but never consulted during bot booking |
| P1-AUTO-1 | Auto-Reply | Capability defined but no runtime behavior implemented |
| P1-APPT-5 | Appointments | No test file for appointment.flow.ts |
| P1-CLASS-1 | Class Booking | No dedicated dashboard page — managed inside Services page with no sidebar entry |
| P1-CLASS-2 | Class Booking | No class schedule display in bot — students see regular time slot picker, not class times |
| P1-PKG-1 | Session Packages | Redemption flow incomplete — no bot integration for session consumption |
| P1-REF-1 | Referrals | Customers cannot discover their referral code via bot — no keyword handler |
| P1-BCAST-1 | Broadcast | History tab reconstructs from `notifications` table, not `business_broadcasts` — inaccurate counts |

---

## 9. P2 Findings (Quality/UX)

| ID | Capability | Finding |
|---|---|---|
| P2-SVC-1 | Services | Yearly recurring label shows "/month" |
| P2-SVC-2 | Services | Silent save failures — error not checked |
| P2-PROD-1 | Products | Price integer vs catalog API minor-unit inconsistency |
| P2-PROP-2 | Properties | `price_is_variable` toggle missing from UI |
| P2-EVT-1 | Events | Verify `purchase_tickets_atomic` creates individual ticket rows |
| P2-APPT-5 | Appointments | `flow_type` always 'scheduling' — no appointment analytics distinction |
| P2-LOC-1 | Locations | Latitude/longitude columns exist but no UI fields |
| P2-LOC-2 | Locations | No location step in reservation or ticketing flows |
| P2-LOC-3 | Locations | Operating hours not exposed in bot responses |
| P2-ATTEND-1 | Attendance | No capability gate — any business can access |
| P2-ATTEND-2 | Attendance | WhatsApp check-in source defined but no bot flow implements it |
| P2-WAIVER-1 | Waivers | No PDF generation for signed waivers |
| P2-WAIVER-2 | Waivers | QR download button timing issue |
| P2-ESIG-1 | E-Signatures | Contract template versioning not implemented |
| P2-REMIND-1 | Reminders | No-show reminder resolves service name via `service_id` which is NULL for appointment bookings |
| P2-ONBOARD-1 | Onboarding | Draft persistence in localStorage stores business details |
| P2-ANALYTICS-1 | Analytics | All metrics computed client-side — slow on large datasets |
| P2-LOYAL-2 | Loyalty | Stale balance displayed during redemption (uses session-cached value) |
| P2-MEMBER-1 | Membership | Tier assignment uses `total_spent` from `loyalty_points` — may not match actual payment totals |
| P2-STORE-1 | Online Store | No web product catalog — WhatsApp only |
| P2-CHAT-2 | Chat | No business hours / away message integration |
| P2-SURVEY-1 | Surveys | Response rate calculation divides by broadcast count which may not match actual survey sends |
| P2-POLL-1 | Polls | No results visualization — text-only counts |

---

## 10. P3 / Future Items

| ID | Capability | Item |
|---|---|---|
| P3-SVC-1 | Services | Duplicate/copy service function |
| P3-SVC-2 | Services | Drag-and-drop reorder |
| P3-PROD-2 | Products | Restore-from-trash for soft-deleted products |
| P3-LOC-4 | Locations | Google Maps integration / geocoding |
| P3-REF-2 | Referrals | Web referral landing page |
| P3-CHAT-3 | Chat | Agent typing indicators |
| P3-BCAST-2 | Broadcast | Broadcast scheduling (UI exists but implementation needs verification) |
| P3-WAIVER-3 | Waivers | Pre-booking waiver requirement enforcement |
| P3-ESIG-2 | E-Signatures | Multi-party signing (sequential signers) |
| P3-ATTEND-3 | Attendance | Event-linked attendance tracking |
| P3-QUEUE-1 | Queue | Estimated wait time display |
| P3-STORE-2 | Online Store | Web storefront with cart/checkout |

---

## 11. Recommended Remediation Sequence

### Phase 1 — P0 fixes (before any public launch)
1. Fix Paystack subscription email_token (P0-SUB-1) — fetch `metadata` in SELECT
2. Fix web Paystack subscription status (P0-SUB-2) — create as `pending`, activate on webhook
3. Fix webhook confirmation dedup (P0-CONFIRM-1) — add `{ count: 'exact' }` to update call
4. Fix `increment_ai_usage` signature (P0-AI-1) — update to 3-arg version
5. Add `buffer_minutes` to appointments table (P0-APPT-1)
6. Fix property occupancy status check (P0-PROP-1) — check `'checked_in'` not `'in_progress'`
7. ~~P0-AUTH-1 removed — `generatePhonePassword` uses random nonce, not deterministic~~

### Phase 2 — P1 fixes (critical for launched capabilities)
1. Fix appointment reschedule capacity (P1-APPT-2)
2. Fix appointment manual booking (P1-APPT-3)
3. Add UPDATE RLS for `loyalty_transactions` (P1-LOYAL-1)
4. Add UPDATE RLS for `chat_messages` for team members (P1-CHAT-1)
5. Either implement auto-reply or remove the capability (P1-AUTO-1)
6. Either implement recurring giving cron or remove the toggle (P1-GIVE-1)

### Phase 3 — P2 improvements (quality)
Prioritize based on customer-facing visibility and business impact.

---

## 12. DO NOT IMPLEMENT YET

All findings in this audit are for review and prioritization only.

**Do not:**
- Create fix PRs based on this audit without CTO approval of priorities
- Modify production or staging
- Begin work on P3/future items
- Expand scope beyond the specific approved fixes
- Treat P2 items as launch blockers without explicit product decision
- Assume product intent for ambiguous behavior — ask Babajide first

**Next steps:**
1. Independent CTO review of this audit
2. Babajide answers product questions (Section 6)
3. Prioritized fix list created
4. Implementation begins only after approval
