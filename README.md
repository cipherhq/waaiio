# Waaiio

WhatsApp-first business automation platform. Businesses connect their WhatsApp number and get AI-powered booking, payments, ticketing, ordering, and customer engagement -- all through conversational flows. Live in 5 countries (US, CA, NG, GH, UK) with multi-currency payment processing across 5 gateways.

See [CLAUDE.md](./CLAUDE.md) for golden rules, pre-change checklists, and deep implementation details.

---

## Architecture

| Layer | Stack |
|-------|-------|
| Frontend | Next.js 14, React 18, TypeScript, Tailwind CSS |
| Admin Panel | Vite + React 18 (separate app in `admin/`) |
| Database | Supabase (PostgreSQL + Auth + Storage + Realtime) |
| WhatsApp | Meta Cloud API (dedicated numbers) + Gupshup (shared) |
| Payments | Paystack (NG/GH), Stripe (US/GB/CA), Flutterwave, Square, PayPal |
| AI | Anthropic Claude (intent detection + voice transcription) |
| Email | Resend |
| Monitoring | Sentry + PostHog |
| Rate Limiting | Upstash Redis (in-memory fallback when unconfigured) |
| Deploy | Vercel (4 deployments) |

---

## Quick Start

```bash
npm install
cp .env.example .env.local   # Fill in required values
npm run dev                   # http://localhost:3000

# Admin panel (separate app)
cd admin && npm install && npm run dev   # http://localhost:8083
```

---

## Project Structure

```
app/
  api/                    # ~150 API routes
  dashboard/              # Protected business dashboard pages
  (auth)/                 # Login, signup, forgot-password
  (marketing)/            # Public marketing pages
  get-started/            # Onboarding wizard
  checkin/                # QR check-in pages (property, events)
lib/
  bot/                    # WhatsApp bot engine
    bot.service.ts        # Main orchestrator (~2,500 lines)
    flows/                # 17+ conversational flows (executor, step-manifest)
    handlers/             # 9 handler modules
  channels/               # Channel resolution + message sending
  payments/               # Gateway integrations (factory pattern)
  capabilities/           # 24+ capability types, tier gating
  supabase/               # 3 DB clients (browser, SSR, service)
  pdf/                    # PDF generation (invoices, receipts, tickets, contracts)
  email/                  # Email templates + sending
components/
  dashboard/              # DashboardProvider, Sidebar, OnboardingChecklist
  ui/                     # Shared UI primitives
admin/                    # Separate Vite admin panel
  src/pages/              # 43+ admin pages
  src/lib/                # Admin utilities
supabase/
  migrations/             # 219 migrations (NNN_description.sql)
  functions/              # Edge Functions (cron jobs)
```

Path alias: `@/*` maps to project root.

---

## Database

- **Supabase project ref:** `cxcmiqotkowhxinjbytg`
- **219 migrations**, 100+ tables, RLS on every table in public schema

### Three client patterns

| Client | Import | Use case |
|--------|--------|----------|
| Browser | `createClient()` from `@/lib/supabase/client` | Client components, respects RLS |
| SSR | `createClient()` from `@/lib/supabase/server` | Server components, reads cookies |
| Service | `createServiceClient()` from `@/lib/supabase/service` | Admin/cron only, bypasses RLS |

### Migrations

Named `NNN_description.sql`. Run on remote via Management API:

```bash
SQL=$(cat supabase/migrations/NNN_file.sql)
curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$SQL" '{query: $q}')"
```

---

## Environment Variables

See `.env.example` for the full list. Categories:

| Category | Examples | Notes |
|----------|----------|-------|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | URL and anon key are public; service key is server-only |
| WhatsApp | `META_CLOUD_ACCESS_TOKEN`, `META_APP_SECRET` | Never expose `META_APP_SECRET` to client |
| Payments | `STRIPE_SECRET_KEY`, `PAYSTACK_SECRET_KEY` | Secret keys are server-only |
| AI | `ANTHROPIC_API_KEY` | Server-only |
| Email | `RESEND_API_KEY` | Server-only |
| Analytics | `NEXT_PUBLIC_POSTHOG_KEY` | Public (browser-bundled) |
| Rate Limiting | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional; falls back to in-memory |

**Rule:** Never use `NEXT_PUBLIC_` or `VITE_` prefix for secret keys. They get bundled into browser JS.

---

## Testing

```bash
npm run test          # ~339 unit tests, Vitest
npm run test:e2e      # 42 E2E tests, Playwright
```

Bot-specific testing uses a harness at `lib/bot/__tests__/bot-harness.ts` with mock sender, mock DB, and conversation fixtures.

---

## Deployment

| Target | Command | URL |
|--------|---------|-----|
| Main app | `vercel --prod` (from root) | waaiio.com |
| Staging | `vercel --prod` (staging branch) | staging.waaiio.com |
| Admin | `cd admin && vercel --prod` | admin.waaiio.com |
| Admin staging | `cd admin && vercel --prod` (staging) | admin-staging.waaiio.com |

Vercel Pro -- charges per deploy. Always ask before deploying.

**Note:** Vercel env vars are in the "blowded" project, not "waaiio".
**Note:** Admin `VITE_API_URL` must use `https://www.waaiio.com` (non-www redirects strip POST body).

---

## Key Conventions

- **Always commit and push** after changes -- don't ask, just do it
- **CHANGELOG.md** tracks every change with date, files, and impact
- **Payment status enum:** `pending`, `success`, `failed`, `refunded` (not "completed")
- **Booking status enum:** `pending`, `confirmed`, `in_progress`, `completed`, `no_show`, `cancelled`
- **Bot escape words:** cancel, exit, quit, stop, restart, start over (6 languages)
- **Bot error messages:** "Something went wrong on our end" (never "Oops" or slang)
- **Gateway follows business:** `businesses.payment_gateway` overrides country default
- **Multi-tenant isolation:** `business_id` is the partition key; RLS enforces it

---

## Security

### Request protection
- **CSRF:** Origin check in middleware for all mutating methods (POST/PUT/PATCH/DELETE)
- **Rate limiting:** Per-route + global middleware via Upstash Redis (in-memory fallback)
- **Session binding:** IP + User-Agent tracking

### Secrets
- **Token encryption:** AES-256-GCM for stored Meta tokens
- **Service keys** never exposed to client (`SUPABASE_SERVICE_ROLE_KEY`, `META_APP_SECRET`, etc.)
- **Inline tokens refused** -- always use env vars

### Database
- **RLS fully hardened:** No `USING(true)` on user-facing tables
- **Business ownership verified** before mutations (`owner_id = auth.uid()`)
- **SECURITY DEFINER functions** go in private schemas, never public
- **Atomic RPCs** for concurrent-safe operations (slot booking, loyalty points, donations)

### Webhook signatures
- HMAC verification mandatory on all 5 payment gateways
- `timingSafeEqual` for all token/OTP comparisons
- Fail-closed: rejects if webhook secret env var is unset

---

## Webhook Idempotency

All payment webhooks follow the same pattern:

1. **Verify signature** -- HMAC with `timingSafeEqual`, reject if secret env var unset
2. **Verify amount** -- compare webhook amount against stored `payment.amount`
3. **Dedup check** -- skip if `payment_status` is already `success`
4. **Process** -- update payment status, record platform fee, send confirmation
5. **Mark completed** -- set `payment_status = 'success'`

Gateway-specific: Stripe checks `amount_total`, Paystack checks kobo, Square checks `total_money.amount`, PayPal checks `amount`.

---

## Contributing

Read [CLAUDE.md](./CLAUDE.md) before making changes. Key requirements:

1. **Pre-change checklist:** Read the file, grep all callers, verify DB types, check two-function traps
2. **Verify after changing:** `npx next build` + `npm run test` + trace every code path
3. **Security lens:** RLS on new tables, no exposed secrets, sanitized filters, verified webhooks
4. **Log in CHANGELOG.md:** Date, what changed, which files, what could break

### Common tasks

| Task | Steps |
|------|-------|
| New dashboard page | Create `app/dashboard/{name}/page.tsx`, add to `Sidebar.tsx` with capability gate |
| New bot flow | Create `lib/bot/flows/{name}.flow.ts`, register in `registry.ts` |
| New capability | Add to `CapabilityId` union + `CAPABILITIES` + `CAPABILITY_TIER_REQUIREMENTS` in `lib/capabilities/types.ts` |
| New migration | `supabase migration new <name>`, rename to `NNN_`, run via Management API |
