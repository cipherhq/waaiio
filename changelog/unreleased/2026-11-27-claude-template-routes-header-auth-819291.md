## 2026-11-27 — Internal template routes: accept the service token in the Authorization header only

**What changed**
- `GET /api/whatsapp/templates/check`, `GET /api/admin/template-status` and `GET /api/admin/provision-templates` now read the internal service token only from `Authorization: Bearer <INTERNAL_API_TOKEN>`. A `?token=` query value is ignored.
- `templates/check` no longer accepts `CRON_SECRET` as a `?token=` value. Its existing cron path (`Authorization: Bearer <CRON_SECRET>` via `verifyCronAuth`) and admin-session fallback are unchanged, as are the cron and admin paths on the other two routes.
- All three compare the token in constant time and refuse it when `INTERNAL_API_TOKEN` is unset or empty.

**Files**
- `lib/cron-auth.ts`: new `hasBearerSecret(request, secret)` helper (constant-time `Authorization: Bearer` check, false for an empty secret). `verifyCronAuth` now uses it; its behaviour is unchanged.
- `app/api/whatsapp/templates/check/route.ts`, `app/api/admin/template-status/route.ts`, `app/api/admin/provision-templates/route.ts`: use `hasBearerSecret` instead of reading `?token=`.
- `lib/__tests__/template-routes-header-auth.test.ts`: new handler-level tests for the three routes.
- `lib/__tests__/admin-role-escalation.test.ts`: template-check test 1 now sends the token in the header.

**What it affects**
- No caller in this repository uses these routes. Anyone calling them by hand with `?token=` must send the `Authorization: Bearer` header instead.

**What could break**
- A manual or external caller still using `?token=` gets 401/403 until it switches to the header.
