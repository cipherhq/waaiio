## 2026-11-06 — Broadcasts: say why people were skipped, and "could not be confirmed" when the list is capped (#948 follow-up)

**Problem:** two copy gaps the #948 reviewers raised (P2s, Owner approved a follow-up).
1. Keyword-campaign respondents who had not opted in were dropped silently: the banner read "Sending to {kept} respondents", or "Sending to 0 respondents", with no reason.
2. The opted-in list is capped at 500 people and at a 5,000-row consent scan. Hitting the scan cap left `truncated` false, and with a capped list the page still called unmatched imported numbers "not opted in" although they might have opted in.

**What changed**
- `lib/forms/opted-in-contacts.ts`: `listOptedInContacts` sets `truncated: true` when the consent scan stops at `MAX_CONSENT_ROWS` with rows possibly unread (a full last page), as well as when more than 500 people are eligible. `MAX_CONSENT_ROWS` is exported for tests. Who is listed is unchanged.
- `app/dashboard/broadcasts/page.tsx`: the campaign banner adds "Skipped N respondents who have not opted in." (respondents counted once per number). When the opted-in list is truncated, unmatched campaign respondents and pasted/CSV numbers read "N … could not be confirmed as opted in (your list is too long to check them all here)." instead of "not opted in". When not truncated the "not opted in" wording is kept. The "Showing the first N people who opted in." note is unchanged and now also shows at the scan cap.
- `components/dashboard/forms/FormSendPanel.tsx`: the capped-list label says "showing the first {count}" instead of a fixed "500", since the scan cap can cap the list below 500.
- `/api/broadcasts/recipients` and `/api/forms/recipients` already pass `truncated` through unchanged; tests now prove it at the scan cap.

**Unchanged:** send, schedule and cron routes; `hasRecipientPermission`; consent rules; who is included in any audience; the Forms picker's behaviour.

**Tests:** `lib/__tests__/opted-in-contacts-scan-cap.test.ts` (new), plus additions to `lib/__tests__/broadcasts-recipients-591b.test.ts`, `lib/__tests__/forms-send-591.test.ts`, `lib/__tests__/forms-send-ui-591.test.tsx`, `app/dashboard/broadcasts/__tests__/broadcasts-page.test.tsx`.

**Could break:** nothing functional. A business with exactly 5,000 consent rows will see the "capped" wording although nothing was missed (the scan cannot tell without another read).
