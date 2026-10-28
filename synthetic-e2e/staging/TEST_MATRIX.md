# Phase 2 Test Matrix — 5 Businesses × 100 Customers

## Business Archetypes

| # | Name | Category | Country | Payment | Key Scenarios |
|---|------|----------|---------|---------|---------------|
| B1 | SynthShop-NG | `shop` | NG | Paystack test | Product ordering, variations, inventory, bank transfer |
| B2 | SynthBarber-US | `barber` | US | Stripe test | Appointment booking, deposits, scheduling, services |
| B3 | SynthEvents-NG | `event_planner` | NG | Paystack test | **BLOCKED** (M470 missing) — ticketing, event capacity |
| B4 | SynthStays-US | `hospitality` | US | Stripe test | Stays/reservation, check-in/check-out, room management |
| B5 | SynthDining-US | `restaurant` | US | Stripe test | **PARTIALLY BLOCKED** (M472 missing) — ordering, menu, sections |

## Per-Business Customer Distribution (100 each)

### B1: SynthShop-NG (Paystack Commerce)

| Range | Count | Scenario | Expected Outcome |
|-------|-------|----------|-----------------|
| 1-20 | 20 | Product order → Paystack test checkout → success | Order confirmed, payment recorded |
| 21-30 | 10 | Product order → payment declined | Order pending, no payment |
| 31-40 | 10 | Product with variations (size/color) → checkout | Correct variant recorded |
| 41-50 | 10 | Bank transfer → pending → manual confirm | Transfer pending until confirmed |
| 51-55 | 5 | Cancel mid-order | Order cancelled, no charge |
| 56-60 | 5 | STOP → confirm | Opt-out recorded |
| 61-65 | 5 | START after STOP | resubscribed_at set |
| 66-75 | 10 | Inventory conflict (out of stock) | Graceful "out of stock" message |
| 76-80 | 5 | Duplicate order attempt (replay) | Idempotent — no double charge |
| 81-85 | 5 | Cross-tenant (wrong business) | Isolation — no data leakage |
| 86-90 | 5 | Confused/gibberish input | Graceful fallback/help |
| 91-95 | 5 | Language switch (Yoruba/French) | Translation or safe fallback |
| 96-100 | 5 | Malformed webhook payload | Graceful error handling |

### B2: SynthBarber-US (Stripe Appointments)

| Range | Count | Scenario | Expected Outcome |
|-------|-------|----------|-----------------|
| 1-20 | 20 | Appointment booking → Stripe test checkout → success | Booking confirmed, deposit paid |
| 21-30 | 10 | Booking → payment declined | Booking pending, no deposit |
| 31-40 | 10 | Service selection → scheduling → time slot | Correct service/time recorded |
| 41-45 | 5 | Cancel booking | Booking cancelled |
| 46-50 | 5 | Reschedule attempt | Flow handles reschedule |
| 51-55 | 5 | STOP → START | Consent cycle verified |
| 56-60 | 5 | Double booking (same slot) | Conflict handled gracefully |
| 61-65 | 5 | Off-hours booking attempt | Business hours respected |
| 66-75 | 10 | Walk-in / no-appointment greeting | Menu/options presented |
| 76-80 | 5 | Refund request | Refund flow initiated |
| 81-85 | 5 | Cross-tenant isolation | No data leakage |
| 86-90 | 5 | Confused/off-topic | Help/fallback |
| 91-95 | 5 | Rate limit / abuse | Rate limit enforced |
| 96-100 | 5 | Concurrent booking attempts | No double-book |

### B3: SynthEvents-NG (Ticketing) — BLOCKED

**Status:** M470 `create_ticket_booking_checked` missing on staging.

All 100 customers for B3 will be marked `BLOCKED` with reason: "M470 RPC not deployed."
No test traffic will be generated. When M470 is deployed, scenarios include:
- Event discovery, ticket purchase, check-in, capacity limits, refund, cancellation

### B4: SynthStays-US (Hospitality)

| Range | Count | Scenario | Expected Outcome |
|-------|-------|----------|-----------------|
| 1-20 | 20 | Stay booking → Stripe test checkout | Reservation confirmed |
| 21-30 | 10 | Booking → declined payment | Reservation pending |
| 31-40 | 10 | Check-in flow | Status updated |
| 41-50 | 10 | Cancellation | Reservation cancelled |
| 51-55 | 5 | STOP/START | Consent cycle |
| 56-60 | 5 | Date conflict (fully booked) | Graceful unavailable |
| 61-70 | 10 | Walk-in inquiry | Menu/options |
| 71-80 | 10 | Cross-tenant isolation | No leakage |
| 81-90 | 10 | Confused/malformed | Fallback |
| 91-100 | 10 | Concurrent/replay | Idempotent |

### B5: SynthDining-US (Restaurant) — PARTIALLY BLOCKED

**Status:** M472 `book_table_atomic` + `seating_resources` missing. Table seating blocked.
Menu ordering and basic flows available.

| Range | Count | Scenario | Expected Outcome |
|-------|-------|----------|-----------------|
| 1-20 | 20 | Menu order → Stripe test checkout | Order confirmed |
| 21-30 | 10 | Order declined | Order pending |
| 31-40 | 10 | Menu browsing / customization | Items presented |
| 41-50 | 10 | Cancel/modify order | Order updated |
| 51-60 | 10 | STOP/START/consent | Consent verified |
| 61-70 | 10 | Cross-tenant/isolation | No leakage |
| 71-80 | 10 | Table reservation | **BLOCKED** (M472) |
| 81-90 | 10 | Confused/off-topic | Fallback |
| 91-100 | 10 | Concurrent/replay | Idempotent |

## Rollout Plan (proposal — requires separate authorization)

| Phase | Scope | Prerequisite |
|-------|-------|-------------|
| **Pilot** | 2 customers × 5 businesses = 10 | CTO safety review + Owner run approval |
| **Wave 1** | 20 per business = 100 | Pilot reconciliation pass |
| **Wave 2** | 100 per business = 500 | Wave 1 reconciliation pass |

Concurrency: max 1 concurrent customer per business during pilot.
Rate limit: max 2 requests/second per business.
Abort: >10% error rate or any external egress detection.

## Blocked Prerequisites Register

| Item | Owner | Status | Impact |
|------|-------|--------|--------|
| M470 `create_ticket_booking_checked` | Lane #507 | Not deployed | B3 entirely blocked |
| M471 `cancel_pending_*_for_navigation` | Lane #507 | Not deployed | Cancel-during-navigation blocked |
| M472 `book_table_atomic` | Lane #730 | Draft PR #731 | B5 table seating blocked |
| Server-side Meta capture | This lane | Not implemented | Remote webhook testing blocked |
| Payment sandbox mode proof | This lane | Not verified | Payment execution blocked |
