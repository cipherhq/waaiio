## 2026-11-04 — Consent and admin-assisted activation read the new server-only consent column (#878 Bug 2, PR B)

Owner decision (2026-11-04, #878, Option A). PR B of two, stacked on the M515 database PR. **Ships only after M515 is applied in production**; before that, both routes keep failing exactly as they do today.

What changed:
- `app/api/account/consent/route.ts`: GET and POST read `profiles.consent_preferences` instead of `profiles.metadata.consent_preferences` (a column that never existed). POST merges the new answers into the existing object, writes only `consent_preferences`, and returns what the database confirms. Response shapes, the 401/400/404/500 handling, the default answers, the version fallbacks and the terms-evidence merge rules from #768 are unchanged.
- `app/api/onboarding/activate-admin-invite/route.ts`: reads `consent_preferences.consented_at` and `consent_preferences.terms_accepted_at` from the new column. Still refuses (409) without both.
- Tests: `lib/__tests__/account-consent-route-762.test.ts`, `lib/__tests__/account-consent-settings-762.test.tsx` and `lib/__tests__/issue-551-admin-activation-route.test.ts` now model the live table: selecting or writing any profile column other than `consent_preferences` returns PostgREST `42703`, and a non-object value is refused like the M515 check.

Affects: Settings → Account → Privacy preferences, the cookie banner's account sync (`components/marketing/CookieConsent.tsx`), and `/activate` (admin-assisted activation, #551).

Could break:
- Deployed before M515 is in production: the routes return 500 / 409, the same as today (no regression, no fix).
- Owners start with no stored answers, so GET returns the existing defaults until they save once. Nothing was ever stored before, so there is nothing to migrate.
