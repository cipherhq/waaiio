# Engineering Status

Machine-readable canonical ledger: [`docs/engineering-status.json`](./engineering-status.json)

**Last reconciled:** 2026-07-30
**Last reconciled main SHA:** `66cd00adf92ce3b9d46cd81cf12a4bb9b65de8b1`

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
| OPS-001 | Migration history alignment (Issue #53) | `IN_PROGRESS` | #56, #58, #59, #62, #63, #64, #65, #66, #67, #68, #69, #70, #71, #72, #73, #74, #75, #76, #77, #78 | `66cd00ad` |

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

1. **OPS-001: Final read-only verification wave for Batches 8 and 9** — Batch 7 repair complete (15 versions, 194→209); 105 total repairs; 19 candidates remain in Batches 8-9
2. **Resolve Meta WABA billing** — required before AUTH-000 production verification
3. **Continue controlled FIN-LEGACY extraction** — payout idempotency, atomic claims, OAuth reconstruction in future milestones

## OPS-001 Current State

- Batches 1-7 verification and migration-history repair are complete. PR #78 merged.
- Batch 7 repair: 15 versions (208-225), remote 194→209, tracked 98→113.
- 105 migration-history repairs complete across Batches 1-7.
- Active repair allowlist: empty (0).
- ALIGNED_TRACKED = 113, VERIFIED_APPLIED_UNTRACKED = 0, PENDING = 19, NOT_VERIFIABLE = 12, SUPERSEDED = 2.
- 19 production-verification candidates remain across Batches 8-9.
- Migration 298 is applied and forensically verified. Exactly 11 historical payment rows were linked. Pending linkage rows are zero.
- Migration 298 was executed using Management API SQL and recorded using migration repair. The approved dry-run stop condition was violated.
- Corrected forensic evidence is canonical for the procedure-deviation conclusion.
- Issue #53 remains open. Batches 8 and 9 not started.
- Next action: final read-only production-verification wave for Batches 8 and 9.

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
