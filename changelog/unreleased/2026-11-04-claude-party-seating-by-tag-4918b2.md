## 2026-11-04 — M514: seat party guests by tag or by their RSVP answer (database only)

Owner decision (2026-11-04, #874, D1–D8 as recommended). This is PR A of two: the database change only. The app (questions checkbox, "Reserved for" on tables, planner, guest list and CSV) follows in a stacked PR B.

What changed (`supabase/migrations/514_party_seating_by_tag.sql`):
- **Answer → tag.** A single-choice question may set `tag_answers: true` (at most one per party, D1). When the RSVP authority (`complete_party_rsvp_489`, web and WhatsApp) saves an answer, a new trigger `party_answer_tag_514` adds the chosen option's trimmed label to `event_invites.tags` and records it in the new column `event_invites.answer_tag`. A changed answer swaps only that tag. A tag the organiser added by hand is never adopted or removed, even when it equals the answer. Only the answer authorities may change `answer_tag` (a direct write is refused, `42501`).
  - Maybe and Decline do not change answers, so they do not change the tag.
  - A guest seated by hand (`seating_pinned`) keeps an existing auto-tag when the answer changes (D2). One with no auto-tag yet still gets one.
  - Saving questions re-applies the tags to existing answers (D3); renaming an option re-tags unpinned guests. Deleting the option a guest chose keeps their tag as an ordinary tag, as for D7.
  - Unticking or deleting the question keeps the tags as ordinary tags and clears `answer_tag` (D7).
- **Reserved tables.** New column `party_tables.reserved_tag` (NULL, or trimmed, 1–100 characters). A new trigger `party_reserved_table_514` refuses to seat a guest at a reserved table without that tag ("Table 1 is reserved for Groom's family", `23514`). It only ever names the guest's own party's table; another party's table is left to M457's rejection. It covers every path: the seating commit, manual seating, `assign_guest_to_table`, `bulk_assign_guests_to_table` (these two return their usual `{success:false,error}`) and direct updates. It checks only when the table changes, so tag edits and RSVPs are never blocked, and guests already seated stay when a table becomes reserved (D4).
- **Replaced functions** (every attribute and grant restated):
  - `private.validate_party_questions_489`: also accepts `tag_answers`.
  - `private.party_questions_489`: after a save, re-applies answer tags under the existing party lock.
  - `public.party_seating_snapshot_486`: adds guest `tags` and table `reserved_tag`, so a change to either makes an open preview stale.
- **New functions:** `private.party_answer_tags_514` (the one tagging rule) and the two trigger functions. All are SECURITY INVOKER with `search_path = pg_catalog`, and executable by nobody except their owner. No new SECURITY DEFINER function, no table grant or RLS change.
- **Catalog delta:** `supabase/catalog-deltas/514_party_seating_by_tag.json` (11 changes).
- **Tests:** `lib/__tests__/party-seating-by-tag-514.pg.test.ts` (real PostgreSQL), added to the `ci.yml` pg-file guard and the unit-job exclude.

Affects: party RSVPs, question saves and seating writes (web, WhatsApp, dashboard). The app needs no change to keep working: with no `tag_answers` and no `reserved_tag`, the new triggers change nothing.

Could break:
- The first seating preview opened before the migration and confirmed after it returns "Seating changed. Create a new preview." (the fingerprint now includes tags).
- If the app is rolled back after an organiser has ticked "Tag guests with their answer", the old questions editor cannot load that party's questions. RSVPs keep working.
- Saving questions and a direct guest edit (for example a dashboard tag edit) at the same moment can rarely deadlock; PostgreSQL aborts one side (`40P01`) and nothing is half-written. The M486 seating commit already has the same pattern.
