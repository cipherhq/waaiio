## 2026-11-10 — Low messaging-balance alerts for merchants (dashboard + email)

**Why:** TestBiz staging, 10 Nov 2026. A non-expiring NGN top-up (₦15,000) ran down to 900 minor units while each reply cost 1300 (₦13, config version 6205a7a2). Every later reply was refused with `insufficient_allowance_balance` and the merchant got no warning. The ledger, the price and the refusal were verified as correct; no merchant or admin low-balance alert existed (`checkSpendThresholds` covers the monthly spend cap only). Owner request: alerts at 200, 100 and 50 estimated messages plus a money threshold per country/currency, starting with ₦250 for Nigeria.

**What changed**
- `lib/messaging/low-balance-alerts.ts` (new): `checkLowBalanceAlerts(supabase, businessId)`.
  - Billing facts are read where billing reads them (`check_or_authorize_send` / `authorize_message_send`): the newest effective `platform_config_versions` snapshot. No alert while its `messaging_financial_gate` is not `true` (balances are not enforced then). Currency = the one currency whose `rates` name the business country (none or two: no alert, as billing refuses). Rate for a bot reply = `rates[country].service`, then `rates[country]['*']`, then `default_cost_minor`.
  - Balance = `remaining_minor` of the business's non-expired allowances in that currency (as authorization spends them). Allowances in other currencies are ignored.
  - Estimated messages = balance / that rate (marketing templates cost more, so it is an upper bound).
  - Levels: `platform_settings` key `messaging_low_balance_alerts` (`message_thresholds`, `money_thresholds_minor`). Code defaults `[200, 100, 50]` and `{ NGN: 25000 }` (₦250) apply while no row exists; malformed parts fall back to the default. No settings row is written by this change.
  - Only the most urgent level reached is raised; passed levels are not sent late.
  - Record: an `alerts` row, type `messaging_low_balance`, on the existing merchant dashboard alerts (bell, banner, alerts page). Severity `warning` at 200/100, `critical` at 50 and the money level.
  - Email to the owner (Resend via `sendEmail`, no immediate resend). The outcome is written on the alert as `provider_accepted` (with the provider id), `failed`, or `not_sent` (`no_owner_email` / `email_not_configured`). It is never recorded as delivered.
  - An email left `pending` (the function stopped before recording) or `failed` is sent again by a later check after 10 minutes, at most 3 attempts in all. The retry first claims the row (an update that applies only while `claimed_at` is unchanged), so two checks cannot both send it. `not_sent` is not retried.
  - Deduplication: the alert id is a fixed UUID derived from business, currency, newest allowance and level. The existing `alerts` primary key refuses a second copy (23505), also from two sends at once; only the inserting send emails.
  - Reset on top-up: every top-up or other credit grant creates a new allowance row (verified on staging), which gives new ids, so the levels alert again.
- `lib/bot/flows/executor.ts`: `sendMessages` runs the check after each batch of bot replies, next to the existing spend-cap check, also when a send was refused. Non-blocking: it never throws into the reply, never sends WhatsApp and never changes a balance. The check is not awaited (the reply is not delayed) but is registered with Next's `after()`, so it keeps running after the webhook responds; outside a request (crons, tests) `after()` throws and is ignored.

**Unchanged:** billing and authorization (`authorize_message_send`, allowances, ledger), prices, top-up packages, spend caps and their alerts. No migration, no data change.

**Tests:** `lib/__tests__/messaging-low-balance-alerts.test.ts` (levels incl. the TestBiz numbers, config override and fallback, dedupe, two sends at once, falling through every level, big drop, top-up reset, expired credit, healthy balance, no credit ever, every email outcome, unreadable settings, id format; gate off/absent, config snapshot over live settings, rate order, no/ambiguous currency, foreign-currency allowance; stuck pending email resent after 10 minutes, failed email at most 3 attempts, no retry of not_sent, two retries at once send once); `lib/__tests__/messaging-low-balance-executor-hook.test.ts` (real `FlowExecutor.sendMessages`: check runs after an accepted send and after a refused one; a failing check does not break the reply).

**Could break:**
- Each bot reply batch does one business read and one `messaging_allowances` read (config version and thresholds are cached for 60 s per instance); once a level is reached, one primary-key read of `alerts` per batch.
- When an allowance expires (e.g. an unused trial credit) the balance can drop to 0 and the owner is told to top up, although subscribing may be their next step. Any new allowance (including a small promotional or monthly included grant) re-arms the levels, so a still-low balance can alert again. Two checks that reach different levels at the same moment can both alert.
- Only bot replies trigger the check. Balance used by broadcasts, reminders or other senders is noticed on the next bot reply.
- The email ignores the merchant notification preferences (there is no low-balance toggle in Settings yet), like other billing notices.
- Merchants can update their own `alerts` rows (existing RLS), so the recorded email outcome is not tamper-proof; it is not a delivery or billing record.
