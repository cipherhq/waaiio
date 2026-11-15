## 2026-11-14 — Two Codex reviewers and coordinator decision routing

- Implements the Owner decision to use the same two independent Codex reviewers across chats, with functional/accessibility and security/integrity responsibilities, both reviewing the final SHA and rechecking corrections.
- Aligns AGENTS.md, CLAUDE.md, the Operating Order, release guidance and changelog guidance. Replaces the separate mandatory CLI reviewer invocation with coordinator dispatch to the assigned pair.
- Records coordinator-only selectable Owner questions and preserves Owner authority, the Evidence Verification gate, exact-head CI and historical review validity.
- Validation uses the changelog fragment checker, whitespace checks and targeted policy consistency searches.
- Could break review routing if a chat bypasses the coordinator or treats an automated minimum review count as satisfying the two-reviewer policy. Release automation is unchanged.
