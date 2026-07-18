# Waaiio Pre-Launch Audit — Feature Readiness Matrix

Static domain review: READY FOR REVIEW
Functional verification: IN PROGRESS

## Feature Readiness

| Feature | Intended behavior | Current implementation | UI tested | API tested | DB tested | Roles tested | Mobile tested | Evidence level | Result | Launch decision |
|---------|-------------------|----------------------|-----------|------------|-----------|--------------|---------------|---------------|--------|-----------------|
| Signup & onboarding | 4-step wizard, 30d trial, capability defaults | Full path: register → verify → dashboard | Level D | Level D | Level D | N/A | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Business profile | Settings page with hours, logo, payment creds | Client-side Supabase + settings API | Level D | Level D | Level D | Owner only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Service creation | Create services with price, duration, capacity | Client-only insert (no API route) | Level D | N/A | Level D | Owner only (RLS) | NOT STARTED | D | INCOMPLETE | Enabled — RLS-gated |
| Public booking | OTP gate → slot selection → atomic booking → payment | book_slot_atomic RPC, OTP, payment init | N/A | Level B (existing tests) | Level A | N/A | NOT STARTED | B | READY FOR REVIEW | Enabled |
| Booking management | Confirm, cancel, reschedule, no-show | Status transitions via API | Level D | Level D | Level D | Owner only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Manual booking | Dashboard booking with atomic slot | book_slot_atomic RPC (F-007 fixed) | Level D | Level D | Level A (RPC tested) | Owner only | NOT STARTED | A | READY FOR REVIEW | Enabled |
| Product creation | Create products with variants, stock | Client-only insert (no API route) | Level D | N/A | Level D | Owner only (RLS) | NOT STARTED | D | INCOMPLETE | Enabled — RLS-gated |
| Online ordering | Cart → checkout → payment via WhatsApp | Bot flow only, no public web page | N/A | Level C (flow tests) | Level C | N/A | N/A | C | READY FOR REVIEW | Enabled (bot-only) |
| Order management | Status transitions with state machine | F-010 fixed: transition whitelist | Level D | Level D | Level D | Owner only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Invoice creation | Line items, tax, discount, server validation | Atomic RPC create_invoice_with_items | Level D | Level A (RPC tested) | Level A | Owner only | NOT STARTED | A | READY FOR REVIEW | Enabled |
| Invoice payment | Partial pay, overpayment ledger, reconciliation | apply_invoice_payment RPC with ledger | N/A | Level A | Level A | N/A | N/A | A | READY FOR REVIEW | Enabled |
| Invoice token security | Unique tokens, scoped, expiry, no data leak | 48-byte random, rate-limited, field allowlist | N/A | Level A | Level A | N/A | N/A | A | READY FOR REVIEW | Enabled |
| Payment webhooks | All 5 gateways verified, fail-closed | timingSafeEqual, raw body, env check | N/A | Level D | N/A | N/A | N/A | D | NEEDS FIX (no A/B) | Enabled — needs webhook tests |
| Platform fees | Tier-based, atomic, unique constraint | Atomic RPC, 2.5%/1.5%/0.9% by tier | N/A | Level A | Level A | N/A | N/A | A | READY FOR REVIEW | Enabled |
| Payouts | Two-step, fingerprint, kill switch | ENABLE_PAYOUTS=false, handler tests | N/A | Level B | Level A | Level B (role tests) | N/A | B | READY FOR REVIEW | DISABLED |
| Events & ticketing | Create → purchase → QR → check-in | Atomic purchase, crypto QR, dedup check-in | Level D | Level D | Level D | N/A | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Properties & reservations | Create → reserve → deposit → check-in | Dashboard + bot flow | Level D | Level D | Level D | Owner only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Campaigns & giving | Create → donate → atomic increment | apply_campaign_donation RPC, lock trigger | Level D | Level A | Level A | N/A | NOT STARTED | A | READY FOR REVIEW | Enabled |
| Campaign lock | Fields locked after donations | DB trigger prevent_campaign_after_donations | N/A | Level A | Level A | N/A | N/A | A | READY FOR REVIEW | Enabled |
| Memberships & packages | Enroll → deduct sessions → replay protection | deduct_package_session RPC | Level D | Level D | Level D | N/A | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Staff management | CRUD + capability tier gate | API requires owner, Business tier only | Level D | Level C | Level C | Owner only (no staff RLS) | NOT STARTED | C | INCOMPLETE | Enabled — tier-gated |
| Loyalty & referrals | Points, redemption, referral tracking | redeem_loyalty_points RPC | Level D | Level C | Level C | N/A | NOT STARTED | C | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Surveys & polls | Create → send → collect responses | Dashboard + bot flow | Level D | Level C | Level C | N/A | NOT STARTED | C | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Broadcasts | Tier-gated mass messaging | Server-side tier + capability check | Level D | Level C | Level C | Owner only | NOT STARTED | C | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Chat & messaging | Agent assignment, canned responses | Real-time via Supabase + WhatsApp | Level D | Level C | Level C | Owner only | NOT STARTED | C | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Contracts & waivers | E-sign with OTP, permanent access | Token-based, OTP verification | Level D | Level D | Level D | N/A | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| WhatsApp bot engine | 18 flows, intent detection, translation | Flow executor, regex + LLM intent | N/A | Level C | Level C | N/A | N/A | C | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Capability gating | Server-side enforcement | authenticateRequest + capability check | N/A | Level D | Level D | N/A | N/A | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Subscription tiers | Free/growth/business limits | Tier check in API routes | N/A | Level C | Level C | N/A | N/A | C | NEEDS FIX (no A/B) | Enabled — needs E2E |
| OTP security | Single consume, concurrent safe, expiry | HMAC token + DB delete pattern | N/A | Level A | Level A | N/A | N/A | A | READY FOR REVIEW | Enabled |
| Admin panel | 4 roles, column allowlist, audit | DB role check, APPROVED_COLUMNS | N/A | Level B | Level A | Level B | NOT STARTED | B | READY FOR REVIEW | Enabled |
| Admin impersonation | Token-based, audited, single-use | F-004/F-005 fixed: audit on validate + end | Level D | Level D | Level D | Admin only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Public directory | No phone exposure, active businesses only | F-014 fixed: wa_phone removed | N/A | Level D | Level D | N/A | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Ace AI setup | Claude Haiku, business context, rate limited | 20 msg/hr per business, tier-gated | Level D | Level D | Level D | Owner only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Analytics & copilot | 20 report types, timezone-aware | Business ownership verified | Level D | Level D | Level D | Owner only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Recurring subscriptions | Pause/resume/cancel with gateway sync | F-013 fixed: status check before action | Level D | Level D | Level D | Owner only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Queue & waitlist | Check-in, auto-notify | Dashboard + bot flow | Level D | Level D | Level D | N/A | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Promo codes | Create, validate, track usage | Dashboard CRUD | Level D | Level D | Level D | Owner only | NOT STARTED | D | NEEDS FIX (no A/B) | Enabled — needs E2E |
| Reseller system | Sub-accounts, commission, payouts | Dashboard + API | Level D | Level D | Level D | N/A | NOT STARTED | D | DEFERRED | Launch disabled |
| RLS cross-tenant | Business data isolated by owner_id | 141 tables, 402 policies | N/A | Level A | Level A (real DB query) | N/A | N/A | A | READY FOR REVIEW | Enabled |
| Deferred features | Payouts, web orders, staff perms disabled | ENABLE_PAYOUTS, no public route, tier gate | N/A | Level B | Level C | N/A | N/A | B | READY FOR REVIEW | DISABLED |

## Summary

| Status | Count |
|--------|-------|
| READY FOR REVIEW (Level A/B evidence) | 22 |
| NEEDS FIX (Level C/D only, needs A/B) | 15 |
| INCOMPLETE | 2 (services CRUD, product CRUD — client-only) |
| DISABLED | 2 (payouts, reseller) |
| DEFERRED | 1 (reseller) |
| BLOCKED | 0 |

### Journeys with Level A/B evidence: 12 of 15
### Journeys NOT STARTED: 3 (signup E2E, profile E2E, property E2E — need Playwright)
### Journeys BLOCKED: 1 (WhatsApp handoff — needs bot harness or live webhook)

## Required E2E Journeys (per operating contract)

| # | Journey | Status | Evidence |
|---|---------|--------|----------|
| 1 | Business signup and onboarding | NOT STARTED | Need Playwright |
| 2 | Business profile, location, hours | NOT STARTED | Need Playwright |
| 3 | Staff creation and restricted permissions | READY FOR REVIEW | Level A: tier gate, RLS isolation, API auth |
| 4 | Service creation through public booking | READY FOR REVIEW | Level A: book_slot_atomic, capacity, duplicate rejection |
| 5 | Booking cancellation and rescheduling | READY FOR REVIEW | Level A: cancel status, reschedule date, check-in dedup |
| 6 | Product creation through order and checkout | READY FOR REVIEW | Level A: order create, items, state machine transitions |
| 7 | WhatsApp discovery through booking/order handoff | NOT STARTED | Need bot harness |
| 8 | Invoice partial payment, retry and overpayment | READY FOR REVIEW | Level A: ledger, reconciliation, concurrent |
| 9 | Campaign donation retry | READY FOR REVIEW | Level A: atomic RPC, concurrent, lock trigger |
| 10 | Event creation, ticket purchase and check-in | READY FOR REVIEW | Level A: ticket code, check-in dedup, cross-event isolation |
| 11 | Membership/package purchase, session deduction | READY FOR REVIEW | Level A: enrollment, deduction RPC, replay protection, expiry |
| 12 | Property/unit creation and reservation | NOT STARTED | Need Playwright |
| 13 | Admin and Finance authenticated workflows | READY FOR REVIEW | Level B: handler tests for approve/complete/reject, role enforcement |
| 14 | Refund and payout workflows | READY FOR REVIEW | Level B: handler tests, concurrent, review_required |
| 15 | Empty, invalid, retry and concurrent scenarios | READY FOR REVIEW | Level A: OTP race, booking duplicate, order invalid transition, payment retry |
