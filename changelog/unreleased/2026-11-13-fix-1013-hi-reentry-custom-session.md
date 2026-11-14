## 2026-11-13 — Custom Flow: internal 'Hi' re-entries reach the normal bot (Issue #1013)

- **Why:**
  - The platform restarts the customer by re-entering `handleMessage(from, 'Hi', …)` — waitlist acceptance and the returning-customer path. With an active custom session, that 'Hi' was consumed by the custom engine as node input instead of restarting the customer to the normal menu, so the booking flow never started.
- **What changed:**
  - `lib/bot/bot.service.ts`: the custom-flow branch now skips the engine when the call carries internal provenance and the text is a restart signal ('Hi'/'start'/'restart'), closing any active custom session first — a deliberate restart ends the custom session, the same as a typed restart word. The guard is deliberately narrow: internal re-entries that redispatch the customer's own text (language-picker, chat handoff) still reach the engine.
  - `lib/bot/bot.service.ts`: waitlist acceptance now passes `'waitlist_acceptance'` provenance on its 'Hi' re-entry, matching the returning-customer path.
  - `lib/__tests__/custom-flow-botservice-routing.test.ts`: new test 5 proves waitlist acceptance reaches the booking flow with an active custom session (entry confirmed, custom session closed, capability menu shown, then "1" reaches the scheduling date step).
  - `lib/__tests__/bot-recovery-messaging-682.test.ts`: the structural provenance test's one known exception was the waitlist call (no provenance). It now carries `'waitlist_acceptance'`, so the exception is removed and the rule is strict again — every business-scoped recursive `handleMessage` call must pass provenance.
- **Affects:** only internal restart re-entries for businesses with an active custom session. No published custom flows exist yet, so no customer traffic changes.
- **Unchanged:**
  - The custom engine (`lib/bot/custom-flow/engine.ts`) — no changes.
  - Redispatches of the customer's own text (language-picker, chat handoff) still reach the engine.
  - All other bot routing, payments, and code flows.
