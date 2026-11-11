# Shared tax arithmetic contract (#980)

Draft migration 530 defines `public.calculate_merchant_tax_quote_980(jsonb,text,jsonb,bigint)` and its rule validator. Both are immutable security-invoker functions with a fixed `pg_catalog` search path; only `service_role` may execute them. They perform no table reads or writes.

The calculator accepts the same configuration and ordered line JSON as `calculateTaxQuote` in `calculation.ts`, plus currency and optional basket discount. All money is nonnegative integer **minor units**, bounded by JavaScript's safe-integer maximum. Rate basis points are integers from 0 through 10000. The result is the same version-1 line snapshot, including allocated discounts, effective tax treatment, net, tax, gross, and pre-tax percentage-fee base.

PostgreSQL uses exact numeric multiplication, `div` and `mod` rather than floating point or rounded decimal division. Largest-remainder discounts preserve input-order ties. Half-up integer rounding matches the TypeScript BigInt formula. Label/description limits count UTF-16 code units, matching JavaScript strings, and labels use the JavaScript whitespace trimming set.

Malformed JSON is rejected before generating a snapshot. TypeScript validation now rejects non-string identifiers/currency and non-array inputs rather than relying on type declarations or coercion.

## Verification status

- TypeScript calculator and malformed-input suites: 29 passed, zero skipped locally.
- Scoped TypeScript check covering the SQL test and changed calculator: passed.
- `sql-calculation.pg.test.ts` is authored for an explicitly supplied disposable loopback test database. It compares SQL/TypeScript mixed-rate baskets, rounding, discounts, disabled tax, Unicode labels, safe-integer boundaries and invalid inputs, and executes expected-deny/allow role checks.
- SQL parity and role execution tests passed after the Owner approved an elevated disposable local PostgreSQL instance: **19 passed, zero skipped**. No staging or production migration was applied. This proves the pure calculator contract; it is not checkout or refund integration evidence.
- A PostgreSQL 17 catalog-oracle delta must be generated and reviewed before release; it has not been fabricated from expected source. CI must explicitly execute this SQL test in a database job with `REQUIRE_PG_TESTS=true` and report zero targeted skips.

The pure function is not a pricing authority by itself. Checkout integration must supply authoritative locked line/configuration inputs, compare the customer-confirmed gross before persistence, and save the snapshot atomically with the transaction. Existing payment routes and custody rules are outside this migration and remain unchanged.
