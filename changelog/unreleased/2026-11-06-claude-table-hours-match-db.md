## 2026-11-06 — Table times the bot offers now fit the business hours (TestBiz "no longer available")

**Found on staging (TestBiz, 6 Nov):** the bot offered a Friday 20:30 table. The table takes bookings 10:00–22:00, but the business is open 09:00–17:00 on Fridays. `book_table_atomic` (M510, Owner decision 2026-11-04) requires the business to be open for the whole booking, so it refused with `day_unavailable`. The customer got "That time is no longer available for this table. Send *Hi* to pick a different time." after answering every question. The table was free.

**What changed**
- `lib/bot/flows/shared/slot-availability.ts`: new `tableTimeInsideBusinessHours()`. It is the business-hours part of `book_table_atomic` (M510) in TypeScript: the day before, the day and the day after on one minute axis, joined stretches, closed/unknown/malformed days read the same way, "not past midnight" when the day has no usable hours.
- `lib/bot/flows/scheduling.flow.ts` `candidateTimes()`: table times outside the business hours are dropped. This one function feeds the time list, a typed or pre-filled time, and the date list (a day with no time left is not listed). Table length is `_seating_duration`, as `create_booking` sends it.
- `lib/bot/flows/shared/table-same-day.ts` `hasTableSlotLeftToday()`: the same filter, so today is not offered once no table can end by closing time.
- `create_booking`, table refused with `day_unavailable` / `before_opening` / `after_closing` / `past_midnight` (e.g. the hours changed after the list was sent): "That time is no longer available for this table. Please choose another time." and the open times again, as the #919 "just got booked" path does (`backToTimeList` takes an optional first line). `past_midnight` gave the generic error before. After 3 refusals in a session the old "Send *Hi*" message is kept (no loop).
- Late-night times listed under the wrong day are no longer offered: for a bar open only Saturday 20:00–02:00, the list showed 00:30 under Saturday, which `book_table_atomic` reads as early Saturday morning and refuses (`before_opening`). The #919 test that expected it is updated.

**Unchanged**: `book_table_atomic` and every migration, services and appointments (`book_slot_atomic`), the table's own days and hours, overlap and same-day rules, deposits and prices, the referral step, property reservations. The filter only removes times; nothing hidden before is shown now.

**Tests**
- `lib/__tests__/table-overnight-510.pg.test.ts` (real PostgreSQL): the real `book_table_atomic` and `tableTimeInsideBusinessHours` give the same answer for every half hour on Friday and Saturday, 60 and 150 min, across 13 hour setups (TestBiz, overnight, closed, `is_open: false`, 24 hours, joined, unknown, malformed); Saturday 00:30 before a Saturday-only night is `before_opening`.
- `lib/__tests__/bot-unavailable-dates-919.test.ts` (H): real `select_time` / `select_date` / `create_booking` steps with the TestBiz hours: the list stops at 14:30, typed 20:30 refused, closed Saturday not listed, today not offered after 15:00, each hours refusal shows the times again.

**Could break**: a business whose table hours are wider than its business hours now sees fewer table times in the bot. That is what the database already allowed; those bookings always failed at the last step. Fix the business hours or the table hours in the dashboard to offer later times.
