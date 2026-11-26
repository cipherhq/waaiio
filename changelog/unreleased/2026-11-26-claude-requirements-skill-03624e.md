## 2026-11-26 — Requirements skill: evidence-backed requirements before code

**What changed:** Owner design 2026-11-26. New project skill `requirements` writes one requirements document per feature, in the feature's GitHub issue, before any code is written. It has Business (B), Functional (F) and System (S) requirements with IDs, out of scope, open questions as PRODUCT DECISION NEEDED cards, and an acceptance ledger mapping each ID to a planned test.
- Evidence rules: every claim about current behaviour cites file:line, a migration or a live read-only query; anything else is marked UNVERIFIED. Tool order: Graphify (commitSha must equal HEAD), then Serena, then grep/read; Supabase MCP SELECT-only for the live schema.
- The S section includes an overlap check against open PRs and recent merges (`gh pr list` + `gh pr diff --name-only`).
- Gate: two independent read-only Claude reviewers (req-reviewer-a business/functional, req-reviewer-b system/security) post `Requirements-Review-Record` lines; then the Owner approves B and F through the coordinator; only then may implementation start. The implementation PR lists the IDs it covers.
- Full process applies to new features, money, migrations, auth and cross-capability bot changes. Small bug fixes keep CLAUDE.md's one-paragraph implementation contract.

**Files:** `.claude/skills/requirements/SKILL.md`, `.claude/skills/requirements/TEMPLATE.md`, and a one-line pointer in `CLAUDE.md` under "Lean implementation discipline", habit 1.

**Affects:** process only. No app code, migration, money routing or user-facing behaviour changes.

**What could break:** nothing at runtime.
