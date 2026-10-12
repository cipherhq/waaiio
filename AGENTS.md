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
- Never claim a test runs in CI unless you have shown it from `.github/workflows/ci.yml` AND the CI log with test counts, zero skipped. A green CI run does not prove a test ran.

## Public repository rule

This repository is public. Never describe how to exploit a weakness in review comments, issues, or PR descriptions. Describe the defect and the fix at a high level and reference the files.

## Rules for all agents

- `main` is protected. Never attempt to work around a rejected push or merge.
- If a tool or credential returns a permission error, stop and report it. Never switch credentials.
- Never create worktrees in `/tmp` or `/private/tmp`.
