## 2026-11-06 — Bind Google Calendar connect to a signed state

- **What changed:**
  - The Google Calendar connect start route (`app/api/integrations/google-calendar/route.ts`) now sends Google a signed `state` instead of the business id. The state carries the user id, business id, provider and a random nonce, expires after 10 minutes, and is signed with HMAC-SHA256 using a labelled sub-key derived from the existing `SUPABASE_SERVICE_ROLE_KEY` (no new env var). The nonce is also set in an httpOnly, SameSite=Lax cookie (`gcal_oauth_nonce`) scoped to the callback path.
  - The callback (`app/api/integrations/google-calendar/callback/route.ts`) now requires a signed-in user and checks the signature, expiry, provider, user and cookie nonce before the code exchange or any write. The business id is taken only from the verified state, and ownership is re-checked. Any failure redirects to `/dashboard/integrations?error=callback_failed`. The nonce cookie is always cleared.
  - New helper: `lib/integrations/google-calendar-oauth-state.ts`.
  - New tests: `lib/__tests__/google-calendar-connect-state.test.ts`.
- **Unchanged:** the successful owner flow, the token columns written, `lib/integrations/google-calendar.ts`, the `google_denied` and `missing_params` redirects, and the shared `oauth_connect_states` table (no migration).
- **What it affects:** connecting Google Calendar from the dashboard.
- **Could break:**
  - A connect started before this deploy and finished after it is rejected once; the owner can start it again.
  - Finishing the connect in a different browser, or signed in as a different user, from the one that started it is now rejected.
  - If `SUPABASE_SERVICE_ROLE_KEY` is missing, the start route returns "Google Calendar not configured" (fail closed).
