## 2026-11-10 — Low messaging-balance alerts for merchants (dashboard + email)

**Why:** TestBiz staging, 10 Nov 2026. A non-expiring NGN top-up (₦15,000) ran down to 900 minor units while each reply cost 1300 (₦13, config version 6205a7a2). Every later reply was refused with `insufficient_allowance_balance` and the merchant got no warning. The ledger, the price and the refusal were verified as correct; no merchant or admin low-balance alert existed (`checkSpendThresholds` covers the monthly spend cap only). Owner request: alerts at 200, 100 and 50 estimated messages plus a money threshold per country/currency, starting with ₦250 for Nigeria.

**What changed**
- `lib/messaging/low-balance-alerts.ts` (new): `checkLowBalanceAlerts(supabase, businessId)`.
  - Balance per currency = `remaining_minor` of the business's non-expired `messaging_allowances` (as the billing page counts it).
  - Estimated messages = balance / `messaging_pricing[currency].default_cost_minor` (the service-message rate; marketing templates cost more, so it is an upper bound).
  - Levels: `platform_settings` key `messaging_low_balance_alerts` (`message_thresholds`, `money_thresholds_minor`). Code defaults `[200, 100, 50]` and `{ NGN: 25000 }` (₦250) apply while no row exists; malformed parts fall back to the default. No settings row is written by this change.
  - Only the most urgent level reached is raised; passed levels are not sent late.
  - Record: an `alerts` row, type `messaging_low_balance`, on the existing merchant dashboard alerts (bell, banner, alerts page). Severity `warning` at 200/100, `critical` at 50 and the money level.
  - Email to the owner (Resend via `sendEmail`, no retries). The outcome is written on the alert as `provider_accepted` (with the provider id), `failed`, or `not_sent` (`no_owner_email` / `email_not_configured`). It is never recorded as delivered.
  - Deduplication: the alert id is a fixed UUID derived from business, currency, newest allowance and level. The existing `alerts` primary key refuses a second copy (23505), also from two sends at once; only the inserting send emails.
  - Reset on top-up: every top-up or other credit grant creates a new allowance row (verified on staging), which gives new ids, so the levels alert again.
- `lib/bot/flows/executor.ts`: `sendMessages` runs the check after each batch of bot replies, next to the existing spend-cap check, also when a send was refused. Non-blocking: it never throws into the reply, never sends WhatsApp and never changes a balance.

**Unchanged:** billing and authorization (`authorize_message_send`, allowances, ledger), prices, top-up packages, spend caps and their alerts. No migration, no data change.

**Tests:** `lib/__tests__/messaging-low-balance-alerts.test.ts` (levels incl. the TestBiz numbers, config override and fallback, dedupe, two sends at once, falling through every level, big drop, top-up reset, expired credit, healthy balance, no credit ever, every email outcome, unreadable settings, id format); `lib/__tests__/messaging-low-balance-executor-hook.test.ts` (real `FlowExecutor.sendMessages`: check runs after an accepted send and after a refused one; a failing check does not break the reply).

**Could break:**
- Each bot reply batch does one more read of `messaging_allowances` (settings are cached for 60 s); once a level is reached, one primary-key read of `alerts` per batch.
- Only bot replies trigger the check. Balance used by broadcasts, reminders or other senders is noticed on the next bot reply.
- The email ignores the merchant notification preferences (there is no low-balance toggle in Settings yet), like other billing notices.
- Merchants can update their own `alerts` rows (existing RLS), so the recorded email outcome is not tamper-proof; it is not a delivery or billing record.
