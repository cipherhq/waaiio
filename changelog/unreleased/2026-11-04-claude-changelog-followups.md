## 2026-11-04 — Changelog fragments: review follow-ups

- Follow-ups from the #866 and #864 reviews:
  - `scripts/changelog/collect.mjs`:
    - `check` now rejects fragments that still contain a merge-conflict line (`<<<<<<<`, `=======`, `>>>>>>>`). One slipped into #864's fragment and was caught by review.
    - The repo root now comes from the script's own location, not the current folder. Running it from a subfolder used to report "OK (0)".
  - Docs (`CLAUDE.md`, `changelog/README.md`, PR template): in the fragment name, every character other than letters, digits and `-` in the branch name becomes `-` (for example `/`, `_` and `.`).
  - `docs/RELEASE_V3_GATE.md` step 0: the collect PR runs after the last PR for the release has merged, immediately before prepare. Its merge commit becomes the prepare target.
  - `RELEASE_GATE_V2.md` §9.3: one line records the Owner-approved carve-out for changelog files.
- Tests: `scripts/__tests__/changelog-collect.test.ts`, 5 new cases:
  - 3 conflict-marker cases;
  - running from a subfolder;
  - a Markdown `---` rule is still fine.
- Could break: a fragment with a leftover conflict line now fails the "Engineering governance" check.
