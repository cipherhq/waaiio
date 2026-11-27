## 2026-11-27 — Settings: confirm current password before changing it

- **What changed:** Settings > Change Password now sends the current and new password to a new `POST /api/account/password` route. The route confirms the current password with a throwaway sign-in (the same pattern as payout setup, so the user's own session is not rotated), then sets the new password on the signed-in session. Attempts are limited to 5 per user per 15 minutes. A wrong current password shows "Current password is incorrect." The 6-character minimum is unchanged. Accounts with only a phone confirm with the phone.
- **Files:** `app/api/account/password/route.ts` (new), `app/dashboard/settings/tabs/AccountTab.tsx`, `lib/__tests__/account-password-route.test.ts` (new), `app/dashboard/settings/tabs/__tests__/account-tab-password-change.test.tsx` (new).
- **What it affects:** Only the Settings password change. Sign-in, forgot password, reset password and email change are unchanged.
- **What could break:** Supabase sign-in limits for the account also apply to the confirmation step. A merchant who forgot their current password uses "Forgot password" instead.
