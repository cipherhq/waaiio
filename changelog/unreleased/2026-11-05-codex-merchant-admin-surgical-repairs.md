## 2026-11-05 — Merchant and admin read/display repairs

**Flow Analytics (merchant dashboard)**
- `app/dashboard/analytics/dropoffs/page.tsx`: select `step_id`, the column `flow_dropoffs` actually has (migration 225). The page asked for `step_name`, which does not exist, so the query failed and the page showed zero drop-offs. A failed load now shows an error instead of false zero summaries. Business scope, 30-day range and 500-row limit are unchanged.
- `lib/__tests__/flow-dropoffs-page.test.tsx`: populated, empty and error results, and the tenant query scope.

**Pending bank transfers (admin) — money display**
- `admin/src/pages/PendingTransfers.tsx`: `expected_amount` is stored in minor units (kobo/cents; written as `Math.round(amount * 100)` by `lib/bot/flows/shared/bank-transfer.ts`). The admin summary, list and detail now divide by 100, as the merchant view and the server confirmation messages already do. Display only: the confirm/reject writes, the payment and fee rows they insert, and the raw CSV export are unchanged.
- `admin/src/__tests__/pending-transfers-display.test.tsx`: NGN and fractional USD amounts in summary, list and detail, with no database writes.

**Calendar dates (admin)**
- `admin/src/lib/formatters.ts`: new SQL `DATE` formatter that keeps the stored calendar day in every viewer timezone and rejects invalid or date-time input. Existing timestamp formatters are unchanged.
- `admin/src/pages/Events.tsx`, `admin/src/pages/ClassSessions.tsx`: use it for five calendar-date displays only.
- `admin/src/__tests__/calendar-date.test.ts`.

**Bot session history (admin)**
- `admin/src/pages/ChatHistory.tsx`: read the existing `session_data`, derive the flow label with the established active-capability/category fallback, and show a load error instead of claiming zero sessions.
- `admin/src/__tests__/chat-history-bot-read.test.tsx`.

**AI Intent Review (admin)**
- `admin/src/pages/AIMarketplace.tsx`: show the existing record ID in place of an unsupported input-hash column. No raw message text is shown.
- `admin/src/__tests__/ai-review-record-id.test.tsx`.

The Messaging Credits fix that was in this PR is already on main (#831) and has been dropped here.

- **Affects**: read and display paths on the pages above. No schema, write, authorization or payment-logic changes.
- **Could break**: drop-off step labels; admin transfer amounts (they show 100x smaller than before, which is the correct value); admin event/class date text; bot history labels and error display; intent review record column.
