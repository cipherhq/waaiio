---
name: release-verification
description: "Ordered deploy, migrate, verify sequence for a production release. Run before and during any production rollout."
---

# Release Verification

> MANDATORY for any production release.

The deploy and migration order is decided per release, written down in the release plan, and approved before starting. Never improvise it.

Default guidance: additive migrations (new tables, columns, functions) that new code depends on run BEFORE the code deploy. Migrations that would break the currently running code run AFTER the new code is live.

1. Confirm the target commit is known and has green CI. Every deploy must trace to a specific commit.
2. Apply pre-deploy migrations (additive changes the new code depends on) in order, minus any marked staging-only. Follow migration-safety for each.
3. Deploy code to the environment. Confirm the deployment is READY and serving the intended commit.
4. Apply post-deploy migrations (breaking changes to old-code assumptions) in order. Follow migration-safety for each.
5. Any migration enforcing admin MFA requires every admin to be enrolled first.
6. Verify in order: MFA login works, password-only is denied, step-up is required on a payout, emergency kill switch suspends and resumes.
7. After each step, verify before moving to the next. If any step fails, stop.

Output: commit, deploy state, migrations applied, admins enrolled, four verifications passed?
