# Engineering Status

Machine-readable canonical ledger: [`docs/engineering-status.json`](./engineering-status.json)

**Last reconciled:** 2026-07-30
**Last reconciled main SHA:** `21cbf57ff76d30538fe493069148e673451431c6`
**Last reconciled at:** 2026-07-30T23:00:00Z

## Milestone Status

| ID | Title | Stage | PR(s) | Merge SHA |
|----|-------|-------|-------|-----------|
| AUTH-001 | Prevent admin privilege escalation | `PRODUCTION_VERIFIED` | #36 | `78e28344` |
| AUTH-000 | Phone OTP via WhatsApp template | `DEPLOYED` | #37, #38 | `641c31b0` |
| FIN-LEGACY | Financial integrity hardening | `STRANDED` | #18, #19, #20, #21 | none |
| GOV-001 | Engineering governance foundation | `MERGED` | #39, #40 | `c6f9b02c` |
| FIN-001 | Financial and credential containment | `PRODUCTION_VERIFIED` | #44 | `d886c8d9` |
| FIN-002 | Atomic payout execution and provider idempotency | `DEPLOYED` | #50 | `7556dec5` |
| SEC-001 | Remove public access to sensitive platform tables | `PRODUCTION_VERIFIED` | #54 | `90b0f766` |
| OPS-001 | Migration history alignment (Issue #53) | `IN_PROGRESS` | #56, #58, #59, #62, #63, #64, #65, #66, #67, #68, #69, #70, #71, #72, #73, #74, #75, #76, #77, #78, #79 | `21cbf57f` |

## Stage Definitions

See [`docs/ENGINEERING_WORKFLOW.md`](./ENGINEERING_WORKFLOW.md) for full definitions.

**Important:** `IMPLEMENTED` and `LOCALLY_TESTED` do not mean merged or deployed. Only `MERGED` and beyond indicate code is on `main`. Only `PRODUCTION_VERIFIED` indicates a feature is confirmed working in production.

**Important:** `main` may be ahead of production. A commit on `main` is not necessarily deployed. Automatic Vercel Preview deployments on PR branches do not advance a milestone to `DEPLOYED`.

## Stranded Work

### FIN-LEGACY (PRs #18-#21)

PR #21 (`fix/combined-18-19-20`, head `22168545`) contains tested but unmerged financial safety work across 270 changed files:

- Payout kill switch (`ENABLE_PAYOUTS`)
- Payout idempotency keys
- Payout atomic claiming (CAS)
- Square OAuth CSRF protection
- Admin query credential column filtering
- Destination fingerprinting

**Why stranded:**
- 270 files, 48 migrations — too large for safe review
- Migrations 244-248 directly conflict with main's applied migrations
- Migrations 249-291 are stranded/reserved while PR #21 remains open
- Auth patterns use obsolete `profiles.role` (replaced by PR #36's `app_metadata`)

**Next action:** Controlled extraction via FIN-001 and subsequent milestones. Do not merge or rebase PR #21 wholesale.

## Active Next Actions

1. **OPS-001: Controlled Batch 8 migration-history repair** — Wave 2 verification complete (19 versions, 153 objects); Batch 8 activated (15 versions in allowlist); Batch 9 verified but deferred; 105 total repairs
2. **Resolve Meta WABA billing** — required before AUTH-000 production verification
3. **Continue controlled FIN-LEGACY extraction** — payout idempotency, atomic claims, OAuth reconstruction in future milestones

## OPS-001 Current State

- Batches 1-7 verification and migration-history repair are complete. PR #79 merged.
- Final Verification Wave 2 V3 canonical complete: 19 migrations (Batches 8-9) production-verified.
- Wave 2: 153 objects (13 function objects), 140 exact match, 2 equivalent-stricter, 11 superseded, 0 failed, 370 compared paths.
- V3 canonical evidence with per-object provenance (migration_version, migration_filename, migration_checksum, expected_object_digest).
- Migration 236 has one comment-only raw-definition difference (normalized executable SQL identical; no committed matching blob exists).
- Batch 8 verification complete and repair activated (15 versions in allowlist).
- Batch 9 verification complete but deferred — repair blocked until Batch 8 closeout.
- 105 migration-history repairs complete across Batches 1-7.
- Active repair allowlist: 15 Batch 8 versions.
- ALIGNED_TRACKED = 113, VERIFIED_APPLIED_UNTRACKED = 19, PENDING = 0, NOT_VERIFIABLE = 12, SUPERSEDED = 2.
- All actionable verification candidates complete (candidate registry empty).
- 12 NOT_VERIFIABLE_SAFELY and 2 SUPERSEDED migrations remain intentionally outside repair.
- Migration 298 is applied and forensically verified. Exactly 11 historical payment rows were linked. Pending linkage rows are zero.
- Migration 298 was executed using Management API SQL and recorded using migration repair. The approved dry-run stop condition was violated.
- Corrected forensic evidence is canonical for the procedure-deviation conclusion.
- Issue #53 remains open.
- Next action: controlled Batch 8 migration-history repair.

## Updating This Ledger

Every milestone PR must update `docs/engineering-status.json` when:
- A milestone advances to a new stage
- Evidence is recorded (merge SHA, deployment, verification)
- A blocker is added or resolved
- A milestone is closed

### Post-Merge Updates

A PR cannot mark itself `MERGED` before it merges. After a PR merges:
1. Update the ledger in the next commit or PR to record `MERGED` stage and merge SHA
2. After production deployment, update again with `DEPLOYED` and deployed SHA
3. After production verification, update with `PRODUCTION_VERIFIED` and evidence
