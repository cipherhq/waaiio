# #980 — monetary precision prerequisite

Base: `8a83dda5efb1d85082d1de05139ce227a1086620`; subsequent main `0a5b2d4798ca8d1c99aa45c7a291c0434f804483` changes only the top-up popup lane. Read-only schema/function evidence collected 2026-11-11 through Supabase MCP. This document describes a **new-feature prerequisite**, not an active production defect declaration.

## Units and migration boundary

M529 preserves existing **major-currency** semantics. `10` remains `10.00`; historical values are never multiplied or divided by 100. Tax calculation uses integer minor units through the explicit TypeScript boundary. Provider amounts already expressed in minor units retain integer types. Quantities, capacity, counts, percentages and nonmonetary sequence numbers retain their types.

The migration widens 26 columns to `numeric(20,2)`:

- `payments`: amount and the three gateway-fee observation/claim fields.
- `platform_fees`: gross transaction amount, total/flat/gateway fees, reseller commission.
- `orders`: gross, platform fee, discounts, shipping/addons, deposits/balance.
- `bookings`: gross, deposit, platform fee, discount.
- `order_items.unit_price`.
- `quote_requests.estimated_subtotal`, `quoted_amount`.
- `payment_spend_applications.amount`, `payment_visit_applications.visit_amount`.

Existing decimal invoice/refund/payout columns are unchanged. No routing, custodial ownership, paid settlement state, tax remittance or gateway-fee bearer rule changes here.

## Function dependency inventory

`lib/tax/__tests__/precision-change-manifest.json` records exact old/new signatures. M529 includes explicit full replacements, not runtime text substitution.

| Function group | Required change | Preserved behavior |
| --- | --- | --- |
| `create_order_atomic` | Numeric monetary args, accumulators, persisted unit-price casts | Product/addon/promo validation, locking, inventory, idempotency, legacy discount rounding |
| `create_catalog_order_atomic` | Numeric amount accumulator and persisted unit-price cast | Existing catalog validation and stock transaction |
| `accept_order_quote_atomic` | Numeric quoted total, deposit/balance and unit-price snapshot | Identity, quote state, inventory; explicit `trunc` preserves its previous integer-division deposit until tax-specific allocation is added |
| `book_slot_atomic` | Numeric money args and committed total/deposit locals | Counts, capacity, class/staff checks, slot locks and idempotency |
| `private.scheduling_604_quote` | Numeric money locals/casts | Raw catalog whole-price guard, existing discounts, deposit modes, price limits, counts |
| `private.scheduling_604_create_booking` | Numeric total/deposit locals | Original confirmation claim, package, promo and status ordering |
| Three public `*_authoritative_604` wrappers | Numeric money inputs and returned committed amounts | Existing private authority and permissions |
| `claim_payment_finalization_with_verified_fee` | Accept exact 2-decimal fee; preserve all three fields without integer cast | Tuple/provenance checks, sealing, conflict refusal, claim token and legacy recovery |
| `confirm_nonorder_transfer_atomic` | Numeric payment amount local | Existing merchant confirmation and fulfillment controls |
| `apply_payment_customer_visit_once` | Numeric spend local and marker column | Original entity attribution and idempotency |
| Five revenue/history functions | Numeric monetary returns/accumulators | Existing owner checks, identity matching and report definitions |

The selected core columns and changed public signatures had no view/caller dependencies reported by `pg_depend` in staging. PL/pgSQL text dependencies were separately traced; the absence of catalog edges is not proof of complete application coverage.

The migration pins known function bodies and ACLs before changing anything. Three production report definitions differ from staging only in comments; both exact captured hashes are permitted. Changed signatures/return types are dropped **without CASCADE**, recreated and granted explicitly. Old integer overloads must be absent. An unknown source, ACL, overload or dependent object stops the transaction instead of overwriting another lane.

## Explicit exclusions

- `create_transfer_with_reservation.v_expected_amount` is `ROUND(order.total_amount * 100)`: a provider **minor-unit** integer, so it is unchanged.
- `finalize_stripe_recurring_charge.p_amount_cents` and its minor-unit comparisons remain integer; its major-unit locals are already decimal.
- `create_recurring_offer` is restricted to Giving. Automatic tax does not apply to Giving; it is not rewritten.
- Separate table-reservation, ticket and generic payment-booking price authorities are not upgraded as part of this initial order/invoice/service tax scope. Tax enablement must not silently claim coverage of those capabilities.
- `finalize_payment_confirmation.v_total` and accounting count variables are counts, not money.
- M501 refund accounting, legacy holds and settlement are not replaced by this precision migration. Tax-specific refund/fee allocation remains a following integration.

## Executable evidence and limits

`precision-db.test.ts` runs the complete M529 draft in a **disposable local PostgreSQL** database, guarded by a localhost URL and the exact dedicated database name. It installs captured baseline function definitions and minimal typed fixture tables, then exercises real RPCs. The fixtures include the unchanged M485 provenance trigger. They are not a full production RLS/constraint/trigger replica.

Coverage: historical no-rescale, fractional gross/fees, signature and ACL final state, fractional verified-fee seal/conflict/denial, idempotent order customer spend, owner-scoped revenue/history, and real slot-writer fractional total/deposit persistence. The tests do not certify full checkout, refunds, custody settlement concurrency or provider behavior.

The first local `initdb` hit a sandbox shared-memory permission error. That path stopped; after explicit Owner authorization, the elevated disposable server was initialized on localhost only. No staging or production migration, business row, provider operation or deployment was performed. Existing-environment application still requires separate authorization.

CI integration is pending with the coordinating agent: the dedicated PostgreSQL job must set `TAX_PRECISION_TEST_DATABASE_URL` and `REQUIRE_TAX_PG_TESTS=true`. A generic green test run with this suite skipped is not evidence that these database tests ran.
