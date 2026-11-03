# Fixed postlaunch app-only release

The named `postlaunch-app-only-v1` policy (manifest schema6) admits only the baseline, target, tree and exact changed-blob inventories in `scripts/postlaunch-release-targets.json`. Both projects may use that one fixed source revision. No deleted paths or migration changes are admitted. The pinned read-only catalog-query change is release verification code, not a migration.

The existing verification and deployment workflows remain the entry points. Source ancestry, pristine checkouts, protected-main CI, authenticated verification artifacts, original private report bytes, fresh Owner approval, staging acceptance, and merchant-then-admin deployment retain their existing gates. The bounded chunk transport is reused. No deployment, SQL, or configuration operation is added by the policy.

Evidence for both environments must establish the completed post-app catalog through the fixed canonical projections, exact post-app component contracts, and an approval-bound current catalog digest. The successor explicitly accounts for the two canonical M446 production policy deletions in a separate completion projection; schemas1–5 retain their historical behavior. The complete current ledger is bound with zero allowed additions. Current signup must be open in production and closed in staging, scheduled Vercel jobs paused, and channel and payout operations disabled. This is not a historical whole-database row equality assertion: authorized concurrent activity is not relabeled a migration or preservation failure.

The manual admin alias contract permits a schema6 descriptor for the serving baseline itself only when its complete descriptor and production target match live evidence. The existing older non-serving descriptor path remains strict. Latest and serving pointers may transition only to the candidate created by this invocation; only the fixed canonical admin alias is assigned. Permissions failures and partial-release uncertainty stop rather than trigger retry or rollback.

The target suites retain accounting, security, MFA and payout coverage and add the affected onboarding, marketing and admin cases. Integration SQL tests remain disposable prerequisite verification, not hosted migration execution. New acceptance cases require owner-email Bearer authority, credits views, launch-list rendering with preview writes blocked, signup plan/back/pricing behavior without signup mutation, and marketing navigation. Independent evidence must distinguish real read-only acceptance, rendered fixtures, inherited dependency-equivalent evidence, and any unavailable proof. Synthetic test reports are never release observations or Owner approvals.

## Successor pin (2026-11-03): b741 → 5e3204d9

The same fixed policy now pins baseline `b741c7cf` (the live release) to target `5e3204d9` (main after #833, #834 and #835): 17 changed blobs, no deletions, no SQL. It adds the delta suites `marketing-country-pricing` (1), `issue-496-qr-production` (6), `queue-share-qr` (16) and admin `users-null-email-search-833` (3). It also adds three acceptance cases:
- pricing lists all active countries from the public API;
- the admin Users list loads, and search is safe with null emails;
- the QR page shows "not connected" for an unassigned business and no warning for an assigned shared channel.

All earlier suites and acceptance cases are retained. Migration 507 (#836) is deliberately outside this app-only release.

### Correction (2026-11-03): QR suites are not gate suites

`issue-496-qr-production` and `queue-share-qr` hard-code `https://www.waaiio.com/m/...`, but the gate runs tests with `NEXT_PUBLIC_APP_URL=https://example.invalid`. Under that environment they fail (verify run 41680254404) even though the code is correct. Main CI runs them without that variable, and they pass at `5e3204d9`. They are removed from the pinned delta suites. QR acceptance evidence cites main CI at the exact target and the staging read-only RLS proof. The tests' environment dependence will be fixed separately.
