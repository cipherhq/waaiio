# Release Gate V2

> Durable release-safety contract for Waaiio. Supplements `WAAIIO_ENGINEERING_OPERATING_ORDER.md`.
> Read both before any migration, payment, authorization, provider, or cross-cutting change.

---

## 1. Invariant Registry

Every invariant has a unique ID, an owner (the PR/issue that established it), a blast-radius scope, and a required evidence type. A passing CI suite is necessary but **never sufficient** alone — each invariant specifies the minimum proof.

### 1.1 Database / Migration Invariants

| ID | Invariant | Owner | Required Evidence |
|----|-----------|-------|-------------------|
| DB-001 | `SECURITY DEFINER` functions calling `digest()` must have `SET search_path = public, extensions` | M390, #365 | `pg_proc.proconfig` catalog assertion + RPC execution returning valid hash |
| DB-002 | `CREATE OR REPLACE FUNCTION` that recreates a function resets all attributes (search_path, grants, security label) to what the `CREATE` statement specifies — any prior `ALTER` is lost | M390→M394 regression | CI migration lint (see §6) |
| DB-003 | Every table in `public` schema has RLS enabled, default deny | Standing | Migration review + `pg_class.relrowsecurity` assertion |
| DB-004 | Saved-card RPCs (`accept_saved_card_offer`, `decline_saved_card_offer`, `create_provider_consented_offer`) are blocked for `anon`/`authenticated`; only `service_role` may execute | M396, #353 | Grant catalog assertion |
| DB-005 | `bot_sessions.whatsapp_number` must store the raw inbound transport key (no `+` prefix normalization), because session lookup uses exact match on raw Meta `from` | #338 | Behavioral test: insert with raw phone → lookup with same raw phone → match |
| DB-006 | Payment confirmation RPCs (`initialize_terminal_effects`, `finalize_payment_confirmation`) must both carry `search_path = public, extensions` | M390, #365 | `pg_proc.proconfig` catalog assertion for both functions |

### 1.2 Payment / Provider Invariants

| ID | Invariant | Owner | Required Evidence |
|----|-----------|-------|-------------------|
| PAY-001 | Stripe Checkout Session must include `saved_payment_method_options[payment_method_save]=enabled` when customer is provisioned and business is platform-eligible | #353, #366 | Checkout creation test asserting param presence when preconditions met |
| PAY-002 | `stripeRequest()` must set an explicit `Stripe-Version` header ≥ `2024-04-10` for Checkout Sessions that use `saved_payment_method_options` | #366 (pending fix) | Unit test asserting header presence |
| PAY-003 | Paystack Save Card PIN session uses raw inbound phone (transport key), not canonPhone | #338 | Behavioral test: no-session accept → assert `whatsapp_number` = raw `from` |
| PAY-004 | Saved-card ownership authority uses canonical `+E.164` phone, never raw transport key | #353 | RPC parameter assertions in behavioral tests |
| PAY-005 | Platform fee recording resolves tier from DB, never trusts caller-supplied tier | #352, Phase 2D | `recordPlatformFee` call-site audit |
| PAY-006 | Stage-2 finalization (booking/order state, deposit_status) completes before Stage-3 manifest initialization | #358 | Code-path trace: `sendProactiveConfirmation` ordering |
| PAY-007 | Stage-3 manifest initialization failure is fail-closed: claim is released for retry, no partial effects | #365 | `initializeManifest` error-path test |

### 1.3 Channel / Routing Invariants

| ID | Invariant | Owner | Required Evidence |
|----|-----------|-------|-------------------|
| CH-001 | Channel resolver priority: `assigned_channel_id` → dedicated → country shared → any shared | Standing | Channel resolution unit tests |
| CH-002 | Inbound channel provenance is recorded in payment metadata for confirmation routing | #358 | Metadata assertion in payment creation tests |
| CH-003 | Outbound confirmation uses the same channel that received the inbound payment message | #358 | Round-trip channel test |

### 1.4 Security / Authorization Invariants

| ID | Invariant | Owner | Required Evidence |
|----|-----------|-------|-------------------|
| SEC-001 | Service role key never exposed to client (`NEXT_PUBLIC_` prefix forbidden for secrets) | Standing | Grep CI check |
| SEC-002 | Webhook handlers verify signatures (HMAC) before processing | Standing | Handler code review |
| SEC-003 | Business ownership verified before mutations (`owner_id = auth.uid()` or RLS) | Standing | RLS + API route audit |
| SEC-004 | PIN hash uses bcrypt, never plaintext comparison | #353 | `saved-cards.ts` handler audit |

---

## 2. Final-State Migration Checks

> **Rule:** The truth about a database object is the cumulative result of ALL migrations, not any single file.

### 2.1 The CREATE OR REPLACE Trap

`CREATE OR REPLACE FUNCTION` **replaces the entire function definition**, including any attributes set by prior `ALTER` statements (search_path, security label, cost, rows). This is how M394 silently reverted M390's `search_path` fix.

**Mandatory check before merging any migration that uses `CREATE OR REPLACE`:**

1. Grep all prior migrations for `ALTER FUNCTION <name>` — list every attribute that was set.
2. Verify the new `CREATE OR REPLACE` preserves every required attribute in its own statement.
3. If any attribute would be lost, either include it in the `CREATE OR REPLACE` or add a subsequent `ALTER` in the same migration.

### 2.2 Required Self-Verification Pattern

Every migration that touches a `SECURITY DEFINER` function calling `digest()`, `gen_random_uuid()`, or other extension functions must include a verification block:

```sql
DO $$
DECLARE v_config text[];
BEGIN
  SELECT p.proconfig INTO v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.oid = 'public.<function_name>(<arg_types>)'::regprocedure;
  IF NOT ('search_path=public, extensions' = ANY(v_config)) THEN
    RAISE EXCEPTION 'Migration verification FAILED: <function_name> search_path incorrect: %', v_config;
  END IF;
END $$;
```

### 2.3 CI Migration Lint

A CI step must scan every migration file for `CREATE OR REPLACE FUNCTION` bodies that call `digest(`, `encode(`, `gen_random_uuid(`, or other `pgcrypto`/`extensions` functions. For each match, assert the statement includes `extensions` in `search_path`. Failure blocks merge.

---

## 3. Golden Journeys

Golden journeys are the end-to-end user paths that must work on every production release. Each journey spans multiple subsystems and exercises the full stack.

### 3.1 Appointment Payment (Stripe)

```
Customer → WhatsApp → bot flow (scheduling) → deposit calculation
→ Stripe Customer provisioning → Checkout Session creation (with Save Card option)
→ customer pays on Stripe-hosted page
→ Stripe webhook (checkout.session.completed)
→ Stage 1: claim payment
→ Stage 2: finalize booking (status=confirmed, deposit_status=paid)
→ Stage 3: initialize manifest → execute effects (WhatsApp confirmation, email, loyalty)
→ finalize confirmation claim
→ Post-finalization: saved-card offer/activation (if consented)
```

**Verification points:**
- Booking status = `confirmed`, deposit_status = `paid`
- `confirmation_sent_at` is populated
- Terminal effects manifest exists with valid semantic hash
- All required effects executed
- If Save Card consented: offer record exists, PIN session created with raw transport phone

### 3.2 Order Payment (Paystack)

```
Customer → WhatsApp → bot flow (ordering) → product selection → checkout
→ Paystack charge initialization → customer pays
→ Paystack webhook (charge.success)
→ Stage 1-3 (same as 3.1)
→ Post-finalization: saved-card CTA via WhatsApp buttons
→ Customer taps Save → PIN session created → customer enters PIN → card saved
```

**Verification points:**
- Order status updated, stock applied
- Confirmation sent
- If Save Card: PIN session `whatsapp_number` = raw inbound phone (not canonPhone)
- Saved method ownership = canonical `+E.164` phone

### 3.3 Direct Bank Transfer (Phase 2D)

```
Customer → WhatsApp → order flow → selects bank transfer
→ pending_transfer created with inventory reservation
→ Owner confirms via dashboard
→ Stage 1-3 confirmation pipeline
→ Stock committed, promo finalized
```

### 3.4 Ticketing / Invoice / Giving

Same Stage 1-3 pipeline as 3.1, substituting the payment type context. Each must produce correct terminal effects for its category.

### 3.5 Reconciliation Cron

```
Cron fires → scans payments with confirmation_sent_at IS NULL
→ Claims payment → retries Stage 3
→ Must succeed if the original failure was transient (e.g., fixed search_path)
```

---

## 4. Provider Acceptance

Before declaring a provider integration production-ready, prove these independently:

### 4.1 Stripe

| Check | Evidence |
|-------|----------|
| Checkout Session creation succeeds | `sessionData.id` and `sessionData.url` are present |
| `saved_payment_method_options` is accepted by Stripe | Retrieve session via API, confirm options are persisted |
| Customer provisioning round-trips | `provider_customer_identities` row with `provisioning_state = provider_confirmed` |
| Webhook signature verification passes | `stripe-webhook/route.ts` HMAC check |
| Refund flow works | `stripeRequest('/refunds', ...)` returns success |
| API version compatibility | Explicit `Stripe-Version` header set, or account default ≥ required version |

### 4.2 Paystack

| Check | Evidence |
|-------|----------|
| Charge initialization succeeds | `authorization_url` returned |
| Webhook HMAC verification passes | `webhook/route.ts` signature check |
| Save Card authorization round-trips | `authorization_code` persisted in `saved_payment_methods` |
| PIN session uses transport key | `whatsapp_number` = raw `from`, not canonPhone |

### 4.3 Meta (WhatsApp)

| Check | Evidence |
|-------|----------|
| Webhook responds < 30s | Vercel function completes within `SIDE_EFFECT_DEADLINE_MS` |
| Message deduplication works | `claim_webhook_event` RPC prevents double-processing |
| Outbound message delivery confirmed | Delivery status webhook updates `message_delivery_status` |

---

## 5. Exact-SHA Certification

### 5.1 Certification Requirements

A release SHA is **certified** only when ALL of the following are recorded on GitHub:

1. **Exact SHA** — the full 40-character commit hash on protected `main`
2. **CI evidence** — all required jobs green on that exact SHA (not a prior commit)
3. **CTO review** — ChatGPT posted `READY FOR MERGE` or equivalent on the exact SHA
4. **Owner authorization** — explicit merge authorization recorded
5. **Migration reconciliation** — all migrations in the SHA are applied to production and verified
6. **Deployment verification** — Vercel deployment is `READY`, aliases are correct, HTTP smoke check passes
7. **Runtime error scan** — post-deployment log scan shows no new runtime errors

### 5.2 Stale Evidence

- CI evidence becomes stale if the HEAD SHA changes after the run.
- CTO review becomes stale if new commits are pushed after the reviewed SHA.
- Deployment evidence becomes stale if a new deployment occurs.

**Stale evidence must be regenerated, not reused.**

### 5.3 SHA Provenance Chain

For production incident investigation, the certified SHA must be traceable:

```
PR merge commit → protected main SHA → Vercel deployment ID → production runtime
```

Record all four in the release control issue.

---

## 6. Canary Rules

### 6.1 Pre-Production Canary

Before declaring a release production-ready:

1. **Staging deployment** — deploy to staging Vercel project first
2. **Staging migration** — apply migrations to staging Supabase
3. **Golden journey smoke test** — manually or via test run at least one golden journey (§3) on staging
4. **No new runtime errors** — staging logs clean for the tested journey

### 6.2 Post-Production Canary

After production deployment:

1. **Owner runs at least one golden journey** within the first hour
2. **Runtime error monitoring** — scan production logs for 30 minutes post-deploy
3. **Reconciliation cron** — verify cron fires and processes without errors
4. **If any golden journey fails** — the deployment is a P0 incident; do not proceed with further releases until resolved

### 6.3 Rollback Authority

- Only Owner can authorize a production rollback.
- Rollback means redeploying the prior certified SHA, NOT reverting commits.
- Migration rollback is a separate, higher-risk action requiring explicit Owner + CTO agreement.

---

## 7. Escaped Defect Policy

An **escaped defect** is any bug that reaches production despite the release gate. Every escaped defect triggers a mandatory post-incident process.

### 7.1 Classification

| Severity | Definition | Example |
|----------|-----------|---------|
| P0 | Production functionality broken for users | #365: all confirmations fail |
| P1 | Feature not working as designed but workaround exists | #366: Save Card checkbox missing |
| P2 | Edge case failure, limited user impact | Phone format mismatch for specific country codes |
| P3 | Cosmetic or non-user-facing | Log format inconsistency |

### 7.2 Mandatory Response

For every P0 or P1 escaped defect:

1. **File a GitHub issue immediately** with read-only production evidence.
2. **Root-cause to the specific migration, commit, or code path** that introduced or failed to prevent the defect.
3. **Identify which invariant (§1) was violated** — if none covers it, add a new invariant.
4. **Identify which golden journey (§3) would have caught it** — if none would, add a new journey or verification point.
5. **Write an executable regression test** that fails without the fix and passes with it.
6. **Add a CI migration lint rule** if the defect was caused by a migration pattern (e.g., DB-002: CREATE OR REPLACE dropping ALTER attributes).
7. **Update this document** with the new invariant and/or journey.

### 7.3 Escaped Defect Log

Track every escaped defect for pattern analysis:

| Date | Issue | Severity | Root Cause | Invariant Gap | Gate Improvement |
|------|-------|----------|-----------|---------------|-----------------|
| 2026-09-22 | #365 | P0 | M394 `CREATE OR REPLACE` dropped M390's `search_path` fix | DB-001, DB-002 added | CI migration lint for `digest()` + `search_path` |
| 2026-09-22 | #366 | P1 | Stripe API version not pinned; `saved_payment_method_options` may be silently ignored | PAY-002 added | Require explicit `Stripe-Version` header |
| 2026-09-22 | #338 | P1 | PIN session stored canonPhone; session lookup uses raw transport key | DB-005, PAY-003 added | Behavioral test for phone-key round-trip |

### 7.4 Pattern Prevention

After 2+ escaped defects with the same root-cause pattern, escalate to a **structural prevention**:

- If migrations keep dropping attributes → add a CI catalog verification step that runs after all migrations
- If provider params keep being silently ignored → add response-validation that checks the created object matches the request
- If phone format mismatches keep occurring → add a single canonical test that exercises insert + lookup with the exact Meta format

---

## 8. State Diff & Regression Baseline (Executable Infrastructure)

> This section describes the machine-enforced release gate. It is not documentation-only —
> the implementation lives in `lib/release-gate/` and runs as executable tests.

### 8.1 Architecture

```
Pre-Deployment Baseline    Candidate Baseline     Post-Deployment Baseline
(current production SHA)   (release candidate)    (actual deployed state)
         │                        │                         │
         └───── State Diff ───────┘                         │
                    │                                       │
              Classification                                │
         (expected / unexpected /                           │
          improved / regression)                            │
                    │                                       │
         ┌─────────┴──────────┐                            │
         │   Release Manifest │                            │
         │  (declared changes)│                            │
         └────────────────────┘                            │
                    │                                       │
              Release Certificate ◄────────────────────────┘
              (PASS / BLOCKED)
                    │
         ┌─────────┴──────────┐
         │  CTO Reviews       │  ← automation produces; CTO reviews;
         │  Owner Authorizes   │    Owner is final authority
         └────────────────────┘
```

### 8.2 Baseline Snapshot

A baseline captures the complete observable state at a specific SHA:

- **Database catalog:** function signatures, bodies (hashed), `search_path`, `SECURITY DEFINER/INVOKER`, ownership, EXECUTE grants, RLS status, RLS policies (hashed), constraints, triggers, extensions and their schemas
- **Invariant test results:** every invariant from §1 evaluated as pass/fail/skip/error
- **Golden journey results:** every journey from §3 evaluated with checkpoint-level detail
- **Migration state:** applied migrations with content hashes
- **Cron/recovery jobs:** pg_cron and Vercel cron schedules

**Implementation:** `lib/release-gate/baseline-capture.ts`
**Types:** `lib/release-gate/types.ts` → `BaselineSnapshot`

### 8.3 Release Change Manifest

Before deploying, declare what the release is expected to change:

```typescript
{
  release_id: "PR-400",
  candidate_sha: "abc123...",
  base_sha: "def456...",
  approved_by: "CTO",
  expected_changes: [
    {
      category: "function",
      object_id: "public.initialize_terminal_effects",
      change_type: "modified",
      reason: "M397 restores search_path (fixes #365)",
      authorization: "#365",
    },
  ],
}
```

Any delta NOT covered by a manifest entry is classified as **unexpected**. Unexpected critical deltas are **blockers**.

**Types:** `lib/release-gate/types.ts` → `ReleaseManifest`

### 8.4 Automatic Delta

The diff engine compares before and after baselines and classifies every difference:

| Classification | Meaning | Action |
|---|---|---|
| **expected** | Covered by manifest entry | No action |
| **unexpected** | Not declared in manifest | Critical if on protected object; warning otherwise |
| **improved** | Previously failing, now passing | Positive signal |
| **regression** | Previously passing, now failing | **BLOCKS release** |

**Previous-passing-must-stay-passing rule:** Any invariant or golden journey that was `pass` in the before-baseline must remain `pass` in the after-baseline. Violations are automatic blockers. Owner may override only by explicitly approving the behavior change in the manifest.

**Implementation:** `lib/release-gate/diff-engine.ts`
**Tests:** `lib/__tests__/release-gate-diff-engine.test.ts`

### 8.5 Critical Invariant Comparison

Protected objects are registered in `lib/release-gate/invariant-registry.ts`. Changes to these require manifest entries:

- Function `search_path`, `SECURITY DEFINER/INVOKER`, ownership, body hash
- EXECUTE grants on payment/authorization RPCs
- RLS enabled/disabled on public tables
- Constraint definitions on financial tables
- Extension schema locations

### 8.6 Migration Lint

A static analysis pass scans migration SQL files for patterns that silently break protected attributes:

1. `CREATE OR REPLACE FUNCTION` calling `digest()` without `extensions` in `search_path`
2. `CREATE OR REPLACE FUNCTION` recreating a protected function without required attributes

**Implementation:** `lib/release-gate/migration-lint.ts` (also usable as CLI: `npx tsx lib/release-gate/migration-lint.ts`)
**Tests:** `lib/__tests__/release-gate-migration-lint.test.ts`

### 8.7 Release Certificate

The certificate is the final artifact documenting what was verified:

- Exact SHA, baseline identities, migration set
- Before/after state diff with classifications
- Invariant gate (total/passed/failed/critical)
- Journey gate (total/passed/failed)
- Provider acceptance checks
- Final verdict: **PASS** / **BLOCKED** / **PENDING_REVIEW**

**Governance:** Automation generates the certificate. CTO independently reviews the exact-head evidence. Owner authorizes. Claude cannot self-certify its own changes.

**Implementation:** `lib/release-gate/certificate.ts`

### 8.8 Escaped Defect Permanence

Every escaped defect must add:

1. A new invariant in `lib/release-gate/invariant-registry.ts`
2. A new protected object entry (if applicable)
3. A new migration lint rule (if pattern-based)
4. A new test in `release-gate-invariants-db.test.ts` or `release-gate-diff-engine.test.ts`
5. An entry in the escaped defect log (§7.3)

This ensures the same class of defect cannot silently return.

### 8.9 Module Layout

```
lib/release-gate/
  index.ts                  — Module exports
  types.ts                  — All type definitions (baseline, manifest, diff, certificate)
  invariant-registry.ts     — Machine-readable invariant + protected object registry
  baseline-capture.ts       — Captures DB catalog state (read-only, requires TEST_DATABASE_URL)
  diff-engine.ts            — Compares baselines, classifies differences
  migration-lint.ts         — Static analysis of migration files (also CLI)
  certificate.ts            — Generates release certificates

lib/__tests__/
  release-gate-diff-engine.test.ts       — Diff engine proofs (synthetic, no DB required)
  release-gate-invariants-db.test.ts     — DB invariant proofs (real PostgreSQL)
  release-gate-migration-lint.test.ts    — Migration lint proofs
```

### 8.10 Future Slices

Foundation slice (this document) establishes types, invariant registry, diff engine, migration lint, and certificate generation. Future slices will add:

- **CI integration:** Run migration lint and invariant checks as GitHub Actions steps
- **Baseline persistence:** Store baselines as JSON artifacts in CI or a dedicated store
- **Journey automation:** Automated golden journey execution against staging
- **Provider sandbox checks:** Stripe test-mode Checkout Session inspection
- **Runtime health comparison:** Error rate, webhook timeout, reconciliation failure deltas
- **Regression-to-change correlation:** `git log` integration linking diffs to specific commits

---

## Document Maintenance

This document is a living contract. It must be updated when:

- A new invariant is established (new PR/feature that adds a safety property)
- An escaped defect reveals a gap
- A golden journey changes (new payment type, new provider, new flow)
- A canary rule proves insufficient
- A new protected object or migration lint rule is added

Updates follow the standard change process: PR, CTO review, Owner merge authorization.
