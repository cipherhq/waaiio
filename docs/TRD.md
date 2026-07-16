# Technical Requirements Document (TRD)

**Product:** Waaiio — AI-Powered WhatsApp & Web Automation Platform
**Entity:** CipherHQ LLC d/b/a Waaiio
**Version:** 1.0 | Date: 2026-05-27

---

## 1. System Architecture

```
Client (Browser / WhatsApp)
    │
    ▼
Vercel Edge Network (CDN + Serverless)
    │
    ├── Next.js 14 App Router (SSR + API Routes)
    │       ├── 174 API routes (app/api/)
    │       ├── 67 dashboard pages (app/dashboard/)
    │       ├── Public pages: /e/[slug], /b/[slug], /directory
    │       └── Middleware: CSP, CSRF, rate limiting, auth
    │
    ├── Supabase (PostgreSQL + Auth + Storage + Realtime)
    │       ├── 100+ tables, 295+ indexes
    │       ├── 162 migrations (NNN_description.sql)
    │       ├── RLS on all public schema tables
    │       └── RPC functions for atomic operations
    │
    ├── WhatsApp (Meta Cloud API)
    │       ├── Inbound: webhook → bot.service.ts → flow executor
    │       └── Outbound: channel resolver → MetaCloudSender
    │
    └── Admin Panel (Vite + React, separate deploy)
            ├── 43 admin pages
            └── Role-gated: admin, support, finance, operations
```

## 2. Database Design

- **Tables:** 100+ across public schema
- **Migrations:** 162 files (001 through 162), cumulative
- **RLS:** 100% coverage. Zero permissive USING(true) policies on PII tables. All dropped in migration 144.
- **Key tables:** businesses, bookings, payments, services, products, events, bot_sessions, whatsapp_channels, customer_profiles, platform_fees, subscriptions, ai_usage
- **Atomic operations:**
  - `book_slot_atomic` — SELECT FOR UPDATE + slot validation, prevents double-booking
  - `purchase_tickets_atomic` — lock event row, check availability, increment tickets_sold
  - `redeem_loyalty_points` — FOR UPDATE prevents double-redeem
  - `increment_form_response_count` — atomic counter increment
  - `increment_campaign_donation` — atomic raised_amount + donor_count
- **Enums:** payment_status (pending/success/failed/refunded), booking_status (pending/confirmed/in_progress/completed/no_show/cancelled), user_role (restaurant_owner/restaurant_staff/admin/support/finance/operations)
- **Key constraints:** 
  - Unique partial index on platform_fees (booking_id/invoice_id/campaign_id WHERE refunded_at IS NULL)
  - Payout dedup: UNIQUE(business_id, period_start, period_end) WHERE status NOT IN (rejected, failed)
  - Subscription: UNIQUE(business_id) — one per business, upsert on re-onboarding
  - Bot sessions: unique partial index prevents duplicate active sessions

## 3. API Design

- **Total routes:** 174
- **Auth patterns:**
  - Standard: `supabase.auth.getUser()` for session validation
  - Business ownership: `authenticateRequest({ requireBusinessOwnership: true })`
  - Public with OTP: `verifyOtpToken(otpToken)` — HMAC-signed, 15min TTL
  - Admin: server-side role check against profiles.role
  - Webhooks: HMAC signature verification, fail-closed
- **Rate limiting:**
  - Global: 120 write / 300 read per min per IP (middleware)
  - Per-phone bot: 20 messages/min (bot.service.ts)
  - Per-route: 42 route-specific limits
  - LLM intent: 30/min global
  - Translation: 50/min global
  - OTP: 3/email/10min + 10/IP/10min
  - Webhooks and cron exempted from IP limits
- **Error handling:** Generic messages to clients; error.message logged server-side only
- **Cron jobs (12):**

| Job | Schedule (UTC) |
|-----|---------------|
| Backup | 2:00 AM |
| Cleanup | 3:00 AM |
| Customer Intelligence | 4:00 AM |
| Auto-Payout | Mon 6:00 AM |
| Recurring Invoices | 7:00 AM |
| Reminders | 8:00 AM |
| Trial Check | 9:00 AM |
| Balance Reminder | 9:15 AM |
| Business Health | 10:00 AM |
| Low-Stock Alerts | 10:20 AM |
| Payout Nudge | 11:00 AM |
| Quote Expiry | 11:30 AM |

## 4. Bot Architecture

- **Entry:** `lib/bot/bot.service.ts` (2,478 lines, decomposed into 9 handler modules in `lib/bot/handlers/`)
- **Flow engine:** `lib/bot/flows/executor.ts` — step-based with validate() → merge data → next() → advanceToStep() or deactivateSession()
- **17 flow files:** appointment, scheduling, ordering, reservation, ticketing, payment, chat, crowdfunding, feedback, invoice, loyalty, poll, queue-checkin, recurring-manage, survey, waitlist, capability-selection
- **Intent detection:** Regex-first (`smart-intent.ts`), Claude Haiku fallback (`llm-intent.ts`). Extracts intent, service keywords, date, time, quantity, amount, variant keywords. 5-min result cache.
- **Language support:** 8 languages detected (English, Pidgin, Yoruba, Igbo, Hausa, Twi, French, Spanish). All outgoing messages translated via translateMessage() in executor before sending. 30-min template cache on translations.
- **Escape words:** Cancel/restart in 6 languages (CANCEL_WORDS + RESTART_WORDS arrays)
- **Channel resolver priority:** assigned_channel_id → dedicated → country shared → any shared
- **Session management:** bot_sessions table with is_active flag. last_active_at updated every message. DB trigger auto-sets last_active_at on deactivation (migration 147).
- **Capability gating:** Bot menu only shows capabilities with backing data (services, products, events, properties). Non-user-facing capabilities filtered out.
- **Pre-booking questions:** Self-looping flow step, max 3 questions, answers in bookings.metadata.custom_answers
- **Cost protection:** Per-phone rate limit (20/min), LLM cap (30/min), translation cap (50/min), abuse detection (gibberish → 5min timeout, profanity → 30min timeout)

## 5. Payment Pipeline

**5 Gateways:** Paystack (NG/GH), Stripe (US/CA/UK), Flutterwave, Square, PayPal (PPCP)

**Flow:**
1. Gateway checkout → customer pays
2. Webhook fires → signature verified (HMAC + timingSafeEqual)
3. Fail-closed: reject if signature secret env var is unset
4. Idempotency: processed_webhook_events table with upsert + ignoreDuplicates
5. Amount verified against stored payment.amount (all 5 gateways)
6. Payment status updated
7. Platform fee recorded (unique index prevents duplicates)
8. Booking/order confirmed
9. Confirmation sent (WhatsApp + email) — dedup via confirmation_sent_at atomic UPDATE WHERE NULL
10. Post-completion: loyalty points, feedback request, referral tracking

**Shared functions:** `lib/payments/process-success.ts` (pipeline), `lib/payments/send-confirmation.ts` (WhatsApp + email). Change once, updates all 5 gateways.

**Refunds:** processRefund() handles gateway refund + proportional fee reversal + payout adjustment. Admin "Approve & Refund" button calls actual gateway API.

**Payout pipeline:** Auto-payout cron (weekly). Balance re-verified before approval. Cooling period (7 days). Velocity checks. Verification gate (basic level minimum).

## 6. Security Architecture

| Layer | Implementation |
|-------|---------------|
| CSP | Strict headers in middleware.ts, no unsafe-eval, PayPal production-only |
| CSRF | Origin check on POST/PUT/PATCH/DELETE in middleware |
| Auth | Supabase Auth (JWT), email OTP stored in DB, HMAC-signed OTP tokens (15min TTL) |
| Webhooks | HMAC signature verification with timingSafeEqual, fail-closed |
| RLS | All tables, default deny, explicit allow. Defense-in-depth .eq('business_id') on APIs |
| Input | sanitizeFilterValue() for .or() filters, LIKE/ILIKE escape, enum validation, array caps |
| Secrets | Never NEXT_PUBLIC_ for secrets, never VITE_ for service keys, env vars only |
| Redirects | Domain allowlist, startsWith('/') and !startsWith('//') |
| Rate Limit | Per-IP (120w/300r), per-phone (20/min bot), per-route (42), LLM (30/min), translation (50/min) |
| Impersonation | Admin-only, audit logged, field whitelist on editable columns |
| Payments | Amount verification on all 5 gateways, platform fee unique indexes, payout balance re-check |
| Admin | 4 roles with sidebar filtering + server-side role checks, self-role-change blocked |

## 7. DevOps

- **Environments:**
  - Production: waaiio.com (Supabase cxcmiqotkowhxinjbytg)
  - Staging: staging.waaiio.com (Supabase tqjvrzopvtczxfxiwmnz)
  - Admin Production: admin.waaiio.com
  - Admin Staging: admin-staging.waaiio.com
- **Deploy:** Vercel. Main app: `vercel --prod` from project root. Admin: `cd admin && vercel --prod`. Env vars in blowded project (prj_QkvBTiDA905GHTwX5DQCJVyZzd9d).
- **Monitoring:** Sentry for errors (20% server trace sample), PostHog for analytics (consent-gated), structured logging via logger.ts (info visible in production)
- **Cron:** 12 scheduled jobs via Vercel Cron (vercel.json), staggered to avoid collisions
- **Backups:** Daily automated backup cron at 2am, Supabase PITR enabled
- **Health:** /api/health endpoint checks DB connectivity, returns 503 if degraded

## 8. Testing Strategy

- **Unit tests:** 283 tests across 25 suites (Vitest). Run: `npm run test`
- **E2E tests:** 42 tests across 4 files (Playwright + @antiwork/shortest). Run: `npm run test:e2e`
- **Load testing:** Validated at 100 concurrent users via k6
- **Security testing:** 4 rounds of audit (team review, full code audit, RLS/webhook deep dive, final auth audit)
- **Key dependencies:** vitest ^4.1.4, @playwright/test ^1.60.0, @antiwork/shortest ^0.4.9

## 9. Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Next.js 14 (not 15) | Stability; 15 had breaking changes at time of build |
| Supabase (not Firebase) | PostgreSQL + RLS + native auth + real-time |
| Vercel (not AWS) | Zero-config serverless, edge CDN, preview deploys |
| Claude Haiku for NLU | Cost-effective ($0.001/call), supports Pidgin/Yoruba |
| In-memory rate limiting | Works per-instance; Upstash Redis ready for cross-instance |
| Step-based flows (not drag-and-drop) | Maintainable, testable, no user configuration needed |
| overflow-x: clip (not hidden) | Prevents mobile horizontal scroll without breaking sticky positioning |
