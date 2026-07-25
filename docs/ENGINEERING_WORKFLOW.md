# Engineering Workflow

Permanent engineering process for Waaiio.

## Source-of-Truth Hierarchy

1. **Current GitHub `main`** — the deployed codebase
2. **Merged pull requests** — completed work with review trail
3. **Open pull requests** — proposed changes with diffs
4. **GitHub Issues** — planned and tracked milestones
5. **Engineering status ledger** (`docs/engineering-status.json`)
6. **Migration registry** (`docs/MIGRATION_REGISTRY.md`)
7. **Changelog** (`CHANGELOG.md`)
8. **Chat handoffs** (`docs/CHAT_HANDOFF_TEMPLATE.md`)

**Chat memory and pasted summaries are never authoritative over GitHub.** If a chat session claims work is complete but `git merge-base --is-ancestor <sha> origin/main` fails, the work is not on main.

## Milestone States

### Normal States

| State | Evidence Required |
|-------|------------------|
| `PLANNED` | GitHub Issue created with objective, scope, and acceptance criteria |
| `IN_PROGRESS` | Branch created; implementation underway |
| `IMPLEMENTED` | All code changes committed on a feature branch |
| `LOCALLY_TESTED` | `npm run test` passes; `npm run build` passes; relevant focused tests pass |
| `INDEPENDENTLY_REVIEWED` | A reviewer other than the implementer has approved or provided substantive feedback |
| `MERGED` | PR squash-merged into `main`; merge SHA recorded; `git merge-base --is-ancestor <merge-sha> origin/main` passes |
| `DEPLOYED` | Vercel deployment for the merge commit shows `success`; production URL returns HTTP 200 |
| `PRODUCTION_VERIFIED` | Post-deployment checks confirm the feature works correctly in production |
| `CLOSED` | GitHub Issue closed; changelog updated; status ledger updated |

### Exceptional States

| State | Evidence Required |
|-------|------------------|
| `BLOCKED` | Specific blocker documented with a next action |
| `STRANDED` | Code exists on an unmerged branch; cannot be merged as-is; next action documented |
| `SUPERSEDED` | A newer approach replaced this work; link to the replacement |
| `ROLLED_BACK` | Revert commit merged; rollback reason documented |

**Critical rule:** `IMPLEMENTED` and `LOCALLY_TESTED` do not mean merged or deployed. Code on a feature branch is not production code.

## Roles

| Role | Responsibilities |
|------|-----------------|
| **Claude** | Implementation, local testing, preflight checks |
| **ChatGPT** | Independent review, GitHub reconciliation, release recommendation |
| **User / Release Authority** | Scope approval, merge authorization, production configuration, deployment authorization |

## No-Duplicate-Work Rule

Before implementation begins, every task must classify all relevant existing work:

- **Already implemented on main** — do not reimplement
- **Implemented differently on main** — document the difference before proposing changes
- **Implemented only on an unmerged branch** — evaluate whether to extract, port, or discard
- **Superseded** — link to the replacement and do not revive
- **Partially implemented** — identify the gap precisely
- **Confirmed missing** — proceed with implementation
- **Unable to determine** — investigate further before coding

No coding begins until this classification is complete and recorded.

## Small-PR Rules

Default expectations:

- One security or product objective per PR
- Fewer than 15 changed files preferred
- Fewer than 500 meaningful changed lines preferred
- No unrelated cleanup bundled
- One migration concern per PR
- No permanent combined integration branches
- Large exceptions require written justification in the PR description

## Integration-Branch Rule

An integration branch (e.g., PR #21 `fix/combined-18-19-20`) may prove compatibility across multiple changes, but does not mean the underlying work is merged or complete. Integration branches must be decomposed into small PRs for merge.

## Completion Proof

To verify work is on main:

```bash
git fetch origin main
git merge-base --is-ancestor <implementation-sha> origin/main && echo "PRESENT" || echo "NOT ON MAIN"
```

A failed ancestry check means the work is not present on main regardless of what any chat session, document, or memory claims.

## Evidence Categories

These are distinct and must not be conflated:

| Category | What It Proves |
|----------|---------------|
| **Implementation evidence** | Code exists on a branch |
| **Integration evidence** | Code works with other changes on a combined branch |
| **Release evidence** | Code is merged, deployed, and verified in production |

Only release evidence means a feature is complete.

## New-Chat Protocol

Every new conversation must begin by reading:

1. `docs/ENGINEERING_WORKFLOW.md` (this file)
2. `docs/ENGINEERING_STATUS.md`
3. `docs/MIGRATION_REGISTRY.md`
4. The active GitHub Issue
5. The active pull request
6. `CHANGELOG.md`

Then confirm current `origin/main` SHA before proposing or changing anything.
