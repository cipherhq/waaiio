## 2026-11-23 — Owners now see customers' pre-booking answers; optional questions get a Skip button

**What changed:** Answers to the business's own pre-booking questions (Settings → Business, saved in `bookings.metadata.custom_answers`) were stored but never shown anywhere. They now appear as "Question: Answer" lines:
- in the booking detail panel on the Bookings page and in the Calendar booking details, next to Special Requests;
- as a "Pre-booking Answers" column in the Bookings CSV export;
- in the owner's new-booking email (escaped) and WhatsApp alert (each answer capped at 300 characters), for bookings confirmed in the bot without a deposit. Bookings with a deposit notify the owner later from the payment confirmation (`lib/payments/send-confirmation.ts`), which this change does not touch, so those alerts do not carry the answers yet; the dashboard still shows them.
Labels come from the business's current questions, matched by id. An answer to a question that was since deleted keeps the label "Earlier question" and is never dropped.
In the bot, an optional question now shows a "Skip" reply button (the existing localized `booking.skip` title) instead of the "_Type *skip*_" hint; typing "skip" still works and a skipped question still stores nothing. A required question can no longer be passed by typing "skip" (it gets the same "Please answer this question to continue." as an empty reply). A question longer than a WhatsApp button body allows (1024 characters) keeps the old text hint.
How answers are stored is unchanged.

**Files:** `lib/bookings/pre-booking-answers.ts` (new shared labelling helper), `components/dashboard/PreBookingAnswers.tsx` (new), `app/dashboard/reservations/page.tsx`, `app/dashboard/calendar/page.tsx`, `lib/bot/flows/scheduling.flow.ts` (`pre_booking_questions` step and the owner notify call), `lib/bot/flows/shared/notify-owner.ts`, `lib/email/templates.ts` (`newBookingOwnerEmail`). Tests: `lib/bot/flows/__tests__/pre-booking-questions.test.ts`, `lib/__tests__/intake-create-booking-963.test.ts` (create_booking → notifier wiring), `lib/bot/flows/shared/__tests__/notify-owner-pre-booking-answers.test.ts`, `app/dashboard/reservations/__tests__/pre-booking-answers.test.tsx`, `lib/bookings/__tests__/pre-booking-answers.test.ts`.

**Affects:** Scheduling/appointment and table bookings made through the bot; Bookings and Calendar dashboard pages; owner new-booking notifications.

**What could break:** The Bookings and Calendar booking queries now also select `bookings.metadata` (already readable by the owner under existing RLS). A customer who used to type "skip" on a required question must now answer it.
