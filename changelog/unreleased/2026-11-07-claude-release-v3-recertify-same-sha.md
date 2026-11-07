## 2026-11-07 — Release V3: re-certify the last release after a same-code redeploy

**Why:** release #5 prepare (run 42320623698) stopped with "Production merchant is not serving the last certified release (stale or uncertified baseline)".
- On 2026-11-06 at 03:28 UTC, after the Owner changed the production Stripe keys, the merchant site was rebuilt by CLI at release #4's own SHA `466e0691` (deployment `dpl_9jdnT2Lx…`).
- The code was the same, but it was a different deployment from the one in release #4's record (`dpl_GGSn7F8F…`).
- The documented recovery ("reviewed lock update") had no effect, because prepare reads the lock only when no release record exists.
- Rolling back would bring back the old Stripe keys.

**What changed**
- `scripts/release-v3/lock.json`: new `recertified` entry (Owner-approved 2026-11-07). It names deploy run 42136027063, SHA `466e0691`, the merchant deployment now serving (sha256 `bc8a5005…`), and the unchanged admin deployment (`73dbe116…`).
- `scripts/release-v3/admission.mjs` `loadLock`: accepts an optional `recertified` with exactly these keys and valid values; anything else fails closed.
- `scripts/release-gate-v3.mjs`: `certifiedBaseline` passes the last record through the new `applyRecertification`. The lock entry replaces the record's deployment hashes only when it names exactly the newest successful deploy run and that run's SHA. A different SHA fails closed. An entry for an older run is ignored. The packet's `certified_by` says "lock re-certification after release-deploy run N".
- `docs/RELEASE_V3_GATE.md`: "Same-code redeploy" under Recovery.

**Unchanged:** every other prepare and deploy check (CI, staging, database admission, reviews, lane, packet, single use, deploy identity); mixed baselines (still lock `certified` only); rollback rules; migrations, app code.

**Tests:** `scripts/__tests__/release-v3-gate.test.ts` covers `certifiedBaseline` with a real release-record zip (record only, matching re-certification, older run ignored, other SHA refused). `scripts/__tests__/release-v3-admission.test.ts` covers the committed entry and malformed entries.

**Could break:** nothing outside the release gate. A wrong deployment hash in the entry would make prepare stop again (fail closed).
