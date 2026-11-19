## 2026-11-19 — Release gate: measured corrections for M547/M549 table permissions

- **What changed:** The Release V3 gate can now accept a reviewed, measured correction for one catalog object in one environment. A correction applies only while its migration is admitted, and only if the gate's prediction still equals the recorded value. `lock.json` records 2 corrections for production and 3 for staging (`admin_role_permissions`, `business_bank_accounts`, plus staging `customer_suspensions`), with the measured catalog aggregates. Owner decision 2026-11-19 (option A), after prepare run 44537217990 stopped.
- **Files:** `scripts/release-v3/admission.mjs`, `scripts/release-v3/lock.json`, `scripts/__tests__/release-v3-admission.test.ts`, `docs/RELEASE_V3_GATE.md`.
- **What it affects:** Only Release V3 prepare and deploy database admission. No app code, migration or database change.
- **What could break:** A wrong correction would make prepare stop (fail closed), never pass silently. Every other object still has to match exactly. A future lock re-bootstrap must remove these entries; a stale entry stops the gate.
