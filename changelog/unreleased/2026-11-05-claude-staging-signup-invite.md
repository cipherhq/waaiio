## 2026-11-05 — Staging sign-up needs an invite code; release gate can reach a login-protected staging admin

**What changed** (Owner approval, 2026-11-05)

- **Staging sign-up** (`app/api/auth/staging-signup/route.ts`, staging only):
  - a new account needs the invite code set in the staging-only server variable `STAGING_SIGNUP_INVITE_CODE`;
  - the code is compared in constant time. Wrong guesses count toward the existing 20-per-hour limit, because the limit is checked first;
  - if the variable is missing or shorter than 16 characters, sign-up stays closed (403). Existing staging accounts can still sign in.
- **Sign-up screen** (`OnboardingWizard.tsx`, `steps/StepAuth.tsx`, `steps/types.ts`): on staging only, the form shows a required "Staging invite code" field and sends it with the sign-up. Production shows no new field and its sign-up path is unchanged.
- **Release gate** (`scripts/release-v3/platform.mjs`, `scripts/release-gate-v3.mjs`, `release-prepare.yml`, `release-deploy.yml`):
  - the staging admin health check sends Vercel's automation bypass header from the `VERCEL_ADMIN_STAGING_BYPASS` secret, so it keeps working once staging admin is behind Vercel's login;
  - production and the merchant sites never receive the header;
  - without the secret, Vercel's login redirect or a 401 fails with a message that names it.

**Tests:**
- `lib/__tests__/staging-signup-invite.test.ts`: the real route with the right code, a wrong code, no code, missing or short configuration, rate limit order, and production.
- `lib/__tests__/staging-signup-invite-wizard.test.tsx`: the real wizard on staging and production.
- `scripts/__tests__/release-v3-admin-staging-bypass.test.ts`: the header goes only to staging admin; the missing-secret message on a login redirect or a 401.
- Red check: on `main`, 12 of these 20 tests fail and 8 pass.

**Could break:**
- After deploy, staging sign-up is closed until the Owner sets `STAGING_SIGNUP_INVITE_CODE` on the staging Vercel project. Testers and release rehearsals need the code.
- If Vercel's login is turned on for staging admin before the `VERCEL_ADMIN_STAGING_BYPASS` GitHub secret exists, release prepare and deploy stop at the staging admin check. They fail closed with a clear message.
