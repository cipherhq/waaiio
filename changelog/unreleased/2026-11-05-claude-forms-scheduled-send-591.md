## 2026-11-05 — Forms: schedule a send for later, and see past sends (#591, PR C)

**What changed**
- **Send now or later** (`components/dashboard/forms/FormSendPanel.tsx`). The merchant picks a time between 1 minute and 90 days ahead.
  - `/api/forms/send` with `scheduledAt` saves a `form_sends` row (M517). The row stores only the people who have opted in at that moment; everyone else is reported as skipped straight away.
  - Sending a template needs an approved template, checked when the send is scheduled.
- **New cron `/api/cron/scheduled-form-sends`** (every 5 minutes, `vercel.json`):
  - takes turns fairly: it reads up to 200 due sends and goes round-robin between businesses (every business's next send before any business's second), runs at most one send per business per run, least recently tried first, and up to 10 sends per run while time remains;
  - claims each send with a status-guarded update that must return the row, so overlapping runs send it once;
  - checks consent and opt-outs **again for every recipient at send time**;
  - a form that was switched off or removed means the send is cancelled, never sent;
  - if the chosen template is no longer approved, nothing is sent (same as an immediate send);
  - a template-check outage puts the send back in the queue, for up to 2 hours, then it fails with a clear message;
  - one 40-second budget per run, and no new send starts with less than 20 seconds left; people not reached in time go back in the queue (never dropped), with results so far kept;
  - a send left "sending" by a killed run is marked "Interrupted… check before sending again" after 10 minutes, and is never re-sent;
  - a send that never gets going (out of time on every run) is closed after 2 hours with "Nothing was sent because…";
  - a send that stops early after earlier runs already reached some people says so ("Sent to N; the other M were not sent because…"), never "nothing was sent";
  - final status is `sent` if at least one message was accepted, otherwise `failed`, with the reason ("Nobody was eligible…" or "No messages were accepted").
- **Send history and cancel** (new `app/api/forms/sends/route.ts`):
  - owner only; ids must be UUIDs;
  - lists a form's last 20 sends, immediate ones included; the panel shows who wasn't sent and why;
  - cancels a send that has not started (409 once it has).
- **Interim cap:** at most 20 sends waiting per business (Owner decision pending on limits).
- Immediate sends are now also saved to `form_sends`, so they appear in the history. This is best effort: the messages have already gone.

**What it affects:** the Forms page send panel, `/api/forms/send`, a new cron route, and a new `vercel.json` cron entry.

**What could break / dependency:**
- **Requires migration 517 in production first.** Without it, scheduling returns 500 and immediate sends work but have no history.
