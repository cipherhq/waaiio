## 2026-11-27 — Stronger sign-in protection, slice 1: shared counting for code limits (#1175)

**What changed:**
- `lib/brute-force.ts` counts wrong-code attempts in the shared Upstash store when it is configured, so every server sees the same counts.
  - Without the store, it counts per server as before.
  - If the store is unreachable, it falls back per server and alerts Sentry. A lock recorded on this server while the store refused writes is still enforced when the store serves reads again.
- Merchant sign-in codes, customer checkout codes and contract-signing codes are now counted separately. Before, one address count was shared by all three.
- The numbers are unchanged: 5 failures give a 15-minute wait, and 20 per address give 30 minutes.
- Store keys hold a hash, never a phone number, email or token.
- Lock log lines no longer include the identifier.
- `checkBruteForce`, `recordFailure` and `clearFailures` are now async and take a scope.
- `lib/rate-limit.ts` exports `getSharedRedis()`.
- `verifyTurnstileToken` gains an optional `{ secret }` option for a later sign-in widget. When it is given, only that secret is used, even if it is unset (it never falls back to the forms secret). Public forms and demo-request are unchanged.
- New `lib/security/firewall-exclusions.ts` is the planned firewall path list, with a catalog test against `app/api`.

**Files:**
- `lib/brute-force.ts`, `lib/rate-limit.ts`, `lib/security/turnstile.ts`, `lib/security/firewall-exclusions.ts`.
- `app/api/auth/otp/send`, `app/api/auth/otp/verify`, `app/api/auth/email-otp`, `app/api/contracts/otp/verify`, `app/api/trial-credit/claim`.
- Tests: `lib/__tests__/brute-force-shared.test.ts`, `lib/__tests__/firewall-exclusions-list.test.ts`, `lib/__tests__/turnstile-secret-override.test.ts`; `trial-credit-claim.test.ts` mock signature.

**Affects:** merchant WhatsApp-code sign-in, the claim-credit code, customer booking and ticket email codes, and contract-signing codes. All responses and messages are the same.

**Owner step:** none to deploy. Counts become shared once the Upstash store is connected (#1175 §3.1 step 3).

**What could break:** a caller that forgets `await` would read a Promise as "not blocked". All five callers await, and `tsc` checks the type. An Upstash outage logs and alerts but never blocks a request.
