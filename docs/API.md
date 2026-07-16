# Waaiio API Documentation

## Overview

Waaiio is a WhatsApp automation platform with 100+ API endpoints. All API routes are under `/api/` and use Next.js App Router route handlers.

**Authentication:** Most endpoints require a Supabase auth session. Admin endpoints verify `profile.role === 'admin'`. Webhook endpoints use HMAC signature verification.

**Response format:**
```json
// Success
{ "success": true, "data": { ... } }

// Error  
{ "error": "Error message" }  // with appropriate HTTP status code

// Webhooks (always return 200 to prevent retries)
{ "status": "ok" }
```

---

## Webhooks (Inbound)

### `POST /api/webhook/meta-cloud`
Meta Cloud API WhatsApp webhook. Receives incoming WhatsApp messages and routes them to the bot engine.
- **Auth:** `META_APP_SECRET` HMAC-SHA256 signature verification
- **Dedup:** Atomic upsert on `processed_webhook_events` table
- **Flow:** Parse payload → resolve channel → create BotService → handleMessage

### `POST /api/payments/webhook`
Paystack payment webhook. Handles `charge.success`, `charge.failed`, `subscription.create`, `invoice.payment_failed`, `subscription.not_renew`, `subscription.disable`.
- **Auth:** HMAC-SHA512 signature verification
- **Dedup:** Atomic upsert with event ID
- **Alerts:** Creates alerts on payment failures

### `POST /api/payments/stripe-webhook`
Stripe payment webhook. Handles `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`.
- **Auth:** Stripe signature verification (timing-safe)

### `POST /api/webhooks/flutterwave`
Flutterwave payment webhook. Handles `charge.completed` events.
- **Auth:** `verif-hash` header verification

### `POST /api/payments/square-webhook`
Square payment webhook for US market.

### `POST /api/payments/byo-webhook/[businessId]`
Per-business Paystack webhook for BYO (Bring Your Own) payment credentials.

---

## Authentication

### `POST /api/auth/otp/send`
Send OTP to phone number via Termii.
- **Body:** `{ phone: string }`

### `POST /api/auth/otp/verify`
Verify phone OTP and create/login user.
- **Body:** `{ phone: string, otp: string, pinId: string }`

### `POST /api/auth/facebook/callback`
Handle Facebook OAuth callback for WhatsApp Business Account linking.

### `POST /api/auth/facebook/discover`
Discover available WhatsApp Business Accounts for a Facebook user.

### `GET /api/auth/profile`
Get current user's profile data.

---

## Onboarding

### `GET /api/onboarding/check-name`
Check if a business name or bot code is available.
- **Query:** `name=string&bot_code=string`

### `POST /api/onboarding/register`
Register a new business with bot configuration.
- **Body:** `{ name, city, neighborhood, address, phone, category, country, bot_alias?, bot_greeting?, bot_code?, wa_method, capabilities? }`
- **Returns:** `{ business_id, bot_code }`

### `POST /api/onboarding/subscribe`
Subscribe a business to a paid plan.
- **Body:** `{ business_id, plan, payment_method? }`

### `POST /api/onboarding/verify`
Verify business WhatsApp connection is working.

---

## Dashboard

### `GET /api/dashboard/alerts`
Fetch alerts for the authenticated user's business (paginated).
- **Query:** `page=number`
- **Returns:** `{ alerts: Alert[], total: number }`

### `PATCH /api/dashboard/alerts`
Mark alerts as read.
- **Body:** `{ alertIds: string[] }`

### `POST /api/receipts/generate`
Generate a PDF receipt for a booking.

### `GET /api/payouts/balance`
Get current payout balance and history.

### `POST /api/payouts/setup`
Configure payout bank account.

---

## Chat

### `POST /api/chat/send`
Send a message from business to customer via WhatsApp.
- **Rate limit:** 20 requests per 60 seconds
- **Body:** `{ businessId, to, message }`

### `GET /api/chat/list`
List chat conversations for a business.

### `POST /api/chat/resolve`
Mark a chat as resolved (end human handoff).

### `POST /api/chat/reopen`
Reopen a resolved chat.

---

## Orders

### `POST /api/orders/quote-respond`
Business responds to a quote request (accept/reject with price).
- **Rate limit:** 20 requests per 60 seconds

### `POST /api/orders/update-status`
Update order status (preparing, ready, delivered, etc).

### `POST /api/orders/tracking`
Update delivery tracking info.

---

## Invoices

### `POST /api/invoices`
Create a new invoice.

### `GET /api/invoices/[id]`
Get invoice details.

### `POST /api/invoices/send`
Send invoice to customer via WhatsApp.

### `POST /api/invoices/pay`
Initialize payment for an invoice.

### `GET /api/invoices/pdf/[id]`
Generate invoice PDF.

---

## Admin

### `POST /api/admin/impersonate`
Impersonate a business (admin only). Creates a time-limited token and audit log.

### `POST /api/admin/impersonate/end`
End impersonation session.

### `POST /api/admin/payouts/generate`
Generate payout batch for businesses.

### `POST /api/admin/payouts/[id]/approve`
Approve a pending payout.

### `POST /api/admin/payments/refund`
Process a payment refund.

### `POST /api/admin/businesses/[id]/capabilities`
Override capabilities for a specific business.

---

## Cron Jobs

Configured in `vercel.json`, protected by `CRON_SECRET`.

### `GET /api/cron/trial-check`
Daily 9 AM — Check and expire business trials.

### `GET /api/cron/reminders`
Daily 8 AM — Send appointment reminders via WhatsApp.

### `GET /api/cron/cleanup`
Daily 3 AM — Clean up expired sessions and stale data.

---

## Contracts (WhatsApp E-Signature)

### `POST /api/contracts/send`
Send a contract for signature via WhatsApp.

### `POST /api/contracts/submit`
Submit a signed contract.

### `GET /api/contracts/pdf/[id]`
Generate signed contract PDF.

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access |
| `PAYSTACK_SECRET_KEY` | Paystack payment processing |
| `STRIPE_SECRET_KEY` | Stripe payment processing |
| `ANTHROPIC_API_KEY` | LLM intent detection |
| `SENTRY_DSN` | Error tracking |
| `NEXT_PUBLIC_POSTHOG_KEY` | Analytics |
| `RESEND_API_KEY` | Email sending |
| `CRON_SECRET` | Cron job authentication |
