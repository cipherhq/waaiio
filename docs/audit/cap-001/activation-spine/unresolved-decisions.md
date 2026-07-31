# Product Decisions

## Approved Decisions (2026-07-31)

### 1. Trial expiry — runtime filtering, no grace period

**Decision:** Option C — runtime filtering. No destructive row deletion.

**Implementation:** `getEffectiveCapabilities()` in `lib/capabilities/policy.ts` filters at query time using `isTrialActive()`. Growth/business capabilities pause immediately when trial expires. Business regains access on upgrade or admin override. No cron job or destructive migration required.

**Status:** Implemented in Batch 1 (CAS-007 addressed through runtime eligibility).

### 2. API capability enforcement — selective (writes only)

**Decision:** Option B — enforce on write operations, not reads.

**Implementation:** `canPerformAction()` in `lib/capabilities/policy.ts` provides the reusable guard. `create_new` is denied for non-effective capabilities. `manage_existing` and `read_history` remain permitted.

**Status:** Guard created. Broad rollout to existing routes deferred to CAS-003 next batch.

### 3. Capability writes — server API route

**Decision:** Option A — `POST /api/capabilities/toggle` with server-side tier validation.

**Implementation:** `app/api/capabilities/toggle/route.ts` authenticates, verifies ownership, loads overrides, calls `canModifyCapability()`, writes atomically via service client.

**Status:** Implemented in Batch 1 (CAS-006 addressed).

### 4. New category defaults — explicit opt-in for existing businesses

**Decision:** Never silently activate. Show as New/Recommended. Require explicit owner activation.

**Implementation:** `getEnabledCapabilities()` in `lib/capabilities/service.ts` no longer auto-merges new defaults for existing configured businesses. Category defaults are only applied during initial onboarding.

**Status:** Implemented in Batch 1 (CAS-010 addressed).

### 5. Recoverable onboarding

**Decision:** Capability initialization failure returns a recoverable error. Business remains in pending status. Retry reuses the same business (idempotent upsert).

**Implementation:** `initCapabilities()` now throws on Supabase error. Register route catches and returns `{ recoverable: true, businessId }` with HTTP 500. Business is not activated until capabilities succeed. Uses upsert for idempotency.

**Status:** Implemented in Batch 1 (CAS-009 addressed).

## Deferred Decisions

### CAS-003 — Broad API route capability enforcement

Deferred to next controlled batch. The reusable `canPerformAction()` guard exists but is not yet applied to individual capability-specific write routes (bookings, orders, tickets, etc.).
