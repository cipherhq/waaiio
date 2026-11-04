## 2026-11-04 — Parties: seat guests by tag or by their RSVP answer (app)

Owner decision (2026-11-04, #874, D1–D8 as recommended). PR B of two. It needs M514 (PR A) in production first.

What changed:
- **Questions editor** (`app/dashboard/parties/components/PartyQuestionsEditor.tsx`): a "Tag guests with their answer" checkbox on single-choice questions. Ticking one unticks any other. It reports the saved questions to the page, which reloads the guest list because a save re-tags guests.
- **Question contract** (`lib/parties/rsvp-questions.ts`): `parseQuestions` accepts the optional boolean `tag_answers`, on single-choice questions only, at most one per party (same rules as the database).
- **Planner** (`lib/parties/seating-planner.ts`): guests whose tags have reserved tables are placed only at those tables (either tag's tables when they have two, D5), filling one table before the next (D6). Everyone else is placed only at unreserved tables. A new `warnings` list names pinned guests left at a table reserved for a tag they lack (D4); unlike conflicts, warnings do not block Confirm. With no reserved tables the plan is identical to before for the same seed (tested against the previous planner).
- **Dashboard** (`app/dashboard/parties/page.tsx`):
  - each table has a "Reserved for" dropdown (the tagging question's options plus existing tags), and shows a note when no guest has that tag yet;
  - a reserved table's "+ tag" buttons offer only its tag;
  - the guest-list table picker disables reserved tables for guests without the tag;
  - the guest list shows each guest's RSVP answers and marks the tag that came from the RSVP;
  - the seating preview shows each table's reserved tag, lists guests who don't fit per tag, and lists D4 warnings. The existing "Not placed by this plan" line is unchanged for other guests.
- **CSV** (`lib/parties/guest-answers.ts`): the export adds one column per current question with the guest's answer. These new cells are exported as plain text: a value starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe. The existing columns are unchanged.
- **Seating route** (`app/api/parties/[partyId]/seating/route.ts`): the database's "Table 1 is reserved for …" refusal is shown as the error message. Other `23514` errors keep the generic message.
- **Tests:** `lib/__tests__/party-seating-by-tag-514.test.ts` (planner, contract, CSV), `lib/__tests__/party-seating-by-tag-ui-514.test.tsx` (rendered dashboard), and two cases added to `lib/__tests__/party-seating-route-762.test.ts`.

Affects: the Parties dashboard (questions, tables, guest list, seating, CSV) and the seating route's error text. No bot change.

Could break:
- Deploying before M514 is in production: the guest-list query asks for `answer_tag` and the table query for `reserved_tag`, which would fail. Ship only after M514.
- Plan hashes include the new `warnings` field, so a preview made just before the deploy and confirmed after it returns "Seating changed. Create a new preview."
