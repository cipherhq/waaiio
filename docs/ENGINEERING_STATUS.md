# Engineering Status

Machine-readable canonical ledger: [`docs/engineering-status.json`](./engineering-status.json)

**Last reconciled:** 2026-07-27
**Last reconciled main SHA:** `90b0f7668b06c5d2f41b753eb40dbe30379e58dd`

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

1. **FIN-001: implement no-migration containment** — Issue #41; payout kill switch, connect feature gates, column restrictions, transfer-method allowlist, safe logging
2. **Resolve Meta WABA billing** — required before AUTH-000 production verification
3. **Continue FIN-LEGACY extraction** — payout idempotency, atomic claims, OAuth reconstruction in future milestones

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
