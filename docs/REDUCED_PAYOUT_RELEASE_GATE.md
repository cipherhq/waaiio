# Versioned reduced payout release gate

The existing schema-version-1 calendar/feedback release remains unchanged. Schema version 2 selects only `admin-payout-mfa-v1`; it is an explicitly reviewed payout/MFA source closure. Neither profile deploys arbitrary main or accepts a manifest-provided path allowlist.

## Private inputs and source identity

The Owner-managed `REDUCED_RELEASE_MANIFEST` contains the protected integration SHA and each project's original production baseline SHA/deployment ID, exact target SHA/tree, and `source_blobs` mapping each changed path to its raw-byte SHA256. The merchant package and lockfile explicitly declare the PostgreSQL test dependency. The fixed path inventory and required test counts live in `scripts/reduced-payout-policy.mjs`. Every path must be present, no extra/deleted path is accepted, and each blob must match the target Git object. M430 is outside this inventory.

The baseline must precede its target; each target must be an ancestor of the trusted protected-main integration. Reconcile canonical main explicitly: the reduced prepare route supports four payout actions, while main retains its wider reviewed capability contract. Do not overwrite main's prepare route with the reduced route or substitute a squash commit for ancestry. Fresh push-main CI and a clean exact source checkout are required.

Freeze the raw manifest before verification and acceptance. The manifest never embeds an acceptance report digest. Exact-target CI artifacts bind its raw SHA256; formatting changes require new evidence.

## Exact-target verification

The existing verification workflow installs each exact target's lockfile and runs the fixed suites/build in isolated checkouts. Merchant verification includes calendar cases in UTC and America/New_York, the payout/authentication regression suite, actual local TLS tests, and the five-case PostgreSQL test. The PostgreSQL 17 service is disposable and local to the job. Only that suite receives the localhost test database URL and `REQUIRE_PG_TESTS=true`; absence must fail, never skip. No production database or provider credentials are available to target code.

A separate trusted-integration job executes four actual challenge-binding/consume CAS cases and sixteen canonical settlement/refund cases against disposable PostgreSQL 17. Its distinct receipt binds the raw manifest, integration SHA, merchant SHA/tree, exact canonical migration byte hashes and test source hashes. Both test files must execute with zero skips. Their command includes `--no-file-parallelism` because fixture roles are cluster-global; transaction concurrency within each test is preserved. This is integration SQL evidence, not merchant HTTP handler execution.

Receipts list exact commands and per-file passed/failed/skipped counts. Every expected case must pass with zero skips. GitHub run attempt, Owner original/triggering actor, exact integration SHA, successful required jobs/steps and authenticated artifact ZIP digests are verified. A green badge alone is insufficient.

## Separate private acceptance and schema snapshot

Reuse the existing private input pattern: `PRIVATE_RELEASE_RECEIPT`, `PRIVATE_RELEASE_ACCEPTANCE_REPORT`, and independently Owner-approved `PRIVATE_RELEASE_ACCEPTANCE_SHA256`. The report binds the immutable manifest, original baselines and exact verification run/attempt. These are trusted-gate inputs only; the deployment CLI child receives neither them nor GitHub/database credentials.

The fixed report cases distinguish actual hosted Owner AAL2 login and one operation-bound `payout_generate` prepare/verify from intercepted UI response fixtures. Correlate session/factor/challenge with the verified, unconsumed grant; record the rotated session before the generation request is intercepted. Require zero forwarded generation, approval, rejection, settlement-confirmation and provider requests. Security-state writes require their separately recorded Owner authorization. Browser interception proves the bounded request boundary, not universal absence of server-side writes. Local/CI custody and concurrency tests are not hosted business-route execution.

Merchant identity uses its existing four fields, plus independent pinned public-config Supabase project mapping. Admin identity is explicitly bounded to trusted control-plane and asset mapping. Neither proof invents a new runtime identity endpoint. Existing-main acceptance is supporting evidence only, not acceptance of a different reduced target.

Immediately before dispatch, use the existing authorized Supabase connector for read-only final-state evidence. Normalize according to `scripts/reduced-payout-schema-contract.json`: exact function-body bytes and explicit metadata/ACL, pinned owner identity, exact reviewed authorization table/action/security contract, session/audit prerequisites, enabled linkage trigger, currency columns and valid currency-aware index. Canonical source filenames establish provenance; they do not instruct replay of migrations whose final state is already equivalent. Existing compatible extra action values and service privileges are preserved in the reviewed fixed contract. Any genuine definition difference requires review of a concrete new policy, not a generic equivalence override.

Bind the connector report and raw evidence digest to the approved acceptance report. Include the canonical serving deployment's disabled payout cron flag observation (project and deployment runtime/build metadata); latest Git attempts are not serving identity. This snapshot expires after 15 minutes. The gate revalidates approval, code-run binding and snapshot freshness immediately before each application deployment. It does not query production continuously or claim that a historical snapshot proves current schema indefinitely.

Missing schema prerequisites require a separately reviewed ordered DDL plan and Owner authorization. This workflow never applies SQL, rewrites migration history, performs business backfills or reconciles legacy payout rows. M430 remains excluded.

## Production identity and stop behavior

Version 2 resolves the canonical alias first and verifies its exact approved original deployment ID/SHA, project, configured root and READY state. A differing project production target is allowed only when separately fetched evidence proves a same-project Git attempt was canceled by the exact ignored-build-step reason. Missing evidence, other cancellation, READY/building/queued divergence or changed aliases stop the gate. Version 1 retains its original semantics.

Before each deployment, recheck both applications' canonical identities; never redefine a partially deployed target as a baseline. Deploy exact target directories with explicit runtime/build source SHA flags and a small CLI environment. Verify the resulting control-plane identity and merchant runtime identity. Permission failures stop immediately. Partial failure requires private Owner recovery review; there is no automatic rollback or credential switch.

Code review and passing verification do not authorize a production release. Protected-main approval, concrete private acceptance/schema evidence and the normal Owner deployment gate remain separate. Payout and business-data writes remain blocked throughout this release procedure.
