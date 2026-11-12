## 2026-11-12 — Bank transfer "expired" WhatsApp notice is no longer refused

**What changed:** The customer's "your bank transfer has expired" WhatsApp message now goes out with message category `service`. Before this, the expiry job sent it with no category, and Waaiio's financial authorization guard (M370/M371/M461 `check_or_authorize_send`) refused it with `missing_message_category`. Customers only got the email copy. The defect showed up in the first staging run after cron jobs were switched back on (2026-11-12 15:48 UTC). `service` follows the rule #721 set for free-form transactional sends (payment confirmations, event cancellation notices).

**Files:** `app/api/cron/expire-transfers/route.ts` (one option on the `sendOrEmail` call); test `lib/__tests__/expire-transfers-stale.test.ts`. The new test runs the real `sendOrEmail` against a sender that refuses a missing category.

**Affects:** the WhatsApp copy of the transfer-expired notice for bookings, reservations, invoices and orders. Each one now reserves messaging credit at the configured `service` rate, as other transactional notices do. Email copy, expiry rules, booking/order cancellation, fees and payouts are unchanged. No migration.

**What could break:** nothing else. The message is now actually sent, so it counts against the merchant's messaging balance and spend cap. Not fixed here: 9 other business-scoped cron sends also pass no category (balance, booking/reservation and subscription reminders, low-stock alerts, quote expiry). Choosing `service` or `utility` for them changes what merchants are charged, so that needs an Owner decision.
