# Waaiio Full Capability Audit — August 2026

**Date:** 2026-08-05
**Auditor:** Claude (code audit, read-only)
**Branch:** `main` at commit `f02e6e58` (post-PR #98 merge)
**Method:** Automated code inspection of all 34 requested capabilities and 20 shared systems against current `main`

---

## 1. Executive Summary

Waaiio is a substantial WhatsApp-first business automation platform with **31 defined capabilities**, **247 API routes**, **69 dashboard pages**, **18 bot flows**, and **100+ database tables** across **306 migrations**.

The core commerce flows (scheduling, ordering, ticketing, payments, reservations) are **functionally complete end-to-end** through the WhatsApp bot. The dashboard provides full CRUD for most entities. RLS is systematically applied. Payment integration spans 4+ gateways with webhook verification and platform fee accounting.

The audit identified **4 P0 findings**, **18 P1 findings**, **29 P2 findings**, and **12 P3/future items** across **34 audited capabilities**.

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

### Classification rules

Each capability receives ONE primary classification:
- **COMPLETE** — intended end-to-end workflow is connected and usable
- **PARTIAL** — core functionality exists but material gaps remain
- **DEFECT** — primary workflow is broken by a concrete code defect
- **UX IMPROVEMENT** — works but has notable UX rough edges
- **FUTURE / NOT REQUIRED** — capability is defined but not yet implemented

A capability classified as COMPLETE may still contain defects; the classification reflects the primary workflow, not perfection. The scorecard severity column reflects the highest verified finding.

### Severity rules

- **P0** — launch blocker: concrete financial integrity risk, provider/local state divergence that causes real money consequences, or fundamental inability to use a core workflow
- **P1** — important: existing capability is materially broken or incomplete in a way that affects real users
- **P2** — quality: usability, observability, resilience, or workflow improvement
- **P3** — future: optional enhancement / nice-to-have

---

## 3. Requested Capability Mapping

The audit scope requested 34 entries. Two entries (#9 "Waivers" and #33 "Waiver System") map to the **same underlying implementation**: `waiver` capability, `waiver_templates` + `signed_waivers` tables, `app/dashboard/waivers/page.tsx`, and `app/api/waivers/` routes. They are audited as a single entry (#30 in the scorecard). Similarly, #32 "Electronic Signature" maps to `whatsapp_sign` capability and is audited as "E-Signatures / Contracts" (#33 in the scorecard).

All 34 requested capabilities are accounted for: 33 unique implementations + 1 consolidated duplicate.

---

## 4. Capability Scorecard

| # | Capability | ID | Tier | Classification | Highest Severity |
|---|---|---|---|---|---|
| 1 | Appointments | `appointment` | Free | PARTIAL | P1 |
| 2 | Services | `scheduling` | Free | COMPLETE | P2 |
| 3 | Products | `ordering` | Free | COMPLETE | P2 |
| 4 | Properties | (via `reservation`) | Growth | PARTIAL | P1 |
| 5 | Events / Ticketing | `ticketing` | Free | COMPLETE | P2 |
| 6 | Donations / Giving | `giving` | Free | PARTIAL | P1 |
| 7 | Locations | `multi_location` | Growth | COMPLETE | P2 |
| 8 | Reservations | `reservation` | Growth | COMPLETE | P2 |
| 9 | Online Store (web) | (via `ordering`) | Free | PARTIAL | P2 |
| 10 | Class Booking | `class_booking` | Growth | PARTIAL | P1 |
| 11 | Estimates & Quotes | `estimates` | Free | PARTIAL | P2 |
| 12 | Invoices | `invoice` | Growth | DEFECT | P1 |
| 13 | Subscriptions | `recurring` | Growth | PARTIAL | P0 |
| 14 | Session Packages | `packages` | Growth | PARTIAL | P1 |
| 15 | Campaigns / Crowdfunding | `crowdfunding` | Business | COMPLETE | P2 |
| 16 | Chat | `chat` | Free | COMPLETE | P1 |
| 17 | Broadcast | `broadcast` | Growth | COMPLETE | P2 |
| 18 | Reviews / Feedback | `feedback` | Free | COMPLETE | — |
| 19 | Surveys | `survey` | Growth | COMPLETE | P2 |
| 20 | Polls | `poll` | Free | COMPLETE | P2 |
| 21 | Loyalty | `loyalty` | Growth | COMPLETE | P1 |
| 22 | Referrals | `referral` | Growth | PARTIAL | P1 |
| 23 | Membership / Loyalty Tiers | `membership` | Growth | COMPLETE | P2 |
| 24 | Staff | `staff` | Business | PARTIAL | P1 |
| 25 | Attendance | — | — | PARTIAL | P2 |
| 26 | Queue | `queue` | Business | DEFECT | P1 |
| 27 | Waitlist | `waitlist` | Business | COMPLETE | P2 |
| 28 | Reminders | `reminders` | Growth | COMPLETE | P2 |
| 29 | Auto-Reply | `auto_reply` | Growth | PARTIAL | P1 |
| 30 | Waivers (incl. Waiver System) | `waiver` | Growth | COMPLETE | P2 |
| 31 | Documentation / Reports | `reports` | Business | DEFECT | P1 |
| 32 | E-Signatures / Contracts | `whatsapp_sign` | Business | COMPLETE | P1 |
| 33 | Settings | — | — | COMPLETE | P2 |

**Summary:** 18 COMPLETE, 12 PARTIAL, 3 DEFECT

---

## 5. P0 Findings (Launch Blockers)

Each P0 has a concrete financial or provider-state-divergence consequence.

### P0-SUB-1 — Paystack subscription pause/cancel uses wrong credential

**Path:** `app/api/recurring/manage/route.ts` line 28 (SELECT) and line 54 (usage)
**Verified behavior:** SELECT fetches `customer_email` but not `metadata`. Line 54: `const emailToken = sub.customer_email || ''`. Paystack's `/subscription/disable` API requires the subscription's `email_token` (stored in `metadata.email_token`), not the customer's email address.
**Consequence:** Dashboard pause/cancel of Paystack subscriptions silently fails at the provider level. The DB status is updated to `paused`/`cancelled`, but Paystack continues charging the customer. This creates local/provider state divergence with direct financial impact — the customer is charged money that Waaiio shows as cancelled.
**Why P0:** Concrete financial consequence — real money continues to be charged after the business believes they cancelled.

### P0-SUB-2 — Paystack subscription created active before payment confirmation

**Path:** `app/api/recurring/setup/route.ts` lines 106 and 151
**Verified behavior:** Both Paystack setup paths insert `customer_subscriptions` with `status: 'active'` immediately upon initializing checkout, before the customer completes payment.
**Consequence:** If the customer abandons checkout, a phantom `active` subscription exists with no `authorization_code`. The daily `retry-failed-charges` cron (line 45) skips Paystack subs without `authorization_code`, but only for the charge path — the subscription still appears as "active" in the business dashboard and counts toward MRR metrics. More critically, if the webhook fires but fails to correlate (timing race), the cron will eventually attempt to charge and fail, incrementing `failure_count` toward auto-cancellation — generating false failure notifications to the business.
**Why P0:** Creates phantom active subscriptions that pollute business metrics and generate false alerts. The financial state is inconsistent from creation.

### P0-CONFIRM-1 — Webhook payment confirmations never sent

**Path:** `lib/payments/send-confirmation.ts` lines 46-55
**Verified behavior:** `.update({ confirmation_sent_at: ... })` is called without `{ count: 'exact' }` as second argument. Supabase returns `count: null` without this option. The guard `if (!count || count === 0)` always evaluates true (null is falsy). Function returns at line 53 before sending any message.
**Consequence:** ALL webhook-triggered payment confirmations are silently skipped. This affects all 5 payment gateways + BYO. Customers who pay via mobile payment apps (which don't redirect to the success page) never receive a WhatsApp confirmation. The cascading skip also prevents: ticket delivery for events, `handlePostCompletion` (loyalty points, feedback requests, referral code generation), and owner notifications for webhook-path payments. The "I've Paid" bot path and the payment-success redirect page are unaffected (they call different code paths).
**Why P0:** Customers paying via any gateway webhook path receive no confirmation, no tickets, no loyalty points. This affects the core customer experience for every payment that doesn't redirect to the success page.

### P0-INVOICE-1 — Bot invoice flow queries nonexistent column

**Path:** `lib/bot/flows/invoice.flow.ts` lines 32, 117, 194 (three separate SELECT queries)
**Verified behavior:** All three queries select `invoice_number`. The actual DB column (migration `063_invoices.sql` line 14) is `reference_code`. The API route (`app/api/invoices/route.ts` line 137) correctly uses `reference_code`. The bot flow uses the wrong column name.
**Consequence:** Supabase returns `null` for the nonexistent column. Every bot message displays "Invoice undefined". `initializePayment` at line 235 receives `referenceCode: undefined`, causing payment initialization to fail or create a payment with no reference. The entire bot-side invoice workflow (list → view → pay) is broken at runtime.
**Why P0:** Fundamental inability to use the invoice bot workflow. Every customer interaction with invoices via WhatsApp fails.

---

## 6. P1 Findings

| ID | Capability | Finding | Evidence |
|---|---|---|---|
| P1-APPT-1 | Appointments | `buffer_minutes` column missing from `appointments` table. Dashboard UI reads/writes it but column doesn't exist in any migration. Buffer enforcement non-functional. | Migration 146 adds to `services` only; `appointments-management/page.tsx` line 19 |
| P1-APPT-2 | Appointments | Reschedule ignores capacity for appointment bookings. `service_id` is NULL → query returns 0 conflicts. | `app/api/bookings/[id]/reschedule/route.ts` lines 81-98 |
| P1-APPT-3 | Appointments | Dashboard manual booking broken for appointment-only businesses. API only queries `services`. | `app/api/bookings/create-manual/route.ts` lines 62-68 |
| P1-APPT-4 | Appointments | Public booking page non-functional for appointment-only businesses. | `app/api/bookings/public/[slug]/route.ts`, `public/slots/route.ts` |
| P1-PROP-1 | Properties | Occupancy status shows "Vacant" for checked-in properties. Checks `status === 'in_progress'` but canonical status is `'checked_in'`. | `app/dashboard/properties/page.tsx` line 125 vs migration 132 |
| P1-GIVE-1 | Giving | Recurring giving advertised in UI but no auto-charge cron. `recurring_interval` stored, never acted on. | `app/dashboard/giving/page.tsx` — toggle exists; no cron in `app/api/cron/` |
| P1-CHAT-1 | Chat | Team members cannot mark messages as read. Browser client UPDATE blocked by RLS (no UPDATE policy for team members). | `app/dashboard/chat/page.tsx` line 543; migration 168 grants INSERT only |
| P1-LOYAL-1 | Loyalty | Redemption code update silently fails. No UPDATE RLS on `loyalty_transactions` for any role. | `lib/bot/flows/loyalty.flow.ts` lines 244-251 |
| P1-STAFF-1 | Staff | Staff schedules stored but never consulted during bot booking. Customers can book staff on their day off. | `business_staff.schedule` JSONB; `scheduling.flow.ts` reads service-level `available_days` only |
| P1-AUTO-1 | Auto-Reply | Capability defined but `instant_reply_message` is configured in UI yet never sent by bot. Away message works for first message only. | `app/dashboard/settings/tabs/FeaturesTab.tsx` vs `bot.service.ts` — no `instant_reply` reference |
| P1-QUEUE-1 | Queue | Bot writes `status='cancelled'` violating DB CHECK constraint (`waiting/serving/completed/no_show`). "Leave Queue" fails. | `lib/bot/flows/queue-checkin.flow.ts` lines 108, 435; migration 018 CHECK |
| P1-QUEUE-2 | Queue | Queue reopen opt-in writes `type` column to `waitlist_entries` — column doesn't exist. | `queue-checkin.flow.ts` line 135; migration 020 schema |
| P1-CLASS-1 | Class Booking | No dedicated dashboard page or sidebar entry. No class schedule display in bot. | Managed inside `services/page.tsx`; `class_booking` in `nonUserFacing` |
| P1-PKG-1 | Session Packages | `sessions_used` is never incremented anywhere. No redemption mechanism. Dashboard shows 0/N forever. | `app/api/packages/enroll/route.ts` sets 0; no update anywhere |
| P1-REF-1 | Referrals | Customers cannot discover referral code via bot despite code comment claiming they can. | `post-completion.ts` line 379 says "type 'refer'"; no handler exists |
| P1-REPORT-1 | Documents | Send API double-auth causes all dashboard-initiated sends to 403. | `app/api/reports/send/route.ts` lines 14-31: cookie auth + bearer on service client |
| P1-REPORT-2 | Documents | Upload rejects PNG/JPEG despite UI advertising support. Magic byte check is PDF-only. | `app/api/reports/upload/route.ts` line 43-44 |
| P1-ESIG-1 | E-Signatures | Multi-signer PDF captures only last signer's signature. | `app/api/contracts/submit/route.ts` line 218 |

---

## 7. P2 Findings

| ID | Capability | Finding |
|---|---|---|
| P2-SVC-1 | Services | `priceLabel()` renders yearly services as "/month" — ternary doesn't handle `'yearly'` |
| P2-SVC-2 | Services | `handleSave()` doesn't check Supabase error return — silent save failures |
| P2-PROD-1 | Products | Price INTEGER vs WhatsApp catalog API minor-unit multiplication — internally consistent but undocumented |
| P2-PROP-2 | Properties | `price_is_variable` column exists but no UI toggle |
| P2-EVT-1 | Events | Verify `purchase_tickets_atomic` creates individual `event_tickets` rows |
| P2-APPT-5 | Appointments | `flow_type` always `'scheduling'` — no appointment analytics distinction |
| P2-LOC-1 | Locations | Latitude/longitude columns exist but no UI fields |
| P2-LOC-2 | Locations | No location step in reservation or ticketing flows |
| P2-LOC-3 | Locations | Operating hours not exposed in bot responses |
| P2-ATTEND-1 | Attendance | No capability gate — any business can access the dashboard page |
| P2-ATTEND-2 | Attendance | WhatsApp check-in source badge in UI but no bot flow implements it |
| P2-WAIVER-1 | Waivers | No PDF generation for signed waivers (column exists, never written) |
| P2-WAIVER-2 | Waivers | QR download button canvas timing issue |
| P2-ESIG-2 | E-Signatures | Contract revoke does not update `contract_signers` rows — stay `pending` |
| P2-REMIND-1 | Reminders | No-show reminder resolves service name via NULL `service_id` for appointments |
| P2-ONBOARD-1 | Onboarding | Draft persistence in localStorage stores business details |
| P2-ANALYTICS-1 | Analytics | All metrics computed client-side — slow on large datasets |
| P2-ANALYTICS-2 | Analytics | Dropoffs page queries `step_name` but column is `step_id` — all steps show "unknown" |
| P2-ANALYTICS-3 | Analytics | Bot completion check uses `'complete'` vs `'completed'` inconsistently between pages |
| P2-LOYAL-2 | Loyalty | Stale balance displayed during redemption (uses session-cached value) |
| P2-MEMBER-1 | Membership | `discount_percent` stored/configured but never applied during checkout |
| P2-STORE-1 | Online Store | No web product catalog — WhatsApp only |
| P2-BCAST-1 | Broadcast | History tab uses `notifications` table grouping heuristic — inaccurate counts |
| P2-POLL-1 | Polls | `closes_at` not injected into bot session — expired polls still accept votes |
| P2-AI-1 | Ace AI | `increment_ai_usage` RPC uses old 2-arg signature; call silently fails. Analytics tracking only. |
| P2-CRON-1 | Cron | Reminders cron is UTC-naive — off by 1 hour for non-UTC businesses |
| P2-CRON-2 | Cron | Custom reminder hours have no dedup flag — re-sends every 30 min |
| P2-TZ-1 | Scheduling | Uses UTC `new Date().toISOString().split('T')[0]` for "today" — wrong for late-night non-UTC users |
| P2-COUNTRY-1 | Country | `CountryCode` is `string` not union — unsupported country silently defaults to Nigeria |

---

## 8. P3 / Future Items

| ID | Capability | Item |
|---|---|---|
| P3-SVC-1 | Services | Duplicate/copy service function |
| P3-SVC-2 | Services | Drag-and-drop reorder |
| P3-PROD-1 | Products | Restore-from-trash for soft-deleted products |
| P3-LOC-1 | Locations | Google Maps integration / geocoding |
| P3-REF-1 | Referrals | Web referral landing page |
| P3-CHAT-1 | Chat | Agent typing indicators |
| P3-BCAST-2 | Broadcast | Scheduled broadcast execution verification |
| P3-WAIVER-3 | Waivers | Pre-booking waiver requirement enforcement |
| P3-ESIG-3 | E-Signatures | Multi-party sequential signing improvements |
| P3-ATTEND-1 | Attendance | Event-linked attendance tracking |
| P3-QUEUE-3 | Queue | Estimated wait time display |
| P3-STORE-2 | Online Store | Web storefront with cart/checkout |

---

## 9. Questions Requiring Product Decisions

1. **Appointments buffer_minutes:** Add column to `appointments` table, or remove from dashboard UI?
2. **Public booking for appointments:** Should `/b/[slug]` support appointment-type businesses?
3. **Recurring giving:** Should a cron job auto-charge recurring giving categories, or remove the recurring toggle from giving UI?
4. **Online Store web:** Is WhatsApp-only ordering intentional? Should web product catalog be on the roadmap?
5. **Auto-reply instant_reply:** Is `instant_reply_message` intended to be implemented, or should it be removed from the settings UI?
6. **Staff scheduling enforcement:** Should the bot check staff member schedules when selecting a staff member?
7. **Attendance capability gate:** Should attendance require a specific capability, or remain ungated?
8. **`flow_type` for appointments:** Should appointment bookings store `flow_type = 'appointment'` for analytics?

---

## 10. Recommended Remediation Sequence

### Phase 1 — P0 fixes (before any public launch)
1. Fix Paystack subscription email_token (P0-SUB-1) — fetch `metadata` in SELECT, use `metadata.email_token`
2. Fix web Paystack subscription status (P0-SUB-2) — create as `pending`, activate on webhook confirmation
3. Fix webhook confirmation dedup (P0-CONFIRM-1) — add `{ count: 'exact' }` to `.update()` call
4. Fix invoice bot flow column name (P0-INVOICE-1) — change `invoice_number` to `reference_code` in all 3 queries

### Phase 2 — P1 fixes (critical for launched capabilities)
1. Fix queue `cancelled` status (P1-QUEUE-1) — add `'cancelled'` to CHECK constraint
2. Fix queue reopen opt-in (P1-QUEUE-2) — use correct table/column
3. Fix property occupancy status (P1-PROP-1) — check `'checked_in'`
4. Add `buffer_minutes` to appointments table (P1-APPT-1)
5. Fix appointment reschedule capacity (P1-APPT-2)
6. Fix document send API auth (P1-REPORT-1) — remove duplicate bearer check
7. Fix document upload magic bytes (P1-REPORT-2) — accept PNG/JPEG
8. Add UPDATE RLS for `loyalty_transactions` (P1-LOYAL-1)
9. Add UPDATE RLS for `chat_messages` for team members (P1-CHAT-1)
10. Fix multi-signer PDF (P1-ESIG-1)

### Phase 3 — P2 improvements (quality)
Prioritize based on customer-facing visibility and business impact.

---

## 11. Severity Downgrade Notes

The following findings were initially considered for P0 but downgraded after evidence review:

- **AI usage tracking (now P2-AI-1):** `increment_ai_usage` RPC signature mismatch causes intent tracking to silently fail. However, this only affects internal analytics — no customer-facing, billing, or security consequence. The tier-guard usage checks (`ai-tier-guard.ts`) correctly use the 3-arg signature, so feature limits still work. Downgraded to P2.
- **Scheduling timezone (now P2-TZ-1):** UTC "today" derivation is wrong for late-night non-UTC users. This is a real date-off-by-one bug but only affects a narrow window (~11PM-midnight local time). Not a launch blocker, but important to fix. Downgraded to P2.
- **Appointments buffer_minutes (now P1-APPT-1):** Column missing from `appointments` table. Dashboard writes silently fail. This is a workflow defect but not a financial or security issue. Downgraded to P1.
- **Property occupancy (now P1-PROP-1):** Wrong status label in dashboard. UI-only issue — no booking or data integrity consequence. Downgraded to P1.
- **Queue cancelled status (now P1-QUEUE-1):** Bot writes invalid status. The customer cannot leave the queue via bot. Real but not launch-blocking (queue is a Business-tier feature, and the dashboard can still manage the queue). Downgraded to P1.

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
2. Babajide answers product questions (Section 9)
3. Prioritized fix list created
4. Implementation begins only after approval
