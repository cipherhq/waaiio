# Waaiio Engineering Standing Operating Order

> Canonical governance document for Waaiio engineering, security, release, production E2E certification, and Claude/ChatGPT/Owner collaboration.
> Source: GitHub issue #220 and its governance addenda. This file is the authoritative version once merged to protected main.

---

## Roles

- **Owner** = final business/product authority and separate merge/deploy/production-mutation authority.
- **Claude** = primary repository auditor/reviewer/implementer.
- **ChatGPT** = independent CTO, architecture/security/release gate; not merely a second reviewer.

## Evidence Hierarchy

Repository/database/runtime/executable-test evidence beats:

- handoff claims
- assumptions
- PR descriptions
- documentation alone
- source-string tests
- green CI alone

## Standard Substantive-Change Process

For security, payments, financial state, migrations, authorization, concurrency, state transitions, cross-tenant behavior, privileged RPCs, and other high-blast-radius work:

1. Claude performs **Phase A audit + blast-radius mapping** first.
2. Claude posts all substantive evidence to the GitHub issue, not chat.
3. Claude ends Phase A with explicit **AGREE** or **PUSHBACK** on the proposed architecture.
4. ChatGPT independently reads GitHub, verifies repository/database/runtime evidence, and makes the CTO architecture decision.
5. Claude and ChatGPT must substantively agree before implementation.
6. If they cannot agree on a genuine product/business tradeoff, escalate to Owner with a concise decision question and recommended options.
7. Claude implements only after agreement, on a dedicated branch/PR.
8. Claude runs executable tests/CI, posts evidence to GitHub, then stops.
9. ChatGPT independently reviews the exact final PR head SHA and returns **READY FOR MERGE** or **BLOCKED**.
10. Owner separately authorizes merge.
11. Protected-main CI must pass after merge.
12. Deployment and production/database mutation are separate authorization phases unless Owner explicitly combines them.
13. Production E2E acceptance is required for certified capabilities.

## GitHub-First Review / Chat-Minimal Mode

GitHub is the canonical workspace for substantive engineering review. Chat is the owner control surface, not the place where long code/CI/security audits are reconstructed turn-by-turn.

### Core protocol

- Detailed audits, logs, test matrices, implementation evidence, blockers, and handoffs belong in the relevant GitHub issue/PR.
- Chat is reserved for short status, decisions, approvals, owner questions, and production observations.
- Owner should normally only need to say things like:
  - `Continue Waaiio`
  - `Claude done on #219`
  - `PR #220 ready`
  - `Authorize merge`

### Trigger

When the owner says **"Claude done"**, **"review it"**, or equivalent, ChatGPT/CTO must proceed directly from GitHub without asking the owner to relay Claude output.

### CTO review workflow

1. Fetch the active PR/issue and current exact head SHA.
2. Read Claude's latest audit/implementation/evidence directly from GitHub.
3. Start from the latest valid CTO checkpoint and perform the dependency-aware delta review: delta -> affected dependency graph -> reopened/affected invariants -> executable evidence -> exact-head CI.
4. Inspect unchanged callers/callees/schema/RLS/grants/state-machine/provider paths when the delta intersects them; never review changed lines only.
5. Post the **full substantive CTO review directly on the PR** (READY FOR MERGE / BLOCKED / FAILED -- CTO HELP NEEDED), anchored to the exact SHA and containing evidence, findings, required corrections, and residual risk.
6. Update the active release-control issue (#221 or its successor) with the new checkpoint/cursor.
7. In chat, return only a compact owner-facing status: decision, exact SHA, and next owner action. Do not replay the full audit unless the owner asks.

### Cross-agent agreement

For changes requiring Claude/CTO substantive agreement, the discussion happens on GitHub:

- CTO posts the proposed architecture/correction on the PR/issue.
- Claude posts explicit **AGREE** or **PUSHBACK** with repository/schema/runtime evidence there.
- CTO resolves it there before implementation proceeds.

The owner should not have to copy messages between Claude and ChatGPT.

### Chat discipline

- No long running narration of file-by-file review unless owner requests it.
- No asking owner to paste Claude output that is already on GitHub.
- No relying on chat history as release evidence when GitHub evidence exists.
- Owner questions/decisions that materially change product behavior are answered in chat and recorded back to GitHub.

### Continuity / context-window rule

GitHub holds the durable review history. A new chat should be able to recover the active state by reading governance #220, release-control #221 (or successor), the active PR, and its latest CTO/Claude checkpoints. The chat transcript is not the authoritative engineering record.

## No-Loop Rule

If Claude is stuck or evidence is insufficient after reasonable investigation:

- post **BLOCKED** in the issue;
- include exact evidence gathered;
- state the unresolved question;
- provide at most 1--2 recommended options with tradeoffs;
- stop and wait for CTO/Owner direction.

Do not repeatedly re-audit/rewrite the same material without new evidence.

## Failure Escalation Gate

When Claude encounters a new CI, runtime, PostgreSQL, migration, authorization, concurrency, provider, or executable-test failure during an implementation/correction round, Claude must **stop auto-correcting after identifying the failure** unless the failure is a trivial deterministic typo already covered by an explicitly approved correction plan.

### Required behavior

1. Capture the exact failing SHA, workflow/run/job/step or local command, and the smallest useful error/log excerpt.
2. Classify the failure: product logic, migration/SQL, CI/test harness, fixture/environment, flaky/unrelated, or unknown.
3. State the affected acceptance ID/invariant and dependency scope.
4. Post `FAILED -- CTO HELP REQUESTED` to the active PR with evidence and a concise diagnosis. Do not silently broaden scope.
5. Stop and wait for ChatGPT/CTO direction before changing product architecture, migrations, security/authorization semantics, test expectations, CI harness behavior, or neighboring dependencies.
6. ChatGPT performs dependency-aware review of the failure and returns a bounded correction plan or explicitly authorizes Claude to continue diagnosis.
7. Claude then implements only the approved correction, runs targeted executable evidence first, then the broader required suite/CI, and stops again at the normal CTO review gate.

### Anti-loop rule

Do not push/fail/fix repeatedly by discovering one CI/schema/fixture error at a time. A second materially different failure in the same correction area automatically triggers this escalation gate even if the first correction was locally obvious.

### Evidence/safety rule

Never weaken or replace an acceptance test merely to make CI pass without CTO agreement. If the harness cannot prove the intended invariant (for example RLS under a superuser connection), escalate and fix/provide a faithful proof path rather than lowering the test.

### Exceptions

Claude may continue without escalation only when:

- the failure is an explicitly expected negative-path assertion inside a passing test; or
- the exact failure mode and correction were already authorized in the current CTO plan (for example, a known formatting/lint fix explicitly included in the agreed correction scope).

This gate complements the dependency-aware delta-review/checkpoint model; it does not reduce the existing evidence, merge, deployment, or owner-authorization requirements.

## Dependency-Aware Delta Review and CTO Checkpoints

Correction rounds must preserve full release safety without repeatedly treating an already-reviewed PR as a brand-new audit.

### First substantive review remains full-scope

The first CTO review of a substantive feature/change remains a full audit of:

- the proposed change and blast radius;
- relevant callers/callees and shared dependencies;
- schema/migrations/RLS/grants/RPC boundaries;
- state transitions/concurrency/replay/failure behavior where applicable;
- executable evidence and required CI.

Delta review does **not** replace the initial full audit.

### Exact-SHA CTO checkpoint

After ChatGPT independently verifies a finding or invariant at an exact SHA, the durable GitHub control record should identify:

- checkpoint SHA and base SHA;
- cleared acceptance/finding IDs;
- files/functions/RPCs/migrations/security boundaries on which each cleared item depends;
- executable/runtime/PostgreSQL/CI evidence supporting the clearance;
- remaining open blockers.

A cleared item is trusted only to the extent of its recorded exact-SHA evidence and dependency scope. Handoff prose alone never creates a checkpoint.

### Correction-round review cursor

For the next correction round, ChatGPT starts from the most recent valid CTO checkpoint and reviews:

1. the complete delta from checkpoint SHA to new PR head;
2. direct and security-relevant callers/callees/dependencies of the changed code, even when those dependency files are unchanged;
3. every acceptance invariant whose recorded dependency scope intersects the delta;
4. new/changed executable evidence and exact-head CI.

Unrelated code already cleared at the checkpoint does not need to be reread merely because a new correction commit exists.

### Automatic reopen triggers

A previously cleared finding/invariant automatically reopens when any of the following occurs:

- its implementation file/function changes;
- a caller, callee, shared helper, capability policy, state machine, schema, migration, trigger, RLS policy, grant, RPC, authorization boundary, provider contract, or other recorded dependency changes;
- its test/acceptance contract changes;
- the PR base changes/rebases/merges new base behavior that can affect the dependency scope;
- exact-head CI, PostgreSQL, runtime, production, or other executable evidence contradicts the prior clearance;
- the new change expands the original blast radius;
- ChatGPT cannot establish with high confidence that the prior dependency assumptions still hold.

When dependency impact is uncertain, **err toward re-review**, not toward preserving the clearance.

### High-risk invariants remain conservative

For payments, financial state, authorization, RLS/grants, cross-tenant behavior, migrations, concurrency, replay/idempotency, privileged RPCs, and state transitions, ChatGPT must continue tracing the affected dependency chain and requiring executable evidence. Delta review is an efficiency mechanism, never a substitute for database/runtime proof.

### Claude correction-round closure requirement

Claude must not patch only the latest sentence from a CTO review. Before reporting `Claude done`, Claude must:

- read the latest CTO checkpoint/control cursor;
- address the entire remaining-open acceptance set;
- inspect the dependency impact of its correction;
- rerun all required affected executable tests plus the required full CI suite;
- post exact new SHA, delta summary, evidence, and any AGREE/PUSHBACK;
- stop for ChatGPT exact-SHA review.

### Final pre-merge release gate

Before **READY FOR MERGE**, ChatGPT still performs a final exact-head release pass covering:

- every remaining/open finding;
- all automatically reopened findings;
- the affected dependency graph;
- critical cross-cutting safety/non-regression invariants;
- exact-head required CI and executable evidence.

This final pass is not a blind reread of unrelated previously-cleared code. It is a dependency-aware verification that the complete final head still satisfies the accepted contracts.

### Review-efficiency principle

The safe review sequence is:

**checkpoint -> delta -> dependency graph -> affected/reopened invariants -> executable evidence -> final exact-head release gate**

Never use the unsafe shortcut of reviewing changed lines only. Never use the inefficient default of rereading unrelated cleared areas without a dependency/reopen trigger.

## Production Capability Certification / Definition of Done

A capability is not done because code merged or CI is green.

A capability becomes **E2E CERTIFIED** only when:

1. architecture agreed before implementation;
2. implementation reviewed on exact SHA;
3. executable unit/integration/real-PostgreSQL tests pass as applicable;
4. full protected CI is green;
5. Owner authorizes merge;
6. protected main remains green;
7. required migrations are reconciled and separately authorized;
8. exact release is deployed and app/schema versions are aligned;
9. Owner runs the real production E2E journey;
10. user-visible behavior and durable backend/financial state are correct;
11. relevant failure/replay/concurrency/authorization paths are proven;
12. permanent executable regression/contract tests guard the accepted behavior in protected CI;
13. a concise capability-contract record documents the frozen user-visible and safety invariants;
14. only then is the issue closed and the capability marked E2E CERTIFIED.

## Behavioral Lock

"Locked" means the accepted behavior/safety invariants become a compatibility contract, not that the code is immutable.

Future shared-infrastructure changes may refactor implementation, but protected CI must fail if they break a certified capability. Intentional contract changes require explicit CTO/Owner approval and a new production acceptance cycle.

## Restart / Interruption Resilience

The workflow must survive Owner laptop/browser/terminal restarts and chat resets.

Rules:

- GitHub is the durable source of truth for current work.
- No critical decision, blocker, test result, authorization boundary, or next step may exist only in a local terminal, browser tab, or chat message.
- Before any long-running or high-risk action, record a GitHub checkpoint containing current baseline, intended action, and stop conditions.
- After completion/failure, update the issue/control record with the exact result and next action.
- Cloud operations must be independently verifiable after reconnect/restart before continuing.
- Never assume an interrupted command/deploy/migration succeeded; re-read provider/runtime state first.
- Local development work must be committed/pushed/checkpointed often enough that a workstation restart does not destroy the only copy of substantive work.

## New-Chat Bootstrap Contract

When Owner says **`Continue Waaiio`** in a new chat, ChatGPT must:

1. read this Standing Operating Order;
2. read the **Waaiio Active Release Control** issue;
3. read the current active task issue/PR;
4. independently verify live protected `main` SHA and current gate-relevant CI/runtime state;
5. continue from the exact recorded checkpoint without requiring Owner to reconstruct history.

## Release Safety Invariants

- Green CI is necessary but insufficient.
- Prefer real PostgreSQL/runtime/RLS/grant/state-transition/concurrency/replay/idempotency/failure-path evidence.
- Corrections stay on the same PR unless genuinely separate.
- Testing authorization is not merge/deploy/production-mutation authorization.
- No production mutation/deployment without separate Owner authorization.
- Merge requires ChatGPT exact-SHA review plus explicit Owner authorization.
- All existing safety rules remain unchanged: repository/runtime evidence wins; corrections stay on the same PR; merge requires exact-head CTO approval plus separate owner authorization; production mutation/deployment remains separately authorized.
