## 2026-11-04 — Parties: guest-list export keeps free text as plain text

Owner decision (2026-11-04).

What changed:
- `app/dashboard/parties/page.tsx` ("Export Guest List"): the **Name**, **Tags** and **Dietary Notes** cells are exported as plain text. A value that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe, so a spreadsheet shows it as text instead of running it as a formula.
- New helper `lib/parties/csv-cell.ts` (`plainTextCell`).
- Test: `lib/__tests__/party-guest-csv-plain-text.test.tsx` (rendered export).

Affects: only the CSV file the organiser downloads. Phone, Status, Plus Ones and Responded At, the column order and the quoting are unchanged. Ordinary values are unchanged.

Could break: a name, tag or dietary note that really starts with one of those characters (for example "-" or "+") now shows a leading apostrophe in some spreadsheet apps. PR #880 (not merged) moves this export into `lib/parties/guest-answers.ts`; whichever merges second must keep this protection on these three cells.
