## 2026-11-04 — Release V3: staging lock update and teardown script for #813 renumbering

- Owner decisions 2026-11-04: #813 option A (renumber its migrations above the V3 lock to 511-513) and staging plan S1 (undo and re-apply).
- `scripts/release-v3/lock.json` and `lock-catalog-staging.json`: the staging entry leaves out #813's 91 catalog objects and 2 ledger rows (6309 objects `49dc33bc…`, 442 rows `dca1b4e0…`). The production entry is unchanged.
- `scripts/release-v3/staging-813-teardown.sql`: a one-time staging script that removes #813's 3 tables, 9 functions, 4 triggers and 2 ledger rows. It runs in one transaction and checks the reviewed statement bytes first, so it refuses to run on production or on a second attempt.
- `docs/RELEASE_V3_GATE.md`: documents the update and the merge order.
- Tests: the release-v3 admission tests pin the new staging values. The teardown was run locally on a disposable PostgreSQL by the author and both reviewers (tamper, dependency, success and re-run cases); no committed test runs it. The read-only staging prediction matched exactly.
- Could break: until the teardown runs on staging, a staging admission against this lock fails closed (catalog and ledger differ). After the teardown, main's old lock fails the same way until this merges. Releases cannot pass the gate in between, so the teardown and the merge happen back to back.
