## 2026-11-20 — "My bookings" after a finished payment opens your history, not the business picker

**What changed:** Owner bug 2026-11-20 (staging, TestBiz saved-card booking). After payment the chat closes, and the "My bookings / My tickets / My orders / My giving" next-steps button then sent the customer to the past-business picker and then "no business found". The button now names its business and the list it opens (`pc_history:<bookings|orders|giving>:<businessId>`), following the View Options pattern from 2026-11-18. When it's tapped with no chat open, the business is checked against this number's own past businesses, and the reply is sent as that business. The existing typed "my bookings" / "my orders" / "my giving" view then opens, looked up from this number's own profile and never from the button. A business this customer never used, or an older bare `pc_history` button, still goes to the picker, as before.

**Files:** `lib/bot/flows/shared/navigation.ts` (`historyPostback`, parser), `lib/bot/flows/executor.ts` (button ids), `lib/bot/bot.service.ts` (`resumeStaleNextSteps` and its two call sites), tests `lib/__tests__/stale-next-steps-button.test.ts` and `lib/__tests__/updates-optin-executor-menu.test.ts`.

**Affects:** Only the "My …" next-steps button. With a chat still open, the id is reduced to `pc_history` and the in-chat handler runs unchanged. View Options, Book again and Done are unchanged.

**What could break:** Anything that compares this button's id with the literal `pc_history` before `parseViewOptionsPostback` runs.

**Known gap (not fixed here):** On the shared number, typing "my bookings" / "my orders" with no chat open still sends nothing, because no business is bound to the reply and the send guard refuses it.
