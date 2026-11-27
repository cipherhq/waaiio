## 2026-11-27 — Release lock: measured corrections for M558 and M559

- **What changed:** The release lock gains five measured corrections. In both environments, `table:public.growth_pricing` and `table:public.keyword_campaign_responses` (M558) end with different table grants from the replay's prediction, because the replay does not model each environment's earlier grants (as with M549). On staging only, `table:public.customer_email_blocks` (M559) differs because staging's default server-role grants differ from production's (as with M547). The lock also records the measured catalogs (production 7231 objects, staging 7252).
- **Files:** `scripts/release-v3/lock.json`, `scripts/__tests__/release-v3-admission.test.ts`, `docs/RELEASE_V3_GATE.md`.
- **What it affects:** Only the catalog check in the next Release V3 prepare. There is no app, database or setting change.
- **What could break:** A wrong value makes prepare stop (fail closed). Every other catalog object must still match exactly.
