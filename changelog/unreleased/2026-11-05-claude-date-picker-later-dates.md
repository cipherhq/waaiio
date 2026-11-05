## 2026-11-05 — Bot date picker: "Later dates" pages and typed dates (#916)

**What changed**
- **"Later dates" paging** (`lib/bot/flows/scheduling.flow.ts`, `select_date`, shared by scheduling, appointment and table reservation).
  - The open-date scan now covers the merchant's whole `max_advance_days` window (default 30) instead of stopping at 10 dates. Bookings for the window were already read in one query; nothing extra is fetched.
  - 10 or fewer open dates: the list is unchanged.
  - More: page 1 shows 9 dates and "Later dates ▸". Later pages show "◂ Earlier dates", 8 dates and "Later dates ▸"; the last page shows "◂ Earlier dates" and up to 9 dates (WhatsApp's 10-row limit).
  - Page rows are tapped as `dates_page_<n>`; the page is kept in the new `session_data._date_page`. No existing key was renamed.
- **Typed dates** (new `lib/bot/flows/shared/typed-date.ts`). The bot now reads "Dec 20", "December 20", "Dec 20th", "20 Dec", "20th December", "20th of December", "20/12", "20/12/2026", "20/12/26", "20.12.2026", "2026/12/20", with or without a weekday in front ("Sat, 20 Dec").
  - No year: the next 20 December that is not before today, in the business's local calendar (its timezone when it fits its country, else the server date).
  - Slash dates are day/month; month/day only for businesses with country `US`. A dot works only with a year ("20.12.2026"), so "1.5" or "20.30" is not read as a date.
  - A day typed without a year that just passed ("4 Nov" on 5 Nov: nearer behind than its next occurrence is ahead) is answered "That date has passed". An upcoming date past the window ("Jan 25" on 20 Dec) is answered "Bookings open up to N days ahead".
  - The old `new Date(input)` fallback is gone. It read "Dec 20" as 2001-12-20 and rejected it as passed.
- **Same rules for every date input.** After the existing past, `max_advance_days` and table same-day checks, a date must be one the list would show: not a closed day, a day the service runs, and not fully booked. Before, a typed "Sunday" was accepted for a business closed on Sundays and the time list fell back to default hours.
- **Hint**: "Or type a date, like *20 Dec*." under the date prompt (buttons and list). New copy keys `booking.type_date_hint`, `booking.later_dates`, `booking.earlier_dates` in all 8 locales (`lib/bot/flows/flow-localization.ts`). en and pcm are certified; the other six are best-effort and listed in `OWNER_REVIEW_ITEMS`.
- **Errors**: "We're closed on Sundays…", "This service isn't available on Tuesdays…", "That day is fully booked…", "Bookings open up to 30 days ahead…" (was "Bookings can only be made up to 30 days in advance."), "That date doesn't look right…", and a help line for unreadable text. Every date error re-shows the full date list from page 1.

**Unchanged**: the Today / Tomorrow / This Saturday / Pick a Date buttons, `date_YYYY-MM-DD` postbacks, waitlist when no dates are open, `skipIf` pre-filled dates, `reservation.flow.ts` check-in/check-out, staff/time steps, payment and booking creation. No migration.

**Tests**: `lib/bot/flows/shared/__tests__/typed-date.test.ts` (parser), `lib/__tests__/date-picker-paging-typed.test.ts` (real `select_date` step with a frozen clock, and the real `FlowExecutor` for the page tap, a typed date and an error).

**What could break**
- A tapped date that filled up or closed after the list was sent is now refused with a message and a fresh list, instead of continuing to an empty or default-hours time list.
- Each date tap now runs the bookings read once more (in `validate()`), plus the same-day slot check for a table today. The scan covers the whole window (up to 365 days) on each prompt and tap; labels use one shared `Intl.DateTimeFormat` per scan.
- A year-less date can land next year when the window is long ("4 Nov" typed on 5 Nov with `max_advance_days` 365 books 4 Nov next year). The booking summary shows the year.
- Wording of the "too far ahead" and "unreadable date" errors changed; other locales still get them through the executor's translation, as before.
