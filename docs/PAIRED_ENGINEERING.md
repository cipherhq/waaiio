# Paired Engineering Workflow

This document extends `docs/ENGINEERING_WORKFLOW.md` for high-risk Waaiio changes where architecture mistakes are more expensive than a short pre-implementation review.

It is intentionally lightweight. Small, obvious changes should continue to use the normal Claude → test → PR → independent review flow.

## When to Use Paired Mode

Use paired mode by default for work involving one or more of:

- payments, payouts, refunds, financial ledgers, fees, or settlement
- authentication, authorization, RLS, service-role boundaries, or secrets
- migrations, concurrency, locks, idempotency, or exactly-once behavior
- webhooks or provider-success reconciliation
- cross-flow lifecycle changes
- changes where a wrong assumption could corrupt business state or customer money

Do not use paired mode for trivial copy, styling, isolated UI polish, or obvious low-risk fixes unless the task unexpectedly expands.

## Roles

### Claude — primary implementer

Claude owns:

- repository audit
- implementation proposal
- code changes
- local test execution
- evidence gathering
- Draft PR updates

Claude is expected to push back when the requested approach does not match the current codebase.

### ChatGPT — architecture and independent gate

ChatGPT owns:

- reviewing the pre-code audit and proposed architecture
- challenging assumptions before implementation
- defining or confirming the implementation boundary
- independent GitHub review of exact commits and diffs
- release recommendation after exact-head CI

ChatGPT may contribute code only when a clearly separable workstream makes parallel work materially faster. Claude and ChatGPT should not edit the same files concurrently unless explicitly coordinated.

### User / Release Authority

The user owns:

- product and business decisions
- approval of material scope changes
- merge authorization
- deployment authorization

GitHub remains the technical source of truth.

## Shared Engineering Room

Every paired-mode task gets one GitHub Issue.

The Issue records:

1. objective
2. current base SHA
3. architecture invariant
4. scope and non-goals
5. Claude audit
6. implementation proposal
7. ChatGPT architecture decision
8. linked Draft PR
9. implementation evidence
10. exact-head review result
11. merge/deploy decision

Do not use chat summaries as a substitute for the Issue, current PR, or current repository state.

## Checkpoint A — Audit Before Code

Before changing application code, Claude traces the complete lifecycle and posts findings to the task Issue.

The audit should answer:

- What happens before the proposed change?
- What happens after it?
- Which entry points reach the same business state?
- Which functions actually own finalization?
- What existing idempotency or database guards exist?
- Is the requested change already implemented differently?
- What can race or replay?
- What would become duplicated if another pipeline is introduced?

For cross-system work, use a compact table such as:

| Flow / entry point | Current authority | Finalization path | Idempotency guard | Risk |
|---|---|---|---|---|

Claude then posts a proposed implementation plan with confirmed defects only.

Claude stops after the audit for high-risk work unless the task Issue explicitly says the architecture checkpoint may be skipped.

## Checkpoint B — Architecture Agreement

ChatGPT reviews the Issue and responds with exactly one state:

- `ARCHITECTURE: AGREED`
- `ARCHITECTURE: REVISE`
- `ARCHITECTURE: NO CHANGE NEEDED`

`ARCHITECTURE: AGREED` means the implementation boundary is frozen unless new code evidence proves the agreed plan cannot work safely.

Do not use later review as an excuse to reopen unrelated deferred architecture. New unrelated findings should be recorded separately unless they directly block correctness of the agreed change.

## Checkpoint C — Implementation

After agreement, Claude implements the smallest semantically correct change.

Rules:

- one objective per PR
- no unrelated cleanup
- reuse existing durable guards before adding new state
- preserve existing behavior outside the agreed lifecycle
- do not silently broaden scope
- if code reality contradicts the approved plan, stop and update the Issue before continuing

## Parallel Work

Parallel coding is optional, not the default.

Use it only when ownership is cleanly separable, for example:

- Claude implements the business path while ChatGPT adds an isolated regression test file
- Claude changes an application flow while ChatGPT independently reviews a migration
- Claude implements backend changes while ChatGPT prepares architecture/test evidence

Avoid parallel edits to the same source file or tightly coupled functions. Coordination overhead must be lower than the time saved.

## Checkpoint D — Local Evidence

Claude runs focused local tests before broad tests.

Permanent execution rules:

- one major test process at a time
- do not launch uncontrolled background test suites
- use the local real-Postgres harness for DB/concurrency tests when available
- compare local DB setup with CI rather than inventing a materially different harness
- never change historical migrations merely to make a weak local harness pass
- verify behavior, not only source strings, when practical

For payment/state-machine work, exercise failure, retry, replay, race, and incomplete-lifecycle states where applicable.

## Environment Safety

When debugging `.env.local` or other local env files:

- check for accidental surrounding quotes before diagnosing provider/webhook authentication
- remember that `"token"` and `token` may be different values to downstream code/tools
- never print, echo, paste, commit, or include secret values in reports
- do not request production credentials when a local/sandbox path is sufficient

## Checkpoint E — Draft PR

Claude creates a Draft PR linked to the task Issue.

The PR description should contain:

- agreed objective
- exact base SHA
- exact changed files
- old lifecycle vs new lifecycle
- idempotency/authorization guards relied upon
- focused test evidence
- known deferred risks

Claude may push fixes to the same PR. Do not create replacement PRs for ordinary review corrections.

## Checkpoint F — Independent Review

ChatGPT reviews the actual GitHub head, not only Claude's report.

Review includes:

- exact head SHA
- changed files/diff
- whether implementation matches the agreed architecture
- direct regressions introduced by the change
- exact-head CI

The reviewer should not reopen unrelated architecture that was explicitly deferred unless it becomes a direct correctness blocker because of the new change.

## Checkpoint G — Merge and Main Verification

Merge only after release authorization.

After merge:

1. record exact merge SHA
2. verify `main` points to/includes it
3. verify post-merge CI for that exact merge commit
4. distinguish merged from deployed
5. do not treat automatic Preview deployment as production verification

## Two-Speed Summary

### Low-risk task

```text
Claude implements → local tests → PR → ChatGPT review → CI → merge authorization
```

### High-risk task

```text
Claude audit
    ↓
GitHub Issue
    ↓
ChatGPT architecture review
    ↓
ARCHITECTURE: AGREED
    ↓
Claude implementation
    ↓
local evidence
    ↓
Draft PR
    ↓
ChatGPT exact-head review
    ↓
CI
    ↓
merge authorization
```

The purpose of paired mode is not to add ceremony. It exists to catch incorrect assumptions before expensive implementation and to reduce repeated review/fix loops.