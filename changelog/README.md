# Changelog fragments

Each pull request records its changelog entry as **its own file** in
`changelog/unreleased/`, instead of editing the top of `CHANGELOG.md`.
Owner decision, 2026-11-04: when every PR edited the top of `CHANGELOG.md`,
every PR conflicted with every other one. Each conflict changed the PR's
head and invalidated its exact-head review approvals.

## Adding an entry (every PR)

Create `changelog/unreleased/YYYY-MM-DD-<branch-name>.md`. Use the PR's branch name in lowercase, with every character other than letters, digits and `-` (for example `/`, `_` or `.`) replaced by `-`. For example, for branch `claude/calendar-fix` the file is `2026-11-04-claude-calendar-fix.md`. Branch names are unique, so two PRs never add the same file.

```markdown
## 2026-11-04 — Short title of the change

- What changed, which file(s), what it affects.
- Owner decisions it implements, if any.
- Tests.
- Could break: …
```

The rules, checked in CI by `node scripts/changelog/collect.mjs check` (job
"Engineering governance"):

- The file name is `YYYY-MM-DD-<slug>.md`, where the slug uses lowercase
  letters, digits and `-`.
- It has no leftover merge-conflict lines (`<<<<<<<`, `=======`, `>>>>>>>`).
- It is a regular file, not a folder or a symlink. Dotfiles such as
  `.DS_Store` are ignored.
- The first line is `## YYYY-MM-DD — <title>`, using an em dash, with the same
  date as the file name.
- At least one line of text follows the heading.

Do not edit `CHANGELOG.md` directly in a feature PR.

## Collecting (before every Release V3 prepare)

After the last PR for a release has merged, and immediately before prepare, the orchestrating session opens a small collect PR (release step 0).
It merges before prepare, because nothing may merge between prepare and deploy.
It is skipped when `changelog/unreleased/` has no fragments. The collect PR is
docs-only, so it needs one review.

```bash
node scripts/changelog/collect.mjs collect --dry-run   # preview
node scripts/changelog/collect.mjs collect             # prepend to CHANGELOG.md, delete fragments
```

Entries are added by fragment date, newest first. On the same date they are
ordered by file name. The order is not merge order. If any fragment is
malformed, nothing is changed. The new `CHANGELOG.md` is written atomically. If
deleting a fragment then fails, recover with
`git checkout -- CHANGELOG.md changelog/`.

## Release lane

The Release V3 classifier (`scripts/release-v3/classify.mjs`) counts these files
as docs:
- correctly named fragments;
- this README;
- `CHANGELOG.md`.

A docs-only PR plus its fragment therefore stays in the standard lane with one
review. `collect.mjs` reads these files, but it only checks their format and
fails closed, and nothing it produces is deployed. That makes it a narrow,
tested exception to the rule that docs read by tooling count as code. Any other
file under `changelog/` is full lane.

## Reading history

Recent, not-yet-collected changes live in `changelog/unreleased/`. Everything
older is in `CHANGELOG.md`. Check both before changing an area.
