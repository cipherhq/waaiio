# Engineering Workflow

Permanent engineering process for Waaiio.

## Source-of-Truth Hierarchy

1. **Current GitHub `main`** — the integrated source branch (may be ahead of production)
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
| `MERGED` | PR squash-merged into `main`; merge SHA recorded; `git merge-base --is-ancestor <merge-sha> origin/main` passes; GitHub PR state is `MERGED` |
| `DEPLOYED` | Production Vercel deployment (blowded project) for the merge commit shows `success`; production URL returns HTTP 200. Automatic Vercel Preview deployments do not qualify. |
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

Waaiio uses squash merges. The PR head (implementation SHA) is not preserved in main's history. Verify the **merge SHA**, not the implementation SHA:

```bash
git fetch origin main
git merge-base --is-ancestor <merge-sha> origin/main && echo "PRESENT" || echo "NOT ON MAIN"
```

The implementation SHA is retained as implementation evidence only. It proves what was reviewed, not what is on main.

A failed merge-SHA ancestry check means the work is not present on main regardless of what any chat session, document, or memory claims.

### Deployment vs. Main

`main` may be ahead of production. A commit on `main` is not necessarily deployed. The `DEPLOYED` stage requires evidence that the **production Vercel deployment** (blowded project) succeeded for the specific merge commit. Automatic Vercel Preview deployments on PR branches do not advance a milestone to `DEPLOYED`.

## Updating the Ledger After Merge

A PR cannot mark itself `MERGED` before it merges. The post-merge update process:

1. The PR merges (creating a merge SHA).
2. In the next commit or PR, update `docs/engineering-status.json`:
   - Set `stage` to `MERGED`
   - Record `merge_sha`
   - Clear `next_action` or set it to the deployment step
3. After production deployment, update again with `DEPLOYED` and `deployed_sha`.
4. After production verification, update with `PRODUCTION_VERIFIED` and evidence.

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

## Paired Architecture Review Process (Claude ↔ ChatGPT)

For high-risk changes (payment, capability, session state, shared helpers, cross-flow behavior), the following process is binding.

### Phase A — Architecture Audit

1. Claude independently audits the repository against the issue's assumptions.
2. Claude explicitly states **AGREE** or **PUSHBACK** on each material assumption, with exact file/function/line evidence from current `main`.
3. Claude traces forward blast radius, backward dependencies, prior fixes/invariants, and supported capability combinations using the contracts in `docs/contracts/` and journeys in `docs/journeys/`.
4. Claude proposes the narrowest architecture and defines the executable regression contract.
5. Claude **STOPS before writing any code.** Posts the complete audit to the GitHub Issue.

### Architecture Gate

6. ChatGPT independently re-reads the GitHub Issue and current repository.
7. ChatGPT posts exactly one architecture decision:
   - `ARCHITECTURE: AGREED` — implementation may proceed
   - `ARCHITECTURE: REVISE` — Claude must address the findings and re-submit
   - `ARCHITECTURE: NO CHANGE NEEDED` — issue does not require a code change
8. **No implementation begins until both sides align on architecture.**

### Phase B — Implementation

9. Claude implements on a dedicated branch from the agreed base SHA.
10. Claude must self-review the diff and explicitly flag any deviations from the agreed architecture. Mechanical compliance without reasoning is not acceptable.
11. Claude posts the implementation report to both the Issue and the Draft PR, including:
    - Exact base/head SHA
    - Files changed with rationale
    - Dependency / Regression Reconciliation (CHANGED INTENTIONALLY / INDIRECTLY AFFECTED / PROVEN UNAFFECTED)
    - Local test evidence
    - Exact-head CI run/jobs

### Exact-Head Review

12. ChatGPT performs independent exact-head PR review against the agreed architecture, prior invariants, regression contracts, and CI evidence.
13. Green CI is necessary but not sufficient for approval. Cross-layer reasoning and dependency reconciliation are required.
14. The user (CTO) retains merge authorization. Neither Claude nor ChatGPT may merge.

### Post-Merge Verification

15. After merge, the exact merge commit SHA and main CI run are verified.
16. The tracking issue is closed only after post-merge CI is green.

### Standing Rules

- **GitHub is the source of truth.** Chat summaries are context, not the system of record.
- **Fix the defect without moving the defect somewhere else.** A local test pass is insufficient if a dependent contract can regress.
- **No silent scope expansion.** Adjacent findings get separate GitHub issues.
- **Exact-head review applies only to the exact reviewed commit SHA.** Any subsequent push requires re-review.
