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
  - The reminder claims `reminder_sent_at` before sending. If the send fails, it releases the claim and restores the link the client already has.
  - The reminder checks the booking first. It skips cancelled or deleted bookings. For a rescheduled booking it moves the link's expiry to the new start instead of reminding at the old time. It also skips a link that was first sent less than 25 hours before the session, because that first message already is the reminder.
  - Session start is converted from the business timezone in two passes, so it stays correct across daylight-saving changes.
- **`lib/bot/flows/scheduling.flow.ts`:**
  - **New `intake_form` step** after the pre-booking questions. It skips appointments, table bookings, classes, reschedules, unentitled businesses and clients who already answered. For first-booking-only forms, the client's own answer in this booking does not count as an earlier one.
    - It sends the link with "I've filled it" and "Send a new link" buttons, then waits until the answers arrive. The booking and payment start only after that.
    - The link is kept while still valid, and is replaced only on request or once it expires.
    - The link is protected from translation.
    - "Back" into the step after answering shows "We already have your answers" instead of an error. If the intake cannot be read just now, the open link is kept.
  - **`create_booking`** attaches the answered intake to the new booking. For a free, confirmed booking, it adds the after-booking link to the confirmation reply, just above the next-steps menu, which stays last.
- **`lib/payments/send-confirmation.ts`:** after a finalized payment confirmation, sends the after-booking form, non-blocking and on the same channel.
- **`app/api/bookings/create-manual/route.ts`:** sends the form for bookings the business makes by hand, non-blocking. Per the #963 decision, a before-booking form is sent here as in after mode.
- **`app/api/dashboard/pending-transfers/[id]/route.ts`** and **`.../[id]/approve/route.ts`:** a bank-transfer booking that becomes confirmed (in one step, or approved later) sends its after-booking form, non-blocking.
- **`lib/bot/flows/executor.ts`:** the saved bot transcript (`conversation_log`) records intake links as `/intake/[token]`, so the token is never stored there. The client still receives the full link.
- **`app/api/intake/after-confirm/route.ts`** (new, owner-only): the Bookings and Calendar pages (`app/dashboard/reservations/page.tsx`, `app/dashboard/calendar/page.tsx`) call it when the business confirms a booking.
- **`app/api/cron/intake-reminders/route.ts`** (new, hourly in `vercel.json`): one reminder for unanswered after-booking forms whose session is 22–25 hours away. It works through due intakes page by page, within a 45-second time budget.
- **Tests:**
  - `lib/__tests__/intake-send-963.test.ts`
  - `lib/__tests__/intake-bot-963.test.ts`
  - `lib/__tests__/intake-routes-963.test.ts`
  - `lib/__tests__/intake-create-booking-963.test.ts`
  - `lib/__tests__/intake-transfer-hooks-963.test.ts`
  - the shared helper `lib/__tests__/helpers/intake-fake-db.ts`

**Affects:** only services that link an intake form, on Pro/Premium/trial businesses. Everything else is unchanged.

**Could break:**
- A before-booking service now needs the client to answer before the booking is made.
- After-booking forms and reminders are skipped whenever the client's 24-hour window is closed (by design).
- A booking rescheduled after its link was sent keeps the old expiry until the reminder cron sees it in the 22–25-hour band.
- In the bot, the after-booking intake row is created just before the reply. If that reply is not delivered, the booking shows the form as sent although nobody received it.
- Other paths that confirm bookings (external-booking integration, automation rules, recurring charges, the public booking page) do not send intake forms yet.
- Session start uses `businesses.timezone`, which defaults to Africa/Lagos and is often unset. The existing booking reminders share this limit.
