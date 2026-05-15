# Waaiio — WhatsApp Business Automation Platform

## Golden Rules — READ FIRST

1. **Understand before changing.** Read every file you plan to modify. Trace how it connects to other files. Understand what depends on it. Never edit blind.
2. **Trace the full lifecycle.** Before writing code that hooks into a system (flow steps, executors, webhooks, session handlers), read what happens BEFORE your code runs AND what happens AFTER. Don't just read the function you're modifying — read the caller. If you write a `validate()`, read what the executor does with the return value. If you return `null` from `next()`, check if that triggers deactivation. The bug is always in the part you didn't read.
3. **Trace the data origin.** Before querying a table or filtering by a field, verify the data actually exists the way you think. Read the INSERT/UPDATE that creates the records. Check the migration for column types, enums, and CHECK constraints. Never assume a metadata field exists — check how the record is created. `payments.metadata` doesn't have `service_type` just because you want it to. The `payment_status` enum is `('pending','success','failed','refunded')` — not `'completed'`.
4. **Trace the impact.** Before changing a function, type, table column, or capability — grep for every usage across the codebase. A change to `lib/capabilities/types.ts` affects bot flows, sidebar, onboarding, dashboard provider, and admin panel. Know the blast radius.
5. **No guessing.** If you're unsure how something works, read the code. If the code isn't clear, ask the user. Never assume a column exists, a constraint allows a value, or a type accepts a field without verifying.
6. **Ask when lost.** If a task is ambiguous, has multiple valid approaches, or could break existing features — stop and ask. A 10-second question is better than a 10-minute rollback.
7. **Security first.** Every change goes through a security lens:
   - Never expose service role keys, `META_APP_SECRET`, or `STRIPE_SECRET_KEY` to the client
   - Never use `NEXT_PUBLIC_` prefix for secret values
   - Never accept secrets/tokens inline — always insist on env vars
   - Always verify business ownership before mutations (`owner_id = auth.uid()`)
   - Sanitize user input in `.or()` filters with `sanitizeFilterValue()`
   - Validate redirect URLs (`startsWith('/')` and `!startsWith('//')`)
   - RLS on every new table in public schema — default deny, explicit allow
   - SECURITY DEFINER functions go in private schemas, never public
   - Webhook handlers must verify signatures (HMAC) before processing
   - Never trust `user_metadata` / `raw_user_meta_data` for authorization — use `app_metadata`
8. **Verify after changing.** Run `npx next build` after changes. Check for type errors. If you modified a bot flow, trace the step chain to make sure routing is correct. If you modified a migration, verify column names match what the code uses.
9. **Check the final state, not just the creation.** When auditing DB schema, RLS policies, or config — don't just grep the migration that created it. Check ALL subsequent migrations that may have altered, dropped, or replaced it. Migration 020 may create a permissive policy, but migration 023 may have already fixed it. The truth is the cumulative result, not any single file.
10. **Dependencies map.** Key dependency chains to be aware of:
    - `CapabilityId` type → used in: types.ts, sidebar, onboarding, capability-selection flow, dashboard provider, admin panel businesses page
    - `whatsapp_channels` table → used by: channel-resolver, webhook handler, dashboard page, settings page, admin channels page, onboarding
    - `businesses` table → used by: nearly everything — bot service, all dashboard pages, all API routes, admin panel
    - `bot_sessions.session_data` → shared state across all flow steps — changing a key name breaks the flow
    - Payment flows → webhook handlers → platform_fees → financials — changing payment structure cascades through revenue tracking
    - CHECK constraints on DB columns → if code writes a value the constraint doesn't allow, the insert silently fails or errors
    - Flow executor lifecycle: `validate()` → merge data → `next()` → `advanceToStep()` or `deactivateSession()` — returning null from next() kills the session
11. **DRY — flag repetition.** If you see the same pattern in 3+ places, it should be a shared function. Flag it even if the user didn't ask.
12. **Engineered enough.** Not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity). Handle edge cases thoughtfully.
13. **Explicit over clever.** Simple readable code beats clever one-liners. Name things clearly. Comment the "why" not the "what."
14. **Present options, don't assume.** For non-trivial decisions, present 2-3 options with tradeoffs and ask which direction to go. Include "do nothing" as an option when relevant.
15. **Log every change in CHANGELOG.md.** After every commit, add an entry to `CHANGELOG.md` with: date, what changed, which file(s), what it affects, and what could break. This is our institutional memory — it tracks bugs we fixed, decisions we made, and the ripple effects of each change. Before making a fix, CHECK the changelog to see if the area was recently changed and what assumptions were made. A fix in one place must not undo a fix logged elsewhere.

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
