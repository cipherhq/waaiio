## 2026-11-18 — Admin Subscriptions: switch off Extend Trial and Cancel until they reach the gateway

- **What changed:** On the admin Subscriptions page, Extend Trial and Cancel Subscription are now disabled. They show the same honest note as Recurring Payments (#1111). Their handlers also return early. Owner decision 2026-11-18.
- **Why:** Extend Trial wrote `subscriptions.trial_ends_at` and status `trial`, which do not exist (the trial is `businesses.feature_trial_ends_at`, M525), so it always failed. Cancel marked the row cancelled in Waaiio but never told Paystack/Stripe, so the merchant could keep being billed.
- **Files:** `admin/src/pages/Subscriptions.tsx`, `admin/src/__tests__/admin-remaining-1108.test.tsx`.
- **Affects:** admin Subscriptions detail panel only. Change Tier is unchanged. No API, DB, migration or gateway change.
- **What could break:** nothing that works today. The server routes that make these actions work come in a follow-up PR.
