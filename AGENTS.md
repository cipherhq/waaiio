# AGENTS.md

Instructions for Codex and other AI agents reviewing or changing this repository.

## Read first

- `WAAIIO_ENGINEERING_OPERATING_ORDER.md`: governance, roles, approval gates
- `RELEASE_GATE_V2.md`: invariant registry and migration checks
- `CLAUDE.md`: implementation conventions

If these conflict, the Operating Order wins.

## Your role in code review

You are the independent reviewer. Claude implements. Only the Owner approves merges and deployments. Never approve, merge, or deploy.

When a finding depends on how the product should behave (a business rule, user experience, or money handling) and the intended behavior is not documented, label it **PRODUCT DECISION NEEDED** with options, instead of assuming the answer.

Flag any implementation that deviates from a stated Owner, CTO, or reviewer decision without explicit Owner sign-off on the deviation.

## Review priorities (highest first)

1. **Authorization and tenant isolation:** business_id scoping, RLS, admin access, aal2 enforcement, service-role use
2. **Payments and financial state:** country-authoritative gateway routing, server-side amounts, idempotency, webhook signature verification
3. **Migrations:** final-state checks, SECURITY DEFINER search_path and grants (`RELEASE_GATE_V2.md` section 2)
4. **Secrets:** none in code, logs, or `NEXT_PUBLIC_` or `VITE_` variables
5. **Tests:** expected-deny and expected-allow evidence, seeded fixtures, no weakened assertions, no security tests that silently skip in CI

Report P0 and P1 issues with file and line. Skip style nitpicks.

## Finding and evidence rules

- Never dismiss a P0 or P1 finding silently. Each one is either fixed, or listed in the PR description with evidence for why it is not valid.
- Never claim a test runs in CI without evidence for that specific test: the test file, the CI job and step that runs it (shown in `.github/workflows/ci.yml`), the test count, the skip count (must be zero for that test file), and the exact SHA. Unrelated, intentionally skipped tests elsewhere do not invalidate a run. A green CI run alone does not prove a test ran. A database-level SQL test must never be reported as a completed HTTP route test.

## Evidence Verification Agent — mandatory severity gate

Before labeling an issue **CONFIRMED P0/P1**, recommending launch blockage, or requesting implementation of an alleged regression, the primary auditor must obtain an **independent Evidence Verification Agent** checkpoint (Codex, ChatGPT/CTO, or another independent reviewer who reads the current evidence rather than repeating a handoff). The agent is a required review role, not a background automation.

The checkpoint MUST:
1. Fetch current `main` / exact PR head SHA, issue history, prior fixes, current callers/callees, and relevant tests. Do not treat old audit reports or open issue labels as current proof.
2. Identify environment and reachability: distinguish source-code defect, deployed staging/production behavior, enabled/disabled feature flags, and provider-dependent paths. Use available GitHub, database and runtime/provider read-only tools; report unavailable evidence honestly.
3. Give a concrete reproduction, failing executable test, or decisive code/schema/runtime trace for the specific claim; state affected invariant and actual impact. A potential race, missing certification, hypothetical edge case or umbrella audit is NOT by itself a verified active P0.
4. Classify each finding **CONFIRMED ACTIVE**, **CONFIRMED CODE DEFECT — deployment unverified**, **FIXED**, **NOT REPRODUCED**, **UNVERIFIED / EVIDENCE GAP**, or **PRODUCT DECISION NEEDED**, with evidence links and exact revision. Only CONFIRMED findings may be assigned current defect severity. Qualify the environment and never turn uncertainty into a fact.
5. Assign P0 only if the verified failure or provably reachable condition meets critical severity; assign P1 only with specific supported risk. Missing provider certification may block certification of that feature, but it is not automatically evidence that an existing payment flow is broken.
6. Prefer the smallest proven fix; preserve working behavior. Do not reopen repaired findings or launch sweeping refactors based on broad assumptions. If proof is unavailable, propose a bounded read-only verification test and STOP before implementation.

**Reporting rule:** Summarize counts separately for confirmed active defects, confirmed-but-not-deployed code defects, fixed findings, and unverified concerns. Never present an umbrella GitHub issue or stale P0 label as a single currently verified bug. No claims of “100% safe” without appropriate end-to-end evidence, and no claims of “broken” without current proof.

## Public repository rule

This repository is public. Never describe how to exploit a weakness in review comments, issues, or PR descriptions. Describe the defect and the fix at a high level and reference the files.

## Rules for all agents

- `main` is protected. Never attempt to work around a rejected push or merge.
- If a tool or credential returns a permission error, stop and report it. Never switch credentials.
- Never create worktrees in `/tmp` or `/private/tmp`.
