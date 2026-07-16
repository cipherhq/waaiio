# Bot Architecture

## Overview

Waaiio's WhatsApp bot is a multi-tenant, flow-based conversation engine supporting 40+ business categories across 5 countries.

```
WhatsApp Message
  → Meta Cloud Webhook
    → Channel Resolver (shared vs dedicated number)
      → BotService.handleMessage()
        → Pre-checks (timeout, profanity)
        → Business Resolution (bot code, phone mapping)
        → Session Management (create/resume)
        → Smart Intent Detection (regex + LLM hybrid)
        → Flow Executor (step-based conversation)
          → Individual Flow Steps (prompt → validate → next)
```

## Key Files

| File | Purpose |
|------|---------|
| `app/api/webhook/meta-cloud/route.ts` | Meta Cloud API webhook |
| `lib/bot/bot.service.ts` | Main bot orchestrator (~2000 lines) |
| `lib/bot/flows/executor.ts` | Step-based flow execution engine |
| `lib/bot/flows/registry.ts` | Maps flow types to flow definitions |
| `lib/bot/smart-intent.ts` | Regex + LLM hybrid intent detection |
| `lib/bot/llm-intent.ts` | Claude Haiku intent classification |
| `lib/bot/translate.ts` | Multi-language response translation |
| `lib/bot/keyword-service.ts` | Unified keyword matching (system/category/business) |
| `lib/bot/bot-intelligence.ts` | Profanity detection, abuse tracking |
| `lib/bot/standalone.service.ts` | Template rendering, business lookup |
| `lib/bot/handoff.service.ts` | Human handoff (escalation) |
| `lib/channels/channel-resolver.ts` | Resolves WhatsApp number → business + sender |
| `lib/channels/message-sender.ts` | Message sender interface |

## Flow System

### Flow Types
- **scheduling** — Appointments, bookings, check-ins
- **payment** — Tithes, fees, donations, bills
- **ordering** — Product orders, food delivery
- **ticketing** — Event tickets, movie tickets
- **reservation** — Duration-based stays (hotels)
- **queue** — Queue check-in and notifications

### Extended Flows (Pseudo-flows)
- **capability-selection** — Routes to the correct flow based on business capabilities
- **crowdfunding** — Campaign-based fundraising
- **feedback** — Post-service reviews
- **waitlist** — Waitlist signup
- **chat** — Human handoff
- **loyalty** — Points and rewards
- **invoice** — Invoice generation and payment
- **recurring-manage** — Subscription management

### Flow Step Structure

Each flow is an array of steps. A step has:

```typescript
interface FlowStep {
  id: string;                              // Unique step ID
  prompt(ctx: FlowContext): Promise<PromptMessage[]>;   // What to show the user
  validate(input: string, ctx: FlowContext): Promise<ValidationResult>;  // Validate user input
  next(ctx: FlowContext): Promise<string | null>;  // Next step ID (null = flow complete)
  skipIf?(ctx: FlowContext): Promise<boolean>;     // Conditionally skip this step
}
```

### Flow Context

Every step receives a `FlowContext` with:
- `supabase` — Database client
- `sender` — Message sender (Meta Cloud)
- `standalone` — Template/lookup service
- `intelligence` — Profanity/abuse service
- `from` — User's phone number
- `session` — Current bot session with session_data
- `business` — Business record with category, tier, metadata

### Adding a New Flow

1. Create `lib/bot/flows/your-flow.flow.ts`:
```typescript
import type { FlowDefinition } from '../types';

export const yourFlow: FlowDefinition = {
  id: 'your_flow',
  steps: [
    {
      id: 'yf_start',
      async prompt(ctx) {
        return [{ type: 'text', text: 'Welcome! What would you like to do?' }];
      },
      async validate(input, ctx) {
        return { valid: true, data: { choice: input } };
      },
      async next(ctx) {
        return 'yf_next_step';
      },
    },
    // ... more steps
  ],
};
```

2. Register it in `lib/bot/flows/registry.ts`:
```typescript
import { yourFlow } from './your-flow.flow';
// Add to FLOW_REGISTRY or EXTENDED_REGISTRY
```

3. If it maps to a capability, update `lib/capabilities/types.ts` to add the capability ID and tier requirement.

## Intent Detection

### Hybrid Architecture (regex → LLM fallback)

```
User message
  → parseSmartIntentHybrid()
    → Step 1: parseSmartIntent() (pure regex, ~5ms)
      → If confident match with service keywords → return
    → Step 2: Check feature flag (llm-intent-enabled)
    → Step 3: classifyWithLLM() (Claude Haiku, ~300ms)
      → If confidence > 0.3 → merge with regex entities → return
      → Else → return regex result (possibly empty)
    → All classifications logged to llm_classifications table
```

### Supported Languages
- English, Nigerian Pidgin (pcm), Yoruba (yo), Igbo (ig), Hausa (ha), Twi (tw), French (fr)
- Language auto-detected by the LLM and stored on `session_data._detected_language`
- Bot responses translated via `translateBotResponse()` when non-English

### Keyword System (3 scopes)

| Scope | TTL | Priority | Description |
|-------|-----|----------|-------------|
| System | 10min | Lowest | Global keywords (hi, help, cancel) |
| Category | 5min | Medium | Category-specific (barber: "cut", church: "tithe") |
| Business | 5min | Highest | Business-custom keywords |

Business keywords override category, which override system.

## Session Lifecycle

1. **Create:** First message → new session with 24h expiry
2. **Resume:** Subsequent messages → find active session → continue flow
3. **Pre-fill:** Smart intent extracts service, date, time, quantity → skip already-answered steps
4. **Escape hatches:** "cancel", "stop", "start over", "talk to human" work at any step
5. **Deactivate:** Flow completes or user cancels → `is_active = false`
6. **Expire:** 24h TTL, cleaned by daily cron

## Step Overrides

Businesses can customize flow steps via the `step_overrides` table:
- **skip** — Skip a step entirely
- **require** — Force a step that would normally be skipped
- **custom** — Replace the prompt with custom text
- **branch** — Conditional branching based on session data

## Conversation Logging

Every bot ↔ user exchange is logged in `session.conversation_log`:
```json
[
  { "role": "bot", "content": "Hello! Welcome...", "timestamp": "..." },
  { "role": "user", "content": "I want a haircut", "timestamp": "..." },
  { "role": "bot", "content": "Got it! Looking up...", "timestamp": "..." }
]
```
Persisted to `bot_sessions.conversation_log` after each exchange.

## Error Handling

- **Step not found:** Log to Sentry, send "Something went wrong", deactivate session
- **Flow execution error:** Catch in BotService, log to Sentry, send generic error
- **Messaging failure:** Try-catch, non-blocking (logged but doesn't crash the flow)
- **LLM failure:** Silent fallback to regex-only intent detection
- **Translation failure:** Silent fallback to English
