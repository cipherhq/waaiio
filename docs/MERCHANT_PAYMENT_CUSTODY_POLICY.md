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

---

# Waaiio fee and trial model — Owner standing order (2026-11-08 / 2026-11-09)

**Status:** Standing Owner financial decision, recorded in issue #958 and implemented by PRs #959, #960 and #961 (M525). It is binding on all code, configuration, migrations, pricing copy, provider integrations, admin tools and PRs. **Nothing changes these rules without a new, explicit Owner decision.** Technical approval, passing CI, a reviewer's or agent's preference, or an old PR description never overrides them.

## Rules

1. **Waaiio fee per paid transaction.** Starter 3%, Pro 1.5%, Premium 1%. The live rates are in `platform_settings.pricing_tiers` and the config snapshot. Changing a rate is itself an Owner decision.
2. **From sign-up.** The fee applies from the day a business signs up. The free trial never waives it.
3. **The same fee on every route.** This includes Waaiio-collected payments, merchant-connected split payments, and businesses that connect their own Stripe or Paystack. Waaiio collects its fee on every route.
4. **The merchant pays every payment-gateway fee, on every route. Waaiio must not absorb any fee at all.**
   - On a split, the provider fee must be borne by the merchant's side. On Paystack (`lib/payments/paystack-split.ts`):
     - splits on Waaiio's account send `bearer: 'subaccount'`;
     - own-gateway splits send `bearer: 'account'`, where the merchant is the main account;
     - an explicit `transaction_charge` is always sent.
   - Estimating or grossing up a provider fee in a way that can leave Waaiio absorbing a difference is not acceptable.
5. **The 14-day free trial is for Pro and Premium features.**
   - It starts at sign-up for every new business. The length comes from `platform_settings.trial_days`.
   - It does not depend on the free messaging credit or on `messaging_financial_gate`.
   - Premium limits apply during the trial. The fee stays at the business's plan rate.
   - After the trial, the business pays for Pro or Premium, or continues on Starter.
6. **Upgrade ends the trial.** If a Starter business upgrades to Pro or Premium during its trial, the trial ends at that moment. A later downgrade does not bring the trial days back.
7. **The free messaging credit is separate.** It is claimed by verifying a phone (#955).
8. **Monthly bookings:** Starter 100, Pro 1,000, Premium unlimited.

## Known limits — must be fixed before they are used

- **Stripe split payments (Connect destination charges).** On this charge type Stripe bills its fee to Waaiio. No business uses it, and per the Owner (2026-11-09) nothing is switched off. It must not be offered to merchants until it is redesigned so that the merchant bears Stripe's fee, for example with direct charges where the connected account is the fee payer.
- **"Connect your own Stripe" setup.** Today this lands funds in Waaiio's Stripe account. No business uses it. It must be fixed before use.
- **Monthly platform-fee invoice.** It must not bill own-gateway or Connect merchants for fees that a split has already collected. Fix this before onboarding any such business.

## Required evidence for fee-related changes

Any change touching fee calculation, splits, trials, limits or pricing copy must show, on the exact head:
- the plan rate charged on every route, with no zero-fee shortcut for a trial or for an own-gateway business;
- the gateway fee borne by the merchant;
- the trial clock and the upgrade rule unchanged;
- regression evidence for both custody routes above.

When this evidence is missing, stop and ask the Owner instead of claiming it.
