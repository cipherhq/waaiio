## 2026-11-18 — SMS becomes a real channel for Nigeria and Ghana (#1131)

**What changed (Owner decisions 2026-11-18, all 9 recommendations in #1131 accepted)**

- **Merchant campaigns:** the broadcast page has an SMS channel for Nigeria and Ghana businesses.
  - Before sending, the merchant sees an estimate: pages, whether accents/Unicode apply, price per page and the total.
  - Each SMS is charged from messaging credit at the BulkSMS cost (VAT included, entered by an admin) plus 20%, rounded up, per page.
  - Sends go only to opted-in customers in the business's own country, and not between 20:00 and 08:00.
- **Admin broadcasts:** SMS is no longer "coming soon".
  - Waaiio pays, and no merchant credit is used.
  - Uses the same step-up, recipient checks and one-send-per-request record as WhatsApp (#1104).
- **Fallback SMS now charged:** the SMS sent when WhatsApp and email fail is now charged to the business (it used to be free, paid by Waaiio). This covers:
  - party invites and party reminders;
  - booking, reservation and event reminders;
  - subscription-setup reminders;
  - failed-charge notices.
  - When credit is short, the SMS is skipped.
- **Charge only on acceptance:** the credit is reserved before sending and charged only when BulkSMS accepts.
  - A refusal or an unknown outcome releases the reservation (the unknown outcome is flagged for reconciliation).
  - While the financial gate is off, merchant SMS is refused, never sent free.
- **BulkSMS client moved to API v2** (`lib/sms/bulksms-ng.ts`):
  - Unicode is used only when the text needs it;
  - it records the provider's real cost, page count and message id;
  - it supports the sandbox via `BULKSMS_NG_SANDBOX=true`.
- **New setting `BULKSMS_SENDER_ID`:** the sender name registered with BulkSMS. It has no default; while unset, SMS is off everywhere.
  - The value to configure is `WAAIIO`, but **only after BulkSMS approves it**: it was registered on 2026-11-18 and is still pending.
  - `TICKETRACK` is refused by the code and never carries Waaiio traffic.
  - If BulkSMS refuses a pending or unregistered name, the send fails: it is recorded and the credit is released, so nothing is charged.
- **Admin Countries editor:** new "SMS Cost / Page" column for NG and GH, which shows what the merchant pays.

**Files**

- `supabase/migrations/551_sms_channel.sql`
- `lib/sms/` (`segments.ts`, `pricing.ts`, `send.ts`, `campaign.ts`, `bulksms-ng.ts`)
- `lib/admin-broadcast/sms.ts`
- `app/api/admin/broadcasts/sms/route.ts`
- `app/api/broadcasts/sms-estimate/route.ts`
- `app/api/broadcasts/send/route.ts`
- `app/dashboard/broadcasts/page.tsx`
- `components/dashboard/SmsEstimate.tsx`
- `lib/channels/send-or-email.ts` and its callers
- `app/api/events/invite/route.ts`
- `lib/parties/reminder-delivery.ts` and `reminder-preview.ts`
- `lib/merchants/recipient-permission.ts` (accepts the `sms` channel)
- `admin/src/pages/Broadcasts.tsx`, `admin/src/components/SmsBroadcastForm.tsx`
- `admin/src/pages/Countries.tsx`

**What it affects**

- Merchant messaging credit, for SMS only. WhatsApp pricing is unchanged.
- Admin broadcasts.
- Every SMS fallback.

**What could break**

- No SMS is sent until all three are in place:
  1. M551 is applied;
  2. `sms_cost` is set per country;
  3. `BULKSMS_SENDER_ID` is set.
- If the app is deployed before M551, SMS attempts are refused: the `units` column is missing, so nothing is charged or sent.
- A Ghana business needs a GHS `sms_cost` entered by an admin.
- An SMS campaign accepts SMS or WhatsApp marketing consent (an interpretation flagged on the PR).
