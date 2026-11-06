## 2026-11-06 — Platform fee bank account: own screen with authenticator code

- **Owner decision 2026-11-06 ("extra code required"):** the platform fee bank account (`platform_settings.platform_bank_ng`) is changed only from its own screen, after the admin enters their authenticator code.
- **What changed:**
  - **New route `app/api/admin/platform-settings/fee-bank` (GET/PUT, full admin only):**
    - PUT validates the bank code (3 to 6 digits), account number (10 digits) and account name.
    - It then consumes a step-up bound to `provider_config`, target `platform_bank_ng`, and this exact value, upserts the setting, and writes an audit entry with a masked account number.
    - GET returns the current value with the account number masked.
  - **`app/api/admin/platform-settings/route.ts` (general editor, PUT/POST/DELETE):** refuses any `platform_bank_*` key (case-insensitive, trimmed) with 403 `fee_bank_protected`.
  - **New `lib/fee-bank-setting.ts`:** key, validation and masking.
  - **New `admin/src/components/FeeBankCard.tsx`:** card on the Platform Settings page that saves through the existing step-up dialog.
  - **Tests:** `lib/__tests__/fee-bank-step-up.test.ts`.
- **Unchanged:**
  - how `app/api/settings/payment-credentials` reads the setting;
  - every other platform setting;
  - commercial and messaging settings (already step-up protected);
  - the step-up tables and actions (no migration; reuses `provider_config`).
- **Could break:**
  - admins can no longer edit `platform_bank_*` keys in the general editor;
  - the new card accepts 10-digit (NUBAN) account numbers only.
