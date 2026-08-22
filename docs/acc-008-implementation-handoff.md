# ACC-008 Implementation Handoff

## Status

- **PR:** #156 (Draft, DO NOT MERGE)
- **Branch:** `fix/acc-008-order-checkout-state-machine`
- **Current HEAD:** `73ca7a9a5bad2c1550504ecd5ee08af858ae9505`
- **Base main:** `9630c3e740471bd18b93e0d22926a057c6381892`
- **CI on current HEAD:** All green (Main App, Migration, Admin, Governance, Secrets, Deps)
- **DO NOT MERGE. DO NOT DEPLOY. DO NOT MODIFY PRODUCTION.**

## What Has Been Done (on current HEAD)

### Already Implemented (needs correction per CTO review below)
1. `nextAfterPrompt` added to `FlowStepConfig` (string | function) — executor honors it
2. `add_to_cart`: direct DB writes removed, nextAfterPrompt set, validate fails closed, next returns 'continue_or_checkout'
3. `process_order`: conditional nextAfterPrompt function, validate catch-all replaced with rejection, direct DB writes removed
4. Executor: payment-pending guard on post-completion menu (checks payment_reference + confirmation status)
5. Owner notification: "Awaiting Payment" for non-zero orders
6. Dashboard orders: 'pending' status with yellow badge
7. Customer spend: deferred (passes 0) for paid orders at creation
8. Referral: deferred for paid orders (total === 0 guard)
9. Migration 333: promo reserved_uses column, finalize/release RPCs, order referral_id column
10. process-success.ts: promo finalization, referral conversion, customer spend on webhook path
11. ordering.flow.ts await_order_payment: promo finalization, referral conversion, customer spend on "I've Paid" path
12. 41 regression tests passing

### Files Already Modified on This Branch
- `lib/bot/flows/types.ts` — nextAfterPrompt property
- `lib/bot/flows/executor.ts` — nextAfterPrompt evaluation + payment-pending guard
- `lib/bot/flows/ordering.flow.ts` — transition fixes, fail-closed, side-effect timing
- `lib/bot/flows/shared/notify-owner.ts` — paymentPending flag
- `lib/payments/process-success.ts` — promo/referral/spend on webhook path
- `app/dashboard/orders/page.tsx` — pending status
- `supabase/migrations/333_promo_reservation_and_order_referral.sql` — promo reservation RPCs
- `lib/bot/flows/__tests__/acc-008-order-checkout-bypass.test.ts` — 41 tests

## CTO Review Blockers (10 items — ALL must be fixed)

### 1. Promo reservation must be PER-ORDER idempotent

**Problem:** Current `finalize_promo_reservation(p_order_id)` uses promo-wide `reserved_uses > 0` as idempotency guard. Order A can consume Order B's reservation on replay.

**Required fix:** Durable per-order reservation state. Recommended: `promo_reservations` table with `UNIQUE(order_id)` and states `reserved | finalized | released`.

Atomic transitions:
- `none → reserved` (reserve)
- `reserved → finalized` (payment success)
- `reserved → released` (cancel/expiry)
- Replay from `finalized` or `released` = no-op
- Order A's operations must NEVER affect Order B's reservation

### 2. Enforce promo capacity inside database transaction

**Problem:** App-layer availability check is raceable. Two concurrent customers can both pass.

**Required fix:** Inside `create_order_atomic`, under FOR UPDATE lock on the promo row:
```sql
WHERE max_uses IS NULL OR (
  SELECT count(*) FROM promo_reservations 
  WHERE promo_code_id = p_promo_code_id AND state IN ('reserved', 'finalized')
) < max_uses
```
If exhausted: fail safely, don't create order with unavailable promo.

**Required test:** Real two-session database concurrency test. Promo max_uses=1, two simultaneous reservations. Exactly one succeeds. `current_uses + reserved count` never exceeds 1.

### 3. Promo finalization must enforce authoritative payment state

**Problem:** `finalize_promo_reservation()` doesn't enforce that the order is actually paid.

**Required fix:** Tie finalization to Payment Authority state. For example, require order status = 'confirmed' or check payment finalization_completed_at.

### 4. Remove second payment-success authority from Ordering

**Problem:** "I've Paid" path in `await_order_payment.validate()` independently calls stock, platform fee, promo finalization, referral conversion, customer spend after `verifyPayment()`. This is a second business-finalization pipeline that diverges from the canonical Payment Authority.

**Required fix:** "I've Paid" must call `reconcilePayment(supabase, paymentId, 'ive_paid')` from `lib/payments/reconcile.ts`. This converges through `authorizeAndFinalize()` which handles claim, finalization, exactly-once, and retry.

The bot may: initiate provider verification, call canonical Payment Authority, interpret result for UX. It must NOT implement another finalization pipeline.

**Key file:** `lib/payments/reconcile.ts` — the canonical entry point. Already used by webhook handlers. "I've Paid" needs to use it too.

**Architecture:**
```
Webhook: processPaystackChargeSuccess() → reconcilePayment(sb, paymentId, 'webhook', providerOverride)
"I've Paid": verifyPayment() → find paymentId → reconcilePayment(sb, paymentId, 'ive_paid')
Both → authorizeAndFinalize() → claim → processSuccessfulPayment() → complete
```

### 5. Customer paid spend must be exactly-once

**Problem A:** `processSuccessfulPayment()` calls additive `upsert_customer_profile(p_booking_amount: payment.amount)` without per-payment spend marker. Stage 2 retry can double-add.

**Problem B:** "I've Paid" path updates spend AND then calls `handlePostCompletion(amountPaid: totalAmount)` which updates spend again. Double-counting.

**Required fix:**
- Single authority for paid spend, inside processSuccessfulPayment (Stage 2)
- Durable exactly-once marker keyed by payment_id (e.g., UNIQUE constraint or check)
- handlePostCompletion must NOT re-add financial spend
- Prove: pending=0, webhook=once, I've Paid=once, replay=once, race=once, cancel=zero

### 6. Required finalization effects must not silently disappear

**Problem:** New promo/referral/spend operations in `processSuccessfulPayment()` catch errors and continue without adding to `criticalErrors`. If they fail, `finalization_completed_at` is set while effects are missing.

**Required fix:** Audit each effect. Critical ones must add to `criticalErrors` or participate in Payment Authority retry. Document why each is critical or noncritical.

### 7. Audit create_order_atomic function signature

**Problem:** Migration 333 adds `p_referral_id` to the function. PostgreSQL `CREATE OR REPLACE FUNCTION` with a different argument list creates an overload, not a replacement.

**Required fix:** Explicitly handle the old signature. Options:
- DROP old signature first (after verifying all callers)
- Use the same argument count with defaults
- Audit every call site to ensure they use the new signature

**Call sites to check:**
- `lib/bot/flows/ordering.flow.ts` (the main caller)
- Any other RPC callers of `create_order_atomic`

### 8. Add REAL integration/concurrency tests

**Required tests:**

a) **FlowExecutor/CAS integration:** Actual executor, not mocked. Quick-add → CAS persists continue_or_checkout → Checkout → apply_promo → terms → process_order → payment → await_order_payment. No fake post-completion.

b) **Cross-flow executor guard:** Payment, Scheduling, Ticketing, Reservation, Crowdfunding — prove payment-pending guard doesn't trap or alter their existing completion.

c) **Migration 333 real DB tests:** Two-session concurrency, finalize replay, release replay, finalize-vs-release race, capacity enforcement, old/new signature behavior.

d) **Payment Authority tests:** Webhook only, manual only, webhook+manual race, Stage-2 retry, duplicate provider event. All order effects exactly-once.

### 9. Automation lifecycle documentation

**Current state:**
- `evaluateRules('order_created')` fires at pending order creation
- `triggerSequences('after_order')` fires at pending order creation  
- `handlePostCompletion()` fires on payment success (can fire automation again)

**Required:** Document what each means, when each fires, whether any fires twice. Preserve backward compatibility unless concrete defect requires change.

### 10. Update PR description

Current PR body is stale. Must include Change Impact Record with: Changed, Upstream, Downstream, Database impact, Payment/financial impact, WhatsApp impact, Automation impact, Analytics/observability impact, Regression surfaces tested, Deferred related risks, Production acceptance required.

## Key Files to Read in Fresh Session

### Payment Authority (canonical system)
- `lib/payments/authority.ts` — `authorizeAndFinalize()`, claim/complete/release lifecycle
- `lib/payments/reconcile.ts` — `reconcilePayment()`, the canonical entry point
- `lib/payments/process-success.ts` — `processSuccessfulPayment()`, Stage 2 effects
- `lib/payments/send-confirmation.ts` — Stage 3 confirmation
- `lib/payments/provider-adapters.ts` — `verifyWithProvider()`
- `supabase/migrations/314_payment_finalization_lifecycle.sql` — claim/complete/release RPCs

### Ordering Flow (the flow being fixed)
- `lib/bot/flows/ordering.flow.ts` — full ordering flow (3200+ lines)
  - `add_to_cart` step: ~line 1100
  - `continue_or_checkout` step: ~line 1248
  - `process_order` step: ~line 2415
  - `await_order_payment` step: ~line 2965
- `lib/bot/flows/executor.ts` — FlowExecutor with CAS, step transitions, post-completion
- `lib/bot/flows/types.ts` — FlowStepConfig interface

### Promo System
- `supabase/migrations/333_promo_reservation_and_order_referral.sql` — current (needs redesign)
- `supabase/migrations/304_session_resilience.sql` — original create_order_atomic
- `supabase/migrations/329_stale_order_atomic_cleanup.sql` — cancel_stale_order_atomic
- `supabase/migrations/021_product_enhancements.sql` — promo_codes table, upsert_customer_profile

### Post-Completion
- `lib/bot/flows/shared/post-completion.ts` — handlePostCompletion (loyalty, receipt, feedback, spend)
- `lib/bot/flows/shared/payment.ts` — initializePayment, recordPlatformFee
- `lib/bot/flows/shared/notify-owner.ts` — owner notifications

### Tests
- `lib/bot/flows/__tests__/acc-008-order-checkout-bypass.test.ts` — current 41 tests
- `lib/bot/flows/__tests__/helpers.ts` — test mock helpers
- CI workflow runs migration tests against real Postgres

## Implementation Plan

### Phase 1: Database redesign (Migration 333 rewrite)
1. Create `promo_reservations` table: `(id, order_id UNIQUE, promo_code_id, state CHECK IN ('reserved','finalized','released'), created_at, updated_at)`
2. Remove `reserved_uses` column approach
3. Rewrite `create_order_atomic` to:
   - Lock promo row with FOR UPDATE
   - Check capacity: `WHERE max_uses IS NULL OR (SELECT count(*) FROM promo_reservations WHERE promo_code_id = X AND state IN ('reserved','finalized')) < max_uses`
   - Insert reservation row atomically with order
   - Fail if capacity exhausted
4. Handle old function signature (DROP old, CREATE new, or use defaults)
5. Rewrite `finalize_promo_reservation(p_order_id)` to transition `reserved → finalized` with state guard
6. Rewrite `release_promo_reservation(p_order_id)` to transition `reserved → released` with state guard
7. Update `cancel_stale_order_atomic` to call release

### Phase 2: Converge "I've Paid" through Payment Authority
1. In `await_order_payment.validate()`, after `verifyPayment()` returns true:
   - Find the payment ID from `payment_reference`
   - Call `reconcilePayment(supabase, paymentId, 'ive_paid')`
   - Interpret `ReconciliationResult` for bot UX
2. Remove all manual stock/fee/promo/referral/spend calls from "I've Paid"
3. Move promo finalization, referral conversion into `processSuccessfulPayment()` (already partially done)

### Phase 3: Customer spend exactly-once
1. Add durable spend marker (e.g., check in upsert_customer_profile or separate marker)
2. Remove spend from handlePostCompletion — it should handle loyalty/receipt/feedback only
3. Ensure processSuccessfulPayment spend update is idempotent

### Phase 4: Effect criticality
1. Audit each new effect in processSuccessfulPayment
2. Promo finalization failure → add to criticalErrors
3. Referral conversion failure → noncritical (informational only, can be reconciled)
4. Customer spend failure → add to criticalErrors (financial accuracy)

### Phase 5: Tests
1. Promo concurrency DB test (two-session, max_uses=1)
2. Promo replay tests (finalize twice, release twice, A vs B isolation)
3. FlowExecutor CAS integration test
4. Cross-flow payment-pending guard regression
5. Payment Authority exactly-once (webhook, manual, race, retry)
6. Automation lifecycle documentation test

### Phase 6: PR description update

## Constraints
- Stay on branch `fix/acc-008-order-checkout-state-machine`
- Push to same PR #156
- DO NOT MERGE
- DO NOT DEPLOY
- DO NOT MODIFY PRODUCTION
- DO NOT touch ACC-009, ACC-010, ACC-011, sidebar, billing/trial, Promotions schema
- Keep ordering-flow scope (other flows deferred to systemic hardening PR)
- Run full CI before reporting done
