## 2026-11-04 — Parties: guest-list export keeps free text as plain text

Owner decision (2026-11-04).

What changed:
- `app/dashboard/parties/page.tsx` ("Export Guest List"): the **Name**, **Tags** and **Dietary Notes** cells are exported as plain text. They go through the shared `neutralizeFormulaPrefix` guard (`lib/utils/csv-export.ts`, #713), the rule the other CSV exports already use: a value whose first character after any leading whitespace is `=`, `+`, `-`, `@` or `|` gets a leading apostrophe, so a spreadsheet shows it as text instead of running it as a formula. Pure numbers such as `-5` are left as they are.
- Test: `lib/__tests__/party-guest-csv-plain-text.test.tsx` (rendered export).

Affects: only the CSV file the organiser downloads. Phone, Status, Plus Ones and Responded At, the column order and the quoting are unchanged. Ordinary values are unchanged.

Could break: a name, tag or dietary note that really starts with one of those characters (for example "-Family") now shows a leading apostrophe in some spreadsheet apps. PR #880 (not merged) moves this export into `lib/parties/guest-answers.ts`; whichever merges second must keep this protection on these three cells (and #880 should use the same shared guard).
