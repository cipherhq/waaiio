# Authorized staging release — 2026-10-31

Owner explicitly overrode the AGENTS.md deployment restriction for **staging only**, authorizing M491, deployment of these fixes with the corrected WABA setting, and verification. No merge or production release was authorized or performed.

## Release identity

- Branch: `codex/bot-onboarding-consistency`.
- Final application/test commit: `a47e926696d217c4c6be4ad896bf9d6a625c431a`.
- Staging Vercel project: `waaiiostaging` (`prj_h7YmC4fvpxhn429znCy34OjLZ6se`). Vercel calls the live target within this staging project `production`; this is not the separate production Waaiio project.
- Final deployment: `dpl_5nvtPcTu53dy4bDP3vDBsbqwT5RT`.
- Host: `https://staging.waaiio.com`.
- Final deployment status: **READY**, 2026-10-31T14:21:50.620Z, exact SHA `a47e926696d217c4c6be4ad896bf9d6a625c431a`; custom staging alias confirmed in the deployment record.
- Initial deployment `dpl_68AevHMoBozfnuUHAtJ5zHeKpAVJ` at `e7c06485` reached READY and passed the HTTP checks below. Final commit changes only four expected label strings and the seating tier documentation; executable application code is identical.

## M491 applied and verified on staging

The full migration content was submitted through Supabase `apply_migration`, including transaction boundaries, both function replacements, grants/revocations and final-state assertions. Success was followed by independent catalog reads and service-role calls. Hosted migration history records version `20261031141210`, name `491_shared_recovery_candidate_fence`. Staging history also identifies M430 under `20261012131222` and M462 under `20261024230336`; these were timestamped entries, not absent migrations. No history repair or fabricated attestation was performed.

Postconditions:

| Check | Result |
| --- | --- |
| Candidate cancellation column | Present; migration assertion passed |
| `promote_channel_candidate` | Cancellation guard present; definition length 7,671 |
| `transition_to_shared` | Cancellation updates present; definition length 2,944 |
| Function security | Both SECURITY DEFINER, retained search paths |
| anon/authenticated EXECUTE | Denied on both, before and after |
| service_role EXECUTE | Allowed on both, before and after |
| Service-role execution smoke | Both correctly returned business_not_found for nonexistent random IDs; transaction rolled back |
| Security advisor categories/counts | Same seven groups before/after; no returned finding names either changed RPC |

This additive migration is compatible with the previous application: existing callers need no new argument and only read/write the old candidate fields. A late provider status update cannot clear the cancellation timestamp. The previous code can remain a rollback target with M491 installed; do not remove the fence while cancelled provider requests could still return.

## Environment and HTTP checks

Before creating the deployments, the staging project's saved `META_CLOUD_WABA_ID` was verified as `26396269840042214`, associated with the approved staging Messaging Account. New deployments were created after that saved configuration change. Existing staging token/app/phone configuration was retained; production credentials were not copied.

Initial post-deployment checks at 2026-10-31T14:16:56Z:

- `/api/health`: HTTP 200, status `ok`.
- `/login`: HTTP 200.
- `/dashboard/whatsapp/connect` without a session: redirects to login with the connect destination preserved.
- POST `/api/whatsapp/add-number` without a session: HTTP 401 Unauthorized, before any provider request.
- Runtime error/fatal log query scoped to the deployed ID: no entries returned in the checked window.

The same checks were repeated against the final deployment at 2026-10-31T14:22:16.892Z and passed. `/get-started` also returned HTTP 200. No error/fatal runtime entries were returned for the final deployment in the checked window. The active staging shared channel also reports the corrected WABA `26396269840042214`.

These checks establish deployment health and expected authentication denial, not successful phone enrollment. The Owner will initiate the dedicated-number test from their account and complete the SMS/voice verification. No OTP was sent and no phone number was registered by the agent. The previously recorded Meta failure belongs to the old pre-correction deployment.

## Validation and CI

Previously completed: 304 targeted application tests, zero skipped; M491 disposable database fixture plus 14 role/concurrency assertions, zero skipped. Base-versus-branch TypeScript diagnostics were identical (516 on each; none introduced by these changes).

First supplemental CI at `e7c06485` found five outdated expectations in three files: four expected the old English product label and the acceptance matrix still listed seating as Free. The expectations now match the explicit Owner decisions. All three affected suites pass locally: **201 tests, zero skipped**. No assertions were removed, role/isolation conditions weakened, or test execution disabled.

Final supplemental CI: https://github.com/cipherhq/waaiio/actions/runs/41209460490 . At the final deployment smoke checkpoint, the full rerun was still in progress; governance, release tooling, dependency audit, secret scanning, admin build and the standalone ACL jobs were successful. The Main App test step subsequently passed; its build and the two migration shards were still running, so no all-green CI claim is made. This workflow_dispatch run is evidence, not a protected-main merge approval. M491's new concurrency runner was executed locally; it is not represented as an HTTP test or as a CI-executed test. Any exact-file CI claim requires the job, step, count, skip count and final SHA.

## Limits

Production is unchanged. New-account email setup and dedicated-number OTP/register journeys still require user/provider end-to-end acceptance. The deployment is intended to enable that staging test; it is not a claim that every number is eligible or that Meta will accept a specific number.

## Follow-up: number already registered (14:23 UTC)

The latest staging deployment returned Meta code 100, subcode 2388103 on two user-initiated add-number attempts. Meta identified an existing WhatsApp account association and refused migration through the fresh-number flow. This is distinct from the earlier WABA account-type rejection (2388339). No successful fresh-number/OTP onboarding is certified by these errors.

Independent evidence verification reproduced the runtime trace and confirmed diagnostic loss: the API returned only “Invalid parameter,” while the page showed an unlabeled historical failure. The bounded correction maps 2388103 to fixed safe guidance, persists a stable reason for subsequent status reads, and labels both historical banners “Previous connection attempt.” Existing stored generic failures cannot be retroactively classified. Provider requests, migration flags, authorization, candidate fencing, and channel assignment remain unchanged. No new database migration, number removal, migration, OTP send, or production mutation is part of this correction.

Preflight: the add-number route is called by the connect page for request/verify/resend; connection-status is called by that page on mount. The shared diagnostic helper has only these two route callers. Risk is limited to response/presentation text and a failed candidate’s existing reason field. Acceptance: exact provider rejection yields actionable text, is persisted, sends no OTP, invokes no promotion, and projects the same safe text on reload.
