## 2026-11-04 — Dashboard calendar: show every booking; full-day grids open at opening time

Owner decisions (2026-11-04), from the #863 reviews.

- **Show every booking.** The week and day views now stretch their hour rows to include every timed entry in view, even outside business hours (e.g. a 06:00 or 20:00 booking on the default 08:00–20:00 grid).
  - Before: those entries were silently left out. A read-only production query on 2026-11-04 found 73 timed entries hidden across 9 businesses; one church had dozens of 06:00 and 20:00 bookings.
  - New: `lib/calendar/hour-range.ts` `hoursIncludingEntries()`.
- **Full-day grids open at opening time.** When the grid covers the whole day (some day runs past midnight), the week and day views open scrolled to the earliest opening hour instead of 12AM. `calendarHourRange()` now also returns `openHour` and `overnight`.
- `app/dashboard/calendar/page.tsx`:
  - the week view uses `weekHours`, built from the 7 days in view, and the day view uses `dayHours`;
  - hour rows carry `data-hour`;
  - the scroll boxes have refs, and an effect sets the scroll position after loading.
  - Month view is unchanged.
- Review fix: `calendarHourRange()` now skips days marked closed (`closed: true` or `is_open: false`). Before, a 22:00–06:00 restaurant whose closed days are stored as 00:00–00:00 got opening hour 0, so its grid still opened at 12AM. A read-only production check on 2026-11-04 found that only that restaurant's opening hour changes (0 → 22); no daytime business's grid changes.
- Tests: 10 new `hour-range` cases: show-all stretching, malformed times, HH:MM:SS, openHour/overnight, and closed days including the production restaurant's hours. 58/58 pass with the existing calendar tests.
- Could break: nothing in data. Calendars with out-of-hours bookings show more rows.
