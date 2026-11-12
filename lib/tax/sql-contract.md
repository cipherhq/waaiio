# Shared tax arithmetic contract (#980)

Draft migration 530 defines `public.calculate_merchant_tax_quote_980(jsonb,text,jsonb,bigint)` and its rule validator. Both are immutable security-invoker functions with a fixed `pg_catalog` search path; only `service_role` may execute them. They perform no table reads or writes.

The calculator accepts the same configuration and ordered line JSON as `calculateTaxQuote` in `calculation.ts`, plus currency and optional basket discount. All money is nonnegative integer **minor units**, bounded by JavaScript's safe-integer maximum. Rate basis points are integers from 0 through 10000. The result is the same version-1 line snapshot, including allocated discounts, effective tax treatment, net, tax, gross, and pre-tax percentage-fee base.

PostgreSQL uses exact numeric multiplication, `div` and `mod` rather than floating point or rounded decimal division. Largest-remainder discounts preserve input-order ties. Half-up integer rounding matches the TypeScript BigInt formula. Label/description limits count UTF-16 code units, matching JavaScript strings, and labels use the JavaScript whitespace trimming set.

Malformed JSON is rejected before generating a snapshot. TypeScript validation now rejects non-string identifiers/currency and non-array inputs rather than relying on type declarations or coercion.

## Verification status

- TypeScript calculator and malformed-input suites: 29 passed, zero skipped locally.
- Scoped TypeScript check covering the SQL test and changed calculator: passed.
- `sql-calculation.pg.test.ts` is authored for an explicitly supplied disposable loopback test database. It compares SQL/TypeScript mixed-rate baskets, rounding, discounts, disabled tax, Unicode labels, safe-integer boundaries and invalid inputs, and executes expected-deny/allow role checks.
- SQL parity and role execution tests passed after the Owner approved an elevated disposable local PostgreSQL instance: **23 passed, zero skipped**. No staging or production migration was applied. This proves the pure calculator contract; it is not checkout or refund integration evidence.
- A PostgreSQL 17 catalog-oracle delta must be generated and reviewed before release; it has not been fabricated from expected source. CI must explicitly execute this SQL test in a database job with `REQUIRE_PG_TESTS=true` and report zero targeted skips.

The pure function is not a pricing authority by itself. Checkout integration must supply authoritative locked line/configuration inputs, compare the customer-confirmed gross before persistence, and save the snapshot atomically with the transaction. Existing payment routes and custody rules are outside this migration and remain unchanged.

## M531 purchase authority and callers

Draft only; not applied to staging/production. `merchant_tax_context_980` locks the stable business row and current settings. Settings INSERT/UPDATE takes the matching exclusive business lock, so missing settings cannot race checkout. Product/service/addon rows use existing authoritative locks. Snapshot money is minor units; database purchase amounts remain two-decimal major units (M529).

- `create_order_atomic` retains existing args and adds `p_expected_tax_snapshot jsonb DEFAULT NULL`, `p_preview boolean DEFAULT false`. Preview requires `p_validate_products=true`. It derives canonical item/variant/addon prices, direct volume discounts, basket promo, delivery, and tax; returns before rows, inventory, counters, reservations, or sequence mutation. Returned fields: `is_preview:true,created:false,server_total,server_discount,server_volume_discount,server_addons_total,tax_snapshot`. Existing-order preview returns the original snapshot. Commit must submit the full expected snapshot and gross. Changed terms fail before persistence; callers reconfirm.
- `quote_booking_tax_980(p_business uuid,p_service uuid,p_appointment uuid,p_party integer,p_addons jsonb,p_promo uuid,p_expected jsonb)` is service-only and read-only. Returns `total,deposit,tax_snapshot` plus existing authority terms. `private.scheduling_604_quote` is the same implementation used before booking persistence; the preview skips only confirmation comparison. Booking commit expected terms now include `tax_snapshot`. Public authoritative wrappers additionally return the saved snapshot. Deposit tax is allocated proportionally with exact minor rounding. Package redemption/giving skip new tax; manual mode has no upfront deposit. Zero-price guest-deposit consideration follows the existing source-specific authority.
- `accept_order_quote_atomic` additionally takes full expected snapshot; taxed quotes require stored explicit negotiated `quoted_items`. M533 owns writing those itemizations, and acceptance persists their negotiated prices without inventing an allocation.
- Tax-backed purchase snapshots are immutable; invoice draft replacement is permitted only through trusted authority, with subtotal/discount/tax/gross/currency reconciliation. Browser writes cannot introduce or replace snapshots. Operational status/paid amounts remain separate.
- `lib/tax/server-quote.ts` validates returned snapshots/gross and fails closed. Ordering and scheduling bot confirmation renders net/tax/gross before accepting; changed terms return to confirmation. Public booking uses its existing verified-email handler with `preview:true` before any identity or booking writes; manual booking similarly previews before identity creation and requires an explicit confirmation. Catalog order links use the canonical payment initializer and show saved tax breakdown.

Rates keep the `rateBps` field, with up to two decimal basis-point places (four percentage places). `parseTaxPercent` converts exact decimal text and rejects excess precision. SQL numeric and TypeScript BigInt calculations use scale 1,000,000; money remains integer minor units.

Unsupported new paid table/ticket/payment-booking purchases are refused at booking INSERT when merchant tax is enabled; free purchases and tax-disabled legacy paths retain behavior. Standalone paylinks reject enabled merchants before payment creation and direct them to an itemized invoice/order. Existing historical null-snapshot payments remain payable under their saved terms. Enabling settings is blocked unless the authoritative country mapping resolves NGN/USD/GBP/CAD.

CI wiring: `merchant-tax-postgres-tests` runs the five named tax PostgreSQL suites sequentially in separate disposable PostgreSQL17 databases, with required environment flags, structured result assertions rejecting every skipped/pending test, and SHA/count receipts. The existing migration aggregate requires that job. This describes the workflow configuration, not a completed CI run.
