## 2026-11-13 — Custom Flow: internal 'Hi' re-entries reach the normal bot (Issue #1013)

- **Why:**
  - The platform restarts the customer by re-entering `handleMessage(from, 'Hi', …)` — waitlist acceptance and the returning-customer path. With an active custom session, that 'Hi' was consumed by the custom engine as node input instead of restarting the customer to the normal menu, so the booking flow never started.
- **What changed:**
  - `lib/bot/bot.service.ts`: the custom-flow branch now skips the engine when the call carries the separate restart flag (`_internalRestart`) and the text is a restart signal ('Hi'/'start'/'restart'), closing any active custom session first — a deliberate restart ends the custom session, the same as a typed restart word. The flag is read only by this guard and is separate from provenance, so it changes no metering, trust, or picker behaviour. The guard is deliberately narrow: internal re-entries that redispatch the customer's own text (language-picker, chat handoff) never pass the flag, so they still reach the engine.
  - `lib/bot/bot.service.ts` + `lib/bot/handlers/escape-hatches.ts`: the restart flag is passed by the platform's deliberate restart re-entries — waitlist acceptance, returning customer, go-back-to-business, cancel/menu restarts, and bot-code redirects that fall back to 'Hi'.
  - `lib/bot/bot.service.ts`: waitlist acceptance passes no provenance on its 'Hi' re-entry, exactly as on main — the restart signal is the flag, not provenance. Usage counting, promo trust and the language picker for waitlist acceptances are unchanged.
  - `lib/__tests__/custom-flow-botservice-routing.test.ts`: new test 5 proves waitlist acceptance reaches the booking flow with an active custom session (entry confirmed, custom session closed, language picker shown as on main, then "1" reaches the scheduling date step). New test 6 proves the waitlist step's usage counting is unchanged (the "yes" is still counted as one inbound message / new conversation).
  - `lib/__tests__/bot-recovery-messaging-682.test.ts`: the structural provenance test keeps the waitlist call as its one known exception (no provenance by design — the restart flag carries the signal instead).
- **Affects:** internal restart re-entries for businesses with an active custom session (the guard now fires on the separate restart flag). The waitlist "yes" step is unchanged from main: usage counting, promo trust and the language picker behave exactly as before. No published custom flows exist yet, so no customer traffic changes.
- **Unchanged:**
  - The custom engine (`lib/bot/custom-flow/engine.ts`) — no changes.
  - Redispatches of the customer's own text (language-picker, chat handoff) still reach the engine.
  - All other bot routing, payments, and code flows.
