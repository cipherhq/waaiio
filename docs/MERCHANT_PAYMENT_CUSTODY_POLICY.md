# Waaiio merchant payment custody and settlement — Owner-approved, non-negotiable

**Status:** Standing product decision confirmed by the Owner on 2026-10-20. Applies to all payment providers, onboarding, checkout, admin finance, payouts, refunds, migrations, bots, and payment-related PRs.

## Two supported merchant payment routes (both MUST remain supported)

### A. Merchant connects its own supported Stripe or Paystack account

- Customer pays via the merchant's connected provider account.
- Where supported, the provider's connected-account/split-payment integration allocates Waaiio's platform fee and the merchant's share.
- The merchant receives its share through its connected provider arrangement. **Waaiio must not require an admin to send a second/manual settlement for that transaction.**
- Changes to platform payout jobs must not disable, divert, or double-pay connected-account payments or split routing.

### B. Merchant does NOT connect its own provider and uses Waaiio's Stripe or Paystack

- Customer pays through **Waaiio's own payment account**. Waaiio holds the funds intended for the merchant.
- Waaiio determines the amount owed to the merchant using the authoritative fees, gateway charges, refunds, adjustments and previous settlements, with correct currency/merchant attribution.
- Waaiio **must have a usable admin payout workflow** for paying that merchant *outside* Waaiio (for example, by bank transfer). This is not optional.
- After the money has actually been sent, an authorized admin records the completed settlement in Waaiio, with the amount, currency, merchant, transfer reference, date/time and responsible admin. The system then marks that settlement **paid**.
- **Approval alone is not evidence that money was sent.** An approved/manual payout remains unpaid until explicit confirmation; never automatically label it paid.
- Enforce authorization/step-up where required, an auditable trail, transactional balance checks, idempotency and protection against duplicate settlement, retries and refund/settlement races.

## Vocabulary and controls — do not confuse these

- Removing a payout method named `manual_cash` **does not mean removing merchant manual settlements**.
- A `manual_bank` method is acceptable only if admins can still pay merchants whose collections were received by Waaiio, and record completion afterward.
- Disabling **Stripe automated platform-managed payouts** until safe reconciliation exists **must not disable Stripe Connect direct/split payments**, and must not disable manual payouts of Stripe-held merchant balances.
- Paystack direct/split routing and Paystack-held merchant balances likewise remain supported.
- Do not redirect connected-account transactions to Waaiio custody or silently turn Waaiio-custody collections into connected-account transfers.
- No code, migration, feature flag, UI simplification or refactor may remove or materially alter either payment route without an **explicit new Owner product decision**. Technical approval, passing CI, Claude/agent preference or an old PR description do not override this rule.

## Required regression evidence for payment-related changes

Before recommending push, merge or release, trace and test **both routes** for Stripe and Paystack as applicable:
1. Connected-provider payment -> correct fee/split routing -> merchant receives share via provider; **no manual payment obligation** introduced.
2. Waaiio-provider payment -> Waaiio custody ledger -> correct merchant payable balance -> admin approves -> external payment -> admin confirms reference -> exactly one paid settlement/audit trail.
3. Duplicate/retry/concurrent confirm, refund-first vs settlement-first, insufficient balance, provider errors and cross-merchant permissions fail safely, without creating phantom paid status or double transfers.
4. Distinguish *money held by Waaiio* from *merchant-owned provider funds* in all reports, balances and admin actions.

When evidence is unavailable, document the limitation and stop for CTO review rather than claiming parity. Database migration application and live money movement require separate Owner authorization.

**Canonical Owner decision:** Merchants with their own connected provider receive money through that provider. Merchants using Waaiio's provider accounts are paid separately by Waaiio, and an admin records the actual payout as complete. **Both routes must work; never silently change this.**
