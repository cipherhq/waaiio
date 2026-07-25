# Engineering Status

Machine-readable canonical ledger: [`docs/engineering-status.json`](./engineering-status.json)

**Last reconciled:** 2026-07-25
**Main SHA:** `6024500f62c600d9b4fd0bfc9f470cf3c5538035`

## Milestone Status

| ID | Title | Stage | PR(s) | Merge SHA |
|----|-------|-------|-------|-----------|
| AUTH-001 | Prevent admin privilege escalation | `PRODUCTION_VERIFIED` | #36 | `78e28344` |
| AUTH-000 | Phone OTP via WhatsApp template | `DEPLOYED` | #37, #38 | `641c31b0` |
| FIN-LEGACY | Financial integrity hardening | `STRANDED` | #18, #19, #20, #21 | none |
| GOV-001 | Engineering governance foundation | `INDEPENDENTLY_REVIEWED` | #39 | none |

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

**Next action:** Extract useful protections into small, focused PRs with updated auth and renumbered migrations (starting from version 292). Do not merge or rebase PR #21 wholesale.

## Active Next Actions

1. **GOV-001: await final CI and merge authorization** — PR #39 independently reviewed
2. **Resolve Meta WABA billing** — required before AUTH-000 production verification
3. **Extract FIN-LEGACY protections** — payout idempotency, Square OAuth, credential filtering
4. **Create tracking issues** — for AUTH-001 closure and financial safety milestones

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
