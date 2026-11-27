## 2026-11-27 — session-bind: identify the user with getUser()

- **What changed:** `POST /api/auth/session-bind` now takes the user's id and email from `supabase.auth.getUser()`, which checks the token with Supabase Auth, instead of from the cookie session returned by `getSession()`. `getSession()` is still read, but only for the access token that `security_sessions.session_id` is derived from. If `getUser()` returns no user or an error, the route returns the same 401 `Not authenticated` as before and writes nothing and sends no email.
- **Files:** `app/api/auth/session-bind/route.ts`; new handler test `lib/__tests__/session-bind-route.test.ts`.
- **Affects:** the session record, `profiles.last_login_at`, login alerts, and the "New login" email sent after email/password sign-in on `/login` (the only caller). Responses are unchanged.
- **What could break:** each call now makes one extra request to Supabase Auth. A sign-in whose token Supabase Auth rejects is no longer recorded and gets no login email. The login page ignores this call's result, so sign-in itself is unaffected.
