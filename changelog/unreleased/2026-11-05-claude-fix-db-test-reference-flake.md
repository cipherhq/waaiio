## 2026-11-05 — Tests: database test booking codes no longer collide

**What changed**
- Three disposable-Postgres test files each build their own booking reference generator: `lib/__tests__/table-reservation-730-db.test.ts`, `lib/__tests__/p1-pkg1-package-redemption-db.test.ts` and `lib/__tests__/recurring-billing-db.test.ts`.
- Those generators picked a random 4- or 5-digit code without checking for duplicates. The column is `UNIQUE`, so two test bookings could occasionally get the same code and the test failed with `23505 bookings_reference_code_key`. This happened on `main` at `63447918`, run 42111907234, "M476 table reservation behavioral + security DB tests".
- Each generator now retries until the code is unused, the same way the real generator does (migration 064). The code format is unchanged.

**What it affects:** these three test files only. No app code, migration or production function changes.

**What could break:** nothing at runtime. In a local check against disposable Postgres, the old generator hit a duplicate within 5,000 inserts, and the new one gave 5,000 distinct codes.
