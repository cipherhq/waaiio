## 2026-11-07 — Schedule the trial-credit activation job (before message charging is switched on)

**Why:** the Owner chose to make message charging safe before switching it on ("Make it safe first", 2026-11-07).
- Trial message credit is granted by `activate_trial_if_eligible`, which is called once when a business goes live (`app/api/onboarding/verify`, `app/api/whatsapp/embedded-signup`).
- While `messaging_financial_gate` is off, it answers `financial_gate_off` and grants nothing.
- The only retry is `/api/cron/trial-activation`, and it was never in `vercel.json`. It was not in the database scheduler either (`cron.job` holds only chat-timeout and session-cleanup).
- So with charging switched on, businesses that went live earlier would never get trial credit, and their messages would be blocked (`insufficient_allowance_balance`).

**What changed**
- `vercel.json`: `/api/cron/trial-activation` runs hourly at :30.
- `app/api/cron/trial-activation/route.ts`: the "Trial activation pending" alert is now a plain insert. A duplicate (23505 from the partial unique index `uq_trial_pending_alert`, M372) counts as already alerted; other errors are logged.
  - Before, it used an upsert with `onConflict: 'business_id,type'`. PostgREST sends that as `ON CONFLICT (business_id, type)` without the index's `WHERE type = 'trial_config_missing'`, and Postgres refuses it with 42P10. The result was ignored, so no alert was ever written (review finding on #954).
- `lib/__tests__/trial-activation-cron-schedule.test.ts` (new) checks:
  - the schedule entry;
  - that the route refuses a request without the cron secret;
  - that it activates an eligible business;
  - that while charging is off it grants nothing and inserts one alert;
  - that a duplicate alert (23505) is treated as already alerted.
- `lib/__tests__/trial-lifecycle-db.test.ts` (real PostgreSQL, CI step "Migration 372 trial lifecycle tests"), new test 17b: a plain duplicate insert is refused with 23505, and `ON CONFLICT (business_id, type)` without `WHERE` fails with 42P10.

**Unchanged:** the route's activation and reconciliation logic, `activate_trial_if_eligible`, trial amounts, the one-trial-per-owner and per-phone rules, and every other cron.

**Effect while charging is off:**
- Each run finds free businesses without a trial. They get `financial_gate_off` and at most one `trial_config_missing` alert per business. The go-live callers write no alert.
- A business whose owner already has a trial is marked ineligible and leaves the queue.

**Known limits (Owner decisions, unchanged here):**
- The one-trial-per-owner check counts only current (v2) trial grants, not older clock-only trials. A second business of an owner whose earlier trial was clock-only can still get a trial once its owner's phone is verified.
- Legacy reconciliation (Phase 2) does not re-check status or owner. It matches 0 rows on production today.

**Could break:** one more cron run an hour; nothing else. The route fails closed without `CRON_SECRET`, and production answers 401, so the secret is set.
