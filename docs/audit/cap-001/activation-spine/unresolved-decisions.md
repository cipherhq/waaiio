# Product Decisions

## Approved Decisions (2026-07-31)

### 1. Trial expiry — runtime filtering, no grace period

**Decision:** Runtime filtering. No destructive row deletion.

**Implementation:** `getEffectiveCapabilities()` in `lib/capabilities/policy.ts` filters at query time. Both dashboard and bot route legacy zero-row defaults through the policy for tier/trial filtering. DB read errors fail closed (empty capabilities, not defaults).

**Status:** implemented_pending_independent_review

### 2. API capability enforcement — selective (writes only)

**Decision:** Enforce on write operations, not reads.

**Implementation:** `canPerformAction()` in `lib/capabilities/policy.ts`. Broad rollout deferred to CAS-003.

**Status:** Guard created. Rollout deferred.

### 3. Capability writes — server API + atomic RPC + RLS enforcement

**Decision:** Server API route + PostgreSQL RPC + RLS migration.

**Implementation:**
- `POST /api/capabilities/configure` validates then calls `configure_business_capabilities` RPC (migration 300) for atomic bulk configuration
- `POST /api/capabilities/toggle` handles single-field operations (sort_order, custom_label, individual toggle)
- Admin grant/revoke uses `admin_grant_capability` / `admin_revoke_capability` RPCs (migration 301)
- Migration 299 drops owner UPDATE/DELETE policies; only service_role can write
- All browser direct writes to business_capabilities eliminated

**Status:** implemented_pending_independent_review — RPC transaction rollback not runtime-tested

### 4. New category defaults — explicit opt-in for existing businesses

**Decision:** Never silently activate.

**Implementation:** `getEnabledCapabilities()` no longer auto-merges new defaults. `getConfiguredCapabilities()` returns typed result distinguishing DB error from zero rows.

**Status:** implemented_pending_independent_review

### 5. Recoverable onboarding — end-to-end retry

**Decision:** Genuine recoverable draft with same-business retry.

**Implementation:**
- Register route accepts `retryBusinessId`, verifies ownership + pending status, skips business creation, retries only capability init
- Wizard detects recoverable response, stores businessId, sends it on retry
- OnboardingDraft includes optional `pendingBusinessId` for page-refresh persistence
- `initCapabilities()` uses upsert for idempotency
- Bot rejects pending businesses (existing behavior, verified)

**Status:** implemented_pending_independent_review

### 6. Fail-closed capability reads

**Decision:** DB errors must not be treated as zero rows.

**Implementation:**
- `getConfiguredCapabilities()` returns `ConfiguredCapabilitiesResult` with `ok` field
- Dashboard fails closed (empty capabilities) on DB error
- Bot sends "temporary issue" message and returns on DB error
- Override query errors fail closed (treated as no overrides)

**Status:** implemented_pending_independent_review

## Deferred

### CAS-003 — Broad API route capability enforcement
Deferred to next controlled batch. The `canPerformAction()` guard exists but is not applied to individual capability-specific write routes.
