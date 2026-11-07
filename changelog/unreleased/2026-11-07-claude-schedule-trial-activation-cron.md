## 2026-11-07 — Schedule the trial-credit activation job (before message charging is switched on)

**Why:** the Owner chose to make message charging safe before switching it on ("Make it safe first", 2026-11-07).
- Trial message credit is granted by `activate_trial_if_eligible`. It is called when a business goes live (`app/api/onboarding/verify`, `app/api/whatsapp/embedded-signup`) and when an owner verifies a phone on `/dashboard/claim-credit` (#955).
- While `messaging_financial_gate` is off, it answers `financial_gate_off` and grants nothing.
- The only retry is `/api/cron/trial-activation`, and it was never in `vercel.json`. It was not in the database scheduler either (`cron.job` holds only chat-timeout and session-cleanup).
- So with charging switched on, businesses that went live or verified a phone earlier would never get their trial credit, and their messages would be blocked (`insufficient_allowance_balance`). The claim page's "added automatically when message billing starts" depends on this job.

**What changed**
- `vercel.json`: `/api/cron/trial-activation` runs hourly at :30.
- `lib/__tests__/trial-activation-cron-schedule.test.ts` (new) checks:
  - the schedule entry;
  - that the route refuses a request without the cron secret;
  - that it activates an eligible business;
  - that while charging is off it grants nothing.

**Unchanged:** the route code, `activate_trial_if_eligible`, trial amounts, the one-trial-per-owner and per-phone rules, and every other cron.

**Effect while charging is off:**
- Each run finds free, active businesses without a trial. They get `financial_gate_off` (or `phone_not_verified`), and nothing is granted.
- A business whose owner already has a trial is marked ineligible and leaves the queue.

**Known limits (follow-ups):**
- **The "Trial activation pending" alert is never written.** The route writes it with an upsert on `business_id,type`, but the matching unique index (`uq_trial_pending_alert`, M372) is partial, so Postgres refuses the upsert (42P10). The route ignores that result. The fix is a plain insert that treats a duplicate as already alerted. It was left out of this PR because writing the alert would show a new banner to merchants, and who sees it and its wording are an Owner decision.
- **The job takes the oldest 100 waiting businesses each run.** Sign-ups that never verify a phone are never marked done, so once there are more than 100 of them, owners who did verify could stop being reached. This needs fixing before many sign-ups arrive with charging on.
- **The one-trial-per-owner check counts only current (v2) trial grants, not older clock-only trials.** A second business of an owner whose earlier trial was clock-only can still get a trial once its owner's phone is verified.
- **Legacy reconciliation (Phase 2) does not re-check status, owner or phone.**
  - It matches 0 rows on production today.
  - Since #955, WhatsApp Flow sign-ups no longer get a hand-set trial clock, so new sign-ups no longer enter it.

**Could break:** one more cron run an hour; nothing else. The route fails closed without `CRON_SECRET`, and production answers 401, so the secret is set.
