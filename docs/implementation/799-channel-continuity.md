# Permanent merchant links and channel continuity (#799)

Permanent `/m/{businessId}` links resolve the merchant's current ready WhatsApp channel. Action and campaign links retain their existing shared/dedicated message semantics. Changing the transport number does not change merchant identity, customer records, consent, or payment identity. Old WhatsApp chat history is not transferred by this feature.

## Approved lifecycle

- First connection retains the existing provider-verified candidate promotion path.
- Normal dedicated-number replacement requires the business owner's fresh MFA authorization for an explicitly selected ready candidate. Candidate promotion retains compare-and-swap checks against the original channel assignment.
- Merchant disconnect requires an explicitly selected eligible shared destination. Country and capacity validation are server-authoritative, including the existing Ghana-to-Nigeria exception. The SQL transaction changes the assignment and consumes authorization together; it never substitutes an allocator-selected destination. Replacing an existing shared assignment requires the admin workflow.
- Lost-access recovery requires manual owner reverification using reviewed, tenant-scoped evidence, followed by approval from a second distinct authorized admin. Either authorized admin may execute with fresh operation-bound MFA; a third distinct admin is not required.
- Admin create, approve and refresh use `mutate_channel_change_approval`. Execution uses `execute_channel_change_approval`. The authoritative descriptor binds the exact operation, destination or candidate, source state, evidence, version, actor and session. MFA and mutation use the same stable UTF-8 authorized text. Refresh increments the version and clears the previous approval.
- Authorization, request changes, channel transitions and their audits are transactional. Changed source state, stale authorization, or a stale version requires a fresh preview/review.

Both merchant payment routes remain unchanged: connected Stripe/Paystack arrangements pay through the merchant's provider, while Waaiio-collected funds retain admin-controlled manual settlement with actual payment confirmation. Healinglabs and other live merchants were not modified during this implementation.

## Database and access contract

M496 `channel_number_continuity.sql` is source-only and requires a separately authorized rollout. It was renumbered because M495 belongs to Embedded Signup sessions from PR #805. Existing Embedded Signup session behavior is preserved.

The three continuity tables enable RLS and deny public client access. Only the service role can call the new SQL functions, whose `SECURITY DEFINER` definitions use an empty search path and schema-qualified application relations. The transition audit permits service-role SELECT/INSERT, not UPDATE/DELETE. Public API handlers enforce owner/admin identity and session assurance before invoking privileged functions. Admin list/preview responses expose explicit display fields without authorization text or session identifiers.

## Maintained verification

| Test file | Scope |
| --- | --- |
| `lib/__tests__/channel-number-continuity.pg.test.ts` | Actual disposable PostgreSQL schema/RLS/grants/search-path checks; first connect, replacement, exact disconnect; atomic create/approve/refresh/execute; evidence isolation; stale/replay/rollback checks; independent concurrent executors; candidate promotion; legacy dedicated-pointer audit; preserved identity |
| `lib/__tests__/channel-change-admin-routes.test.ts` | Actual admin HTTP handler imports with controlled dependencies; expected allow/deny and RPC contract |
| `lib/__tests__/merchant-channel-routes.test.ts` | Actual merchant HTTP handler imports with controlled dependencies; owner/session/candidate/destination binding |
| `lib/__tests__/channel-number-continuity.test.ts` | Existing handler authorization regression checks |
| `lib/__tests__/permanent-merchant-links.test.ts` | Permanent-link HTTP resolution, readiness, message semantics and tenant isolation |
| `admin/src/__tests__/channel-changes.test.tsx` | Rendered admin recovery controls |
| `lib/__tests__/merchant-channel-rendered.test.tsx` | Rendered merchant channel controls |

The maintained PostgreSQL suite passed **75 tests, zero failed and zero skipped**, on a disposable local loopback database while implementing this change. It applies M391, M430, the relevant M439 table definition, and M494–M496 with faithful core fixtures. SQL tests are not HTTP tests or provider certification.

`.github/workflows/ci.yml` discovers `.pg.test.ts` files in job `security-acl-tests`, step `Run .pg.test.ts files in parallel with isolated databases`, and enforces zero skips in `Verify zero skipped .pg.test.ts tests (per-file)`. The main unit-test step excludes this database-dependent file so it runs in that isolated job. Rendered admin tests run in the Admin test job; ordinary handler and merchant UI tests are discovered by the root unit-test runner.

These are local results and CI wiring details, not a claim of final-head CI execution. Final-head review/CI evidence belongs on PR #801. No hosted migration, deployment, provider mutation, live merchant reassignment, or production certification is implied.
