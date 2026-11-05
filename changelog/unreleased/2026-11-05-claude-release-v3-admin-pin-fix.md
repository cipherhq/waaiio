## 2026-11-05 — Release V3: admin re-check accepts the unchanged pin, and recovery from the partial deploy of run 41937185420

- **What changed:**
  1. Deploy: after building the admin candidate with `vercel deploy --prod --skip-domain`, the re-check accepts the admin production target being exactly the approved pin or the new candidate, and still stops on any other value. Before, it required the target to move to the candidate, which Vercel does not do with `--skip-domain`.
  2. Prepare: after an Owner-approved lock re-certification, merchant and admin may start from two different certified SHAs on one line of history. The change set, lane and included PRs are computed from the older one. Mixed baselines are refused when the baseline comes from a release record.
  3. Lock: `certified` is now merchant `2b578c5b`, admin `bdc007a8` (what production serves after run 41937185420). Owner decision R1, 2026-11-05.
- **Why:** deploy run 41937185420 deployed merchant `2b578c5b`, then stopped with "Admin production target changed" before the admin alias. Read-only check: admin `targets.production` was still the approved pin; production had not drifted. Without the lock change the next prepare would stop on the split state.
- **Files:** `scripts/release-gate-v3.mjs`, `scripts/release-v3/lock.json`, `scripts/__tests__/release-v3-gate.test.ts` (fake models real `--skip-domain`; regression for run 41937185420; target-moves-to-candidate; mixed-baseline prepare; uncertified mixed baseline still stale), `scripts/__tests__/release-v3-admission.test.ts` (lock pin), `docs/RELEASE_V3_GATE.md`.
- **Affects:** Release V3 prepare and deploy only. Approvals, lanes, database admission and hold checks are unchanged.
- **Could break:** a later lock re-certification that names two SHAs not on one line of history fails closed. The next release's change set starts at `bdc007a8`, so it re-lists the PRs already shipped to merchant; their review records already exist.
