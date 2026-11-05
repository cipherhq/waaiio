## 2026-11-05 — Next-steps menu after link payments, one menu per payment

- **What changed:**
  - When the payment confirmation sends a customer's "✅ Confirmed!" message for a payment confirmed by the provider, a dashboard transfer approval or a cron job, it now follows it with a "What would you like to do next?" button menu with the footer "Powered by Waaiio.com". The footer is hidden for white-label businesses.
  - The menu is sent only after this payment's single claimed confirmation has been accepted by Meta, so a retry never repeats it. If the menu fails to send, the logs record it, but the confirmation is never marked failed.
  - Buttons use the same words the confirmation already tells the customer to type: `my bookings`, `my orders`, `my giving` or `history`, then `menu`, plus `directory` on shared numbers. So they work whatever state the chat is in.
  - When a customer's "I've Paid" tap itself triggers the confirmation (Stage 3 runs during that same chat request), the chat now ends the session instead of sending a second menu. If the confirmation went out earlier (the webhook got there first), a later "I've Paid" tap still gets the chat's own menu, so the customer always gets a reply. Ending the session is version-checked, so a session that has already moved on (for example to the save-card PIN step) is left alone. The payment lookup is always scoped to the business. If that check fails for any reason, the chat menu still shows: two menus at worst, never none.
  - Owner rule 2026-11-05.
- **Files:**
  - `lib/payments/next-steps-menu.ts` (new)
  - `lib/payments/send-confirmation.ts`: menu send; reads `is_whitelabel` together with `subscription_tier`; customer language captured for the menu copy
  - `lib/bot/flows/executor.ts`: duplicate-menu guard
  - tests `lib/payments/__tests__/next-steps-menu.test.ts`, `lib/__tests__/link-payment-next-steps-menu.test.ts` and `lib/__tests__/executor-payment-menu-dedupe.test.ts`
- **Affects:** every customer WhatsApp payment confirmation from Stage 3, and the completion of paid chat flows.
- **Product note:** a customer whose "I've Paid" tap triggers the confirmation now sees the confirmation's menu (history, view options, directory) instead of the chat's menu, which also had "Book/Order/Give again".
- **What could break:**
  - Payments confirmed before this deploy have an accepted confirmation but no menu. A customer who taps "I've Paid" for one of those after the deploy gets no menu, and still has the text hints.
  - If WhatsApp delivers the two messages out of order, the menu could appear above the confirmation.
