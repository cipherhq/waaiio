# CAP-001 Phase 2: Capability Activation Spine Audit

## Purpose

Maps the complete shared activation path that determines whether a Waaiio capability becomes usable by a business and reachable by a WhatsApp customer.

## Source

- **Commit:** `4ca1e65391a5bbcc8477ff4a2b0370e308530520`
- **Audit date:** 2026-07-31
- **Method:** Static code analysis of imports, callers, database writes, and runtime decisions. No runtime execution or production access.
- **Confidence terminology:** "source_path_verified" means the source code path was traced and the behavior is directly proven from code. It does not mean runtime execution was tested.

## Spine Status Totals

| Status | Count |
|--------|-------|
| verified_connected | 15 |
| partially_connected | 6 |
| disconnected | 1 |
| **Total** | **22** |

## Audit Conclusions

### 1. Is onboarding connected to capability assignment?
**Structurally connected, but not atomic (P1).** Category selection seeds defaults. User toggles in StepFeatures. initCapabilities() persists to business_capabilities. However, initCapabilities() discards the Supabase insert error (CAS-009) — a silent failure leaves the business with zero capability rows and no indication of failure.

### 2. Is capability assignment persisted correctly?
**Structurally correct when the insert succeeds.** business_capabilities rows with is_enabled=true, unique(business_id, capability). But insert failure is not detected (CAS-009), and dashboard and bot use different fallback behavior when rows are missing (CAS-010). Runtime persistence success has not been tested.

### 3. Are plan and override rules consistently enforced?
**No (P1).** Tier enforcement is client-side only. RLS does not check tier. No API route validates tier on capability writes. Admin overrides work correctly.

### 4. Does dashboard visibility match server authorization?
**Partially.** 7 pages use useRequireCapability() for redirect gating. Additional pages use hasCapability()/capabilities.includes() for conditional rendering (not access blocking). ~50 pages have no capability check and are directly accessible via URL. Sidebar hiding is UI-only. No API routes enforce capability access for reviewed write operations.

### 5. Does the bot load the same capability truth as the dashboard?
**No (P1, CAS-010).** Dashboard queries only is_enabled=true rows and falls back to hardcoded CATEGORY_DEFAULT_CAPABILITIES. Bot (getEnabledCapabilities) queries all rows, merges newly-added category defaults, and falls back to DB-backed getCategoryDefaultCapabilities() first. A new category default added after onboarding auto-enables in the bot but not in the dashboard.

### 6. Do guided bot options respect enabled capabilities?
**Yes (source_path_verified).** select_capability step only shows enabled capabilities with backing data.

### 7. Does free-text routing respect enabled capabilities?
**Partially.** Intent classification ignores capabilities. Routing layer prevents wrong-flow dispatch. Intent metadata can pre-fill irrelevant entities.

### 8. Does ambiguity lead to clarification rather than guessing?
**Partially.** With AI enabled, the orchestrator shows clarification. Without AI, ambiguous input re-prompts the capability menu. The bot never guesses a flow.

### 9. Can customers correct, cancel and restart?
**Yes (source_path_verified).** 'cancel' goes back. 'stop/quit/exit' deactivates. 'start over/restart' creates new session. Human handoff works when chat enabled but silently fails when it isn't (CAS-008).

### 10. Does reconfiguration propagate consistently?
**Partially (CAS-010).** Both surfaces re-query business_capabilities on each request. But they use different resolution logic — the bot merges new defaults that the dashboard does not. Capability writes have no server-side tier enforcement (CAS-006).

### 11. What shared defects block all or many capabilities?
- **CAS-006 (P1):** Tier enforcement is client-side only
- **CAS-007 (P1):** No automatic capability downgrade when trial expires
- **CAS-009 (P1):** Capability persistence failure silently ignored
- **CAS-010 (P1):** Dashboard and bot use divergent capability-resolution rules

### 12. What is the smallest safe first implementation batch?
**CAS-009 + CAS-010 + CAS-006** — Capability persistence integrity, unified resolver, and server-side write enforcement. See "Recommended First Implementation Batch" below.

## Findings Summary

| ID | Title | Severity | Confidence |
|----|-------|----------|------------|
| CAS-001 | No onboarding tests exist | P2 | source_path_verified |
| CAS-002 | trial_ends_at uses inline calculation, not TRIAL_DAYS constant | P3 | source_path_verified |
| CAS-003 | No API-level capability enforcement for reviewed write routes | P2 | source_path_verified |
| CAS-004 | Free-text intent does not check capability eligibility | P3 | source_path_verified |
| CAS-005 | Disabled capability response is generic, not informative | P3 | source_path_verified |
| CAS-006 | Tier enforcement is client-side only | P1 | source_path_verified |
| CAS-007 | No automatic capability downgrade when trial expires | P1 | source_path_verified |
| CAS-008 | Human handoff silently fails when chat not enabled | P2 | source_path_verified |
| CAS-009 | Capability initialization failure silently ignored during onboarding | P1 | source_path_verified |
| CAS-010 | Dashboard and bot use divergent capability-resolution rules | P1 | source_path_verified |

**By severity:** P0: 0 | P1: 4 | P2: 3 | P3: 3

## Recommended First Implementation Batch

**CAS-009 + CAS-010 + CAS-006** (3 findings):

1. **Fix initCapabilities() error handling (CAS-009):** Destructure insert result, check error, fail or retry atomically.
2. **Unify capability resolution (CAS-010):** Create a single getEffectiveCapabilities() used by both dashboard layout and bot service. The resolver should apply: enabled rows → tier/trial filter → admin overrides, consistently.
3. **Add server-side capability write enforcement (CAS-006):** Route capability toggles through an API route with tier validation instead of direct browser Supabase writes.

**Architectural direction to evaluate:**
- Preserve a business's selected capability configuration (don't destructively delete at trial expiry).
- Compute effective capabilities centrally from: selected capabilities + subscription tier + active trial + admin overrides + explicit disabled state.
- Use the same resolver for dashboard, bot, and API authorization.
- Deny execution of ineligible capabilities while preserving historical data.
- Use a server-controlled and atomic capability-write path.

**Implementation cannot begin until:**
1. Trial-expiry policy is explicitly approved (CAS-007)
2. Capability-write architecture is approved (API route vs RLS function)
3. Auto-merge behavior for new category defaults is decided (CAS-010 product question)

## Product Decisions Required

1. **Trial expiry:** When a trial ends without upgrade, should growth/business capabilities be immediately disabled, given a grace period, or filtered at runtime without modifying rows?
2. **API capability enforcement:** Should write routes enforce capabilities? Full, selective (writes only), or accept current design?
3. **Capability write mechanism:** API route with server-side tier validation, or RLS function?
4. **New category defaults:** Should newly-added defaults auto-enable for existing businesses (current bot behavior) or require explicit opt-in (current dashboard behavior)?

## Pre-existing CI Issue

The OTP delivery observability test (`lib/__tests__/otp-delivery-observability.test.ts`) fails reproducibly on main and on this branch. It is not caused by audit changes. The test "contract match: contract update executes, OTP tracking also runs" expects `contractUpdateCalls.length === 1` but receives 0. This is documented as a pre-existing CI blocker, not an audit finding.
