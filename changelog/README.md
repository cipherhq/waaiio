# Changelog fragments

Each pull request records its changelog entry as **its own file** in
`changelog/unreleased/`, instead of editing the top of `CHANGELOG.md`.
Owner decision, 2026-11-04: when every PR edited the top of `CHANGELOG.md`,
every PR conflicted with every other one. Each conflict changed the PR's
head and invalidated its exact-head review approvals.

## Adding an entry (every PR)

Create `changelog/unreleased/YYYY-MM-DD-<short-name>.md`:

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
- The first line is `## YYYY-MM-DD — <title>`, using an em dash, with the same
  date as the file name.
- At least one line of text follows the heading.

Do not edit `CHANGELOG.md` directly in a feature PR.

## Collecting (before a release)

A small collect PR gathers the fragments:

```bash
node scripts/changelog/collect.mjs collect --dry-run   # preview
node scripts/changelog/collect.mjs collect             # prepend to CHANGELOG.md, delete fragments
```

Entries are added newest first. If any fragment is malformed, nothing is
changed.

## Reading history

Recent, not-yet-collected changes live in `changelog/unreleased/`. Everything
older is in `CHANGELOG.md`. Check both before changing an area.
