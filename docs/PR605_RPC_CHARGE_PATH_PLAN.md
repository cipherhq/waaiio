# PR #605 — RPC/Charge-Path Ownership, Lock Ordering & Concurrency Plan

> CTO R7 compliance document. Required by Issue #664 §9 Step 3 Phase A.

---

## 1. RPC Ownership Map

| RPC / Function | Owner | Caller | Gateway | Authorization |
|---|---|---|---|---|
| `claim_paystack_billing_cycle(uuid)` | M452 | `retry-failed-charges` cron | Paystack | service_role only |
| `dispatch_paystack_attempt(uuid, uuid)` | M452 | `retry-failed-charges` cron | Paystack | service_role only |
| `finalize_paystack_recurring_charge(uuid, int, text, text, text)` | M452 (preserves M337 body) | `retry-failed-charges` cron | Paystack | service_role only |
| `claim_recurring_billing_cycle(uuid)` | M452 | `retry-failed-charges` cron | Flutterwave | service_role only |
| `list_cancelled_flutterwave_claims(int)` | M452 | `retry-failed-charges` cron | Flutterwave | service_role only |
| `finalize_token_recurring_charge(...)` | Pre-existing (not modified by M452) | `retry-failed-charges` cron | Flutterwave | service_role only |

All RPCs: `SECURITY DEFINER`, `SET search_path = public, extensions`, `REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role`.

---

## 2. Lock Ordering Contract

**Invariant:** Every transaction that locks both `customer_subscriptions` and `paystack_billing_attempts` MUST acquire the subscription lock FIRST.

| RPC | Step 1 | Step 2 | Rationale |
|---|---|---|---|
| `claim_paystack_billing_cycle` | `SELECT * FROM customer_subscriptions WHERE id = p_subscription_id FOR UPDATE` | `INSERT INTO paystack_billing_attempts` (new row — no lock contention) | Claim creates new attempt; no existing attempt lock needed |
| `dispatch_paystack_attempt` | Unlocked parent lookup → `SELECT ... FROM customer_subscriptions WHERE id = v_parent FOR UPDATE` | `SELECT * FROM paystack_billing_attempts WHERE id = p_attempt_id FOR UPDATE` | Subscription locked first; validates cancellation_requested_at under lock |
| `finalize_paystack_recurring_charge` | Unlocked parent lookup → `SELECT ... FROM customer_subscriptions WHERE id = v_parent FOR UPDATE` | `SELECT * FROM paystack_billing_attempts WHERE id = p_attempt_id FOR UPDATE` | Subscription locked first; validates attempt parent identity under lock |

The initial unlocked `SELECT customer_subscription_id INTO v_parent FROM paystack_billing_attempts` in dispatch/finalize is an identifier lookup only — NOT authorization. The parent identity is re-validated after both rows are locked (`v_attempt.customer_subscription_id IS DISTINCT FROM v_parent` → reject).

The cancellation route (`POST /api/recurring/cancel`) writes `cancellation_requested_at` via a CAS UPDATE on `customer_subscriptions` only — never locks `paystack_billing_attempts`. No deadlock vector exists because the cancel path never acquires the second lock.

---

## 3. Charge-Path Lifecycle (Paystack)

```
claim_paystack_billing_cycle
  ├─ cancellation_requested_at IS NOT NULL? → DENY (no attempt created)
  ├─ existing finalized? → DENY (already_finalized)
  ├─ existing dispatched/charged? → DENY (must_reconcile)
  ├─ existing reserved + active lease? → DENY (active_lease)
  ├─ existing reserved + expired lease? → RECLAIM (reuse attempt)
  └─ no existing? → CREATE new attempt (status=reserved, 5min lease)

dispatch_paystack_attempt
  ├─ subscription locked: cancellation_requested_at? → DENY
  ├─ subscription locked: status not active/past_due? → DENY
  ├─ attempt status != reserved? → DENY
  ├─ claim_token mismatch? → DENY
  └─ SET status=dispatched, dispatched_at=NOW()

executePaystackDispatchedCharge (TypeScript, after dispatch commits)
  ├─ reread subscription: cancellation/inactive? → BLOCKED (never call provider)
  ├─ reread error or null? → BLOCKED
  ├─ charge() → success → recordCharged → CHARGED
  ├─ charge() → terminal_failure → recordDefinitiveFailure → DEFINITIVE_FAILURE
  ├─ charge() → pending/indeterminate → UNRESOLVED (leave dispatched)
  └─ charge() → exception → UNRESOLVED (network may have reached provider)

finalize_paystack_recurring_charge
  ├─ already finalized? → validate identity → return canonical IDs
  ├─ wrong status? → DENY
  ├─ amount/currency mismatch? → DENY
  └─ INSERT booking, payment, subscription_charge, platform_fee
     → apply_payment_spend_once → UPDATE attempt status=finalized
```

---

## 4. Charge-Path Lifecycle (Flutterwave)

```
claim_recurring_billing_cycle
  ├─ cancellation_requested_at IS NOT NULL? → DENY
  ├─ existing completed? → DENY
  ├─ existing provider_success? → RECLAIM (finalize only, no charge)
  ├─ existing provider_failed? → CREATE new attempt (a2, a3...)
  ├─ existing claimed + fresh (<10min)? → DENY (active_lease)
  ├─ existing claimed + stale (≥10min)? → RECLAIM (reconcile first)
  └─ no existing? → CREATE first attempt (a1)

processFlutterwaveRenewal (TypeScript)
  ├─ claim returned provider_verified? → skip charge, go to finalize
  ├─ claim returned reconcile_required? → verify() existing attempt
  │   ├─ successful → mark provider_success, finalize
  │   ├─ failed → record_flutterwave_definitive_failure → STOP
  │   └─ pending/unknown → SKIP (leave for next run)
  ├─ pre-charge subscription read: cancelled/inactive? → SKIP
  ├─ chargeToken() → successful → verify() → finalize
  ├─ chargeToken() → pending/unknown → SKIP
  └─ chargeToken() → failed → record_flutterwave_definitive_failure

Post-cancellation reconciliation (verification-only, NO chargeToken):
  list_cancelled_flutterwave_claims → read-only work queue
  reconcileCancelledFlutterwaveClaim
  ├─ verify existing attemptRef (read-only)
  ├─ provider successful + identity match → finalize
  └─ anything else → skip or error (never charge)
```

---

## 5. Cancellation Operational State Machine

### Required states per #664 §9
The audit requested: `cancellation_requested_at` + `cancellation_operational_state` (`pending_provider` | `provider_verified` | `needs_reconciliation`).

### Actual implementation
PR #605 uses `cancellation_requested_at` (TIMESTAMPTZ) + `customer_subscriptions.status` as the state signal, without a separate `cancellation_operational_state` column.

| Effective State | DB Representation | Meaning |
|---|---|---|
| **No cancellation** | `cancellation_requested_at IS NULL`, `status IN (active, past_due)` | Normal billing |
| **Intent recorded** | `cancellation_requested_at IS NOT NULL`, `status IN (active, past_due)` | Cancel requested; provider call pending or failed; all new claims/dispatches blocked |
| **Provider verified** | `cancellation_requested_at IS NOT NULL`, `status = cancelled` | Provider confirmed cancellation; DB updated |
| **Needs reconciliation** | `cancellation_requested_at IS NOT NULL`, `status IN (active, past_due)`, existing `dispatched`/`charged` attempts in `paystack_billing_attempts` | Intent recorded but prior dispatch exists; reconciliation required before financial closure |

### Gap analysis
The explicit `cancellation_operational_state` column is **not implemented**. The current two-field representation (`cancellation_requested_at` + `status`) is functionally equivalent:

- `pending_provider` = intent set, status unchanged (cancel route between intent write and provider call, or provider call failed)
- `provider_verified` = intent set, status = cancelled
- `needs_reconciliation` = intent set, existing dispatched/charged attempts (detected by reconciliation queries)

**Trade-off:** Adding a dedicated column would make the state machine explicit in a single field but adds a new CHECK constraint, migration complexity, and requires updating all existing consumers. The current representation achieves the safety goal (all claims/dispatches check `cancellation_requested_at IS NOT NULL`) without the additional column.

### Evidence matrix: crash recovery and webhook retry durability

The following matrix proves every cancellation operational state is durably reconstructable from persisted columns after any crash point, without a dedicated `cancellation_operational_state` column.

**Persisted columns used:** `customer_subscriptions.cancellation_requested_at`, `customer_subscriptions.status`, `paystack_billing_attempts.status`, `processed_webhook_events.status`

| Scenario | Crash/Retry Point | Persisted State After Recovery | Reconstructed Operational State | Correct Behavior on Restart |
|---|---|---|---|---|
| **S1.** Cancel request, intent written, process crashes before provider call | After `UPDATE cancellation_requested_at` commits, before HTTP to Paystack/Stripe | `cancellation_requested_at IS NOT NULL`, `status = active` | **pending_provider** | Customer retries → intent CAS finds `cancellation_requested_at` already set → re-read confirms intent → proceeds to provider call (idempotent) |
| **S2.** Provider cancel succeeds, process crashes before DB status update | After Paystack `/subscription/disable` returns 200, before `UPDATE status = 'cancelled'` | `cancellation_requested_at IS NOT NULL`, `status = active` | **pending_provider** (provider actually verified) | Customer retries → intent already set → provider call returns "already disabled" or status check shows `non-renewing`/`cancelled` → `providerCancelled = true` → DB updated |
| **S3.** Provider cancel fails (network timeout), process crashes | After HTTP timeout, before 503 response to customer | `cancellation_requested_at IS NOT NULL`, `status = active` | **pending_provider** | All billing claims blocked by intent. Customer retries → full flow re-executes. Cron cannot create new charges. |
| **S4.** Cancel complete (both intent + provider + DB update) | Normal completion | `cancellation_requested_at IS NOT NULL`, `status = cancelled` | **provider_verified** | Idempotent: returns `already_cancelled: true` |
| **S5.** Dispatch committed, cancel intent arrives during provider charge | After `dispatch_paystack_attempt` commits, concurrent `UPDATE cancellation_requested_at` | `cancellation_requested_at IS NOT NULL`, `status = active/past_due`, attempt `status = dispatched` | **needs_reconciliation** | `executePaystackDispatchedCharge` re-reads subscription → sees intent → BLOCKED. Attempt stays `dispatched`. Reconciliation cron picks up via `paystack_billing_attempts WHERE status IN ('dispatched','charged')` query. |
| **S6.** Charge reached provider, provider charges card, process crashes before recording | After Paystack debits customer, before `recordCharged` | `cancellation_requested_at IS NOT NULL`, attempt `status = dispatched` | **needs_reconciliation** | Reconciliation cron → `verify(provider_reference)` → `status: success` → `finalize` → payment recorded. No duplicate charge (attempt status guards). |
| **S7.** Charge succeeded + recorded, process crashes before finalization | After `status = charged`, before `finalize_paystack_recurring_charge` | `cancellation_requested_at IS NOT NULL`, attempt `status = charged` | **needs_reconciliation** | Reconciliation cron → `verify` → `finalize` → booking + payment + fee created atomically. Idempotent: `finalize` checks `status = 'finalized'` before creating records. |
| **S8.** Flutterwave claim exists, cancel arrives, webhook fires for prior charge | `claim_recurring_billing_cycle` blocked by intent; existing `processed_webhook_events` row | `cancellation_requested_at IS NOT NULL`, event `status = claimed` or `provider_success` | **needs_reconciliation** | `list_cancelled_flutterwave_claims` selects events joined on cancelled/intent subscriptions → `reconcileCancelledFlutterwaveClaim` verifies → finalizes if provider confirms success. No `chargeToken` called. |
| **S9.** Flutterwave reconciliation verifies provider success, crashes before finalization | After `verify(attemptRef)` returns successful, before `finalize_token_recurring_charge` | Event `status = provider_success` (updated before crash), `cancellation_requested_at IS NOT NULL` | **needs_reconciliation** | Next cron run → `list_cancelled_flutterwave_claims` → sees `provider_success` → `reconcileCancelledFlutterwaveClaim` → re-verifies → finalizes. |
| **S10.** Webhook retry for already-finalized payment | Paystack/Flutterwave re-delivers charge.success for a completed cycle | `cancellation_requested_at IS NOT NULL`, attempt `status = finalized` or event `status = completed` | **provider_verified** (already settled) | Paystack: `finalize` returns `already_finalized: true` with canonical IDs. Flutterwave: `claim` returns `already_completed`. No duplicate financial records. |

### Reconstruction query for any operational state

```sql
-- Pending provider: intent set, not yet cancelled at provider
SELECT id FROM customer_subscriptions
WHERE cancellation_requested_at IS NOT NULL AND status != 'cancelled';

-- Provider verified: fully cancelled
SELECT id FROM customer_subscriptions
WHERE cancellation_requested_at IS NOT NULL AND status = 'cancelled';

-- Needs reconciliation (Paystack): has in-flight attempts
SELECT s.id, a.id as attempt_id, a.status as attempt_status
FROM customer_subscriptions s
JOIN paystack_billing_attempts a ON a.customer_subscription_id = s.id
WHERE s.cancellation_requested_at IS NOT NULL
  AND a.status IN ('dispatched', 'charged');

-- Needs reconciliation (Flutterwave): has in-flight claims
SELECT * FROM list_cancelled_flutterwave_claims(100);
```

### Conclusion

A dedicated `cancellation_operational_state` column is **not necessary**. Every operational state is:
1. **Durably persisted** in existing columns that survive crashes (all are committed in separate transactions before the next step)
2. **Uniquely reconstructable** from a single query against existing columns
3. **Correctly handled** by existing code paths (cancel route retry, cron reconciliation, webhook idempotency)

Adding a redundant column would create a synchronization obligation (keep it consistent with the source-of-truth columns) without improving safety. The existing design is crash-safe because each step commits its state change before proceeding to the next non-idempotent operation. Current implementation is safe but less self-documenting.

---

## 6. CI Integration Gap

The `tests/run-605-*.mjs` harness scripts require isolated disposable PostgreSQL databases with specific names. The current CI (`ci.yml`) uses a single shared `waaiio_test` database for most shards plus per-test isolated databases for specific migrations.

**What exists:** 6 local harness scripts (complete migration, concurrency, finalizer, static, provider boundary, lock order) all pass locally.

**What CI needs:** A new migration-validation shard (or step within existing shard) that:
1. Creates `waaiio_pr605_*` databases
2. Runs `tests/run-605-complete-migration.mjs`
3. Runs `tests/run-605-concurrency.mjs`
4. Runs `tests/run-605-finalizer.mjs`
5. Drops disposable databases

This is a CI wiring task, not a code correctness gap. All tests are executable and proven on real PostgreSQL.

---

## 7. Parity Check: Paystack vs Flutterwave

| Concern | Paystack | Flutterwave |
|---|---|---|
| Cancellation blocks new claims | `claim_paystack_billing_cycle` checks `cancellation_requested_at` | `claim_recurring_billing_cycle` checks `cancellation_requested_at` |
| Cancellation blocks dispatch | `dispatch_paystack_attempt` checks under subscription lock | `processFlutterwaveRenewal` reads subscription before `chargeToken` |
| In-flight reconciliation | `reconcilePaystackDispatchedAttempt` verifies existing attempts | `reconcileCancelledFlutterwaveClaim` verifies existing claims |
| Idempotent finalization | `finalize_paystack_recurring_charge` checks `status = 'finalized'` | `finalize_token_recurring_charge` (pre-existing) |
| Lock ordering | subscription → attempt (all 3 RPCs) | subscription lock in `claim_recurring_billing_cycle`; TypeScript pre-charge read |
| Service-role only | All RPCs revoked from public/anon/authenticated | All RPCs revoked from public/anon/authenticated |
