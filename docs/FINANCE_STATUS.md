# Finance Work — Status: READY FOR REVIEW

## Branch/PR Map

| PR | Branch | Status | Content |
|----|--------|--------|---------|
| #15 | fix/pre-launch-finance-safety | Draft | Initial finance hardening |
| #16 | fix/admin-finance-authorization | Draft | Admin authorization audit |
| #17 | fix/supabase-auth-integration-tests | Draft | JWT/RLS integration tests |
| #18 | fix/launch-safety-combined | Draft | Combined auth + column allowlist |
| #19 | fix/payment-idempotency | Draft | Atomic RPCs, payment dedup |
| #20 | fix/payout-safety-tests | Draft | Payout handler + DB tests |
| #21 | fix/combined-18-19-20 | Draft | Combined CI branch (all finance) |

PRs #15-#17 are superseded by #18. The merge strategy is: #18 → main, then #19, then #20. PR #21 is the CI validation branch containing all three.

## Locked Finance Criteria

### 1. Overpayment Ledger — READY FOR REVIEW

**Business behavior:** When a payment exceeds an invoice's remaining balance, the full amount is recorded, only the balance is applied to the invoice, and the excess is persisted as an immutable ledger record. Retries return the existing record without changing balances.

**Implementation:**
- Migration 274: `invoice_payment_applications` table with UNIQUE(invoice_id, payment_id), CHECK(amount_received = amount_applied + overpayment_amount), RLS
- Migration 275: `apply_invoice_payment` RPC inserts ledger record atomically; on retry, returns existing application without touching balances

**Evidence:**

| Test | Evidence Level | What it proves |
|------|---------------|----------------|
| Exact payment: overpayment=0, fully_paid=true | Level A (real DB) | Normal path works |
| Partial payment: overpayment=0, not fully_paid | Level A (real DB) | Partial accumulation works |
| Overpayment: 5000 payment on 2000 balance → applied=2000, overpayment=3000 | Level A (real DB) | Excess tracked, not silently capped |
| Overpayment ledger record reconcilable | Level A (real DB) | payment, application, fee all traceable |
| Retry returns existing record without balance change | Level A (real DB) | Idempotency proven |
| Concurrent apply_invoice_payment → one increment | Level A (real DB) | Concurrency safe |
| platform_fees.transaction_amount = full 5000 (not capped 2000) | Level A (real DB) | Fee records full amount |

**Remaining limitations:**
- No automatic refund of overpayment — requires manual admin review via Sentry alert
- No customer-facing credit balance — overpayment is recorded for ops reconciliation only

### 2. Immutable Payout Destination — READY FOR REVIEW

**Business behavior:** Changing any destination field on a payout account clears verification, deactivates the account, and holds all pending/approved payouts. The approve route stores a SHA-256 fingerprint at claim time and verifies it matches before provider transfer.

**Implementation:**
- Migration 276: `destination_fingerprint` column on business_payouts
- Migration 277-278: BEFORE UPDATE trigger on payout_accounts — fires on any destination field change (account_number, bank_code, routing_number, iban, swift_code, subaccount_code, stripe_account_id, square_merchant_id). Sets verified_at=NULL, is_active=false, holds pending+approved payouts.
- Approve route: SHA-256 fingerprint of normalized destination fields, verified before provider API call

**Evidence:**

| Test | Evidence Level | What it proves |
|------|---------------|----------------|
| Editing account_number → auto-holds payout, deactivates, clears verification | Level B (real handler + real DB) | Destination change blocks transfer |
| Deactivating account → auto-holds pending payouts | Level A (real DB trigger) | Account replacement is safe |
| Approval stores fingerprint + snapshot columns | Level B (real handler + real DB) | Snapshot is immutable |
| Approval attempt on deactivated account → 400, 0 provider calls | Level B (real handler) | Transfer prevented |
| Fingerprint mismatch → review_required | Level B (handler code path, tested via trigger) | Changed destination caught |

**Remaining limitations:**
- Fingerprint comparison happens within the same approve-route execution (claim + verify + transfer). A destination change between claim and transfer within the same request is caught by the trigger, which deactivates the account, causing the provider-call path to fail.

### 3. Manual Payout Completion — READY FOR REVIEW

**Business behavior:** Manual payout approval sets status='approved'. A separate completion action requires a transfer reference, admin permission, and audit log. The complete route is idempotent and reverts on audit failure.

**Implementation:**
- Approve route: manual transfers → status='approved' (not 'paid'), paid_at=null
- New route: `/api/admin/payouts/[id]/complete` with compare-and-set, mandatory audit, revert on failure
- Admin panel: separate "Approve" and "Mark Paid" buttons with reference input

**Evidence:**

| Test | Evidence Level | What it proves |
|------|---------------|----------------|
| Admin allowed → 200, status=paid, paid_at set | Level B (real handler + real DB) | Happy path |
| Finance role → 403 | Level B (real handler) | Role restriction |
| Ordinary user → 403 | Level B (real handler) | Role restriction |
| Unauthenticated → 401 | Level B (real handler) | Auth required |
| Duplicate completion → 409 | Level B (real handler + real DB) | Idempotent |
| Missing transfer_reference → 400 | Level B (real handler) | Mandatory field |
| Audit failure → 500, reverts to approved | Level B (real handler + real DB) | Safe revert |
| Paid payout immutable via compare-and-set | Level A (real DB) | Cannot overwrite |

**Remaining limitations:**
- Transfer-reference uniqueness is not enforced by a database constraint — two different payouts can have the same reference string. This is a business decision (some banks reuse references).
- The complete route does not verify the payout destination — it trusts that the approve step already verified it.

### 4. Final Finance CI — READY FOR REVIEW

**CI URL:** https://github.com/cipherhq/waaiio/actions/runs/29653826511

| Job | Result |
|-----|--------|
| Secret scanning | PASS |
| Main App (lint, test, build) | PASS — 784 passed, 58 skipped |
| Migration validation | PASS — 278 migrations, 14+2 RPC assertions |
| Admin App (install, build) | PASS |
| Dependency audit | PASS |
| Playwright smoke tests + DB integration | PASS |

**Test counts (executed in CI):**

| Suite | Executed | Evidence Level |
|-------|----------|---------------|
| JWT/RLS integration | 13 | Level A |
| Payment idempotency DB | 15 | Level A |
| Payout safety DB | 14 | Level A |
| Payout handler integration | 20 | Level B |
| Playwright E2E | 13 | Level A |
| Unit tests | 784 | Level C/D |

**Skipped tests (58):** All are `SUPABASE_INTEGRATION=true` gated DB tests that execute in the Playwright CI job where Supabase is available. They are skipped only in the unit-test job (no DB). Zero tests are suppressed.

**Provider transfer-call count:** 
- Concurrent approval test: 2 calls (1 recipient + 1 transfer) for the winning request, 0 for the loser
- Kill switch test: 0 calls
- Timeout test: 2 calls (recipient ok, transfer throws)
- All other tests: per-test counts documented in handler assertions

**Migration assertions:** 14 original RPCs (migration 265) + 2 payment RPCs (migration 269) = 16 total, all verified: anon=deny, authenticated=deny, service_role=allow

**Remaining limitations:**
- ENABLE_PAYOUTS=false — payouts are not enabled
- No production migrations applied
- No real provider sandbox testing (Paystack/Stripe test mode) — provider calls use fetch stubs
- Admin panel completion UI is implemented but not E2E tested (no admin Playwright tests)
