## 2026-11-17 — Expired card-PIN chats no longer hold the next-steps menu (#1101)

- `lib/payments/abandoned-card-step.ts`: new `isUnexpiredSession()`; `hasActiveCardPin()` counts only PIN sessions that have not expired (a missing expiry still counts).
- `lib/payments/transaction-followup.ts`: the card-step PIN check in `resumePaidTransactionFollowup()` uses the same rule.
- Affects the paid follow-up chain (card step → opt-in → next-steps menu). Found on staging: a saved-card order got its receipt but no menu because an 18-hour-old, expired save-card PIN chat at another business was still marked active.
- Tests: `lib/__tests__/abandoned-card-step-1070.test.ts`, `lib/payments/__tests__/transaction-followup.test.ts` (expired vs unexpired PIN, staging reproduction).
- Could break: nothing expected. An unexpired PIN still holds the chain; lookup errors and missing expiry still hold.
