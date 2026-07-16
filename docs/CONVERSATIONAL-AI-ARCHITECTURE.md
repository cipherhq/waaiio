# Conversational AI Platform — Architecture & Implementation Plan

## Current Architecture

```
WhatsApp Message
    ↓
Meta Cloud Webhook
    ↓
Event State Machine (received → processing → completed/failed)
    ↓
BotService.handleMessage()
    ├── Rate limit + compliance (STOP/START)
    ├── Specialized handlers (RSVP, ticket check-in, quotes)
    ├── Global queries (my orders, location, receipts)
    ├── Bot code detection (fuzzy match to business)
    ├── Session lookup/create
    └── FlowExecutor.execute()
        ├── Step resolution (registry lookup)
        ├── Skip check → validate → next() → advance
        ├── CAS session update (version conflict detection)
        └── Outbound message via MetaCloudService
```

### What already exists and will be REUSED

| Component | Location | Reuse |
|-----------|----------|-------|
| Smart intent (regex) | `lib/bot/smart-intent.ts` | Entity extraction, 40+ patterns, Pidgin/Yoruba/Haiku |
| LLM intent (Haiku) | `lib/bot/llm-intent.ts` | Classification with confidence, caching, rate limiting |
| Flow executor | `lib/bot/flows/executor.ts` | Step lifecycle, CAS session updates, navigation |
| Flow registry | `lib/bot/flows/registry.ts` | 20 flows, step lookup across flows |
| Global queries | `lib/bot/handlers/global-queries.ts` | My orders, bookings, location, receipts |
| Keyword actions | `lib/bot/handlers/keyword-actions.ts` | Unified keyword matching, business overrides |
| Customer intelligence | `lib/bot/customer-intelligence.ts` | History, LTV tier, returning customer detection |
| Capability selection | `lib/bot/flows/capability-selection.flow.ts` | Menu generation, data-backed filtering |
| Flow routing | `lib/bot/handlers/flow-routing.ts` | Capability → first step mapping |

### What's MISSING

| Need | Current State |
|------|---------------|
| Orchestration layer | No unified routing with confidence thresholds |
| Business knowledge retrieval | Global queries answer 9 question types; no FAQ/hours/price answers |
| Correction handling | No "actually Friday" or "make it 4 people" support |
| Flow interruption | Questions during a flow kill the transaction |
| Marketplace search | No cross-business discovery |
| Confidence policy | Binary: regex match or LLM fallback, no threshold tiers |
| Owner copilot | No dashboard AI assistant |

---

## Proposed Architecture

```
WhatsApp Message
    ↓
Meta Cloud Webhook (unchanged)
    ↓
Event State Machine (unchanged)
    ↓
BotService.handleMessage()
    ├── [1] Compliance (STOP/START) — unchanged
    ├── [2] Exact button/list payloads — unchanged
    ├── [3] Active human handoff — unchanged
    ├── [4] Active flow + correction detection — NEW
    │       ↓
    │   ConversationOrchestrator.understand()
    │       ├── Is this a correction? → apply + revalidate
    │       ├── Is this a temporary question? → answer + resume
    │       └── Is this flow input? → pass to executor
    ├── [5] Global customer commands — unchanged
    ├── [6] Business code/switch — unchanged
    ├── [7] NEW: ConversationOrchestrator for free text
    │       ↓
    │   Confidence routing:
    │       ├── ≥0.85 → auto-route to flow
    │       ├── 0.60-0.84 → targeted confirmation
    │       └── <0.60 → clarification menu
    ├── [8] Marketplace search — NEW
    ├── [9] Business knowledge — NEW
    └── [10] Fallback menu — unchanged
```

### Key design decisions

1. **Orchestrator sits INSIDE handleMessage**, not as a replacement. Existing routing priority is preserved.
2. **Deterministic checks run first** — compliance, buttons, active flows. AI only handles ambiguous free text.
3. **Flows are NOT rewritten** — the orchestrator produces structured data that feeds into existing `capabilityToFirstStep()` and step pre-population.
4. **Feature flags control everything** — each component can be enabled/disabled independently.

---

## Release 1: Conversational Workflow Upgrade

### Files to CREATE

| File | Purpose |
|------|---------|
| `lib/bot/conversation-orchestrator.ts` | Main orchestration service |
| `lib/bot/conversation-types.ts` | Shared types (ConversationUnderstanding, etc.) |
| `lib/bot/business-knowledge.ts` | Grounded business info retrieval |
| `lib/bot/correction-parser.ts` | "Actually Friday", "make it 4" handling |
| `lib/bot/confidence-policy.ts` | Threshold config and routing decisions |
| `supabase/migrations/239_ai_conversation_config.sql` | AI settings table |

### Files to MODIFY

| File | Change |
|------|--------|
| `lib/bot/bot.service.ts` | Insert orchestrator call at priority 4 and 7 |
| `lib/bot/flows/executor.ts` | Add temporary question detection before step processing |
| `lib/bot/smart-intent.ts` | Export entity extraction separately for reuse |
| `lib/bot/llm-intent.ts` | Expand prompt for richer entity extraction |

### Files NOT touched

All flow files (scheduling, ordering, payment, ticketing, reservation, etc.), all handlers, all payment logic, all webhook routes. The orchestrator feeds INTO these, doesn't replace them.

---

## Implementation sequence (Release 1)

### Commit 1: Types and orchestrator skeleton
- `conversation-types.ts` — ConversationUnderstanding interface
- `confidence-policy.ts` — threshold config
- `conversation-orchestrator.ts` — skeleton with routing logic

### Commit 2: Business knowledge retrieval
- `business-knowledge.ts` — answer hours, location, prices, delivery, FAQs
- Integration point in executor for temporary questions

### Commit 3: Correction parser
- `correction-parser.ts` — deterministic patterns + LLM fallback
- Session field tracking for targeted corrections

### Commit 4: Integration into bot.service.ts
- Wire orchestrator into handleMessage routing
- Feature flag gating
- Fallback to existing behavior when disabled

### Commit 5: Tests
- Orchestrator unit tests
- Business knowledge tests
- Correction parser tests
- Integration tests with mock sessions

---

## Database changes (Release 1)

```sql
-- Migration 239: AI conversation settings
CREATE TABLE IF NOT EXISTS ai_conversation_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  assistant_name TEXT DEFAULT 'Assistant',
  greeting TEXT,
  tone TEXT DEFAULT 'friendly' CHECK (tone IN ('friendly', 'professional', 'casual')),
  ai_enabled BOOLEAN DEFAULT true,
  faq_enabled BOOLEAN DEFAULT true,
  knowledge_enabled BOOLEAN DEFAULT true,
  auto_route_threshold NUMERIC(3,2) DEFAULT 0.85
    CHECK (auto_route_threshold >= 0.60 AND auto_route_threshold <= 1.0),
  clarification_threshold NUMERIC(3,2) DEFAULT 0.60
    CHECK (clarification_threshold >= 0.30 AND clarification_threshold <= 0.85),
  fallback_behavior TEXT DEFAULT 'menu'
    CHECK (fallback_behavior IN ('menu', 'human_handoff', 'clarification')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id)
);

ALTER TABLE ai_conversation_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners_manage" ON ai_conversation_config FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
```

---

## Feature flags

```
CONVERSATIONAL_ORCHESTRATOR=false    # Main orchestrator
AI_KNOWLEDGE_RESPONSES=false         # Business FAQ/hours answers
AI_CORRECTIONS=false                 # "Actually Friday" handling
AI_TEMPORARY_QUESTIONS=false         # Flow interruption for questions
```

All default to false. Enable per-business via `ai_conversation_config.ai_enabled`.

---

## Risk analysis

| Risk | Mitigation |
|------|------------|
| AI invents business data | Knowledge retrieval only returns DB records; prompt instructs no invention |
| AI overrides active flow | Priority order: buttons > active flow > AI. Orchestrator only handles unmatched free text |
| Higher latency | LLM already exists (Haiku). Orchestrator adds ~100ms for routing logic, not new API calls |
| Cost increase | Haiku is cheap ($0.25/MTok input). Cache + rate limit already in place |
| Regression in existing flows | Feature-flagged. Disabled = zero code path changes. Existing tests must pass |

---

## Release 2: Marketplace (future)

New files: `lib/marketplace/search.ts`, migration for discovery fields, dashboard pages.
Not in scope for Release 1.

## Release 3: Owner Copilot (future)

New dashboard panel with authenticated AI queries.
Not in scope for Release 1.
