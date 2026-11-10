## 2026-11-10 — Client intake forms: sending links, the bot step and reminders (#963 lane 3)

**Why:** this is the last lane of #963. A service's linked intake form now reaches the client on WhatsApp.

The Owner decided on 2026-11-10:
- a before-booking link lasts 24 hours;
- an after-booking link lasts until the session starts;
- links are sent only inside the client's 24-hour window, never by template;
- a booking that needs approval gets its form when the business approves it;
- this covers services only, not Appointments.

**What changed**
- **`lib/intake/send.ts`** (new): creates intake links and sends them.
  - It checks the plan (`resolveLimitTier`), first-booking-only, STOP opt-outs and the 24-hour window (`businessChatWindowState`). It also checks that the form is usable on the intake page.
  - Only the sha256 of the 43-character token is stored. The token is never logged.
  - If WhatsApp refuses the send, the intake row is removed, so the booking shows "Not sent".
  - The reminder claims `reminder_sent_at` before sending, and releases it if the send fails.
- **`lib/bot/flows/scheduling.flow.ts`:**
  - **New `intake_form` step** after the pre-booking questions. It skips appointments, table bookings, unentitled businesses and clients who already answered.
    - It sends the link with "I've filled it" and "Send a new link" buttons, then waits until the answers arrive. The booking and payment start only after that.
    - The link is kept while still valid, and is replaced only on request or once it expires.
    - The link is protected from translation.
  - **`create_booking`** attaches the answered intake to the new booking. For a free, confirmed booking, it adds the after-booking link to the confirmation reply.
- **`lib/payments/send-confirmation.ts`:** after a finalized payment confirmation, sends the after-booking form, non-blocking and on the same channel.
- **`app/api/bookings/create-manual/route.ts`:** sends the after-booking form for manual bookings, non-blocking.
- **`app/api/intake/after-confirm/route.ts`** (new, owner-only): the Bookings and Calendar pages (`app/dashboard/reservations/page.tsx`, `app/dashboard/calendar/page.tsx`) call it when the business confirms a booking.
- **`app/api/cron/intake-reminders/route.ts`** (new, hourly in `vercel.json`): one reminder for unanswered after-booking forms whose session is 22–25 hours away.
- **Tests:**
  - `lib/__tests__/intake-send-963.test.ts`
  - `lib/__tests__/intake-bot-963.test.ts`
  - `lib/__tests__/intake-routes-963.test.ts`
  - the shared helper `lib/__tests__/helpers/intake-fake-db.ts`

**Affects:** only services that link an intake form, on Pro/Premium/trial businesses. Everything else is unchanged.

**Could break:**
- A before-booking service now needs the client to answer before the booking is made.
- After-booking forms and reminders are skipped whenever the client's 24-hour window is closed (by design).
- Session start uses `businesses.timezone`, which defaults to Africa/Lagos and is often unset. The existing booking reminders share this limit.
