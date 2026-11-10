## 2026-11-10 — Client intake forms: sending links, the bot step and reminders (#963 lane 3)

**Why:** this is the last lane of #963. A service's linked intake form now reaches the client on WhatsApp.

The Owner decided on 2026-11-10:
- a before-booking link lasts 24 hours;
- an after-booking link lasts until the session starts;
- links are sent only inside the client's 24-hour window, never by template;
- a booking that needs approval gets its form when the business approves it;
- this covers services only, not Appointments.

Later the same day the Owner also decided:
- a database glitch never blocks a booking;
- a team member's confirmation sends the form;
- an unticked "send confirmation" sends no form;
- the public booking page is included:
  - a before-booking form is answered inside the page;
  - an after-booking link goes by email, with an on-screen button for free bookings;
  - the phone is required only for services with a form.

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
  - **`create_booking`** attaches the answered intake to the new booking, but only for the same service. `linkIntakeToBooking` also checks `service_id`. For a free, confirmed booking, it adds the after-booking link to the confirmation reply, just above the next-steps menu, which stays last. The intake row is saved only after that reply reaches WhatsApp. A bot reschedule moves a pending link's expiry to the new start.
- **`lib/payments/send-confirmation.ts`:** after a finalized payment confirmation, sends the after-booking form, non-blocking and on the same channel.
- **`app/api/bookings/create-manual/route.ts`:** sends the form for bookings the business makes by hand, non-blocking, only when "send confirmation" is ticked. Per the #963 decision, a before-booking form is sent here as in after mode.
- **`app/api/dashboard/pending-transfers/[id]/route.ts`** and **`.../[id]/approve/route.ts`:** a bank-transfer booking that becomes confirmed (in one step, or approved later) sends its after-booking form, non-blocking.
- **`lib/bot/flows/types.ts`** and **`lib/bot/flows/executor.ts`:**
  - new optional `_afterSend` on a prompt message. It runs once after that message was handed to WhatsApp, and never when the message is not sent.
  - the saved bot transcript (`conversation_log`) records intake links as `/intake/[token]`, so the token is never stored there. The client still receives the full link.
- **`app/api/intake/after-confirm/route.ts`** (new; owner or active team member, via `resolveBusinessRole`): the Bookings and Calendar pages (`app/dashboard/reservations/page.tsx`, `app/dashboard/calendar/page.tsx`) call it when the business confirms a booking.
- **Public booking page:**
  - **`app/api/bookings/public/intake/route.ts`** (new): for an OTP-verified client, opens the service's before-booking intake and returns its token once.
  - **`app/api/bookings/public/create/route.ts`:**
    - a service with a form needs the phone number;
    - a before-booking form must be answered first (409 `intake_required`), then it is linked to the booking;
    - a free booking emails the after-booking link and returns it for the confirmation screen.
  - **`app/b/[slug]/page.tsx`** and **`BookingForm.tsx`:** the phone is required for services with a form. The form is shown inside the page before "Book", and the free-booking confirmation shows "Fill in your form".
  - **`components/intake/IntakeFormView.tsx`:** new `onDone` option to show the form inside the booking page. A link from a booking-page booking says "You can close this page now." instead of "go back to WhatsApp".
  - **`app/api/intake/[token]/route.ts`:** returns `from_web`.
  - **`lib/intake/send.ts`:**
    - a booking-page booking is recognised by its `source: 'public'` marker (M518);
    - its after-booking link goes by email, never WhatsApp, and it gets no WhatsApp reminder;
    - "answered before" is checked by the verified email, never the typed phone;
    - new `webBeforeBookingForm` and `findWebIntake`.
- **`app/api/bookings/[id]/reschedule/route.ts`:** a dashboard reschedule moves a pending after-booking link's expiry to the new start (`syncIntakeExpiry`).
- **`app/api/cron/intake-reminders/route.ts`** (new, hourly in `vercel.json`): one reminder for unanswered after-booking forms whose session is 22–25 hours away. It works through due intakes page by page, within a 45-second time budget.
- **Tests:**
  - `lib/__tests__/intake-send-963.test.ts`
  - `lib/__tests__/intake-bot-963.test.ts`
  - `lib/__tests__/intake-routes-963.test.ts`
  - `lib/__tests__/intake-create-booking-963.test.ts`
  - `lib/__tests__/intake-transfer-hooks-963.test.ts`
  - `lib/__tests__/intake-manual-963.test.ts`
  - `lib/__tests__/intake-public-963.test.ts`
  - `lib/__tests__/intake-public-create-963.test.ts`
  - `lib/__tests__/intake-booking-page-963.test.tsx`
  - `lib/__tests__/intake-reschedule-963.test.ts`
  - additions to `lib/__tests__/intake-ui-963.test.tsx`
  - the shared helper `lib/__tests__/helpers/intake-fake-db.ts`

**Affects:**
- Services that link an intake form, on Pro/Premium/trial businesses.
- On the public booking page, a service with a linked form now needs the client's phone number.
- Everything else is unchanged.

**Could break:**
- A before-booking service now needs the client to answer before the booking is made.
- After-booking forms and reminders are skipped whenever the client's 24-hour window is closed (by design).
- A booking rescheduled through any path other than the bot or the dashboard reschedule route keeps the old link expiry.
- Other paths that confirm bookings (external-booking integration, automation rules, recurring charges) do not send intake forms yet.
- Team members cannot confirm bookings in the dashboard today, because the bookings table lets only owners update. The send route already accepts them for when that opens up.
- Booking-page clients get no reminder: the email is their only link.
- The email and the new page text are in English only.
- Session start uses `businesses.timezone`, which defaults to Africa/Lagos and is often unset. The existing booking reminders share this limit.
