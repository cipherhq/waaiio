# Merchant-configured sales tax — Phase A

Issue: #980. Audit revision: 8a83dda5efb1d85082d1de05139ce227a1086620. Date: 2026-11-11.
Status: Owner approved the allocation rules on 2026-11-11 and authorized isolated implementation and independent review. Implementation and local integration verification are complete; final revision review and required remote CI remain release gates. Deployment and migration application to existing environments are prohibited. Owner separately approved disposable local PostgreSQL testing and verified local fixture baseline-grant repairs.

## Approved requirements

Optional merchant default tax, product/service override or exemption, tax-inclusive/exclusive pricing, server-authoritative customer totals, receipt/refund consistency. Waaiio percentage fees use the pre-tax sale amount. No automatic international tax determination, filing or remittance. Preserve both connected-provider and Waaiio-collected/manual-settlement routes.

## Evidence and boundaries

- GitHub current main and open PRs checked. #979 top-up UI, #945 public form captcha and #939 subscription activation are separate work. Recheck overlap before implementation.
- Graphify invoice and payment dependency maps at audit revision; source searches cross-check graph edges.
- Staging Supabase read-only information_schema/pg_proc query confirms dedicated tax fields on invoices; no shared tax snapshot on orders, bookings, payments or refunds. Existing order and booking authoritative functions remain present.
- Independent UI/schema/receipt reviewer also checked production schema and RLS read-only. Owner-scoped browser-direct catalog CRUD means database validation is required, not only UI validation.
- No runtime purchase/refund tests or live provider operations were performed. These are new-feature integration requirements, not claims of active defects.

## Current authorities

| Concern | Source | Required integration |
| --- | --- | --- |
| Invoice totals | app/api/invoices/route.ts; app/api/invoices/[id]/route.ts; dashboard invoices | Legacy single exclusive percentage calculated before discount; retain legacy rendering and use versioned new line snapshots. |
| Order confirmation | lib/bot/flows/ordering.flow.ts | Review and confirmation must show authoritative tax-inclusive/exclusive total. |
| Order commit | create_order_atomic, migration435; catalog-order-handler/create_catalog_order_atomic | Tax must enter authoritative transaction, not only displayed/session totals. Cover both catalog and normal ordering. |
| Service booking | scheduling.flow.ts; book_slot_authoritative_604 | Preserve expected-term/price checks and deposit/balance invariants. |
| Catalog editing | dashboard products/services; ProductForm; services/payload-builders; products/bulk | Default/inherit/override/exempt settings; validation and preservation through non-UI writers. |
| Percentage fee | payments/calculateFee.ts; bot/flows/shared/payment.ts; payments/charge-saved.ts | Separate gross charge from pinned pre-tax fee base. Preserve flat fees and gateway treatment unless separately approved. |
| Payment completion | payments/process-success.ts | Replay the same pre-tax basis used before provider dispatch. |
| Split routing | payments/stripe.ts; payments/paystack.ts; paystack-split.ts | Gross charged; calculated platform fee allocated separately; same merchant/provider destination. |
| Merchant payable | payments/payable-fees.ts | Keep transaction_amount gross. Tax is not Waaiio fee revenue; do not silently reduce merchant funds or alter remittance responsibility. |
| Refund accounting | payments/refund-handler.ts; M501 finalize_refund_execution and accounting_private.finalize_refund_accounting_modern | Original net/tax allocation; preserve legacy holds, idempotency and settlement adjustments. |
| Receipt/PDF | payments/send-confirmation.ts; receipts/generate-direct.ts; receipts/line-items.ts; pdf/receipt-generator.ts | Historical snapshot net/tax/gross; distinguish full purchase from partial payment. |
| Public receipt image | app/api/receipts/image/route.tsx | Preserve privacy: no monetary amounts or buyer identity on reference-accessible image. |
| Recurring invoice | cron/recurring-invoices | Explicit renewal/snapshot policy; do not silently use later tax defaults. |

## Proposed model

Separate versioned merchant configuration, per-item treatment and immutable transaction snapshots. Snapshots contain currency, quantities, quoted price/mode, effective label/rate/treatment, allocated discounts, net/tax/gross and percentage-fee base. Keep explicit currency-unit conversion and integer minor-unit allocation; never reuse major-unit invoice numeric amounts as provider minor units implicitly.

Do not change payments.amount or platform_fees.transaction_amount to net. Do not casually append tax keys to payments.fee_basis: its M376 guard allows a fixed set of keys. Use an additive versioned schema with constraints and immutability rules, preserving old payments/invoices through a legacy branch. Snapshot and line persistence must be atomic.

One authoritative algorithm must drive preview and database commit; if TS/SQL implementations are required, certify parity using shared fixtures and database tests. Catalog/default edits after a sale must not affect receipts, fee replay or refunds. Tax off preserves existing behavior; existing invoice tax must not be erased by a new default-off flag.

## Owner-approved business rules — 2026-11-11

1. Ordinary merchandise discounts reduce each eligible line before tax; allocate basket discounts deterministically. Special tax adjustments remain outside this version.
2. Add-ons inherit their parent item's treatment initially. Delivery is a separately configurable line, not silently taxed at an arbitrary basket rate. Tips and non-purchase giving are outside automatic tax application.
3. Deposits and balances allocate original net/tax proportionally, with final-payment rounding reconciliation; clearly show tax collected versus total sale tax. This is an implementation allocation, not certification of tax-point rules.
4. Full refunds return the remaining original net/tax. For partial mixed-rate refunds require item selection/quantity (or explicit validated line allocation) rather than guessing the tax from a single refund amount.
5. Existing issued invoices and scheduled recurring amounts keep their saved terms until explicitly revised; changes create a new version for future charges.
6. Preserve flat-fee threshold/basis and gateway fee rules. Only the percentage base changes to pre-tax, per the Owner's express decision.
7. Custom negotiated quotes with tax require itemized negotiated prices before acceptance. Owner explicitly selected this on 2026-11-11; never infer item prices by proportionally splitting a negotiated grand total.

The Owner approved these rules before implementation; they are not worldwide tax-compliance claims. Merchant/legal tax responsibility cannot be assigned merely by UI settings or the payment custody route.

## Implementation sequence after agreement

1. Additive constrained configuration/snapshot schema and deterministic calculation fixtures. No deployment/application of migrations without separate approval.
2. Tenant-scoped merchant/product/service settings; preserve other writers.
3. Wire supported order, catalog, invoice and service checkout paths with atomic snapshots and reconfirm changed quotes.
4. Wire fee initialization/finalization/saved-card replay, split destinations and both custody ledgers.
5. Wire receipts, partial payments/refunds and historical compatibility.
6. Independent exact-head review, allow/deny tests, database migration/rounding/concurrency tests and CI. Release only when supported paths reconcile end to end; explicitly gate unsupported capabilities rather than silently treating enabled tax as zero.

The initial invoice-only one-to-two-week estimate was provisional. Database price authority, both payment routes and tax-aware partial refunds make this broader than a settings form; do not promise that schedule until the accepted scope is decomposed.

## MCP precision checkpoint — 2026-11-11

Read-only Supabase catalogs in both staging and production show integer (scale 0) major-unit amounts in payments, orders, bookings and platform fees. Provider adapters convert these major units to provider minor units. Historical data must never be multiplied by 100 as part of a type widening. New calculator snapshots use integer minor units; `lib/tax/money.ts` is an explicit, rejecting conversion boundary for the four initial currencies.

Independent review confirmed that table widening alone is insufficient: order/catalog functions cast monetary JSON values to integers, and the private scheduling quote/create functions have integer money locals in addition to public RPC arguments and return columns. `finalize_payment_confirmation.v_total` is a row count and must remain an integer. Existing decimal invoice/payout columns must not be widened indiscriminately. Refund fee reversal rounding needs targeted tax-aware integration while retaining M501's wrapper and legacy holds.

Before writing the monetary widening migration, inventory column-dependent views/functions/triggers and grants, and choose explicit RPC signature replacement/versioning to avoid overload ambiguity. Then certify decimal persistence through initiation, finalization, split/custody accounting, refunds and manual settlement. This is a new-feature prerequisite; no live failed payment was reproduced and no current production defect severity is asserted.

At the initial foundation checkpoint, draft528 stored only configuration and catalog treatment. It must not be released independently as an operational tax feature. Subsequent implementation and local database verification are recorded below. No migration has been applied to staging or production.

Graphify lookup returned index revision `0a5b2d4798ca8d1c99aa45c7a291c0434f804483`; isolated implementation remains based on `8a83dda5efb1d85082d1de05139ce227a1086620`. The intervening #979 changes only the billing top-up popup, its test and changelog; none overlaps this tax foundation. Graph results are navigation evidence and were cross-checked with local source and live catalog types.

## Implementation progress

Branch rebased onto `0a5b2d4798ca8d1c99aa45c7a291c0434f804483` without conflicts. Local checkpoints (not pushed/deployed): foundation `ff34fc70462f4d851769eb79a6e388ae24984920`, precision `476e0c5cf`, SQL calculator `e76c9690e`, catalog/receipts `e96544156`.

- [x] Deterministic minor-unit calculator, explicit major/minor boundary and fee-basis extension.
- [x] Merchant settings route and Payments-tab component, supported-country/currency gate, owner allow/deny and rendered stale-save tests.
- [x] Catalog item controls and preservation of omitted fields from other writers.
- [x] Decimal precision prerequisite draft and seven disposable PostgreSQL tests (zero skipped).
- [x] SQL/TypeScript calculator parity, including direct line discounts before basket discounts. Latest targeted run: 20 PostgreSQL and 30 TypeScript tests, zero skipped.
- [x] Historical receipt rendering and allocation validation: 62 targeted tests, zero skipped. Database responses in receipt tests are mocked; PDF generation executes.
- [x] Authoritative order/catalog/booking snapshots and customer preview/commit wiring; unsupported paid capabilities explicitly gated when tax is enabled.
- [x] Atomic invoice and itemized negotiated-quote writes, UI, PDFs and recurring preservation. Independent compatibility corrections are under final verification.
- [x] Durable per-line payment/refund allocations, initialization/fee replay, bank transfers and authorization-bound refunds.
- [x] Related local regression testing, database concurrency/custody evidence, migration catalog deltas and CI wiring. Remote CI has not run for this branch.
- [ ] Independent final exact-head review. No merge/deploy/application authorization is implied.

Architecture checkpoints: calculate tax before existing authoritative persistence/status/deposit decisions. Do not wrap a committed untaxed purchase and rewrite totals. Preview and commit share one price authority; commit requires the entire expected snapshot, not gross alone. Direct item volume discounts stay attributed to their own line. Configuration writes and missing-default reads serialize through the business row.

Payments reserve original line allocations before dispatch and pin the same pre-tax fee basis for replay. Fully refunded payments remain in original allocation history. Full monetary refunds and quantity refunds share one durable line ledger; unknown provider outcomes retain reservations. Admin approval binds payment identity and canonical line selection. Taxable legacy v0 payments retain v0 fee policy and rounding while pinning a separate immutable tax fee basis; they do not silently enable v1.

## Local integration verification checkpoint

PostgreSQL 17.11 was built into a disposable temporary directory using existing local libraries. No permanent database service was installed. The complete production-emulating migration replay through draft533 succeeded, generating six new catalog deltas while leaving all existing committed catalog evidence unchanged. This is local replay evidence, not application to staging/production or a CI result. Regenerate and check the deltas after the final SQL edits.

Parent verification on PostgreSQL17: precision 7, calculator parity 23, purchase authority 16 tests, all passed with zero skips. The invoice lane separately ran 14 PostgreSQL17 cases and the finance lane 13; later review corrections require final revision confirmation. Parent rendered/handler verification: 68 passed, zero skipped across the selected invoice, refund and saved-card suites; calculator/settings/catalog/receipt group: 95 passed, zero skipped. Runs overlap other reported worker counts and must not be added as unique coverage.

Independent draft review found compatibility and preview issues: legacy invoices outside the four-currency rollout must retain existing single-rate behavior, and invoice settings loads must be identity-bound and fail visibly before inherited-tax preview/save. These corrections are being verified. Zero-value quantity returns are exposed through merchant/admin controls without a provider refund. Review of the final committed revision, full-schema purchase/refund evidence, TypeScript and final catalog checks remain outstanding.

Recurring invoice copies retain original financial terms. Existing cron-to-send authentication was not changed; actual automatic delivery remains uncertified. No notification or provider transaction was attempted. The feature branch has not been pushed or deployed, and no migration has been applied to an existing environment.

## Full-schema refund and settlement checkpoint

The first full-schema refund fee mismatch was a disposable replay setup gap: live staging and production already use the documented M501 public dispatcher, while migration-only replay had not installed it. Independent read-only verification confirmed this distinction. Replay now restores only the exact required M501 entrypoints and guards and compares every restored identity against both unchanged approved catalog locks. M532 requires the approved dispatcher before modifying its delegated modern function. No accounting enrollment or activation is performed by the test setup.

A separate full-schema test exposed a real integration requirement for new tax refunds: reducing the platform fee alone does not account for refunded principal in merchant payable balances. Independent review confirmed the calculation path; no production occurrence or loss was established. The correction is limited to tax-refund transactions. It retains original gross amounts and existing legacy refund behavior, appends uniquely attributable adjustment deltas, and keeps connected-provider receipts outside the Waaiio-held pool.

Independent architecture review agreed that affected merchant/currency pairs must use the existing lifetime balance model for generation as well as approval, including paid and outstanding commitments. A period-only projection would misread historical fee reversals. Payout creation must recompute under the accounting lock, preserve account/risk/held-status checks and scheduling metadata, and record its lifetime calculation basis. Historical payouts and adjustments are not rewritten. Pre-settlement tax adjustments may lack a source payout only when uniquely linked to an immutable, validated tax refund; legacy adjustments still require their source payout.

Completion evidence now includes exact partial/full and sequential refunds before and after settlement, historical waived-fee handling, retained gateway costs, concurrency, cross-tenant denials, duplicate finalization, legacy-null rejection, refund deletion protection, and both custody routes. Current trial fee policy is unchanged; historical waived-row fixtures are not certification of a new trial waiver.

## Final local verification

- Complete tax unit/handler/rendered UI group: **163 passed, zero skipped, 26 files** (`lib/tax`, excluding the separately executed database suites).
- Final five dedicated PostgreSQL17 suites: **75 passed, zero skipped** (precision 7, finance 14, invoices 15, purchase authority 16, calculator parity 23).
- Full migration-replayed PostgreSQL17 lifecycle: **11 passed, zero skipped**. Tests use real SQL authorities and synthetic provider-success evidence; no provider/webhook acceptance is claimed. Assertions cover 94.50 available after a 107.50 refund on a 215 sale, retained post-settlement debt, 100 of subsequent earnings leaving 2.50, historical waived rows, connected-provider exclusion, stale projection rejection, and concurrent payout creation.
- Existing payout route regressions: 235 in the primary batch, 347 in neighboring suites and 17 in the final step-up suite passed, zero skipped. These batches overlap by 16 tests; do not add them to other historical counts as unique coverage. Existing assertions remain intact, with explicit new read-RPC authorization checks.
- Admin Payments execution: **72 passed**; admin production build passed. Full main TypeScript reported ten errors in three unchanged test files and no tax implementation errors; scoped final payout TypeScript passed. Admin TypeScript reported 75 errors outside the changed finance files, so neither project is described as globally type-clean.
- Migration lint passed for all six new migrations. The PG17 oracle restores only documented, lock-verified operational accounting entrypoints; approved lock files remain unchanged.
- No pushed branch, remote CI, deployment, existing-environment migration, notification or real provider transaction is included in this evidence.

Residual UI limitation: zero-value return forms display the original quantity as their input maximum; SQL enforces the remaining quantity and rejects an excessive repeat return. Existing recurring notification authentication remains unchanged and actual automatic delivery is uncertified. These limitations do not remove the required release/provider acceptance gates.
