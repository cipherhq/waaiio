# Party questions and reminders — local source verification

Base: `cb6e4abb0028799e27f370bb7d3d7dfe0232124e` (merged #786).
Branch: `codex/party-questions-reminders`.
Implementation commit: `901e48bf3efd5d286c989b8f2a23c60a561c54f0`.
Scope: the previously prepared Party Questions and Reminders work associated with #762/#785. Other #785 items are not included.

## Preflight and coordination

GitHub MCP showed open PRs #787 (pricing), #745 (API-key migration), #604 (held scheduling); no Party implementation PR was active. The earlier Party chat held a plan, not a Questions/Reminders implementation. Graphify build `a1ce76ac-b7df-4a5f-ae15-dadbbe1b44be` indexed `ed92cf0`; inspected current source on the base SHA to account for that stale graph snapshot.

| Change | Boundary | Verification |
|---|---|---|
| Question definitions/answer snapshots | New M489 authority; existing M457/M486 remain active | Real PostgreSQL role, revision, rollback and concurrency tests |
| Organizer editor/readback | Dedicated authenticated owner endpoint | HTTP and mounted UI tests |
| Guest web/bot completion | Token/sender binding, Accepted-only required answers | HTTP, mounted UI, flow-step and real BotService-entry tests with mocked external boundaries |
| Reminder preview/confirmation | Party-only owner route; Events retain legacy path | Preview, HTTP, UI and consent tests |
| Reminder dispatch | New M490 service-only occurrence/channel records | Mocked provider outcomes and real PostgreSQL claim/tenant/deletion tests |
| Scheduled Party reminders | Existing date/audience/legacy suppression retained | Shared selection and dispatcher tests; no live cron execution |

Independent verifier agreed with architecture before implementation and reviewed the final local source. Corrections identified during executable tests and review were applied within these boundaries. This is not an exact-head CI or deployment approval.

## Passing local evidence

- 15 focused/non-database suites: **169 passed, zero skipped**.
- New M489 PostgreSQL suite: **11 passed, zero skipped**.
- New M490 PostgreSQL suite: **5 passed, zero skipped**.
- Existing M486 seating PostgreSQL regression: **19 passed, zero skipped**.
- `git diff --check` passed. Final TypeScript comparison has 201 unique normalized diagnostics on both the unchanged #786 checkout and Party checkout, with zero new or removed diagnostics. This is baseline parity, not a passing typecheck.
- Tests use disposable local PostgreSQL only and mocked providers. SQL proof is not represented as HTTP proof.

The initial restricted full-suite run was stopped after sandbox IPC permission errors. The elevated full run completed with **16,437 passed, 5 failed, 2,844 skipped** across 743 files. One affected structural test relied on moved source line numbers; its independently reviewed correction preserves the existing exact-call/deactivation exception and all other assertions (38/38 now pass). Four five-second repository-scan timeouts passed in isolated reruns with unchanged assertions/timeouts: the two-file rerun passed 41/42, then the remaining migration-transport test passed by itself on both unchanged and Party checkouts. Do not represent this as one green full-suite run or as protected CI. The new SQL suites were separately executed with zero skips.

M489/M490 candidate migration lint returned no violations. The initial restricted build could not resolve Google Fonts. Final elevated production build completed with exit code 0: compilation succeeded and 271/271 static pages were generated. It logged an ESLint configuration-load error for `next/core-web-vitals`, so build completion is not clean lint validation. The build used loopback/local placeholder Supabase configuration, not hosted credentials. Standalone TypeScript baseline parity is recorded separately above. The disposable PostgreSQL server was stopped after verification.

## Rollout and retained limitations

M489 and M490 are source only: neither has been applied to staging or production. Apply/reconcile M457/M486 and M489/M490 through a separately authorized rollout before deploying the corresponding application. No deployment, live sends, template provisioning or provider mutations occurred.

Manual chase remains pending/maybe; scheduled follow-up remains accepted/maybe and filters the existing `reminder_sent` flag. A prior manual chase can therefore still suppress scheduled follow-up. No history was backfilled or reinterpreted.

Provider acceptance is distinct from delivery. A dispatch with an indeterminate result is never automatically resubmitted. An interrupted occurrence reports remaining channels as unattempted and is not automatically resumed. A deliberate new preview creates a separate chase occurrence. Scheduled occurrence identity includes party/date/invite, so a later eligible guest receives an independent claim without reopening another guest’s dispatch.

Service-window eligibility requires recorded inbound-message evidence; unavailable evidence is shown honestly. Marketing templates require separate marketing consent and current approval for the resolved WABA. Email and SMS use their own consent checks. Preview and confirmation cannot manufacture consent.

Scheduled date calculation is preserved; this slice does not introduce a new timezone policy. Provider/hosted-schema acceptance and protected exact-head CI remain unverified.

## Pre-PR recheck

GitHub MCP on 2026-10-31 confirmed main remains `cb6e4abb` and identified new draft PR #789 reserving M487 for a separate ACL change. The unapplied Party migrations and matching source/test identifiers were mechanically renumbered from M487/M488 to M489/M490; runtime behavior is unchanged. Graphify still indexes `ed92cf0`, so current branch source remains the authority. Fresh renumbered checks: 11 focused suites passed 92 tests, zero skipped; M489 PostgreSQL suite passed 11 tests, zero skipped; M490 PostgreSQL suite passed 5 tests, zero skipped. Independent reviewer verified all production, SQL and test changes against `3955f57e` are exactly the identifier substitutions. Earlier full-suite, build and typecheck evidence predates this mechanical renumber; no fresh full build or CI result is implied.

PR #790 initial CI exposed a fixture mismatch: M490 business seeds omitted the required name present in the CI template. Reproduced locally (5 failures), then corrected only the fixture schema/seed with independent review; all 5 tests passed with zero skips on a fresh database with the same required-name constraint. Production code and assertions are unchanged. The initial CI result is superseded by the follow-up commit and must not be represented as green.

## Review corrections after initial green CI

The exact-head automated review identified two confirmed source defects, deployment unverified: ordinary bot inbound messages were missing from reminder-window evidence, and per-recipient dispatch rebuilt the full recipient list. Both are corrected in this follow-up.

- The signature-verified Meta webhook records minimal immutable channel/sender/provider-timestamp receipts before webhook claim suppression. M490 adds the service-only receipt table, channel FK, uniqueness and lookup index. Duplicate messages cannot extend timestamps; missing, expired or future evidence does not open a window. Statuses, echoes and system messages do not create evidence. Receipt-storage failure does not stop existing bot processing. Business-specific consent remains independently required.
- The real preview loader now accepts an optional recipient ID, scoped in SQL together with party and business; per-recipient revalidation loads only that guest and assigned table. Initial preview is unchanged. Consent, content, current transport, replay and unknown-outcome checks remain intact.
- Local affected regression run: **60 passed across 8 files, zero skipped**. New signed-webhook-to-preview and real-loader/dispatcher tests cover window boundaries and linear query growth. M490 PostgreSQL: **6 passed, zero skipped**. Candidate M489/M490 migration lint: no violations.
- Independent reviewer agreed with the design and final delta. Fresh CI is required for the new commit; previous green CI is not attributed to this correction.
- No historical inbound activity is inferred or backfilled. Before new verified receipts exist, reminder windows remain unavailable. M490 is still source only; no hosted migration, live send or deployment was requested by this correction.
