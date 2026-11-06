## 2026-11-06 — Admin Countries page shows Messaging Financial Controls again

- **What changed:**
  - The "Messaging Financial Controls" section (trial credit, spend cap, Growth/Business included credit, message rates) is on the admin Countries page again. A 2026-09-12 fix (6d1221bd) restored the component's code but not the line that renders it, so admins could not see or change these amounts.
  - Each smallest-unit box (cents, kobo, pence) shows the normal amount under it, e.g. `600000` NGN shows "= ₦6,000.00". Display only; the saved value and format are unchanged.
  - Save is only possible after the current config loaded successfully for the current country list. A failed, empty or out-of-order load now shows "Could not load the current messaging configuration. Reload the page before editing." and keeps Save disabled. The save replaces the whole messaging maps, so a blank form must never be saveable (review finding, both reviewers).
  - Save is refused if it would drop a currency that is configured today (for example a cleared Spend Cap), with "<CUR>: Spend Cap is required…", before any MFA request.
  - New "All Other Messages Rate" column edits the `*` rate (used for every message without its own category rate, including bot replies). It was already loaded and saved, but had no box.
- **Files:**
  - `admin/src/pages/Countries.tsx`
  - `admin/src/__tests__/countries-messaging-controls.test.tsx` (new)
- **Unchanged:**
  - Save path: same `/api/admin/countries/messaging-config` route, MFA step-up binding, config-version check and server validation. No migration.
  - Active markets still need Utility and Marketing rates before saving (existing rule).
  - Paystack plan codes stay owned by Provider Configuration (sent as null, read-only here).
- **Could break / watch:**
  - Saving now possible from admin changes live trial credit and message prices for every business using that currency. Production rates today have only the `*` rate, so the first save needs Utility and Marketing rates typed in.
