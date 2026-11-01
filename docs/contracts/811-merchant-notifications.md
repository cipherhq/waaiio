# Merchant operational notifications — #811

Base: `d02a4139bafd673c21de2119a277b48b326e8a04`. Implementation authorized by Owner; no merge, hosted migration, deployment or live provider send authorized.

## Accepted design

Multiple owner-managed recipients per business. Each destination is a separate recipient record (`whatsapp` or `email`), with label, event preferences, active/revoked state and its own verified consent. Recipients gain no dashboard permissions. Events: `sale`, `payment`, `appointment`, `booking`.

Onboarding success and dashboard settings share the same recipient manager. Setup is optional and pending verification never blocks business creation. WhatsApp link and optional QR are alternative entry points to the same flow; the recipient sends a prefilled message to prove phone ownership and opt in. Email consent uses a separate confirmation link. Neither link GET nor QR display activates a recipient.

New feature data is service-write-only with owner-scoped reads. Owner-authenticated APIs validate all management operations. Invitation token hashes are stored, bounded by expiry, recipient and intended sender channel; atomic verification binds actual WhatsApp sender or email confirmation to the intended recipient. Address changes require new verification. Removing/disabling a recipient suppresses pending delivery. STOP suppresses merchant alerts for that sender/channel while preserving existing customer consent handling; START does not silently reactivate recipients.

Durable notification intents are captured from authoritative committed source state. Fanout is unique per source event/recipient/channel. Only verified enabled recipients receive future events; no historical backfill. Paid notifications require authoritative success/finalization. Appointment versus booking derives from the actual booking type. An unpaid order must not claim payment. Notifications do not change payment fees, custody, settlement, customer confirmation or fulfillment authority.

Use existing guarded sender and approved utility templates, not unrestricted free text. Email is independent of WhatsApp. Persist a dispatch fence before provider submission; recover pre-provider failures with bounded retries, but retain ambiguous submissions for reconciliation rather than blindly resending. Accepted requires a real provider ID; dev-email results are not delivery. Expose status accurately. Legacy notification compatibility must be explicit and avoid duplicate sends to destinations enrolled in the new system, without turning off existing unenrolled recipients.

## Shared API contract

`/api/settings/merchant-notifications?business_id=UUID`: GET lists recipients and readiness; POST adds `{business_id,label,channel,address,events}`; PATCH updates `{business_id,id,enabled,events}`; DELETE revokes `{business_id,id}`. Owner-only. Recipient fields: `id`, `business_id`, `label`, `channel`, `address`, `events`, `enabled`, `verified_at`, `revoked_at`, `created_at`.

`/api/settings/merchant-notifications/enrollment`: POST `{business_id,id}` issues invitation; WhatsApp returns `{url,expires_at}`, email queues/sends verification and returns `{sent:true,expires_at}` only on provider acceptance. Rate limited. `/notifications/confirm` presents email confirmation and explicit POST acceptance; GET never consumes tokens. WhatsApp command: `WAAIIO ALERTS <token>`.

Migration M499 reserved locally for this lane after main/registry/open PR inventory; not applied. All worker changes remain in this worktree.

## Acceptance ledger

- [x] Independent Phase A source audits and production aggregate settings read
- [x] Multi-recipient owner APIs and channel-specific confirmation
- [x] Reusable onboarding/settings UI; pending, active, revoked and failure states
- [x] Durable source capture, deduplication, guarded template/email dispatch and safe recovery
- [x] Legacy compatibility and STOP/START regressions
- [x] Real PostgreSQL grants/RLS/claim/rollback/replay evidence
- [x] Behavioral HTTP and rendered UI tests
- [ ] Typecheck/build and affected regressions
- [x] Independent source review across enrollment, dispatch and legacy compatibility
- [ ] Exact-head CI (not run; local evidence is not CI evidence)
- [ ] Separate authorized staging/provider acceptance and production rollout

Production observation on 2026-11-01: 46 whatsapp_config records, all email enabled, zero WhatsApp alerts enabled. Settings are not delivery evidence. No active-production defect severity assigned.

## Rollout configuration (separate authorization required)

1. Apply the full reviewed M499 to staging, verify the RPC grants/owner reads, then exercise consent and source capture there. This reservation is **not an applied migration**.
2. In every sending Meta WABA, obtain an approved **UTILITY**, `en_US` template named `waaiio_merchant_alert_v1`. Body: `Waaiio merchant update for {{1}}. Event: {{2}}. Reference: {{3}}. Details: {{4}}. You requested operational updates for this business. Open your Waaiio dashboard to review. Reply STOP to stop these alerts.` The four body parameters are business name, event title, source reference, and operational detail. Example values: `Acme Salon`, `Appointment confirmed`, `APT-1042`, `View your dashboard for the schedule and customer details`. No marketing content or customer personal details. The existing sender uses `en_US`. Static opening text avoids a dangling opening variable; Meta makes the final category/approval decision.
3. Configure working `RESEND_API_KEY` and verified `EMAIL_FROM`, then explicitly enable server-only `MERCHANT_NOTIFICATIONS_ENABLED=true` in the intended environment. Default is off; the disabled feature preserves legacy sends. Missing provider/template readiness retries before submission up to five attempts and then exposes failure.
4. `/api/cron/merchant-notifications` uses existing `CRON_SECRET` authentication and runs every minute, claiming up to 20 destinations per invocation. No browser endpoint sends alerts directly.
5. Verify each destination by email confirmation POST or sending the WhatsApp opt-in command from that phone. A link and QR are alternative ways to open the same WhatsApp message; displaying/opening one does not opt in. The sender channel is consent-bound.
6. Staging provider acceptance must verify real IDs and delivery receipts separately. Queue `accepted` means the provider accepted a submission, **not delivered or read**. `unknown`/`dispatched` require reconciliation; they are never automatically replayed. Operator queries of `merchant_notification_deliveries` show per-destination outcome and bounded reason codes. Delivery-receipt synchronization is not claimed by this implementation.

Source rules: order `confirmed` or `paid_pending_approval` transitions generate one sale event with unpaid-safe wording; pending approval explicitly requests merchant approval. Confirmed scheduling bookings become appointments unless the service is a class; classes, table bookings, and accommodation reservations become bookings. Pending checkout records are not confirmed notifications. Payments require `status=success` plus completed finalization and canonical source foreign keys; cross-tenant conflicting bindings do not fan out. No historical enrollment backfill. Source capture and rollback are in the originating database transaction; notification dispatch never changes payment or settlement state. Both merchant provider-custody routes remain unchanged.

WhatsApp destinations share the existing per-business monthly allowance (free 50; growth/business 999999) with legacy alerts through an atomic reservation RPC when this feature is enabled. Email delivery is independent. Twenty active destinations per business is the technical abuse bound. Disabling, changing event preferences, STOP, source cancellation, or re-verifying consent prevents stale queued sends before the dispatch fence.

## Local verification checkpoint — 2026-11-01

- Combined application run: 132 passed across eight files, zero skipped. Includes owner-authenticated HTTP handlers, rendered enrollment/onboarding, guarded dispatch and payment compatibility.
- STOP compatibility helper: nine passed, zero skipped. Missing-schema compatibility and fail-closed database errors exercised separately from owner-alert tests.
- Disposable PostgreSQL M499 fixture: 21 passed, zero skipped. Includes real grants/RLS, invitation replay/expiry, transaction rollback, tenant scope, concurrent claims/allowance, STOP lineage and cancellation. This is database evidence, not hosted HTTP/provider certification. The isolated database server was stopped after verification.
- Independent source review identified and corrected five integration gaps before release: owner-authorization key consistency, campaign payment capture, STOP of pending invitations, duplicate legacy invoice/donation payment notices, and legacy sends after STOP. No current production defect classification is asserted by this feature review.
- Full repository TypeScript verification reported 520 test-file diagnostics and zero application-code diagnostics. Two new fixture typing errors were corrected; the affected 40 tests passed again with zero skips. The other 518 diagnostics are in unchanged test files; a clean whole-repository typecheck/build has not been certified. Targeted ESLint found no errors and one ref-cleanup warning in the recipient UI. Initial build could not fetch Google Fonts in the restricted environment. The network-enabled production bundle compiled successfully; its redundant full typecheck was stopped because the separate repository check already identified the test errors. No successful full build is claimed.
- No hosted migration, deployment, live notification send or provider delivery test performed. CI has not run for this branch. Do not mark the feature production-ready from local test counts alone.

## Owner-authorized release-blocker follow-up

On 2026-11-01 the Owner authorized fixing the remaining validation blockers and preparing this feature for release. Main was refreshed to `7f81b7b3`; the unpushed feature branch was rebased onto it. Test-fixture corrections must preserve assertions and security gates, without disabling TypeScript, excluding tests, or changing runtime payment behavior. Final exact-head tests/CI and independent review remain required.

Read-only provider/database verification after the Owner selected Waaiio Cipherhq Inc.: the four active shared production country channels reference the Waaiio Bot messaging account; the new template is absent there. Submission instructions above target that account. No provider mutation or template submission has been performed. Template-format reference: https://www.twilio.com/docs/whatsapp/tutorial/message-template-approvals-statuses .

### Follow-up validation and release prerequisites

The repository-wide TypeScript check now exits successfully with no diagnostics. Existing assertions remain intact; fixes update test mocks, required fixture fields, response narrowing and current API signatures. Three trial-date declarations now accept `null`, matching M372 and existing runtime policy, while the original null fixtures are preserved. No runtime trial or payment rule changed.

Local canonical CI bootstrap applied all 433 migration files successfully, including M499, to a disposable database. Independent review checked the fixture corrections. Latest per-file results: cohort A 2,044 passed with three pre-existing intentionally disabled Flutterwave cases; cohort B 1,326 passed with no skips; surface cohort 1,283 passed with no skips plus 78 isolated Engage database tests. Affected nullable-trial/policy rerun: 408 passed (overlaps the surface count). These are local results, not exact-head CI evidence. The full build and wider suite remain separate release checks.

Read-only configuration checks: Resend reports `waaiio.com` verified with sending enabled; Vercel lists a production `RESEND_API_KEY`. The complete project environment-variable metadata list (zero hidden production variables) does not list `CRON_SECRET`, `EMAIL_FROM` or `MERCHANT_NOTIFICATIONS_ENABLED`. `EMAIL_FROM` has the existing verified-domain fallback; `CRON_SECRET` must be configured for authenticated cron dispatch. The new feature flag intentionally defaults off. Configure the secret and enable the flag only in the authorized rollout after schema/template readiness and controlled delivery acceptance.
