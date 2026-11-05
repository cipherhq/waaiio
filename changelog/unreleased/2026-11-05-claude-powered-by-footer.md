## 2026-11-05 — "Powered by Waaiio.com" under the bot's next-steps menu

- **What changed:** When a customer finishes a transaction in the chat, the "What would you like to do next?" menu now shows a small grey footer, "Powered by Waaiio.com". It is hidden for plans marked white-label. The footer is added after translation, so the brand text is never translated. Owner decision 2026-11-05.
- **Files:**
  - `lib/whitelabel.ts`: new `getPoweredByInteractiveFooter()`
  - `lib/bot/flows/executor.ts`: `showPostCompletionMenu` passes `footer` for both the button and list layouts
  - tests in `lib/bot/__tests__/navigation-repeat.test.ts`; `lib/bot/__tests__/session-resilience.test.ts` source pin updated
- **Affects:** every in-chat completion menu (bookings, orders, tickets, giving, payments, invoices), on shared and dedicated numbers.
- **What could break:** nothing expected. WhatsApp footers allow 60 characters and this one is 21, and the sender already cuts footers at 60.
- **Not included:** link payments confirmed by the payment provider still end with a text message and no buttons. Adding the menu there touches the payment confirmation path and needs a guard against two menus, so it comes in a separate PR.
