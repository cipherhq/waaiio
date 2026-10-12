---
name: payment-mutation-checklist
description: "Verify every payment, payout, and refund mutation before saying done. Run after any change to payout approve/reject/generate, fee calculations, refunds, or webhook money paths."
---

# Payment Mutation Checklist

> MANDATORY after any change that reads or writes money: payouts, fees, refunds, webhooks.

For every money mutation, confirm ALL of these:
1. The caller passed admin auth AND an action-bound step-up where required.
2. Step-up is consumed immediately before the first protected write, never before read-only preflight checks.
3. No financially consequential write happens before step-up is consumed.
4. The mutation rechecks target existence, status, and ownership atomically at write time, not only in preflight (races must fail closed).
5. Every write verifies affected-row count. Zero rows changed must never return success.
6. Generation with no eligible records returns an explicit "no eligible" result, never a plain success with created:0.
7. Idempotency: re-running the same generation does not create duplicates.
8. Every mutation writes an audit row with actor, action, target, and outcome.

Output a table: operation, step-up required?, consumed at correct point?, affected-rows checked?, audit written?, race-safe?
