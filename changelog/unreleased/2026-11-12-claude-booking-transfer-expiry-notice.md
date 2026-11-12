## 2026-11-12 — A booking paid by card no longer gets "your booking has been cancelled"

**Why:** a staging trace on TestBiz (2026-11-12) found the gap.
- Every bot checkout offers "Pay online" and "Bank transfer", and saves a `pending_transfers` row with a 4-hour window.
- When an **order** is paid by card, that row is closed (`cancelled`, M393/M400).
- When a **booking** is paid by card (tickets use bookings too), nothing closed it.
- When the window ran out, the `expire-transfers` cron expired the row and messaged the customer: "Your bank transfer has expired… your booking has been cancelled". The WhatsApp message goes when a channel resolves, and the email always goes. The cron only cancels bookings still `pending`, so the paid booking itself stayed confirmed; only the message was wrong.
- TestBiz had five such open rows: WA-2243, WA-2753, WA-862E, WA-71A8 and WA-97EB.

**What changed**
- **`app/api/cron/expire-transfers/route.ts`:** for a booking-linked transfer, the cron now reads back which booking rows its `pending → cancelled` update changed (`.select('id')`). It sends the expiry and cancellation notice only when it really cancelled the booking. If the booking was no longer pending (already paid, confirmed or cancelled), or the cancel errored, the transfer is still marked expired and counted, and no notice is sent. Order-linked transfers and transfers with no booking (invoice, reservation, campaign) are unchanged.
- **`lib/payments/process-success.ts`:** once a booking payment passes the paid-state postcondition, any `pending` `pending_transfers` rows for that booking are set to `cancelled`, as orders already do. This step is non-critical: an error is logged as a warning and does not fail finalization.
- **`lib/__tests__/booking-transfer-expiry-notice.test.ts` (new):**
  - Checks the exact transfer close (`update {status:'cancelled'}`, `eq booking_id`, `eq status 'pending'`), and that a close error leaves the result unchanged.
  - Checks there is no notice when the booking is no longer pending.
  - Checks the notice is still sent when the cron really cancels an unpaid booking.
  - On the old code, the first and third checks fail.

**Unchanged:** money, fees, custody routes, merchant transfer approval, order transfers and the bot's checkout messages. Merchant approval of a transfer already requires the booking to be `pending` (`confirm_nonorder_transfer_atomic`), so it could not double-record a card-paid booking before this change either.

**What could break:**
- A customer who pays by card and also sends a bank transfer will have that transfer row closed. The merchant then handles it as an overpayment, the same as orders today.
- Existing leftover rows are not cleaned up by this change. They expire silently the next time the cron runs.
