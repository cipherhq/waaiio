## 2026-11-27 — Stronger sign-in protection, slice 2: stronger new passwords (#1175)

**What changed:**
- New merchant passwords need at least 8 characters (was 6). Each page states the rule before the merchant types: "Use at least 8 characters." (W3).
- When Supabase refuses a password that appears on breach lists, the page shows W4 in plain words instead of the raw error.
- The rule and its wording live in one file, `lib/password-policy.ts`, used by every place a merchant sets a password:
  - sign-up;
  - staging sign-up;
  - set new password;
  - account activation;
  - Settings > change password, both the form and `/api/account/password` (on top of #1176);
  - WhatsApp onboarding.
- **WhatsApp onboarding (Q13 A):**
  - The Flow's owner-details "Next" now asks Waaiio to check the length, and stays on that screen with W3 if the password is too short. The Flow now also declares `data_api_version` and `routing_model`, which endpoint Flows need.
  - At the end, a new account whose password is refused gets a WhatsApp message (W3, or W4 for a breach-list refusal) with a link to finish at waaiio.com/get-started. No account is created.
  - An existing auth account keeps today's path. Whether an account exists is decided by the auth record, not the profile row. A breach-list refusal never attaches the business to an existing profile.
- The sign-up and Settings password error boxes are now announced to screen readers (`role="alert"`).
- Existing passwords are untouched (F7): sign-in, WhatsApp-code sign-in, and the existing-account check on sign-up all still accept older, shorter passwords.

**Files:**
- New: `lib/password-policy.ts`.
- Pages: `app/(auth)/reset-password/page.tsx`, `app/activate/page.tsx`, `app/get-started/OnboardingWizard.tsx`, `app/get-started/steps/StepAuth.tsx`, `app/dashboard/settings/tabs/AccountTab.tsx`.
- Routes: `app/api/account/password/route.ts`, `app/api/auth/staging-signup/route.ts`, `app/api/whatsapp/flow-callback/onboarding.ts`, `app/api/whatsapp/flow-data/onboarding.ts`.
- Flow: `lib/whatsapp-flows/onboarding-flow.json`.
- New tests: `password-policy-ui`, `password-policy-routes`, `flow-onboarding-password`.
- Updated tests for the new wording: `account-tab-password-change`, `staging-signup-route-449`, `staging-signup-invite-wizard`.

**Affects:** merchants choosing a new password. Customers, payments, webhooks, cron and WhatsApp routing are not affected.

**Owner steps (after this is live):**
- Republish the onboarding Flow to Meta (#1175 §3.1 step 5). Until then the published Flow has no screen check, and a short password is caught at the end instead.
- Set the Supabase minimum to 8 and turn on leaked-password protection (§3.1 step 8). Until then Supabase accepts 6 or more, so only Waaiio's 8-character check applies, and breach-list refusals do not happen yet.

**What could break:**
- The Flow JSON change has not been checked by Meta's Flow validator yet. Republish it on staging first.
- A merchant who types a 6–7 character password on sign-up for a new email now sees W3 instead of an account being created. That is intended.
