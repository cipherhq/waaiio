## 2026-11-05 — Bot: property stays are re-checked right before they are created (#922)

- **What changed:** in `lib/bot/flows/reservation.flow.ts`, step `create_reservation`, one availability check now looks at:
  - every stay that is not `cancelled`, `no_show`, `checked_out` or `completed` (including legacy rows that only carry `service_id`);
  - the merchant's blocked dates, over every night of the stay;
  - but not a stay that this same bot session already created.
- **When it runs:** before the terms, as before. It also runs again right before the stay is created. The old code skipped the check when the step re-ran after the terms, so nights booked or blocked meanwhile were missed.
- **When the nights are taken:** whether the re-check finds it, the database refuses the insert with `23P01` (M522), or the insert loses a simultaneous race as a deadlock (`40P01`) and a re-read shows the nights are now held, the customer gets the existing "Sorry, this property is not available for the selected dates" message with **Choose New Dates** / **Cancel**. No payment link is sent. The dates and terms flags are cleared, so the second pass runs like the first.
- **After "not available":** any reply other than the two buttons gets "Please tap *Choose New Dates* or *Cancel*." and the buttons again, so the session never ends without a stay.
- **Other cases:** if the re-check cannot read availability, the customer gets the existing "Something went wrong" message and nothing is created. Other insert errors and the same-session reuse work as before.
- **Files:** `lib/bot/flows/reservation.flow.ts`, `lib/bot/flows/__tests__/reservation-stay-claim.test.ts`.
- **Unchanged:** the date lists, terms wording, pricing, deposits, payments (both custody routes), saved cards, bank transfer, and the retry path that reuses an existing stay.
- **Could break:** the check now also refuses nights held by any unfinished stay (including `checked_in`, `in_progress` and `seated`) or blocked by the merchant over any night of the stay. The date lists hide only `pending`/`confirmed`/`checked_in` stays and blocked dates, so a customer can still pick such nights and then gets "not available" with **Choose New Dates**.
