# Waaiio Pre-Launch Audit — Phase 1: Inventory

## Summary Counts

| Category | Count |
|----------|-------|
| Dashboard pages | 59 |
| Public/marketing pages | 24 |
| Auth pages | 4 |
| API routes | ~239 |
| Admin panel pages | 43 |
| Database tables | 141 |
| RLS policies | 402 |
| Public RPCs/functions | 50+ |
| Migrations | 278 |
| Capabilities | 31 |
| Subscription tiers | 3 (free/growth/business) |
| Payment gateways | 5 (Paystack/Stripe/Flutterwave/Square/PayPal) |
| Bot conversation flows | 18 primary |
| Cron jobs (edge functions) | 14 |
| Cron jobs (API routes) | 27 |
| Admin roles | 5 (anon/authenticated/support/finance/operations/admin) |
| Countries | 6 (NG/US/GB/CA/GH/IN) |
| Test files | 129 |
| Unit tests | 784 |
| E2E tests (Playwright) | 13 |
| DB integration tests | 49 |

## Feature Domains

### 1. Authentication & Onboarding
- Login (email/password, OTP, Facebook OAuth)
- Signup (email, business name, password)
- Password reset
- 4-step onboarding wizard (signup → industry → details → live)
- 30-day free trial

### 2. Business Profiles & Settings
- Business info (name, logo, category, country)
- Operating hours (day-by-day)
- Multiple locations
- Payment gateway credentials
- WhatsApp channel setup
- Notification preferences
- API key management

### 3. Services & Bookings
- Service catalog (name, duration, price, image)
- Appointment booking (date/time/staff selection)
- Scheduling (on-demand services)
- Calendar view
- Booking management (confirm/cancel/reschedule/no-show)
- Pre-booking questions
- Buffer time between appointments
- Atomic slot booking (advisory locks)

### 4. Products & Orders
- Product catalog (name, price, image, stock, variants, addons)
- Online ordering (cart, checkout, delivery zones)
- Order management (status transitions)
- Quotes (send/accept/reject)
- Volume discounts
- Low stock alerts

### 5. Payments & Invoices
- 5 payment gateways (Paystack/Stripe/Flutterwave/Square/PayPal)
- Payment links
- Invoice creation (line items, tax, discount)
- Partial payments
- Overpayment tracking (ledger)
- Recurring billing (subscriptions)
- Refunds (full/partial)
- Receipt generation (PDF + WhatsApp)
- Platform fee calculation (tier-based)
- Bank transfer verification (receipt OCR)

### 6. Properties & Reservations
- Property/room/unit management
- Reservation booking
- Check-in (QR code scanner)
- Deposit handling

### 7. Events & Ticketing
- Event creation
- Ticket types and pricing
- Ticket purchase (QR code generation)
- Event check-in (scanner)
- Guest lists and invitations
- RSVP
- Event cancellation (notify + refund)

### 8. Campaigns & Giving
- Fundraising campaigns
- Donation collection
- Campaign stats (raised/goal/donors)
- Tithing/offering (church giving)

### 9. Communication
- WhatsApp bot (18 conversation flows)
- Live chat (agent assignment, canned responses)
- Broadcasts (bulk WhatsApp/SMS)
- Email notifications (30+ templates via Resend)
- Keyword campaigns
- Automation sequences

### 10. Customer Management
- Customer profiles (CRM)
- CSV import/export
- Tags and notes
- Customer insights (LTV, churn risk)
- Consent tracking (GDPR)
- Data export/deletion

### 11. Loyalty & Engagement
- Points system (earn/redeem)
- Feedback/ratings
- Referral program
- Surveys
- Polls
- Promo codes

### 12. Memberships & Packages
- Membership tiers (auto-upgrade)
- Session packages (buy N sessions)
- Package deduction on booking
- Recurring subscriptions

### 13. Contracts & Waivers
- Digital contract creation
- E-signature with OTP verification
- Permanent access links
- Waiver templates
- Bulk sending

### 14. Admin Panel (4 roles)
- Dashboard (platform metrics)
- Business management (verification, capabilities)
- Payment/payout approval
- Chat history
- System health monitoring
- Audit logging
- Impersonation mode
- AI usage tracking

### 15. Finance & Payouts
- Platform fee collection
- Payout generation
- Two-step approval (approve → complete)
- Gateway transfers (Paystack/Stripe)
- Manual transfers
- Balance verification
- Destination fingerprinting
- Kill switch (ENABLE_PAYOUTS)

### 16. AI Features
- Intent detection (regex + Claude Haiku fallback)
- Message translation (7 languages)
- Audio transcription
- Receipt OCR
- Ace AI setup assistant
- Menu/image parsing (Claude Sonnet)

### 17. Analytics & Reporting
- Business dashboard (revenue, bookings, orders)
- Copilot queries (20 report types)
- Conversion funnel analysis
- Financial reports
- Activity logs

### 18. Public Pages
- Homepage, features, pricing
- Business directory/discovery
- Blog
- Legal pages (privacy, terms, refund, DMCA, DPA, cookies, AUP, AML/KYC)
- Public booking/invoice/event pages

## Test Coverage by Evidence Level

| Level | Description | Test count | Domains covered |
|-------|------------|------------|-----------------|
| A | Real browser/DB/provider | 62 | Auth, marketing, DB constraints, RLS, E2E smoke |
| B | Real handler + provider stub | 48 | Payout handler, payment processing, webhook handling |
| C | Unit with mocks | 674 | Bot flows, fee calc, intent, sanitization, encryption |
| D | Source inspection | ~30 | Source-text assertions on route patterns |

## Capability/Tier Matrix

| Capability | Free | Growth | Business |
|-----------|------|--------|----------|
| appointment | Y | Y | Y |
| scheduling | Y | Y | Y |
| payment | Y | Y | Y |
| ordering | Y | Y | Y |
| ticketing | Y | Y | Y |
| giving | Y | Y | Y |
| chat | Y | Y | Y |
| feedback | Y | Y | Y |
| poll | Y | Y | Y |
| estimates | Y | Y | Y |
| table_reservation | Y | Y | Y |
| reservation | - | Y | Y |
| recurring | - | Y | Y |
| broadcast | - | Y | Y |
| membership | - | Y | Y |
| survey | - | Y | Y |
| invoice | - | Y | Y |
| auto_reply | - | Y | Y |
| loyalty | - | Y | Y |
| referral | - | Y | Y |
| reminders | - | Y | Y |
| packages | - | Y | Y |
| class_booking | - | Y | Y |
| multi_location | - | Y | Y |
| staff | - | - | Y |
| whatsapp_sign | - | - | Y |
| reports | - | - | Y |
| waitlist | - | - | Y |
| queue | - | - | Y |
| crowdfunding | - | - | Y |
| waiver | - | - | Y |

## Role Permission Matrix

| Resource | Admin | Finance | Support | Operations |
|----------|-------|---------|---------|------------|
| businesses | RWD | - | R | RW |
| bookings | RWD | - | RW | RW |
| payments | RWD | R | R | - |
| payouts | RWD | RW | - | - |
| events | RWD | - | R | RW |
| tickets | RWD | - | R | RW |
| orders | RWD | - | RW | RW |
| invoices | RWD | R | - | - |
| subscriptions | RWD | R | - | - |
| whatsapp_channels | RWD | - | - | R |
| team | RWD | - | - | - |
| settings | RWD | - | - | - |
| resellers | RWD | R | - | - |
| transfers | RWD | RW | - | - |
| campaigns | RWD | - | - | RW |
| bot | RWD | - | - | RW |
| verification | RWD | - | R | - |

R=Read, W=Write, D=Delete, -=No access
