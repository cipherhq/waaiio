## 2026-11-26 — Release lock: re-certify the 2026-11-19 merchant redeploy

- **What changed:** The `recertified` entry in the release lock now names release deploy run 44568946884 at `15d8e3cd`, with the production merchant deployment that serves today. That deployment is the same-SHA Vercel redeploy made after the Owner added the SMS sender setting on 2026-11-19. The admin deployment is unchanged. This entry replaces the old one for release #4, which no longer applied.
- **Files:** `scripts/release-v3/lock.json`, `scripts/__tests__/release-v3-admission.test.ts`, `docs/RELEASE_V3_GATE.md`.
- **What it affects:** Only the certified baseline that the next Release V3 prepare reads. There is no app, database or setting change.
- **What could break:** A wrong value makes prepare stop with "stale or uncertified baseline" (fail closed). The entry stops applying once a newer release deploys.
