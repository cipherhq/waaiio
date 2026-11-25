## 2026-11-25 — Reset per-booking question state between bookings

**What changed:** The answers a customer gives to a business's pre-booking questions, and the bot's position in those questions, now belong to one booking only. They are cleared whenever a new booking starts in the same chat:
- on every capability selection or switch, including picking the same capability again (`clearStaleCapabilityState`);
- when the capability menu auto-selects a business's only capability;
- when the saved-card "Menu" button returns the customer to the capability menu.

Before this, a new booking in the same session could skip the questions and be saved with the earlier booking's answers in `bookings.metadata.custom_answers`.

**Files:** `lib/bot/flows/shared/capability-transition.ts` (new `clearPreBookingQuestionState`, called from `clearStaleCapabilityState`), `lib/bot/flows/capability-selection.flow.ts` (single-capability auto-select), `lib/bot/bot.service.ts` (saved-card Menu), new test `lib/bot/__tests__/pbq-session-reset.test.ts`.

**Affects:** The scheduling flow's `pre_booking_questions` step (session keys `_pbq_answers`, `_pbq_index`) and the answers saved on new bookings. No other session keys and no other flows are touched. Within one booking, the answers are kept exactly as before.

**What could break:** A customer who starts a new booking is asked the business's questions again, as intended. Any future path that returns to an earlier booking step through the capability menu would also start the questions again.
