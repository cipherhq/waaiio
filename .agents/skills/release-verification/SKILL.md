---
name: release-verification
description: "Ordered deploy, migrate, verify sequence for a production release. Run before and during any production rollout."
---

# Release Verification

> MANDATORY for any production release.

Order is fixed: deploy code, THEN apply migrations, THEN verify. Never skip or reorder.

1. Confirm the target commit is known and has green CI. Every deploy must trace to a specific commit.
2. Deploy code to the environment. Confirm the deployment is READY and serving the intended commit.
3. Apply missing migrations in order, minus any marked staging-only. Follow migration-safety for each.
4. Enroll TOTP on every admin account BEFORE the MFA-enforcement migration, or that admin is locked out.
5. Verify in order: MFA login works, password-only is denied, step-up is required on a payout, emergency kill switch suspends and resumes.
6. If any step fails, stop. Do not proceed to the next.

Output: commit, deploy state, migrations applied, admins enrolled, four verifications passed?
