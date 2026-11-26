# Requirements: <feature name>

| | |
|---|---|
| Issue | #<n> |
| Revision | r1 |
| Evidence gathered at | `main` <40-char SHA> (HEAD = origin/main) |
| Author | <session name> |
| Lane | Full process: <trigger: new feature / money / migration / auth / cross-capability bot> |
| Tools used | Graphify (commitSha <sha>, = recorded SHA: yes/no; grep cross-check done) · Serena: used/not needed/failed (<why>) · grep/read · Supabase MCP read-only (<project>) |
| Private advisory | none / <GHSA id, no detail here> |

**Revision log**
- r1 (<date>): first draft.

Status words: `VERIFIED` (evidence cited) · `UNVERIFIED` (what would confirm it) · `BLOCKED ON Q<n>` (waiting on an Owner product decision; never guess).

---

## 1. Business

| ID | Requirement | Owner decision (cited) |
|---|---|---|
| B1 | Problem: … For: … | <memory file / doc § / issue comment / date> |
| B2 | Success measure: … | … |

## 2. Functional

Step by step. Each line testable.

| ID | Actor | Requirement | Current behaviour (evidence) |
|---|---|---|---|
| F1 | customer | … | `path/file.ts:NN` @ <sha> / new |
| F2 | merchant | … | … |

**Edge cases** (each covered by an F-line, or "N/A because …"):
- Skip: F…
- Cancel / escape hatches: F…
- Retry, old button, double tap: F…
- Payment failure, late/duplicate webhook, "I've Paid": F…
- Timeout / customer returns later: F…
- Languages (all supported bot languages): F…
- Next-steps menu with "Powered by Waaiio.com" footer: F…
- First-time vs returning; another business on a shared number: F…

**Proposed wording** (for Owner approval):
- `<copy key>` (en): "…"

## 3. System

| ID | Area | Requirement | Evidence |
|---|---|---|---|
| S1 | Data / migration | … | `supabase/migrations/NNN_*.sql:NN` + later migrations checked: … + live query: `SELECT …` → … |
| S2 | RLS / grants | … | access matrix below; `pg_policies` / `has_function_privilege` result |
| S3 | SECURITY DEFINER | private schema; `search_path` per DB-001/002/006 | `pg_proc.proconfig` result |
| S4 | Payment custody | route for merchant-connected and Waaiio-owned; fee per tier; gateway fees | `docs/MERCHANT_PAYMENT_CUSTODY_POLICY.md` § + code |
| S5 | Provider limits | e.g. list ≤ 10 rows | `lib/bot/flows/shared/list-pages.ts:NN` |
| S6 | Capability / bot routing | entry type, payment eligibility, fulfillment authority | `docs/contracts/736-capability-e2e-contract.md` § + flow file:line |
| S7 | Code impact | preflight-check summary: callers, shared types, blast radius | Graphify/Serena/grep results |
| S8 | Overlap | no conflict with open PRs / recent merges | table below |

**Access matrix** (if S2 applies)

| Object | Identity | Operation | Allow/Deny | Rule | Caller | Evidence |
|---|---|---|---|---|---|---|

**Overlap check** (run at <date>, `main` <sha>)

| PR / commit | State | Shared file or type | Risk | Action |
|---|---|---|---|---|

Commands: `gh pr list --state open --limit 100 --json number,title,headRefName`; `gh pr diff <n> --name-only`; `git log origin/main --since="14 days ago" --name-only -- <paths>`; `CHANGELOG.md` and `changelog/unreleased/` read.

## 4. Out of scope

- …

## 5. Open questions

**Q1**

> **PRODUCT DECISION NEEDED:** …
>
> **Context:** …
>
> **Options:** A) …  B) …  C) Other
>
> **My recommendation:** …
>
> **Meanwhile:** …

Affects: F…, S… (marked `BLOCKED ON Q1`)

**Owner answer** (<date>, relayed by the coordinator): "<Owner's words>"

## 6. Acceptance ledger

| ID | Planned test | Kind | File |
|---|---|---|---|
| B1 | post-launch measure: … | measure | — |
| F1 | … | handler / rendered UI / disposable PG / golden journey / catalog / negative / concurrency | `lib/__tests__/….test.ts` |
| S1 | … | … | … |

## Review records

<!-- Each reviewer's report is posted verbatim as an issue comment, ending with its record line on its own, unformatted: -->
<!-- Requirements-Review-Record: v1 verdict=APPROVED|CHANGES_REQUESTED doc=<issue#>@<revision> reviewer=req-reviewer-a|b -->

## Owner approval

- B and F approved: <date>, revision <rN>, relayed by the coordinator: "<Owner's words>"
