## 2026-11-04 — M510: late-night table bookings fit inside the business's open time (database only)

Owner decision (2026-11-04, revised; table bookings only). It replaces the earlier "must start before midnight" rule:
- A table booking is allowed when it fits completely inside the business's open time (`businesses.operating_hours`).
- A closing time earlier than or equal to the opening time closes the next day. Equal open and close (for example `00:00`/`00:00`, not marked closed) means open 24 hours from that time.
- Bookings are stored on their real calendar date and time. Starts after midnight are allowed when the business is open then. Example: open Mon 22:00 to Tue 06:00 accepts Tue 01:00–02:30, stored as Tuesday 01:00.
- Back-to-back open days join up. Fri and Sat both `00:00`/`00:00` allow Fri 23:30–01:00. Fri 18:00–02:00 plus Sat 02:00–06:00 is one stretch to Sat 06:00.
- A closed day (`closed: true` / `is_open: false`) contributes no open time. A Tue 01:00 booking is allowed only through Monday's overnight hours: with Monday closed it is refused, even if Tuesday opens at 22:00.
- No usable hours for the booking's date (`{}` hours, day missing, malformed values): no business-hours check, and an end past 24:00 is `past_midnight`, exactly as before. Many businesses have `{}` hours, and the Owner has not decided to block them.

What changed (`supabase/migrations/510_table_overnight_reservations.sql`, `CREATE OR REPLACE` of `public.book_table_atomic`, M476 body otherwise verbatim):
- **Weekday entries.** Each is read as one of:
  - **closed**: an object with `closed` = JSON `true` or `is_open` = JSON `false`;
  - **open**: an object, `closed` absent or JSON `false`, `is_open` absent or JSON `true`, and `open`/`close` both match `^([01]\d|2[0-3]):[0-5]\d$`;
  - **unknown**: anything else, including string flags such as `"true"`.
- **One minute axis.** The open time of the booking's date (D), D-1 and D+1 is placed on one axis relative to D, and stretches that touch or overlap are joined. The booking `[start, start + duration]` must lie inside one stretch.
- **Whose hours decide.** Whether there is a check at all depends on D's own entry only. With Mon 22:00–06:00 and Tuesday missing, Tue 12:00 is not checked.
- **Error codes** (no new codes; the bot already shows its "time not available" message for all three):
  - starts inside open time but ends after it → `after_closing` ("…past closing time 06:00");
  - starts outside open time while the business still opens later that day → `before_opening` ("Earliest reservation time is 22:00");
  - starts outside open time with no later opening that day → `day_unavailable` ("The business is closed on Tuesday" when D is closed, otherwise "The business is not open at that time on Tuesday");
  - a start of `24:00` → `past_midnight` (it is not a time on D).
- **Order of checks.** Business hours are checked after the table's own `available_from` and before its `available_to`. The table's own `available_days` / `available_from` / `available_to` checks are unchanged. Table windows stay non-overnight (`seating_no_overnight` unchanged), so a table with `available_to` cannot take a booking that crosses midnight.
- **Lock.** The advisory lock is per (business, table), not per date, so bookings on neighbouring dates of the same table serialise. The key is `abs(hashtext(...)::bigint)`: `abs()` of the int4 value -2147483648 raised "integer out of range", and one unlucky table would always have failed.
- **Overlap.** Overlap uses one minute axis over `b.date` from D-1 to D+1, with the same statuses as M476 (`pending`, `confirmed`, `in_progress`). A booking running past midnight blocks the next day's early bookings, and the other way round.
- **Catalog delta.** `supabase/catalog-deltas/510_table_overnight_reservations.json` has exactly one `modify`, of `book_table_atomic`: new body hash; ACL, owner, INVOKER and no config unchanged. The replay's pre-510 digest of this function equals the production and staging lock digest.
- **Tests.** `lib/__tests__/table-overnight-510.pg.test.ts` has 73 cases on real PostgreSQL. `ci.yml` has the pg-file guard and the unit-job exclude.

Unchanged: the 18-argument signature, return shape, SECURITY INVOKER, no SET/proconfig, grants (restated: service_role only), idempotency, deposit and duration revalidation, payments and deposits, insert columns, `book_slot_atomic`, `reschedule_booking_atomic`, `seating_no_overnight`, the 1–480 duration CHECK.

Could break:
- Businesses with usable hours now get table bookings refused outside their open time, even when the table has no window. This includes a daytime business at 23:30, which was `past_midnight` before and is now `day_unavailable`.
- A table whose own window reaches outside the business hours can be offered times the database now refuses. The bot builds table slots from the table's window when it has one (`lib/bot/flows/shared/table-same-day.ts`).
- The bot does not offer overnight or after-midnight slots yet; that is a separate app change.
- The RPC reads `businesses`, which service_role already has. If that read is denied, the booking errors and is refused.
- All bookings for one table queue on one lock instead of one per date.
- Not applied anywhere. Staging and production need their own Owner approvals.
