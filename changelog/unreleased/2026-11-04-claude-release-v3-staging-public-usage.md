## 2026-11-04 — Release V3: staging lock records the release robot's access to schema public

- Owner decision 2026-11-04 (option A). The first prepare run stopped because staging revoked PUBLIC `USAGE` on schema `public` and production did not. The read-only `release_observer` therefore saw `public` types schema-qualified on staging, and about 928 catalog digests differed from the lock.
- Staging only, Owner-approved: `GRANT USAGE ON SCHEMA public TO release_observer;`. It resolves names only; it grants no table access.
- `scripts/release-v3/lock.json` and `lock-catalog-staging.json`: the staging entry records the changed `schema:public` digest. The staging catalog is 6400 objects, `12ff1745…` (was `80f4ec20…`). `observed.staging_public_usage` keeps the previous values. Production is unchanged.
- Verified read-only: live staging as `postgres` and as `release_observer` both read `c0d2774c…`, which is this lock plus the 509 and 510 deltas.
- `docs/RELEASE_V3_GATE.md`: documents the grant and that it must not be applied to production.
- Tests: the release-v3 admission test pins the new staging digest and the recorded previous values.
- Could break: #872 also edits the staging lock map and must be rebased onto this change.
