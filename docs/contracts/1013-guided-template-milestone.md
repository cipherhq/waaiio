# Custom Flow guided templates — bounded implementation contract

Status: architecture agreed by both independent reviewers; Owner approved the
consolidated wording and runtime fallback packet through the coordinator.
Implementation in progress. No migration application or runtime certification.

## Identity and ownership

- Issue: #1013; branch `codex/1013-guided-templates`.
- Foundation: unmerged PR #1024, `de871238ba7b46e09881be82a130bcffa943ce6c`.
- Remote main verified 2026-11-14: `6fb9d5c73ebc309286f1293fb3045a46f6a8cd90`.
- Implementer owns guided builder, table API, shared read resolver, migration 543,
  and their tests. The same independent behavior and risk reviewers own review.
- M543 is reserved; M542 belongs to seating holds PR #1027. No hosted apply,
  deployment, provider operation, or merge is authorized by this contract.

## Settled scope

The Owner selected a guided Festival Info milestone as the first example of a
generic platform. Template or blank setup uses the existing Message/Menu/Lookup
engine, draft, preview, publish and reset. The block editor remains an advanced
view of the same definition. Templates contain configuration, never customer
branches in the engine. Five empty tables cover artists, vendors, ticket types,
news and FAQs. No customer facts, prices, venue details or sample claims are
invented. A community-centre information desk proves reuse with different data.

Table Saves update live answers immediately. Publish and Reset affect flow
structure only. Reset replaces the draft with the currently published definition;
it does not restore historical releases or revert saved table contents.

Existing configured prices remain authoritative through live references, never
copied into an editable second price source. External vendor information is
explicitly informational. No checkout, fee, payment or custody path changes.

Selected public business details stay linked to Settings: name, description,
address/city, phone/email and operating hours. Timezone and country-derived
currency use existing settings. Flow title, greeting, fallback and keyword are
merchant-controlled; selected business bindings may be inserted in their text.
Language remains an explicit flow choice. Missing settings are flagged, never
invented. No private business fields are exposed by this binding surface.

Drafts may be incomplete. Publish requires complete visible information in each
selected section under its declared fields/reply placeholders, or explicit
merchant disablement. There is no automatic removal of incomplete sections.
Advanced links and saved-draft publication semantics remain intact.

Lists, automatic latest-news ordering, new handoff/consent nodes, and default Hi
entry are outside this milestone. Existing exact-keyword entry is preserved.

## Existing dependencies

- `supabase/migrations/541_custom_flow_base.sql`: flow-owned tables and rows,
  composite tenant foreign keys, owner RLS, row timestamps; no data publications.
- `lib/bot/custom-flow/engine.ts`: Lookup rereads visible rows for each request;
  exact/multiple/no-match behavior remains the shared runtime.
- `app/api/custom-flows/route.ts`: owner/capability authorization, draft version
  checks, saved-draft publish and isolated preview.
- `lib/custom-flow-builder/preview.ts`: memory sessions/logs and captured sends;
  new source reads must remain explicitly scoped and read-only.
- `components/custom-flows/FlowBuilder.tsx`: current editor and publication UI.
- `components/dashboard/DashboardProvider.tsx`: existing business details.
- Products and services have direct business ownership. Ticket types require
  parent-event ownership. Existing availability and pricing semantics apply.
- Graphify snapshot `6fb9d5c`, build `eeff2fab-f511-4cb1-bd14-51ae71916b17`,
  supplied baseline dependencies; Phase 2 additions were read directly.

## Proposed technical architecture

1. Store template identity/version separately from editable graph fields. Guided
   controls update explicit nodes; reopening never regenerates an edited graph.
   Removed/customized sections require an explicit action to rebuild.
2. One atomic initialization RPC creates a draft and empty tables. Reuse the
   stable client request UUID as the flow ID. Add nullable immutable
   `creation_payload` to retain original normalized request, template version,
   table definitions and resolved initial defaults independently of later edits.
   Retry matching original request/tenant returns the existing flow; mismatches
   conflict. Changed business defaults must not alter a retry's initial values.
3. Initialization is SECURITY INVOKER with empty search_path, explicit auth.uid
   ownership checks and RLS. The API retains existing capability checks. No
   duplicate SQL entitlement engine. Grant only required role access.
4. Single-row saves/deletes compare exact updated_at and return conflict instead
   of overwriting another editor. Table-schema edits lock their table and validate
   affected data atomically; all row writers participate in the same protocol.
   Existing flow-owned tables are reused within their flow, not silently shared.
5. Versioned `_source` references use a fixed kind and UUID: product, service or
   ticket type (with parent event ID). Reject unknown keys/kinds and arbitrary
   tables/column mappings. A shared tenant-scoped resolver supplies protected
   canonical fields for live runtime and preview. Row text cannot override them.
   Internal reference objects are never substituted into customer replies.
6. Inactive/deleted/missing sources fail closed. Product variants and variable
   service prices cannot be represented as a fixed-price promise. Currency comes
   from existing authoritative configuration; no fabricated fallback price.
7. Preview still sends no provider messages and writes no real sessions/logs.
   Any new query surface is allowlisted and bound to the selected business.

## Approved unavailable-data behavior

Incomplete, hidden, inactive or deleted live records are excluded from answers.
The configured no-match/fallback response is used; no stale prices, placeholders
or internal metadata are returned. The menu is not silently rewritten. The
consolidated setup/table/source/publish/reset/customer copy packet was approved
2026-11-14 through the coordinator, including the five empty table schemas.

## Executable acceptance plan

| Boundary | Required proof |
|---|---|
| Atomic setup | Successful template and blank creation; rollback on invalid child; concurrent same-request retry; mismatch rejection; retry after draft edits/default changes |
| Ownership | Anonymous/other-owner denial; foreign business/flow/table/record rejection; direct SQL role/grant and composite-FK checks |
| Live edits | Same-row stale writer conflict; schema/row race; hidden/incomplete rows; next lookup sees saved value without republish |
| Publication | Draft edits remain private; Publish uses saved structure; Reset leaves saved table rows unchanged |
| Data references | Source price update in engine and preview; copied fields cannot override; variant/variable/inactive/deleted cases; parent ticket-event scoping |
| Editor | Template/blank paths; guided→advanced→guided preservation; dirty navigation; save failures retain input; accessible keyboard/mobile controls |
| Reuse | Festival and community-centre tenants use same components/engine; no data leakage or mutation of the first flow |
| Preview | Actual engine with captured sends; zero provider calls and zero real session/log writes |
| Release evidence | Focused unit/handler/rendered tests; disposable PG concurrency/RLS; build/lint; exact-head CI with per-file counts; both final-SHA reviews |

Real PostgreSQL proof is separate from mocked HTTP-handler proof. Hosted and
provider acceptance require their own authorization. A five-minute setup claim
requires a timed nontechnical-user trial and is not established by code tests.

## Local verification checkpoint (2026-11-14)

- Focused implementation and neighboring tests: 169 passed across 12 files,
  zero skipped. Final business-value/display delta: 29 passed across 3 of those
  files, zero skipped (not an additional 29 distinct tests).
- Disposable PostgreSQL 16: 14 passed, zero skipped, covering initialization,
  ownership, schema/row concurrency and direct-writer guards. Cluster stopped
  and removed. PostgreSQL 17 catalog evidence remains required from CI.
- Production build completed with exit 0; its embedded lint reported a nested
  worktree plugin-resolution conflict. Explicit ESLint over affected production
  files passed. Standalone TypeScript reports only 10 existing errors in the
  unchanged link-payment-next-steps-menu, tables-and-sections-ui and
  updates-optin-payment-menu test files.
- Broad local run: 20,942 passed, 29 failed, 2,400 skipped across 1,000 files.
  Eight isolated reruns passed (234 tests): both slice-561b runtime suites,
  RPC linker, release-phase integration, first-assignment policy, ticket PDF,
  native-form audience controls and Flutterwave payout setup. Two payout-calendar
  tests passed with their expected America/New_York timezone explicitly set.
  No unrelated production/test code was changed to obtain these results.
- Other broad failures require local sockets/IPC or a disposable database and
  encountered sandbox restrictions. They were not retried through another
  execution method. CI remains necessary; this is not a whole-suite pass claim.
- M543 candidate lint, changelog validation and whitespace checks passed.
  Final-head CI, canonical catalog delta, two final reviews and real guided
  browser acceptance remain outstanding. No hosted deployment/application or
  timed usability claim follows from these checks.
