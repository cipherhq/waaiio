# CAP-001 Phase 2: Capability Activation Spine Audit

## Purpose

Maps the complete shared activation path that determines whether a Waaiio capability becomes usable by a business and reachable by a WhatsApp customer.

## Source

- **Commit:** `4ca1e65391a5bbcc8477ff4a2b0370e308530520`
- **Audit date:** 2026-08-01
- **Method:** Static code analysis of imports, callers, database writes, and runtime decisions
- **Production access:** None

## Audit Conclusions

### 1. Is onboarding connected to capability assignment?
**Yes (verified).** Category selection seeds default capabilities. User toggles in StepFeatures. initCapabilities() persists to business_capabilities. No test coverage.

### 2. Is capability assignment persisted correctly?
**Yes (verified).** business_capabilities rows with is_enabled=true, unique(business_id, capability). Service client bypasses RLS for initial write.

### 3. Are plan and override rules consistently enforced?
**No (P1).** Tier enforcement is client-side only in the capabilities page UI. RLS does not check tier. No API route validates tier on capability writes. Admin overrides work correctly.

### 4. Does dashboard visibility match server authorization?
**Partially.** Sidebar filters by capability. But only 7 of 92 pages use useRequireCapability(). Zero API routes enforce capability access.

### 5. Does the bot load the same capability truth as the dashboard?
**Yes (verified).** Both query business_capabilities where is_enabled=true.

### 6. Do guided bot options respect enabled capabilities?
**Yes (verified).** select_capability step only shows enabled capabilities with backing data.

### 7. Does free-text routing respect enabled capabilities?
**Partially.** Intent classification ignores capabilities. Routing layer prevents wrong-flow dispatch. The intent metadata can pre-fill irrelevant entities.

### 8. Does ambiguity lead to clarification rather than guessing?
**Partially.** With AI enabled, the orchestrator can show_clarification. Without AI, ambiguous input re-prompts the capability menu. The bot never guesses a flow — it either clarifies or shows the menu.

### 9. Can customers correct, cancel and restart?
**Yes (verified).** 'cancel' goes back. 'stop/quit/exit' deactivates. 'start over/restart' creates new session. Human handoff works when chat is enabled but silently fails when it isn't (P2).

### 10. Does reconfiguration propagate consistently?
**Yes (high confidence).** Both bot and dashboard re-query business_capabilities on each request/page load. Changes take effect immediately on next interaction.

### 11. What shared defects block all or many capabilities?
- **CAS-006 (P1):** No server-side tier enforcement for capability writes
- **CAS-007 (P1):** No automatic capability downgrade when trial expires

### 12. What is the smallest safe first implementation batch?
**CAS-006 + CAS-007 + CAS-002** — Tier enforcement and trial lifecycle. These three findings share the same code area (capability writes + trial management) and together close the largest systemic gap.

## Findings Summary

| ID | Title | Severity | Confidence |
|----|-------|----------|------------|
| CAS-001 | No onboarding tests exist | P2 | verified |
| CAS-002 | trial_ends_at uses inline calculation, not TRIAL_DAYS constant | P3 | verified |
| CAS-003 | No API-level capability enforcement | P2 | verified |
| CAS-004 | Free-text intent does not check capability eligibility | P3 | verified |
| CAS-005 | Disabled capability response is generic, not informative | P3 | verified |
| CAS-006 | Tier enforcement is client-side only | P1 | verified |
| CAS-007 | No automatic capability downgrade when trial expires | P1 | verified |
| CAS-008 | Human handoff silently fails when chat not enabled | P2 | verified |

## Recommended First Implementation Batch

**CAS-006 + CAS-007 + CAS-002** (3 findings, all in plan/persistence stage):

1. Add server-side tier validation for capability writes (CAS-006)
2. Implement trial expiry capability downgrade (CAS-007)
3. Use TRIAL_DAYS constant instead of inline calculation (CAS-002)

These three share the same code area and together close the systemic gap where a free-tier business can retain growth/business capabilities indefinitely after trial.

## Product Decisions Required

Before implementing the first batch, these decisions are needed:

1. When a trial expires without upgrade, should growth/business capabilities be immediately disabled or given a grace period?
2. Should API routes independently enforce capabilities, or is the current UI/bot-only gating acceptable?
3. Should the capabilities page use a server API route instead of direct browser Supabase writes?
