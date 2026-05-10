# Waaiio — WhatsApp Business Automation Platform

## Quick Start
```bash
npm run dev          # Next.js dev server (port 3000)
npm run build        # Production build
cd admin && npm run dev  # Admin panel (port 8083)
```

## Architecture
- **Main app:** Next.js 14 + React 18 + TypeScript + Tailwind CSS
- **Admin panel:** Vite + React 18 (separate app in `admin/`)
- **Database:** Supabase (PostgreSQL + Auth + Storage + Realtime)
- **WhatsApp:** Meta Cloud API (premium) + Gupshup (shared numbers)
- **Payments:** Paystack (NG/GH), Stripe (US/GB/CA), Flutterwave, Square
- **AI:** Anthropic Claude (intent detection), OpenAI Whisper (voice transcription)
- **Email:** Resend
- **Analytics:** PostHog
- **Monitoring:** Sentry
- **Deploy:** Vercel (main app), separate deploy for admin

## Path Alias
`@/*` maps to project root (`./`). Example: `@/lib/constants`, `@/components/ui/Button`

## Key Directories
```
app/                    # Next.js App Router pages
  api/                  # 149 API routes
  dashboard/            # 59 protected business dashboard pages
  (auth)/               # Login, signup, forgot-password
  (marketing)/          # Public marketing pages
  get-started/          # Onboarding wizard
lib/
  bot/                  # WhatsApp bot engine (25 flows, intent detection, translation)
  bot/flows/            # Conversational flows (executor, step-manifest, 17 flow files)
  channels/             # WhatsApp channel resolution & message sending
  payments/             # Payment gateway integrations (factory pattern)
  capabilities/         # 24 capability types, tier gating, category defaults
  supabase/             # 3 clients: client.ts (browser), server.ts (SSR), service.ts (admin)
  pdf/                  # PDF generation (invoices, receipts, tickets, contracts)
  email/                # Email templates and sending
components/
  dashboard/            # DashboardProvider, Sidebar, EmptyState, PageHelp, OnboardingChecklist
  ui/                   # Shared UI primitives
admin/                  # Separate Vite admin panel
  src/pages/            # 43 admin pages
  src/lib/              # Admin utilities (adminAuth, supabase, etc.)
supabase/
  migrations/           # 126+ migrations (NNN_description.sql naming)
  functions/            # Edge Functions (cron jobs)
```

## Supabase
- **Project ref:** `cxcmiqotkowhxinjbytg`
- **3 client patterns:**
  - `createClient()` from `@/lib/supabase/client` — browser, respects RLS
  - `createClient()` from `@/lib/supabase/server` — SSR, reads cookies
  - `createServiceClient()` from `@/lib/supabase/service` — bypasses RLS, admin/cron only
- **RLS:** All tables in public schema have RLS enabled. Use service client only when necessary.
- **Migrations:** Named `NNN_description.sql`. Create with `supabase migration new <name>` then rename.
- **Run migrations on remote:** Use Management API:
  ```bash
  SQL=$(cat supabase/migrations/NNN_file.sql)
  curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg q "$SQL" '{query: $q}')"
  ```

## Bot Architecture
- Entry: `lib/bot/bot.service.ts` (2,478 lines) — main message orchestrator
- Flow engine: `lib/bot/flows/executor.ts` — step-based conversation flows
- Each flow has steps with: `prompt()`, `validate()`, `next()`, `skipIf()`
- 17 flow files: appointment, scheduling, ordering, reservation, ticketing, payment, chat, crowdfunding, feedback, invoice, loyalty, poll, queue-checkin, recurring-manage, survey, waitlist, capability-selection
- Intent detection: regex first (`smart-intent.ts`), Claude Haiku fallback (`llm-intent.ts`)
- Channel resolver priority: assigned_channel_id → dedicated → country shared → any shared
- Escape hatches: "cancel", "exit", "quit", "stop", "restart", "start over"

## Capability System
24 capabilities: `scheduling`, `appointment`, `payment`, `ordering`, `ticketing`, `reservation`, `whatsapp_sign`, `reminders`, `crowdfunding`, `reports`, `queue`, `feedback`, `loyalty`, `chat`, `waitlist`, `referral`, `staff`, `invoice`, `survey`, `poll`, `giving`, `broadcast`, `recurring`, `auto_reply`, `membership`

- Defined in `lib/capabilities/types.ts`
- Each capability has a tier requirement (free/growth/business)
- Category defaults in `CATEGORY_DEFAULT_CAPABILITIES`
- Bot only shows capabilities with backing data (no empty options)
- Sidebar items are gated by capabilities

## API Route Patterns
```typescript
// Standard pattern
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // ... business logic
  return NextResponse.json({ success: true });
}

// With business ownership verification
const { user, businessId, service } = await authenticateRequest(request, {
  requireBusinessOwnership: true,
  businessIdKey: 'businessId',
});
```

## Dashboard Page Patterns
```typescript
'use client';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { EmptyState } from '@/components/dashboard/EmptyState';

export default function MyPage() {
  const business = useBusiness();
  // Load data with: supabase.from('table').select().eq('business_id', business.id)
  // Show PageHelp banner at top
  // Show EmptyState when no data
}
```

## Environment Variables (required)
```
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_APP_URL
META_CLOUD_ACCESS_TOKEN, META_CLOUD_WABA_ID, META_CLOUD_PHONE_NUMBER_ID
NEXT_PUBLIC_META_APP_ID, META_APP_SECRET
PAYSTACK_SECRET_KEY, NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY
STRIPE_SECRET_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET
ANTHROPIC_API_KEY
RESEND_API_KEY
NEXT_PUBLIC_POSTHOG_KEY
```

## Conventions
- **Always commit and push** — don't ask, just do it
- **No sample data during onboarding** — businesses add their own content
- **Bot flows need "I've Paid" verification step** for all payment flows
- **Security:** Never use `VITE_` prefix for secret keys. Validate redirect params. Use `sanitizeFilterValue()` for `.or()` filters.
- **Multi-tenant:** business_id is the partition key. RLS enforces isolation.
- **Naming:** Migrations are `NNN_description.sql`. API routes are `/api/{resource}/{action}/route.ts`.
- **Testing:** `npm run test` (Vitest). E2E with `@antiwork/shortest`.

## Brand
- Primary color: Purple (#6C2BD9)
- Accent: Orange (#F59E0B)  
- WhatsApp Green: #25D366
- Dark mode: class-based toggle

## Common Tasks
- **New dashboard page:** Create `app/dashboard/{name}/page.tsx`, add to Sidebar.tsx with capability gate
- **New bot flow:** Create `lib/bot/flows/{name}.flow.ts`, register in `registry.ts`, add capability routing in `capability-selection.flow.ts`
- **New capability:** Add to `CapabilityId` union + `CAPABILITIES` array + `CAPABILITY_TIER_REQUIREMENTS` in `lib/capabilities/types.ts`
- **New migration:** `supabase migration new <name>`, rename to `NNN_`, run via Management API
