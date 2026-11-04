## 2026-11-04 — Orders paid online alert the owner once, after payment

- Owner decision 2026-11-04 (option A). Before this change, the owner got a "new order" WhatsApp alert when a bot order was created and a second one after online payment (staging WA-OR-8782, Paystack saved card).
- `lib/bot/flows/ordering.flow.ts` (`process_order`): a freshly created order now records that its creation alert is owed (`session_data._owner_order_alert_due`, the order id). The alert is sent only once the payment route is known:
  - online only (payment link, saved card): not sent at creation. The owner gets the existing post-payment alert from `send-confirmation.ts`, which is unchanged;
  - bank transfer only, zero total: sent, as before;
  - ambiguous routes keep the alert: online and bank transfer offered together, or payment setup failed (no link, no transfer).
- A saved-card skip keeps the owed marker, so a later bank-transfer offer for the same order still alerts once. Re-entry on an order the session did not just create never alerts, as before.
- Unchanged: `send-confirmation.ts`, payment finalization and authority, the transfer-proof alert, both custody routes (merchant-connected and Waaiio-owned), fees and refunds.
- Tests: new `lib/bot/flows/__tests__/order-owner-alert-routing.test.ts` (9 tests, real `process_order` and real `sendProactiveConfirmation`). `message-optimization.test.ts`: the online-only first-entry test now expects no creation alert.
- Could break: when online and bank transfer are offered together and the customer pays online, the owner still gets two alerts (kept on purpose, route is ambiguous at creation). The creation alert now goes out after the payment link is set up, a moment later than before.
