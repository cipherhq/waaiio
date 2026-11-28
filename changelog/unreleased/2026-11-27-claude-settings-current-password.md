## 2026-11-27 — Settings: confirm it's you before changing the password

- **What changed:**
  - Settings > Change Password now goes through a new `POST /api/account/password` route, which confirms it's really the account owner before setting the new password.
  - The owner confirms in one of two ways (Owner decision 2026-11-27):
    - **Current password:** checked with a throwaway sign-in (the same pattern as payout setup), so the user's own session is not rotated.
    - **WhatsApp code:** for accounts with a confirmed WhatsApp number, "Use a WhatsApp code instead" sends a code with the existing login code system. The route checks it against the account's own confirmed number, never a number sent by the browser. This is for people who sign in with a WhatsApp code, because that sign-in sets the account password to a random value.
  - Attempts are limited to 5 per user per 15 minutes.
  - A wrong password shows "Current password is incorrect." If Supabase can't check the password (for example it's busy), the message asks the user to try again instead of saying the password is wrong.
  - The 6-character minimum is unchanged.
- **Files:**
  - `app/api/account/password/route.ts` (new)
  - `app/dashboard/settings/tabs/AccountTab.tsx`
  - `lib/__tests__/account-password-route.test.ts` (new)
  - `app/dashboard/settings/tabs/__tests__/account-tab-password-change.test.tsx` (new)
- **What it affects:** Only the Settings password change. Sign-in, WhatsApp-code sign-in, forgot password, reset password and email change are unchanged.
- **What could break:** Each WhatsApp code sent is a paid message, the same as a login code. Supabase sign-in limits for the account also apply to the password check.
