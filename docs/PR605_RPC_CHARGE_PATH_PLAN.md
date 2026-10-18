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

**Decision needed:** Whether to add `cancellation_operational_state` as a formal column or accept the implicit two-field representation. Current implementation is safe but less self-documenting.

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
