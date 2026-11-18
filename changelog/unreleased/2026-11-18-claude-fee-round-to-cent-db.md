## 2026-11-18 — Waaiio fee rounds to the cent/kobo in the database (M550)

- **Owner decision (2026-11-18):** round Waaiio's platform fee to the cent/kobo instead of whole units, for new payments only. Rates are unchanged and no historical rows are rewritten. PR #1122 did this in TypeScript; this PR covers the three database sites it disclosed.
- **Migration `supabase/migrations/550_fee_round_to_cent.sql`:** rewrites one statement in each function from its live definition (the M525 method), so schema, SECURITY DEFINER, search_path, owner and grants stay the same (DB-002). It fails if a function is missing, if the whole-unit statement is not found exactly once, or if any attribute changes; a re-run is a no-op.
  - `public.bind_merchant_tax_fee_980`, legacy (v0) branch: `round(net*pct/100)+flat` → `round(round(net*pct*100)/10000+flat,2)`, the same as its v1 branch and `calculateFee`. A v0 payment with merchant tax no longer charges whole units (e.g. 3% of $10.00 net is $0.30, was $0).
  - `public.finalize_stripe_recurring_charge`: recorded fee `ROUND(amount*pct/100)+flat` → `ROUND(ROUND(amount*pct*100)/10000+flat,2)`, as `getPlatformFees`. $50 at 2.5% records $1.25 (was $1). The token and Paystack recurring finalizers already rounded to the cent and are not touched.
  - `accounting_private.finalize_refund_accounting_modern`: partial-refund fee reduction for payments without merchant tax `ROUND(x)` → `ROUND(x,2)`. $15.50 refunded of $50 at 3% reduces the fee by $0.47 (was $0). The merchant-tax branch, full refunds (fee to 0) and payout adjustments (they follow the refund amount) are unchanged.
- **Catalog delta:** `supabase/catalog-deltas/550_fee_round_to_cent.json` from the CI PostgreSQL 17 oracle.
- **Registry:** `docs/MIGRATION_REGISTRY.md` reserves 550.
- **Tests:**
  - New `lib/__tests__/fee-round-to-cent-550-db.test.ts` (full migration history, CI shard b step "Migration 550 fee round-to-cent tests"): final catalog attributes and grants, DB-006 functions untouched, rebuild from the pre-M550 statements, re-run no-op, fail-closed on unexpected bodies, partial-refund reduction on the Waaiio-held route (with payout adjustment) and the merchant-connected route (no adjustment), replay of a finalized refund, another business's fee untouched.
  - `lib/__tests__/stripe-recurring-finalization-db.test.ts`: cases q/r/s compared the fee with `parseInt`, which read 1.25 as 1; they now compare the exact value. New case s2: the recorded recurring fee equals `calculateFee` for the same amount and rate ($50 at 3% → $1.50).
  - `lib/tax/__tests__/finance-authority-db.test.ts`: the fixture applies M550 after M532; the v0 test now expects $0.30 (it was named "preserves whole-major percentage rounding").
- **Not applied:** to staging or production; that needs a separate Owner approval. A read-only check on staging found each statement exactly once, with bodies identical to the CI replay.
- **Could break / notes:**
  - The M501 accounting activation procedure recognises the Stripe recurring finalizer by body hash; it already fails closed since M525 and still does.
  - Exact half-cent ties follow PostgreSQL numeric rounding (half away from zero); the TypeScript side uses float `Math.round`, so a tie can differ by at most one cent, as v1 already does.
  - Until this is applied, a v0 payment with merchant tax keeps the whole-unit fee pinned by the database while #1122's TypeScript rounds untaxed payments to the cent.
