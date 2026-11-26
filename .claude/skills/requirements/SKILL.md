---
name: requirements
description: Write one evidence-backed requirements document per feature, in its GitHub issue, before any code is written. Use for new features, money/payments, migrations, auth/permissions and cross-capability bot changes, or when asked to "write requirements", "spec this", "requirements doc" or "/requirements". Produces Business (B), Functional (F) and System (S) requirements with IDs, out-of-scope, Owner decision cards and an acceptance ledger, then runs two independent reviewers and the Owner approval gate. Small bug fixes keep the one-paragraph implementation contract instead.
metadata:
  author: Waaiio Team
  version: "1.0"
  approved: "Owner design 2026-11-26"
---

# Requirements — evidence-backed, before any code

You write the requirements document for one feature. It is the contract the implementation PR and its reviewers check against. You write **no code** in this skill, and you never run a write against any database, provider or branch other than the doc itself.

This skill sits inside the existing governance. It does not replace or weaken anything in:
- `WAAIIO_ENGINEERING_OPERATING_ORDER.md`: evidence hierarchy, Evidence Verification gate, Standard Substantive-Change Process (Phase A), Owner authority;
- `RELEASE_GATE_V2.md`: §1 invariant registry, §2 final-state migration checks, §9.1 non-negotiables;
- `CLAUDE.md`: "Lean implementation discipline", "Product decisions", payment custody, standing safety rules.

The requirements doc is the "approved requirements" that CLAUDE.md habit 1 and the Operating Order's Lean Change Contract say a new feature uses as its contract.

## When to use this skill (scaling)

This gate is an Owner-approved addition (2026-11-26) for the work below. The req reviewers review the requirements doc only; they do not replace the two assigned post-implementation reviewers.

**Full process (this skill), required for:**
- new features or new capabilities;
- anything touching money: payments, payouts, fees, refunds, settlement, provider integrations;
- migrations (any schema, RLS, grant or function change);
- auth, permissions, admin access, tenant isolation;
- cross-capability bot changes (shared routing, menus, session state, payment authority, channel handling).

**Not this skill: small bug fixes.** Keep CLAUDE.md's existing one-paragraph implementation contract (habit 1): requested outcome, current behaviour, affected path, what must not change, executable acceptance criteria, plus a reproducible failure or decisive code/schema trace. If a "bug fix" turns out to need a migration, money change or new behaviour, stop and switch to this skill.

If unsure which applies, use the full process and say why in the issue.

## Where the document lives

- **GitHub-first.** The doc is the body (or a pinned comment) of the feature's GitHub issue. Create the issue if none exists. Chat gets a short status only.
- **Revisions.** Every material edit bumps the revision (`r1`, `r2`, …) in the doc's header and adds a one-line entry to its revision log. Reviews name the revision they reviewed.
- **The repo is public.** Security-sensitive requirements (exploit paths, auth bypasses, secret handling, tenant-isolation weaknesses) go in a **private GitHub security advisory**. The public issue says only "S-n: see private advisory" with no detail.
- Start from the template: `.claude/skills/requirements/TEMPLATE.md`.

## Evidence rules (non-negotiable)

1. **Every statement about current behaviour cites evidence**: `file:line` at a stated SHA, a migration file (`supabase/migrations/NNN_*.sql`), or a live read-only query with its result. Docs alone, PR prose, memory and handoff claims are not evidence of current behaviour (Operating Order "Evidence Hierarchy"). They can be cited as the source of an Owner decision.
2. **Anything not confirmed is marked `UNVERIFIED`**, with what would confirm it. Never present an assumption as fact. An `UNVERIFIED` item that a requirement depends on is either verified before review or becomes an open question.
3. **Final state, not creation.** For any table, column, enum, constraint, policy, grant or function, check every later migration that may alter it (CLAUDE.md Golden Rule 9, RELEASE_GATE_V2.md §2), then confirm against the live schema.
4. **Record the SHA.** Gather evidence on a checkout of current `main` (or a branch at the same commit), so `git rev-parse HEAD` equals `git rev-parse origin/main`. The doc header names that SHA. Graphify's `commitSha` is compared against the same SHA.

### Never guess product behaviour (Owner instruction 2026-11-26)

The Owner said: "for the requirements it should ask product related questions on whenever its not sure about something".

- A requirement may depend on how the product should behave: what a user sees or can do, wording, business rules, fees, limits, eligibility, edge cases (cancel, retry, timeout, failure), or anything affecting merchants' money or customers' experience. When current code, docs or a recorded Owner decision do not already settle the answer, the writer **must** raise a PRODUCT DECISION NEEDED card (§5). The writer must not pick an answer.
- Mark each affected B, F or S line `BLOCKED ON Q<n>`.
- Reviewers must reject (CHANGES_REQUESTED) a doc that fills a product gap with an assumption.
- The Owner approval step cannot happen while any product card is unanswered.
- Record each answered card in the doc with the Owner's words, as relayed by the coordinator, and the date.

### Tool order

Use these in order, and record in the doc's "Tools used" line which ones you used and what failed.

1. **Graphify MCP:** `graphify_find` (definitions), `graphify_callers`, `query_graph` (how/where behaviour is handled), `graphify_impact` (blast radius, `include_risk=true`), `graphify_tests_for`. Check that each result's `commitSha` equals the recorded SHA. For the S7 code-impact blast radius, always cross-check Graphify's callers and dependents with grep at that SHA (RELEASE_GATE_V2.md §9.1 item 10), even when the SHAs match. Graphify indexes **code only, not docs**: read docs directly.
2. **Serena MCP** (local stdio server `serena`), when Graphify is down, partial, or its `commitSha` differs from the recorded SHA. Call `initial_instructions` first, then use `serena_repl` with **only** these read-only calls: `s.lsp.find_symbol`, `s.lsp.find_referencing_symbols`, `s.lsp.find_declaration`, `s.lsp.get_symbols_overview` (TypeScript language server), plus `s.fs.read_file` / `s.fs.search_for_pattern`. Anything else (edit, rename, delete, create file, shell, memory writes) is forbidden.
3. **Direct grep and read**, when neither works. Read the file around each hit; a grep hit alone is not a trace.
4. **Supabase MCP** for the live schema. `execute_sql` with catalog and table `SELECT`s only (`information_schema`, `pg_catalog`, `pg_policies`, `pg_proc.proconfig`, `has_function_privilege`, etc.). Never `apply_migration`, never INSERT/UPDATE/DELETE/DDL, and never a SELECT that calls an application or side-effecting function. Production reads need the user's explicit OK first (a stricter rule than the design's minimum, matching CLAUDE.md's separate authorization phases). Never put customer data, PII, secrets or environment values in the doc; prefer counts and identifiers.

**Never skip verification because a tool is down.** Fall through to the next tool. If no tool can confirm something, mark it `UNVERIFIED` and say which tools failed.

For the code-impact part (callers, shared types, two-function traps, enum values), run the checks in the **`preflight-check`** skill and summarise its report under S. Don't repeat its checklist here.

## Document sections

Every requirement has an ID and is one testable statement. IDs never get renumbered; a removed requirement stays as `~~F7~~ removed in r3: reason`.

### Header
Feature, issue number, revision, `main` SHA, author session, tools used (and failures), and the lane (full process, with the trigger that made it full).

### 1. Business (B1…)
- The problem, in plain words.
- Who it is for: customer, merchant (which kind), admin, Owner.
- The success measure: something observable after launch.
- **The Owner decision it rests on**, cited: memory file, doc section, issue/PR comment, or dated Owner message relayed by the coordinator. If there is no Owner decision, that is an open question, not a B-line.

### 2. Functional (F1…)
What the customer, merchant or admin sees and does, step by step, in the order it happens. Each F-line must be testable: someone can write a test that passes or fails against it.

Cover each of these edge cases, or state why it does not apply:
- **skip** (optional steps and their Skip button);
- **cancel** and the escape hatches ("cancel", "exit", "quit", "stop", "restart", "start over");
- **retry** (wrong input, re-tap of an old button, double-tap);
- **payment failure** (declined, abandoned, webhook late or duplicated, "I've Paid" verification);
- **timeout** (session expiry, a customer coming back hours later);
- **multiple languages** (every user-facing string in every supported bot language: see `docs/contracts/736-capability-e2e-contract.md` §3.2);
- **the next-steps menu rule**: every bot transaction ends with a next-steps menu, with "Powered by Waaiio.com" in its footer;
- returning versus first-time customer, and a customer of a different business on the same shared number.

New user-facing wording is proposed in the doc and approved by the Owner with the F section. Never invent wording silently.

### 3. System (S1…)
Each with evidence:
- **Data and migrations.** Tables, columns, types, enums, CHECK constraints, defaults, NOT NULL, indexes, verified against the **final migration state** and the live schema. Name any new migration, its number as currently free (check `supabase/migrations/` and open PRs), and whether it ships ahead of the app (RELEASE_GATE_V2.md §9.2). Trace the INSERT/UPDATE that creates any record you read (Golden Rule 3).
- **RLS and grants.** RLS on every new public table, default deny (DB-003). An access matrix (identity × operation × allow/deny × rule × caller), per Operating Order "Access-contract matrix". Every `SECURITY DEFINER` function: private schema, a pinned `search_path` on every one (and `public, extensions` where DB-001/DB-006 apply), and `CREATE OR REPLACE` attributes preserved per DB-002 / §2.1. List every RELEASE_GATE_V2.md §1 invariant the feature touches (e.g. DB-004, DB-005, CH-001, SEC-003), not only the payment ones.
- **Payment custody.** If money moves, state the route for each custody model in `docs/MERCHANT_PAYMENT_CUSTODY_POLICY.md` (merchant-connected and Waaiio-owned), the fee per tier, who pays gateway fees, the trial rule, and the §1.2 invariants touched. Any change to these rules is an open question for the Owner, never a requirement.
- **Provider limits.** E.g. WhatsApp lists max 10 rows (`lib/bot/flows/shared/list-pages.ts` `LIST_MAX_ROWS`, `lib/channels/meta-cloud.ts`), button and title lengths, template approval, Stripe/Paystack constraints. Cite the code or provider docs.
- **Capability and bot routing**, checked against `docs/contracts/736-capability-e2e-contract.md`: entry type, payment eligibility, post-payment fulfillment authority, dependencies. Name the flow files, step IDs, `session_data` keys and handlers (`bot.service.ts` versus `executor.ts`) involved.
- **Code impact.** The `preflight-check` summary: files, callers, shared types, blast radius.
- **Overlap check.** Open PRs and recent merges touching the same files or types. On 2026-11-26 two PRs each added `metadata` to the same type and broke main (fixed by `6bf62d202`, #1156); this check exists to catch that.
  ```bash
  gh pr list --state open --limit 100 --json number,title,headRefName
  gh pr diff <n> --name-only        # for each open PR
  git log origin/main --since="14 days ago" --name-only --format="%h %s" -- <paths>
  ```
  List each overlapping PR, the shared file or type, and the risk (type change, migration number, `session_data` key, copy key). Also check `CHANGELOG.md` and `changelog/unreleased/` for recent changes to the area (CLAUDE.md Golden Rule 16).

### 4. Out of scope
What this feature deliberately does not do, so reviewers and the implementer don't add it.

### 5. Open questions
Each one is a decision card in the CLAUDE.md format:

> **PRODUCT DECISION NEEDED:** one line
>
> **Context:** what you found and why it is unclear
>
> **Options:** A) ...  B) ...  C) Other
>
> **My recommendation:** which one, and why
>
> **Meanwhile:** what I will keep working on that does not depend on this

Number each card `Q1`, `Q2`, …; affected lines carry `BLOCKED ON Q<n>`. When answered, add under the card: **Owner answer (<date>, relayed by the coordinator):** "<Owner's words>", then update and unblock the affected lines in a new revision.

Architecture, migration or security conflicts are CTO questions in the same format. The writer never asks the Owner directly: the coordinator queues the cards one at a time.

### 6. Acceptance ledger
Every B, F and S ID → the planned test and its kind: handler test, rendered UI test, disposable PostgreSQL test, golden journey (RELEASE_GATE_V2.md §3), catalog assertion, negative/concurrency test. Name the planned test file. A B-line may map to a post-launch measure instead of a test. A source-string test or mock alone is not acceptance for an F or S line (CLAUDE.md "Prove actual behavior"). For any money lane, the ledger must also include both custody routes and duplicate-payment, fee, refund and cross-business regression tests (RELEASE_GATE_V2.md §9.1 item 2).

## Gate

Implementation must not start until all four steps are done.

1. **Two independent reviewers.** Each is a fresh-context, read-only Claude subagent with no shared notes. Give each the issue number, revision, `main` SHA and the governance docs, and ask them to verify the claims, not trust them.
   - **req-reviewer-a (business/functional):** completeness; every edge case in §2 covered or justified; consistency with Owner decisions (memory, docs, issues); no product gap filled with an assumption instead of a card; every F-line testable; wording proposals present; ledger complete.
   - **req-reviewer-b (system/feasibility/security):** re-verifies every citation against the code at the SHA and the live schema, using the same tool order; re-runs the overlap check itself; checks RLS/grants/SECURITY DEFINER, custody, provider limits and routing; confirms that `UNVERIFIED` marks are honest and that nothing sensitive is in the public issue.
2. **Review records.** Each reviewer's report is posted on the issue verbatim, ending with this line on its own, unformatted:
   ```
   Requirements-Review-Record: v1 verdict=APPROVED|CHANGES_REQUESTED doc=<issue#>@<revision> reviewer=req-reviewer-a|b
   ```
   CHANGES_REQUESTED → fix, bump the revision, and have the same reviewer recheck the new revision. A record for an older revision does not count.
3. **Owner approval.** With both reviewers APPROVED on the same revision and every product card answered and recorded, the coordinator brings the Owner a plain-language summary of the B and F sections, recommendation first, with no jargon, and one question at a time for any open card. The Owner approves B and F. Record the approval on the issue (date, revision, the Owner's words as relayed). **The writer never asks the Owner directly.**
4. **Implementation may start**, within the task the coordinator authorizes. Phase A agreement still applies for high-risk work (Operating Order "Standard Substantive-Change Process"). Owner approval of B and F is approval of the requirements only. It is not merge, migration-apply, deployment, production-data or live-provider/financial authorization; each stays a separate Owner approval (RELEASE_GATE_V2.md §9.1 item 5).

### After approval
- The implementation PR lists the IDs it covers (e.g. "Covers B1, F1–F6, S1–S4 of #NNNN@r3") and, per ID, the test that proves it.
- The post-implementation reviewers check each listed ID against the code and tests, as part of their existing review.
- A requirement change after approval bumps the revision and goes back through the gate for the changed IDs only.

## Owner-facing summary

When the coordinator needs a summary for the Owner:
- recommendation first, then "why" in one plain sentence;
- what the customer/merchant will see, in everyday words;
- no file names, IDs, SQL or jargon;
- each open decision as one selectable question with options.

## Report back

When the doc is ready for review, or the gate is complete, report to the coordinator: issue number, revision, `main` SHA, the reviewer verdicts, open decision cards, and the next gate. Stop there.
