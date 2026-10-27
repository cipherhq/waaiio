# Subscription-included WhatsApp messaging credit — read-only audit and owner decision

**Date:** 2026-10-26  
**Repository:** `cipherhq/waaiio`  
**Audited protected-main baseline:** `cf5a41e59edc6972e790aa77fc576cd45acf159c`  
**Status:** **AUDIT / SPECIFICATION ONLY. NOT IMPLEMENTED.**  
**Scope:** Pro (`growth`) and Premium (`business`) subscription-included messaging credit. No edits to subscriptions, migrations, payment code, messaging send paths, pricing, or environments in this PR.

## 1. Owner decision (confirmed October 26)

* Include WhatsApp messaging credit equal to **10% of each paid monthly Pro or Premium subscription's approved monthly plan price**, in its billing currency.
* Apply the same 10% rate to both Pro and Premium. The included amount increases naturally with the plan price.
* Grant **once per successfully paid billing period**, using server-verified payment authority and durable idempotency, not a frontend callback or mere subscription object creation.
* Subscription-included credit **expires at the end of its own billing period**, without rollover.
* **Purchased top-up credit remains separate and does not expire**; do not change existing top-up checkout, ledger, or refund rules.
* Signup promotional/trial messaging credit stays a separate allowance with existing eligibility and expiry rules. Merchant messages still use Waaiio's configured charge rates, even if the platform receives a Meta free-message allocation; this is not cash back.

**Unresolved Owner decisions — future implementation gates (do not block this documentation PR).** The 10% rate for both Pro and Premium is already Owner-approved and is not reopened by these questions. The following require separate Owner sign-off before the implementation PR: (a) For coupon-discounted monthly plans, whether 10% uses the approved standard plan price or actual pre-tax amount paid — do not credit based on taxes or provider processing fees. (b) For annual plans, define a monthly equivalent and monthly release only after the annual billing/entitlement lifecycle is proven to support it. (c) Deterministic rounding rule for minor-unit conversion (e.g., 10% of $89.99 = $8.999 — round to $9.00 or truncate to $8.99). (d) Confirm that the commercial percentage should be an audited Admin-controlled setting (MFA-gated, versioned) rather than code-hardcoded or per-currency manual values. No silent change to existing subscribers' already-granted or already-pinned historical allowances.

## 2. Independently verified current state (read-only)

### Source-of-truth code

1. `supabase/migrations/418_fix_activation_pricing_authority.sql`, `activate_paid_subscription(uuid)`: included credit amount is read from a **fixed integer minor-unit value** at `config_snapshot.subscription_included_minor_by_tier_currency[plan][currency]`; it is **not** calculated as a percentage of subscription payment or tier price. This replaces activation function behavior originating in M375.
2. `supabase/migrations/375_subscribe_now.sql`, `reconcile_paid_allowance(uuid)`: the channel-ready/recovery route likewise resolves a fixed tier/currency amount from the payment-pinned versioned configuration; both paths must change consistently if a new percentage authority is introduced.
3. Both activation and recovery use the existing `grant_messaging_allowance(..., 'subscription_included', ...)` primitive. The activation path sets `expires_at` from **verified payment period_end**. Existing source-reference / payment-evidence deduplication must be preserved.
4. M418 explicitly rejects `payment_billing_interval <> 'month'` and subscription intervals other than `month`. Do **not** assume annual subscribers already receive properly prorated monthly credits.
5. `supabase/migrations/416_messaging_topup_infrastructure.sql` grants purchased credit with `expires_at = NULL`; leave purchased-credit semantics unchanged.

### Live Supabase inspection (read-only; staging and production)

On 2026-10-26, querying `pg_proc` for `activate_paid_subscription(uuid)` and `reconcile_paid_allowance(uuid)` in **both staging and production** confirmed that both deployed functions contain the fixed-value `subscription_included_minor_by_tier_currency` lookup. The activation functions also contain billing-interval validation and period-end expiry logic. Thus this is a verified implementation gap, not merely a stale documentation claim.

Staging `platform_settings.subscription_included_minor_by_tier_currency` currently stores the following **fixed** included amounts (major currency units):

| Market | Pro / growth | Premium / business |
|---|---:|---:|
| US | $2.25 | $6.00 |
| Canada | CA$3.00 | CA$7.50 |
| UK | £1.80 | £4.80 |
| Nigeria | ₦2,250 | ₦6,750 |
| Ghana | GH₵22.50 | GH₵60.00 |

These are **current staging values**, not 10% of the newly owner-approved October 25 subscription prices. Production had no active `platform_settings.subscription_included_minor_by_tier_currency` row during the read-only check, even though the deployed grant function supports fixed config lookups. This PR does **not** infer from that absence that production credit grants are operational.

### Target examples at owner-approved *monthly* plan prices (not yet deployed in all markets)

| Market | Approved monthly Pro | 10% Pro credit | Approved monthly Premium | 10% Premium credit |
|---|---:|---:|---:|---:|
| US | $49 | $4.90 | $89.99 | ~$9.00 (illustrative; rounding rule pending Owner approval) |
| Canada | CA$49 | CA$4.90 | CA$89.99 | ~CA$9.00 (illustrative; rounding rule pending Owner approval) |
| UK | £30 | £3.00 | £80 | £8.00 |
| Nigeria | ₦49,000 | ₦4,900 | ₦99,000 | ₦9,900 |
| Ghana | GH₵450 | GH₵45.00 | GH₵900 | GH₵90.00 |

**Pricing dependency:** PR #711 (Stripe-market subscription prices) merged to main at `352430a7` on 2026-10-26; NG/GH Paystack atomic plan-code cutover remains a separate Admin operation requiring verified plan codes and MFA-gated `save_provider_plan_refs`. This document does not overwrite prices or Paystack plan references. Actual grant calculations must be tied to the authoritative, verified plan price/currency for that billing period, not a frontend display, unsupported FX conversion, or stale fallback.

## 3. Implementation design to review — not implemented

1. Prefer a single versioned and MFA-authorized Admin commercial setting, provisionally `subscription_included_credit_percent_by_tier` with `growth: 10`, `business: 10`. Validate 0–100 bounds, strict types, all markets, permission/step-up and audit logging. **First check existing config extensibility**; avoid a duplicate pricing system. Determine whether to derive percent from `subscription_payments` verified amount or server-authoritative plan price under explicit discount/tax policy.
2. On each proven successful monthly subscription payment/renewal, compute integer minor-unit included credit using an explicit deterministic rounding rule. Pin the calculation inputs and setting version to the specific payment, so later plan price/percentage edits do not change prior grants.
3. Ensure initial activation and delayed channel-READY reconciliation call the **same canonical calculation** and produce exactly the same allowance amount, currency, source reference, expiration, and idempotency result. No dual grants after webhook retries or concurrent callbacks.
4. Preserve terminal ledger accounting and existing financial send authorization, pricing by country/category, rate snapshot provenance, FIFO allowance consumption, spend caps and threshold alerts.
5. Expire `subscription_included` at period end with no rollover. Do not expire `purchased`; preserve trial grants independently. No retroactive grant/backfill without separately approved migration policy.
6. Audit annual subscriptions **as a separate gated design question**, because the current M418 paid activation is month-only; do not promise annual credit monthly distribution until payment-period and renewal semantics are proven end-to-end.
7. Update merchant Billing display and public plan disclosure only after verified backend behavior; show accurate included credit/expiry and distinguish purchased funds.

## 4. Acceptance evidence required before the implementation PR (not this document)

* Current-head source trace for payment confirmation, Stripe and Paystack subscription renewals, delayed channel reconciliation, configuration pinning, and Admin writes.
* Owner sign-off on discounted prices and annual/monthly credit calculation behavior.
* Hermetic and real-PostgreSQL tests: Pro/Premium and all five currencies; minor-unit rounding; paid-vs-failed/pending payment; once-per-period grant; webhook replay and concurrency; versioned pricing/percentage; stale or missing currency/config; initial channel pending then ready; renewals and period turnover; upgrade/downgrade, cancellations/refunds; trial vs purchased vs included separation; no purchased credit expiry.
* Proof that an existing merchant and a new merchant receive correct balance, that no duplicate credit is granted, that an expired included allowance cannot fund a send, and purchased credit still funds sends when appropriate.
* Independent exact-head CI and security/financial review, staging verification, and distinct owner gates for merging, any database migration/config write, and production deployment.

## 5. Governance / stop condition

This PR deliberately changes **only this Markdown document**. It authorizes **no implementation**, no writes to staging or production, no provider payment actions, and **no merge without separate explicit Owner authorization**. PRs #711 and #722 have since merged to main; this document does not alter their scope or behavior. PR #712 (currency-safe payouts) remains an open draft on a separate lane. Any subsequent implementation code must use a separate isolated implementation lane and draft PR, followed by standard exact-SHA CTO verification and explicit Owner approval.
