# Onboarding staging follow-up — 2026-10-31

Code under test: `d8cfc6fd1736883155911997c04fb88628610544`; base `da9020670b856fda73dd05477d82859fdd460cf7`.

## Completed migration execution

M491's full content ran against a disposable local PostgreSQL instance. This is **database-level validation, not a staging HTTP or Meta test**. No hosted migration was applied or recorded.

- SQL fixture passed cancellation from pending, validating and ready states, persistent fencing after a late provider status update, and unchanged pending work when shared allocation fails.
- `scripts/test-m491-concurrency.mjs` passed 14 executable assertions with zero skips: both RPCs deny anon/authenticated, service_role can execute both, and two independent sessions serialize both cancellation-first and promotion-first ordering. Both finish on shared routing with no active dedicated channel.
- The harness waits for the competing session's actual PostgreSQL lock wait before releasing the first transaction. It executes the production RPC bodies; it does not replace them with mocked concurrency behavior.
- The test fixture was expanded to support actual first-number promotion and its rollback to shared. The runner requires an explicitly named local disposable database and fails if configuration is absent.
- Initial sandbox shared-memory denial was resolved through the authorized elevated local test run. A test-harness SQL replacement error was corrected before the passing run; no migration SQL was changed.

Reproduce in an empty local `waaiio_m491_test` database:

```sh
M491_TEST_DATABASE_URL=postgresql://localhost:55491/waaiio_m491_test node scripts/test-m491-concurrency.mjs
```

Staging's existing RPC grants were also checked read-only: both are SECURITY DEFINER; anon/authenticated cannot execute; service_role can. Their search paths match the migration's retained definitions. M491/cancelled_at is not installed on staging. Only exact version `391` appeared in the bounded migration-history query; the existence of M430/M462 objects does not prove corresponding history reconciliation. Reconcile full history before applying a hosted migration.

## TypeScript attribution

A clean `git archive` snapshot of the base commit was compiled with the exact same installed dependencies as the branch. Both returned **516 diagnostics**. After normalizing repository roots, changed line offsets and seven truncated absolute import paths, the diagnostic multisets are identical: **0 added, 0 removed**. The existing runtime destructuring of a nonexistent `type` export in the table-reservation test is present at the base SHA too.

Evidence: `2026-10-31-onboarding-type-comparison.json`. No TypeScript fix was necessary for this branch. This does not mean the repository typecheck passes. Prior branch regression result remains 304 tests passed, zero skipped; this follow-up changes only the database test fixture/runner and evidence documentation.

## Current staging deployment and Meta evidence

- `staging.waaiio.com` aliases deployment `dpl_AmXzJ18QT3z9gavQzTYR9pijSe2A`, READY at base commit `da902067`, not this branch.
- Deployment creation: `2026-10-31T08:32:04.714Z`. Saved `META_CLOUD_WABA_ID` update: `2026-10-31T08:43:44.881Z`. The saved value is `26396269840042214`. The correction occurred **after** the deployment; no subsequent READY deployment was found. Saved configuration must not be represented as the running deployment's configuration.
- Runtime evidence: `2026-10-31T08:35:59.797Z`, POST `/api/whatsapp/add-number`, request `pl8pk-1793435758996-e06c28aa8865`, Meta code `100`, subcode `2388339`, title `Invalid WhatsApp account usage`, message `This API is not supported for this WhatsApp Business Account.` This is the historical failing request, not a new end-to-end attempt.
- Live Meta checks: Waaiio Cipherhq Inc. remains verified with complete profile. Staging Messaging Account `26396269840042214` is Approved, associated with WhatsApp Account `1535802517852577`. Production Messaging Account `2015131016027475` is separate and Approved, associated with WhatsApp Account `1816559392839310`.
- Staging app `1722212455524293` is published, has its messages callback configured, and is subscribed to the staging account. The provider checklist reports a configured payment method. These are provider readiness reads; they do not prove a new dedicated number's POST/OTP/register sequence succeeds.
- No new provider OTP, number registration, credential change or webhook mutation was performed. The Owner chose to test the dedicated number using their existing account. No new attempt was present in the latest bounded runtime-log reads.

## Email evidence

Resend reports `waaiio.com` verified with sending enabled. A TestBiz invitation sent at `2026-10-31T07:46:11.470Z` has delivery status **delivered**; its destination is a staging `/invite/` link. Recipient details and bearer invitation links are deliberately omitted.

That email predates this branch and has no new account-setup callback. It proves delivery of the earlier invitation, not the new user's password setup/recovery/consent/acceptance chain. The Owner chose to test using an existing account rather than supplying a new test recipient. No additional invitation was sent and no account credentials were changed.

## Remaining environment steps

The code branch and M491 still need the repository's release process before the fixed journey can be tested on staging. AGENTS.md says **“Never approve, merge, or deploy.”** No deployment was performed under this verification request. The release operator must deploy the approved exact SHA with the corrected environment after the necessary staging migration/history checks. Production still requires M462, as documented in the original audit.

After that: owner-driven dedicated-number OTP/register test; shared fallback versus pending connection through HTTP; new and existing email recipient journeys including expired/failed first delivery. These remain **UNVERIFIED / EVIDENCE GAP**, not claims of a broken provider or a completed certification.
