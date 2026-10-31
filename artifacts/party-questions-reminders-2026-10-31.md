# Party questions and reminders — local source verification

Base: `cb6e4abb0028799e27f370bb7d3d7dfe0232124e` (merged #786).
Branch: `codex/party-questions-reminders`.
Implementation commit: `901e48bf3efd5d286c989b8f2a23c60a561c54f0`.
Scope: the previously prepared Party Questions and Reminders work associated with #762/#785. Other #785 items are not included.

## Preflight and coordination

GitHub MCP showed open PRs #787 (pricing), #745 (API-key migration), #604 (held scheduling); no Party implementation PR was active. The earlier Party chat held a plan, not a Questions/Reminders implementation. Graphify build `a1ce76ac-b7df-4a5f-ae15-dadbbe1b44be` indexed `ed92cf0`; inspected current source on the base SHA to account for that stale graph snapshot.

| Change | Boundary | Verification |
|---|---|---|
| Question definitions/answer snapshots | New M487 authority; existing M457/M486 remain active | Real PostgreSQL role, revision, rollback and concurrency tests |
| Organizer editor/readback | Dedicated authenticated owner endpoint | HTTP and mounted UI tests |
| Guest web/bot completion | Token/sender binding, Accepted-only required answers | HTTP, mounted UI, flow-step and real BotService-entry tests with mocked external boundaries |
| Reminder preview/confirmation | Party-only owner route; Events retain legacy path | Preview, HTTP, UI and consent tests |
| Reminder dispatch | New M488 service-only occurrence/channel records | Mocked provider outcomes and real PostgreSQL claim/tenant/deletion tests |
| Scheduled Party reminders | Existing date/audience/legacy suppression retained | Shared selection and dispatcher tests; no live cron execution |

Independent verifier agreed with architecture before implementation and reviewed the final local source. Corrections identified during executable tests and review were applied within these boundaries. This is not an exact-head CI or deployment approval.

## Passing local evidence

- 15 focused/non-database suites: **169 passed, zero skipped**.
- New M487 PostgreSQL suite: **11 passed, zero skipped**.
- New M488 PostgreSQL suite: **5 passed, zero skipped**.
- Existing M486 seating PostgreSQL regression: **19 passed, zero skipped**.
- `git diff --check` passed. Final TypeScript comparison has 201 unique normalized diagnostics on both the unchanged #786 checkout and Party checkout, with zero new or removed diagnostics. This is baseline parity, not a passing typecheck.
- Tests use disposable local PostgreSQL only and mocked providers. SQL proof is not represented as HTTP proof.

The initial restricted full-suite run was stopped after sandbox IPC permission errors. The elevated full run completed with **16,437 passed, 5 failed, 2,844 skipped** across 743 files. One affected structural test relied on moved source line numbers; its independently reviewed correction preserves the existing exact-call/deactivation exception and all other assertions (38/38 now pass). Four five-second repository-scan timeouts passed in isolated reruns with unchanged assertions/timeouts: the two-file rerun passed 41/42, then the remaining migration-transport test passed by itself on both unchanged and Party checkouts. Do not represent this as one green full-suite run or as protected CI. The new SQL suites were separately executed with zero skips.

M487/M488 candidate migration lint returned no violations. The initial restricted build could not resolve Google Fonts. Final elevated production build completed with exit code 0: compilation succeeded and 271/271 static pages were generated. It logged an ESLint configuration-load error for `next/core-web-vitals`, so build completion is not clean lint validation. The build used loopback/local placeholder Supabase configuration, not hosted credentials. Standalone TypeScript baseline parity is recorded separately above. The disposable PostgreSQL server was stopped after verification.

## Rollout and retained limitations

M487 and M488 are source only: neither has been applied to staging or production. Apply/reconcile M457/M486 and M487/M488 through a separately authorized rollout before deploying the corresponding application. No deployment, live sends, template provisioning or provider mutations occurred.

Manual chase remains pending/maybe; scheduled follow-up remains accepted/maybe and filters the existing `reminder_sent` flag. A prior manual chase can therefore still suppress scheduled follow-up. No history was backfilled or reinterpreted.

Provider acceptance is distinct from delivery. A dispatch with an indeterminate result is never automatically resubmitted. An interrupted occurrence reports remaining channels as unattempted and is not automatically resumed. A deliberate new preview creates a separate chase occurrence. Scheduled occurrence identity includes party/date/invite, so a later eligible guest receives an independent claim without reopening another guest’s dispatch.

Service-window eligibility requires recorded inbound-message evidence; unavailable evidence is shown honestly. Marketing templates require separate marketing consent and current approval for the resolved WABA. Email and SMS use their own consent checks. Preview and confirmation cannot manufacture consent.

Scheduled date calculation is preserved; this slice does not introduce a new timezone policy. Provider/hosted-schema acceptance and protected exact-head CI remain unverified.
