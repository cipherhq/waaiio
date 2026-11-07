## 2026-11-07 — Schedule the trial-credit activation job (before message charging is switched on)

**Why:** the Owner chose to make message charging safe before switching it on ("Make it safe first", 2026-11-07).
- Trial message credit is granted by `activate_trial_if_eligible`, which is called once when a business goes live (`app/api/onboarding/verify`, `app/api/whatsapp/embedded-signup`).
- While `messaging_financial_gate` is off, it answers `financial_gate_off` and grants nothing.
- The only retry is `/api/cron/trial-activation`, and it was never in `vercel.json`. It was not in the database scheduler either (`cron.job` holds only chat-timeout and session-cleanup).
- So with charging switched on, businesses that went live earlier would never get trial credit, and their messages would be blocked (`insufficient_allowance_balance`).

**What changed**
- `vercel.json`: `/api/cron/trial-activation` runs hourly at :30.
- `lib/__tests__/trial-activation-cron-schedule.test.ts` (new) checks:
  - the schedule entry;
  - that the route refuses a request without the cron secret;
  - that it activates an eligible business;
  - that while charging is off it grants nothing and raises one deduplicated alert.

**Unchanged:** the route's code, `activate_trial_if_eligible`, trial amounts, the one-trial-per-owner and per-phone rules, and every other cron.

**Effect while charging is off:**
- Each run finds free businesses without a trial. They get `financial_gate_off` and one deduplicated `trial_config_missing` alert per business, the same as the existing call at go-live.
- A business whose owner already has a trial is marked ineligible and leaves the queue.

**Could break:** one more cron run an hour; nothing else. The route fails closed without `CRON_SECRET`, and production answers 401, so the secret is set.
