## 2026-11-06 — Polls and surveys follow broadcast recipient rules

- **What changed (Owner decision 2026-11-06):**
  - Sending a poll or survey now skips anyone without granted `marketing` permission for the business, and anyone who opted out. This is the same check (`hasRecipientPermission`, purpose `marketing`) that broadcasts use. The check runs before a bot session is created or a message is sent.
  - Each send is capped at 500 recipients, the same limit as `app/api/broadcasts/send`. A larger request is refused with 400 "Too many recipients. Maximum 500 per request." Nothing is sent.
  - Both responses gain `skipped_no_permission`. The existing `sent`, `failed` and `total` fields are unchanged; `total` is still the number of phones requested.
- **Files:**
  - `app/api/polls/[id]/send/route.ts`
  - `app/api/surveys/[id]/send/route.ts`
  - `app/api/polls/__tests__/polls-api.test.ts` (adds the new response field; permission is stubbed as granted for the existing delivery-outcome tests)
  - `lib/__tests__/poll-survey-recipient-rules.test.ts` (new)
- **Unchanged:** sign-in, ownership and capability checks, rate limits, the conversation limit, the active-status check, and the message content.
- **Could break:**
  - Merchants reach fewer people than before (accepted by the Owner). People without a recorded `marketing` consent no longer receive polls or surveys.
  - The dashboard poll and survey pages still show only "sent to N contacts". They do not yet show the skipped count or the over-limit error, because they ignore non-OK responses.
