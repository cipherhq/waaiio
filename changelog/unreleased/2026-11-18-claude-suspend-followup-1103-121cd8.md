## 2026-11-18 — Suspended customers also get no reminders, Edge campaigns, automation messages or after-payment offers (#1103 follow-up)

- **Owner decision 2026-11-17 (#1103):** a suspended customer's number is blocked from ALL Waaiio bots, and money is untouched. PR #1112 shipped the inbound block and merchant marketing. This PR closes the paths it left open. No new table or migration: every check reads `public.customer_suspensions` (M547) with the service role, and RLS stays deny-all.
- **Reminders skip the number and fail closed** (`blocksReminder`, `lib/customer-suspension.ts`). The whole reminder is skipped, on WhatsApp, email and SMS, as #1112 did for marketing email. A skipped reminder is not marked sent, so it goes out if the number is unsuspended in time.
  - `app/api/cron/reminders/route.ts`: booking, reservation check-in and event reminders.
  - `app/api/cron/balance-reminder/route.ts`: balance-due payment reminders (checked before a payment link is created).
  - `app/api/cron/subscription-reminders/route.ts`: pending Stripe recurring-setup reminder and expiry notice. The stale setup still expires.
  - `lib/intake/send.ts` `sendIntakeReminder`: intake form reminder (new skip reason `suspended`).
  - `lib/parties/reminder-preview.ts`: party chase and follow-up reminders, every channel. The preview shows "consent unavailable", never the suspension.
- **Supabase Edge Functions skip the number and fail closed** (`supabase/functions/_shared/customer-suspension.ts`, the Deno copy of the same rule):
  - campaigns: `birthday-campaign`, `customer-reengagement`, `abandoned-cart-reminder`, `process-sequences`. A suspended customer's sequence step is held an hour at a time, so those rows cannot fill every 50-row batch.
  - reminders: `booking-reminders` (booking, check-in, check-out and post-visit), `recurring-reminder` (due, failed-payment and auto-cancel messages), `contract-reminders`, `noshow-reschedule`.
  - In `recurring-reminder` the money state still moves as before: the due date advances and a third failure still auto-cancels. Only the messages are skipped.
- **Automation rule messages** (`lib/bot/automation/rules-engine.ts`, `sealed-rule-actions.ts`): `send_message` and `send_template` to a suspended customer are refused (fail closed), with the same rule as reminders, so a number stored in local format is not refused. After a payment, the sealed action is settled `failed` before the sending fence, so it is never recorded as possibly sent. `notify_owner` still reaches the business.
- **After-payment follow-up** (`lib/payments/transaction-followup.ts`, `lib/bot/transaction-followups.ts`): a suspended customer gets no saved-card offer, recurring offer, updates opt-in or next-steps menu. The follow-up is retired (`done`). If the status read fails, nothing is sent and the recovery cron retries later.
- **Money paths are untouched.** The payment confirmation, tickets and receipt still go to a suspended customer who paid. A new test proves it.
- **Unrelated pre-existing fix, needed to run these functions:** four Edge Functions did not parse. Their header comment held a cron string with a star-slash (`*/30`, `*/5`), which ended the comment early (`deno check`: "SyntaxError: Expression expected"). The comment now gives the same schedule as `0,30 * * * *` or `0-59/5 * * * *`. Code is unchanged.
- **Tests:**
  - New `lib/__tests__/customer-suspension-reminders-1103.test.ts`: the real reminder and balance crons, the rules engine (live and sealed) and the after-payment follow-up, over an in-memory database.
  - New `lib/__tests__/customer-suspension-edge-1103.test.ts`: runs each real Edge Function handler under Node with a stubbed Deno and Meta API.
  - Added cases to `intake-send-963`, `party-reminders-preview-490` and `post-payment-message-order-1070` (confirmation, ticket and receipt still sent).
  - Test DB mocks gained an empty `customer_suspensions` table in `rules-engine-actions`, `sealed-rule-actions` and `report-failure-wiring`.
- **Could break:**
  - If the suspension status cannot be read, these reminders, campaigns and automation messages are skipped for that run. Before M547 is applied, that means every one of them.
  - A number stored without its country code (for example `080…`) is not matched to a suspension, so its email or SMS reminder still goes out.
  - Not covered here (follow-ups):
    - the waitlist-expiry notice and the quote-expiry notice;
    - the chat-timeout closing message;
    - the post-payment loyalty points text;
    - the first after-booking intake link;
    - the merchant-sent sign link;
    - the email-only overdue-invoice reminder;
    - form invites sent inside an open 24-hour window (from #1112).

    Merchant-facing messages are out of scope.
  - **Release order:** M547 must be applied before this app code and before these Edge Functions are deployed. Otherwise every gate fails closed for everyone, and sealed after-payment rule messages are settled `failed` for good.
