## 2026-11-11 — Merchant-configured purchase tax (unreleased)

- PR982 CI follow-up keeps legacy booking/payment regression fixtures aligned with explicit untaxed authority responses, sanitizes tax-preview log metadata, and verifies the Owner-approved CI-only deployment exception. Disposable replay restores the existing lock-verified accounting entrypoints; historical M518 HTTP compatibility stays bounded to its original schema versions, while current-schema tests assert the intentional numeric-money signatures. No live migration or deployment is included.

- Adds `lib/tax/calculation.ts` and focused tests for optional merchant tax, item overrides/exemptions, inclusive/exclusive prices, discount allocation, payment allocation and item refunds. Validates stored snapshot arithmetic before allocation.
- Extends `lib/payments/calculateFee.ts` with an optional pre-tax percentage basis. Existing callers retain their current behavior; gross still controls the flat-fee microtransaction threshold. Records Owner-approved rules in `docs/contracts/980-merchant-tax-phase-a.md`.
- Adds whitelisted settings parsing, explicit major/minor conversion for NGN/USD/GBP/CAD, and an unapplied draft configuration migration. No existing amount is rescaled.
- Local regression verification: 147 tests passed, zero skipped across six files. Independent reviewer separately ran 81 tests across five files, zero skipped; reviewed the refund rounding correction and settings/schema tenant boundaries. These are local results, not CI or database policy execution evidence.
- The subsequent integration adds merchant settings under Payments, catalog overrides/exemptions, authoritative order and service quotes, itemized negotiated quotes, invoices, receipts and refund controls. New tax configuration is limited to NGN/USD/GBP/CAD; legacy invoices in other currencies retain their existing single-rate behavior. Unsupported paid capabilities direct tax-enabled merchants to an itemized invoice or order.
- Draft migrations528–533 add configuration, decimal money precision without rescaling, calculation authority, immutable transaction terms, and payment/refund allocation ledgers. Percentage fees use pre-tax amounts; existing flat-fee rules and both payment custody routes remain intact. Provider failures release allocation only with a confirmed outcome; uncertain outcomes remain held.
- Merchant/admin refunds support explicit line amounts and zero-value quantity returns. Admin authorization binds the selection and request identity. Zero-value returns do not contact a payment provider. Receipts use stored tax terms, including partial payments and refunds.
- Tax refunds account for refunded principal through immutable adjustment records. Affected merchant/currency pairs use lifetime balances and atomic payout creation so refunds before or after settlement reconcile correctly. Other legacy payout paths remain unchanged; merchant-connected funds stay outside the platform-held pool.
- Invoice sends freeze reviewed financial terms before dispatch without claiming delivery. Recurring copies retain their original terms; existing cron-to-send authentication was not changed and automatic delivery is not certified by this work.
- Supabase MCP read-only catalogs in staging and production confirm integer major-unit payment/order/booking/fee columns. Exact decimal persistence and corresponding RPC arguments, locals and return types are prerequisites for fractional tax totals. Independent review confirmed this feature-integration constraint, not an active-payment-defect claim.
- Verification includes disposable PostgreSQL17 migration replay and generated catalog deltas, SQL authority tests, rendered merchant/admin forms, HTTP handlers with mocked providers, and independent draft reviews. Final revision evidence is maintained in `docs/contracts/980-merchant-tax-phase-a.md`; earlier test counts above are historical foundation checkpoints, not cumulative unique coverage or CI claims.
- No deployment, staging/production migration, notification or real provider transaction occurred. Required CI and final release approval remain separate gates.

### CI and quote compatibility follow-up
- Scope: RefundModal type adapter, legacy reseller/ordering fixture compatibility, actual quote button/parser/handler snapshot binding, and draft M531/M533 untaxed negotiated-price compatibility with regenerated catalogs.
- Verification: scoped independent review; 31 reseller SQL tests plus four concurrency scenarios, 42 ordering SQL tests, 35 quote/route/logging tests, 18 invoice SQL tests and five refund UI tests passed locally with zero targeted skips. Groups are not a unique combined count. Fresh remote CI remains required.
- Risk: quote messages with non-null snapshots need the new terms-bound button; old snapshot-null quote behavior is preserved. Existing tax-unsupported currencies remain untaxed. Both payment custody routes and production deployment configuration remain unchanged.

### Later migration-fixture compatibility
- Updated only refund convergence and recurring finalization test fixtures to preserve immutable accounting provenance. All original assertions and runtime guards remain intact.
- Restored the historical M356 projection signatures only within its existing migration replay fixture; current tax migrations are unchanged.
- Disposable PG17 evidence: refund convergence 30 passed/zero skipped; recurring finalization 34 passed/zero skipped. Independent reviewer verified fixture boundaries. Existing dedicated CI teardown disposes retained rows; recurring suite requires a fresh database.

### Payment identity test fixtures
- Three existing database suites now seed payments with their owning business; entity ACL checks use exact current M531 signatures. Runtime code, accounting guards and assertion expectations remain unchanged.
- Fresh disposable PG17: saved-card session 11, saved-card ACL 1, entity commit 70 passed, all zero skips. Historical replay tests require fresh databases; contaminated same-database reruns are excluded from evidence.

### Offline approval fixture
- M479 database test keeps its exact 5000 amount assertion numeric after money precision changes and leaves immutable accounting rows for existing dedicated database teardown.
- Fresh disposable PG17: 21 passed, zero skipped; independently reviewed. Runtime payment behavior and guards unchanged.

### Payout fixture currency compatibility
- M440/M444 test fixtures now supply consistent NGN business/payout/adjustment identity and retain immutable provenance with isolated IDs. Assertions and runtime code are unchanged.
- Fresh disposable PG17: M440 18 and M444 5 tests passed, zero skipped. Bounded later database suites also passed; remote verification remains required.
