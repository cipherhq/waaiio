# Engineering Status

Machine-readable canonical ledger: [`docs/engineering-status.json`](./engineering-status.json)

**Last reconciled:** 2026-07-30
**Last reconciled main SHA:** `8a1eeba50e0d0818363b7ac9b698915f716ba0d2`

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
| OPS-001 | Migration history alignment (Issue #53) | `IN_PROGRESS` | #56, #58, #59, #62, #63, #64, #65, #66, #67, #68, #69, #70, #71, #72, #73, #74, #75, #76, #77 | `8a1eeba5` |

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

1. **OPS-001: Batch 7 controlled migration-history repair** — Batch 6 repair complete (15 versions, 179→194); Batch 7 active in repair allowlist (15 versions); 19 candidates remain in Batches 8-9
2. **Resolve Meta WABA billing** — required before AUTH-000 production verification
3. **Continue controlled FIN-LEGACY extraction** — payout idempotency, atomic claims, OAuth reconstruction in future milestones

## OPS-001 Current State

- Batches 1-6 verification and migration-history repair are complete. PR #77 merged.
- Batch 6 repair: 15 versions (191-207), remote 179→194, tracked 83→98.
- 90 migration-history repairs complete across Batches 1-6.
- Accelerated Verification Wave 1 complete: Batches 6 and 7 verified in parallel.
- Batch 6 (15 versions): 129 objects, 129 exact match, 550 compared paths. Evidence SHA `0fc3ff1f`.
- Batch 7 (15 versions): 83 objects, 82 exact match, 1 superseded (Migration 223 → 293), 341 compared paths. Evidence SHA `ef3822de`.
- Wave 1 combined: 30 versions, 212 objects, 211 exact match, 1 superseded, 891 compared paths. Wave SHA `c78e0c26`.
- Batch 7 activated for repair (15 versions in allowlist).
- 19 production-verification candidates remain across Batches 8-9.
- Migration 298 is applied and forensically verified. Exactly 11 historical payment rows were linked. Pending linkage rows are zero.
- Migration 298 was executed using Management API SQL and recorded using migration repair. The approved dry-run stop condition was violated.
- Corrected forensic evidence is canonical for the procedure-deviation conclusion.
- Issue #53 remains open. Batches 8 and 9 not started.
- Next action: Batch 7 controlled migration-history repair.

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
