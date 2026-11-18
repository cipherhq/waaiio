## 2026-11-18 — Monthly platform-fee invoice job switched off

- **Owner decisions (2026-11-18):** switch the monthly fee invoice off. The fee on direct bank transfer and cash stays ₦0 ("Not now").
- **Why:** `app/api/cron/platform-fee-invoices` selected `is_direct_transfer` fees. Code sets that flag for `byo`/`connect` routing, whose Waaiio fee a split already collected, so the job would have billed merchants a second time. Real bank transfers record a ₦0 fee. The job also never succeeded: its end-date filter (`periodEnd.toISOString() + 'T23:59:59.999Z'`) is not a valid timestamp. Staging has 0 invoices.
- **Change:**
  - `vercel.json` no longer schedules the job (previously `17 9 1 * *`).
  - The route code stays, with a comment pointing to the decision.
  - `docs/MERCHANT_PAYMENT_CUSTODY_POLICY.md` "Known limits" records both decisions.
  - `lib/__tests__/fee-invoice-cron-off.test.ts` fails if the job (or the unscheduled `platform-fee-overdue` reminder) is put back on the schedule.
- **Unchanged:** fee recording, payouts, refunds, the invoice tables, admin and merchant invoice pages (their 100x display units are deferred by the Owner), all other crons.
- **Could break:** nothing runs on the 1st of the month any more for fee invoices. If the Owner later wants invoices, the job needs the date fix, the units fix and a routing filter first.
