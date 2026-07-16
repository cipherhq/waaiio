# Product Requirements Document (PRD)

**Product:** Waaiio — AI-Powered WhatsApp & Web Automation Platform
**Entity:** CipherHQ LLC d/b/a Waaiio
**Version:** 1.0 | Date: 2026-05-27

---

## 1. Product Overview

Waaiio provides a business dashboard (web) and a conversational AI bot (WhatsApp) that together automate the full customer lifecycle: discovery, booking, payment, confirmation, reminders, feedback, and re-engagement. Public web pages (/e/[slug] for events, /b/[slug] for services) serve customers without WhatsApp.

## 2. User Roles

| Role | Access | Description |
|------|--------|-------------|
| Business Owner | Dashboard, WhatsApp bot config | Manages services, staff, payments, customers |
| Customer | WhatsApp, public web pages | Books, pays, orders, gives feedback |
| Admin | Admin panel (full access) | Platform-wide oversight, impersonation, finance |
| Support | Admin panel (limited) | Customer/business support, no impersonation |
| Finance | Admin panel (finance views) | Payouts, revenue, subscriptions, giving |
| Operations | Admin panel (ops views) | Businesses, bookings, bot management, channels |

## 3. Feature List (30 Capabilities, 6 Groups)

### Booking & Scheduling (5)
- **Appointments** — 1:1 bookings with date, time, and staff selection (salon, clinic, tutor)
- **Scheduling** — Service requests without specific time picking (laundry, repairs, cleaning)
- **Table Reservations** — Reserve tables with party size for restaurants, cafes, bars
- **Property Reservations** — Multi-night stays with check-in/check-out dates (hotel, shortlet)
- **Class Booking** — Group classes with capacity limits (yoga, dance, bootcamp)

### Payments & Commerce (7)
- **Payments** — One-off payments via WhatsApp (school fees, parking, bills)
- **Ordering** — Browse catalog, add to cart, checkout (shop, food delivery, pharmacy)
- **Giving** — Tithes, offerings, donations for churches, mosques, NGOs
- **Recurring Payments** — Auto-billing subscriptions (monthly memberships, term fees)
- **Invoicing** — Send professional invoices via WhatsApp with payment links
- **Estimates & Quotes** — Send price quotes, customer approves → becomes booking
- **Session Packages** — Sell multi-session bundles (buy 10, redeem over time)

### Events & Tickets (2)
- **Ticketing** — Sell event tickets with QR codes for check-in
- **Crowdfunding** — Fundraising campaigns with goal tracking

### Customer Engagement (8)
- **Live Chat** — Multi-agent customer support with assignment and routing
- **Broadcasts** — Targeted bulk messages with customer segmentation
- **Feedback** — Post-visit ratings and reviews
- **Surveys** — Multi-question customer surveys
- **Polls** — Quick single-question polls
- **Loyalty** — Points per visit, redeemable rewards
- **Referrals** — Refer-a-friend with tracking and rewards
- **Membership** — Tiered membership system

### Operations (7)
- **Staff Management** — Multi-staff scheduling and assignment
- **Queue Management** — Virtual walk-in queues with WhatsApp notifications
- **Waitlist** — Auto-notify when slots open (cancellations, no-shows)
- **Reminders** — Automated 24hr and 2hr booking reminders
- **Auto-Reply** — Bot responds when business is closed
- **Reports** — Dashboard analytics and business intelligence
- **Multi-Location** — Branch routing for chain businesses

### Documents (1)
- **E-Signatures** — Send contracts for digital signature via WhatsApp

## 4. User Journeys

### Onboarding (4 steps)
Sign Up (email/password) → Industry Selection (16 groups → specific type → "Other" option) → Business Details (name, phone, address, WhatsApp connection) → Live (bot code issued, dashboard accessible). Category auto-configures capabilities. No plan selection step; 30-day trial starts automatically.

### Booking via WhatsApp
Customer sends message → NLU parses intent, service, date, time → Bot confirms or asks clarifying questions → Pre-booking questions (if configured) → Terms & conditions → Payment link sent → Customer pays → Confirmation + receipt sent (WhatsApp + email) → 24hr/2hr reminders → Follow-up message (configurable delay)

### Booking via Web
Customer visits /b/[slug] → Picks service → Selects date → Selects time slot → Enters details (name, email, phone) → Email OTP verification → Confirms → Payment (if deposit required) → Confirmation email

### Event Ticket Purchase
Customer visits /e/[slug] or messages WhatsApp → Selects ticket type/quantity → Email OTP verification → Payment → Ticket image generated (next/og with QR code + event flyer background) → Sent via WhatsApp + email → QR scan at venue for check-in

### Payment Pipeline
Customer taps payment link → Gateway checkout (Paystack/Stripe/Flutterwave/Square/PayPal) → Webhook fires → Signature verified (HMAC, fail-closed) → Amount verified against stored payment → Payment status updated → Platform fee recorded → Confirmation sent (WhatsApp + email) → Dedup via confirmation_sent_at

## 5. Platform Architecture Overview

- **Frontend:** Next.js 14 App Router, 67 dashboard pages, React 18, Tailwind CSS, Framer Motion
- **Backend:** Next.js API routes (174 endpoints), Supabase PostgreSQL, Vercel serverless
- **Admin Panel:** Separate Vite + React app (43 pages), role-gated sidebar
- **Bot Engine:** WhatsApp via Meta Cloud API, 17 flow files, step-based executor
- **AI:** Anthropic Claude (intent detection, translation in 7 languages), OpenAI Whisper (voice transcription)
- **Ace AI Setup Assistant:** 5-step wizard with image OCR (Claude Sonnet) and text extraction (Claude Haiku)

## 6. Integration Points

| System | Purpose | Protocol |
|--------|---------|----------|
| Meta Cloud API | WhatsApp messaging | REST + Webhooks |
| Paystack | Payments NG/GH | REST + Webhooks |
| Stripe | Payments US/CA/UK | REST + Webhooks |
| Flutterwave | Payments (alternative Africa) | REST + Webhooks |
| Square | Payments (alternative US) | REST + Webhooks |
| PayPal (PPCP) | Payments (alternative) | REST + Webhooks |
| Resend | Transactional email | REST |
| Anthropic Claude | NLU intent detection, translation | REST |
| OpenAI Whisper | Voice note transcription | REST |
| PostHog | Analytics (consent-gated) | JS SDK |
| Sentry | Error monitoring | JS SDK |

## 7. Non-Functional Requirements

- **Performance:** Scaled for 500+ concurrent users (Vercel Pro + Supabase Pro). Load tested at 100 concurrent. Booking slots use atomic PostgreSQL functions with SELECT FOR UPDATE.
- **Security:** CSP headers (no unsafe-eval), CSRF origin check on mutations, webhook HMAC verification (timingSafeEqual, fail-closed), RLS on 100% of tables, input sanitization on LIKE queries, per-phone bot rate limiting (20/min).
- **Scalability:** Multi-tenant with business_id partition key. Stateless serverless functions. 295+ database indexes.
- **Availability:** Vercel edge network, Supabase managed PostgreSQL with automated daily backups.
- **Accessibility:** WCAG 2.1 AA — skip link, focus-visible ring, aria-labels, aria-live error regions, prefers-reduced-motion support, role="dialog" on mobile menu.
- **Multilingual:** Bot responds in 7 languages (English, Pidgin, Yoruba, Igbo, Hausa, Twi, French). All outgoing messages translated via AI with 30-min template cache.
