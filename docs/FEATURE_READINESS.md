# Waaiio Pre-Launch Audit — Feature Readiness Matrix

Status: IN PROGRESS

## Feature Journey Classification

| # | Feature | Dashboard | API | Bot | Public | DB | Status | Evidence | Notes |
|---|---------|-----------|-----|-----|--------|-----|--------|----------|-------|
| 1 | Signup & onboarding | Y | Y | - | Y | Y | READY FOR REVIEW | Level D | Full path verified: signup→category→details→trial→dashboard |
| 2 | Business profile & settings | Y | Y | - | - | Y | READY FOR REVIEW | Level D | Settings page with payment credentials, hours, notifications |
| 3 | Service creation | Y | ⚠️ | - | - | Y | NEEDS FIX | Level D | F-012: Client-only insert, no server API route |
| 4 | Public booking | - | Y | Y | Y | Y | READY FOR REVIEW | Level B | Atomic RPC, OTP gate, slot validation |
| 5 | Booking management | Y | Y | - | - | Y | READY FOR REVIEW | Level D | Status transitions, reschedule (F-009: past date) |
| 6 | Manual booking | Y | Y | - | - | Y | READY FOR REVIEW | Level D | F-007/F-008 FIXED: now uses book_slot_atomic |
| 7 | Product creation | Y | ⚠️ | - | - | Y | NEEDS FIX | Level D | Client-only insert like services; no server API |
| 8 | Online ordering | - | - | Y | - | Y | READY FOR REVIEW | Level C | Bot-only ordering flow; no public web ordering |
| 9 | Order management | Y | Y | - | - | Y | NEEDS FIX | Level D | F-010: No status state machine |
| 10 | Invoice creation | Y | Y | - | - | Y | READY FOR REVIEW | Level A | Atomic RPC, server validation, line items |
| 11 | Invoice payment | - | Y | Y | Y | Y | READY FOR REVIEW | Level A | Partial payment, overpayment ledger, reconciliation |
| 12 | Payment webhooks (5 gateways) | - | Y | - | - | Y | READY FOR REVIEW | Level D | All 6 verified: fail-closed, timingSafeEqual |
| 13 | Refunds | Y | Y | - | - | Y | READY FOR REVIEW | Level C | Full/partial, gateway API, fee reversal |
| 14 | Platform fees | - | Y | - | - | Y | READY FOR REVIEW | Level A | Tier-based, atomic, unique constraint |
| 15 | Payouts | Y | Y | - | - | Y | READY FOR REVIEW | Level B | Two-step, fingerprint, kill switch |
| 16 | Events & ticketing | Y | Y | Y | Y | Y | READY FOR REVIEW | Level D | Atomic purchase, QR, check-in dedup |
| 17 | Properties & reservations | Y | Y | Y | - | Y | READY FOR REVIEW | Level D | Deposit tracking, blocked dates |
| 18 | Campaigns & giving | Y | Y | Y | - | Y | READY FOR REVIEW | Level A | F-016 FIXED: locked after donations |
| 19 | Memberships & packages | Y | Y | Y | - | Y | READY FOR REVIEW | Level D | Enrollment, atomic deduction, replay protection |
| 20 | Staff management | Y | Y | - | - | Y | INCOMPLETE | Level D | CRUD works; no permission enforcement |
| 21 | Loyalty & referrals | Y | Y | Y | - | Y | READY FOR REVIEW | Level C | Points, redemption, referral tracking |
| 22 | Surveys & polls | Y | Y | Y | - | Y | READY FOR REVIEW | Level C | Create, send, collect responses |
| 23 | Broadcasts | Y | Y | - | - | Y | READY FOR REVIEW | Level C | Tier-gated, capability-checked server-side |
| 24 | Chat & messaging | Y | Y | Y | - | Y | READY FOR REVIEW | Level C | Agent assignment, canned responses |
| 25 | Contracts & waivers | Y | Y | - | - | Y | READY FOR REVIEW | Level D | E-sign with OTP, permanent access |
| 26 | WhatsApp bot engine | - | Y | Y | - | Y | READY FOR REVIEW | Level C | 18 flows, intent detection, translation |
| 27 | Capability gating | Y | Y | Y | - | Y | READY FOR REVIEW | Level D | Server-side enforcement confirmed |
| 28 | Subscription tiers | Y | Y | - | - | Y | READY FOR REVIEW | Level D | Free/growth/business, feature limits |
| 29 | Admin panel | - | Y | - | - | Y | READY FOR REVIEW | Level B | 4 roles, column allowlist, audit |
| 30 | Admin impersonation | - | Y | - | - | Y | NEEDS FIX | Level D | F-004/F-005: incomplete audit logging |
| 31 | Public directory | - | Y | - | Y | Y | READY FOR REVIEW | Level D | F-014 FIXED: wa_phone removed |
| 32 | Ace AI setup | Y | Y | - | - | Y | READY FOR REVIEW | Level C | Claude Haiku, 24 business types |
| 33 | Analytics & reporting | Y | Y | - | - | Y | READY FOR REVIEW | Level C | Copilot queries, timezone-aware |
| 34 | Customer management | Y | Y | - | - | Y | READY FOR REVIEW | Level D | CRM, import, tags, consent |
| 35 | Recurring subscriptions | Y | Y | Y | - | Y | NEEDS FIX | Level D | F-013: resume without status check |
| 36 | Queue & waitlist | Y | Y | Y | - | Y | READY FOR REVIEW | Level D | Check-in, auto-notify |
| 37 | Delivery zones | Y | - | - | - | Y | READY FOR REVIEW | Level D | Dashboard config only |
| 38 | Promo codes | Y | Y | - | - | Y | READY FOR REVIEW | Level D | Create, validate, track usage |
| 39 | Keyword campaigns | Y | Y | - | - | Y | READY FOR REVIEW | Level D | Keyword triggers, responses |
| 40 | Reseller system | Y | Y | - | - | Y | READY FOR REVIEW | Level D | Sub-accounts, commission, payouts |

## Fix Priority

### Critical (must fix before launch)
- None remaining (F-007 fixed)

### High (must fix or disable)
- None remaining (F-008, F-014, F-016 fixed)

### Medium (fix if safe and isolated)
| ID | Feature | Fix |
|----|---------|-----|
| F-001 | Email OTP race | Add isolation level |
| F-004 | Impersonation validate audit | Add audit log |
| F-005 | Impersonation end audit | Add audit log |
| F-009 | Reschedule past date | Add date validation |
| F-010 | Order status machine | Add transition whitelist |
| F-012 | Services client-only CRUD | Create API route |
| F-013 | Subscription resume | Add status check |
| F-015 | Invoice public address | Redact from response |
| F-017 | Campaign goal validation | Accept — DB trigger now handles |
| F-018 | Admin CORS localhost | Use env var only |

### Low (defer)
| ID | Feature | Reason |
|----|---------|--------|
| F-002 | Login IP in email | Standard practice |
| F-003 | OTP timing | Rate-limited |
| F-006 | Cron abuse | ENABLE_PAYOUTS=false |
| F-011 | Booking status transition | Low impact |
| F-019 | Phone in comment | Informational |

## Incomplete Features (not launch-blocking if disabled)

| Feature | What's missing | Disable method |
|---------|---------------|----------------|
| Staff permissions | No RLS enforcement for staff viewing other staff's bookings | staff capability = Business tier only |
| Web ordering | No public order page; orders via WhatsApp only | Already bot-only; no change needed |
| Services server validation | Client-only CRUD | RLS prevents cross-tenant; owner can corrupt own data |
| Product server validation | Client-only CRUD | Same as services |
