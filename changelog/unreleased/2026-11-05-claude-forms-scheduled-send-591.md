## 2026-11-05 — Forms: schedule a send for later, and see past sends (#591, PR C)

**What changed**
- **Send now or later** (`components/dashboard/forms/FormSendPanel.tsx`). The merchant picks a time between 1 minute and 90 days ahead.
  - `/api/forms/send` with `scheduledAt` saves a `form_sends` row (M517). The row stores only the people who have opted in at that moment; everyone else is reported as skipped straight away.
  - Sending a template needs an approved template, checked when the send is scheduled.
- **New cron `/api/cron/scheduled-form-sends`** (every 15 minutes, `vercel.json`):
  - claims each due send with a status-guarded update that must return the row, so overlapping runs send it once;
  - checks consent and opt-outs **again for every recipient at send time**;
  - re-checks the template on the sending account;
  - a form that is switched off or removed means the send is cancelled, never sent;
  - a template-check outage puts the send back in the queue;
  - one 40-second budget per run; anyone not reached is reported as "not attempted";
  - final status is `sent` if at least one message was accepted, otherwise `failed`, with the reason.
- **Send history and cancel** (new `app/api/forms/sends/route.ts`):
  - owner only;
  - lists a form's last 20 sends, immediate ones included;
  - cancels a send that has not started (409 once it has).
- Immediate sends are now also saved to `form_sends`, so they appear in the history. This is best effort: the messages have already gone.

**What it affects:** the Forms page send panel, `/api/forms/send`, a new cron route, and a new `vercel.json` cron entry.

**What could break / dependency:**
- **Requires migration 517 in production first.** Without it, scheduling returns 500 and immediate sends work but have no history.
- A send can stay "sending" if the function is killed mid-run. Same known limitation as scheduled broadcasts.
