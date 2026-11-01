# Accounting installation and operational activation

M500 installs inert accounting tables, RLS/ACLs and private implementations. It does not enroll a business/payment, replace the public refund dispatcher, install financial guards or change settlement authority. M501 installs an owner-only `SECURITY INVOKER` procedure and does not call it. Both complete files run in ordinary migration bootstrap; neither skips its body for CI.

Installing these migrations is not financial activation. Migration history records the full installation, not a later procedure call. Reconcile canonical sequence/name/hash with the migration service's actual generated ledger version; never assume or repair a numeric ledger version.

Separately authorized activation uses one reviewed transaction and one database request: `BEGIN`, transaction-local evidence binding, exact procedure call, postchecks and `COMMIT`. Never rely on pooled-session state or a separate preliminary `set_config` request. The procedure accepts data only and executes fixed SQL, never SQL supplied by a manifest. It has no transaction control, so failure rolls back enrollment, function replacement, triggers and indexes together.

The execution authority must verify the approved project/environment, exact source and raw manifest hashes, complete expected-before catalog, audit actor and genuine Owner receipt. A hexadecimal receipt argument is only a consistency field, not authentication of approval. Current schema/data is checked under exclusion locks; unresolved or in-flight domains abort. Drain relevant writers before activation: an invocation already running an old function body can otherwise resume under new guards and fail atomically. Quiescent composition tests do not establish transparent online cutover safety.

Exactly reviewed recurring precursors are supported: token M335, Stripe M339 and Paystack M337 or M452. Each replacement adds its existing authoritative payment ID to the fee insert. The M452 branch preserves its parent lock and search path; unknown bodies fail closed. Existing cancellation semantics are never downgraded.

Schema activation precedes exposure of application code requiring the guards. Keep enrollment, activation and deployment approvals distinct. Hold domains and refund membership are separate reviewed datasets; no automatic release or historical attribution occurs. Connected provider splits remain separate from platform-held settlement authority. Production additionally requires current backup and verified restore evidence.

## Reproducible proof

`lib/__tests__/accounting-migration-installation.pg.test.ts` runs unchanged canonical files against two disposable local databases. It covers inert installation under legacy and canonical refund/recurring baselines, owner-only access, missing binding/unknown source denial, complete rollback, all three recurring writers/replay, strict/direct/enrolled refunds, manual confirmation/rejection and held/prior-authority behavior. Identifiers are synthetic; no provider requests or hosted credentials are used.

Run with an existing authorized local PostgreSQL owner and preprovisioned Supabase-like roles:

```sh
TEST_DATABASE_URL=postgresql://127.0.0.1:5432/postgres REQUIRE_PG_TESTS=true npx vitest run lib/__tests__/accounting-migration-installation.pg.test.ts
```

Absent or non-local database access fails, never skips. CI's `security-acl-tests` job discovers this file, uses an isolated database and enforces zero skips. The unit step explicitly excludes this mandatory database suite. Exact-head CI receipts with individual counts remain required before claiming CI verification.
