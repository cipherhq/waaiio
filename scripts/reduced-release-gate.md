# Reduced presentation release gate

This separate gate supports a bounded presentation release when merchant and
admin run different source histories. It does not modify or bypass the phased
migration gate. No database operations or provider/payment exercises are part of
this workflow.

## Source and review chain

Each source target must descend from its own project's live baseline and be an
ancestor of the reviewed protected-main integration commit. That integration
contains the trusted helper/workflows, and must have fresh successful push-main
CI. The main CI run does not substitute for testing the two older source trees.

The fixed merchant allowlist is the two payout page formatters, calendar-date
helper, its unit test and mounted period-display fixture. The admin allowlist is
the payout-result display and feedback test. Any migration, API/backend, package,
workflow, unrelated file, deletion or rename in a source target's baseline delta
fails closed. There is no generic migration exemption. The app targets are
separate commits; the integration tree itself is not deployed.

## Private manifest

The Owner provisions `REDUCED_RELEASE_MANIFEST` as a GitHub secret only after
reviewing exact source identities and baselines. Schema1 has `integration_sha`
and `projects.merchant` / `projects.admin`, each containing pinned `project_id`,
`baseline_sha`, `target_sha` and `target_tree`. This code contains no live baseline
or target receipt values. The manifest must match the workflow's exact control
SHA and must not be written into a target checkout or uploaded as an artifact.

## Exact-target verification

Owner dispatches `verify-reduced-release.yml` at the reviewed integration ref.
The plan job validates protected-main CI, ancestry and bounded deltas. Separate
jobs check out the trusted helper and exact source target with persisted Git
credentials disabled. The trusted helper measures actual clean checkout SHA/tree,
runs `npm ci`, focused tests and build in the target app, and measures clean
identity again afterward.

Merchant tests run in UTC and America/New_York, each requiring six helper tests
and two mounted display tests. Admin requires four feedback tests plus nineteen
existing held-review tests. JSON reports must include every exact file and all
expected assertions with zero failures/skips. The wrapper records actual command
provenance and per-file counts only after success.

Target install/test/build subprocesses receive an explicit environment allowlist
and placeholder public build settings. They do not inherit the private manifest,
GitHub token, production credentials or provider keys. Verification jobs have no
production/provider secrets. They run source from their own checkout; the helper
always comes from the trusted integration checkout.

Artifacts contain only `receipt.json`: code project kind, integration SHA, tested
source SHA/tree, run/attempt, commands, per-file counts and build outcome. They do
not contain production baselines, deployment IDs, private manifest or credentials.
The artifact name includes run ID and attempt to distinguish reruns.

## Deployment gate

Owner dispatches `deploy-reduced-release.yml` at that same integration ref with
the successful verification run ID/attempt. This job separately checks out both
source targets. Before its first deployment operation it verifies:

- fresh exact push-main CI for the trusted integration;
- both source lineages, clean SHA/tree checkouts and fixed file allowlists;
- authenticated verification run repository, Owner actor/triggering actor,
  workflow path, integration SHA, attempt and successful job/step evidence;
- unique non-expired artifacts from that exact run/attempt, archive SHA256,
  exact ZIP contents and each source receipt's commands/files/counts/build;
- both production projects' current baseline SHA, READY deployment, active
  target, public alias and expected root directory.

The GitHub credential is never forwarded to signed artifact storage URLs. Artifact
bytes are downloaded from the authenticated run and hashed; a caller-supplied
JSON report is not accepted in place of those artifacts.

Only then does the pinned Vercel CLI deploy merchant from its target checkout and
admin from its separate target checkout. Each deployment explicitly passes its
verified source SHA as `VERCEL_GIT_COMMIT_SHA` through both `--env` and
`--build-env`; local process environment and Git metadata are not substitutes for
runtime/build environment transport. The control integration SHA is never used
as either app's runtime identity. Both projects are rechecked before each
mutation. Each created deployment must have the expected project/SHA and its own
exact captured ID; same-SHA replacement IDs do not satisfy that check. Serving
verification uses bounded read-only polling, public health, merchant runtime
identity and both public aliases. Permission failures stop without retrying or
switching credentials. No deployment retry or automatic rollback occurs.

The older merchant runtime identity contract reports SHA/project/deployment/env,
not a database project reference. This gate checks the supported fields and
preserves the pinned production project/environment configuration. It does not
claim runtime database-ref proof or modify application APIs.

A partial release cannot be replayed by treating a now-live target as the old
baseline. Stop for private Owner review if a project fails or identity drifts.
Do not silently redeploy, redefine the baseline or run recovery mutations.
Operational receipts/manifests remain private; CLI output is captured and the
workflow logs only minimal gate outcome, not tokens or live identity records.

## Verification and limits

Run the executable local tests with:

```
npx vitest run scripts/__tests__/reduced-release-gate.test.ts scripts/__tests__/reduced-release-gate-integration.test.ts
```

Tests use local Git fixtures, actual ZIP parsing and the real orchestration code,
with every external request mocked and unknown requests rejected. CLI/npm test
boundaries use fake executables. Synthetic test artifacts are never actual CI or
hosted acceptance evidence. Deployment still requires real exact-target CI and
normal independent review/Owner authorization; those are not inferred from local
unit-test results.

### Accounting-hold v3 profile

`schema_version: 3`, `policy: accounting-hold-v1` selects a separate fixed source, test and active-schema contract. V1 and v2 retain their existing rules. Merchant source is the reduced accounting descendant; admin source remains separately pinned. Ordinary ancestry, protected-main CI, exact-target checkout/build and authenticated run/attempt/artifact checks still apply. The workflow's existing `payout_policy` capability output enables required private evidence and isolated PostgreSQL tests for both v2 and v3; it is not a migration bypass.

The v3 manifest additionally binds independent `accounting_activation.staging` and `.production` objects: environment/project, verified audit actor UUID, approved manifest and executed envelope SHA256, cohort and Owner approval receipt SHA256, exact hold/member/audit/preserved-pending counts, and preserved-pending row digest. Do not copy staging counts into production. Bind this immutable manifest before generating the independently reviewed report.

Each report activation record must contain that exact binding, actual commit/read-back timestamps, independently reviewed Owner references, exact fixed schema contracts and source hashes, raw evidence and hold/member/audit row digests, zero existing-financial-row changes and zero provider calls. It must attest active dispatcher/private helpers, recurring definitions, guards/index, ownership/config/ACL and cohort—not merely installer ledger rows. Read-back freshness and disabled payout-cron evidence are rechecked before each deployment mutation. Installer source filenames are provenance, not instructions to replay SQL.

These are code deployment gates only. They never execute DDL, enroll a cohort, reconcile a payment, release a hold or call a provider. Activation and later post-fence restoration require their separately approved operational envelopes. Intercepted hosted UI acceptance is labeled UI-only; actual held server denial is supported by exact-target handler and disposable SQL evidence, not inferred from an intercepted request. No operational report, account identifier, cohort list or approval receipt belongs in public code or Actions output.

V3 uses two finite schema profiles exported as `ACCOUNTING_SCHEMA_PROFILES`. Staging requires service-role SELECT/INSERT/UPDATE on step-up grants; production retains its full fixed table ACL. Production also pins explicit application-role EXECUTE entries on the three public payout flag/linkage helpers whose staging ACL contains owner and PUBLIC entries. These are exact environment contracts, not permission-subset matching. Unknown grantees, changed grantors/grantability, private execution grants and cross-environment profile substitution fail. No database permissions are modified by the verifier.

Profile digests are SHA256 of UTF-8 JSON with recursively sorted object keys, compact separators, preserved array order and no trailing newline. The staging step-up sub-contract digest uses the same recipe without its own `contract_sha256` field. The production-schema evidence gate selects the production profile; each activation record selects its independently pinned environment profile. Report producers must use these expanded contracts/digests and retain raw observations. Return metadata follows the fixed contract recipe (normalized TABLE return formatting; procedure return type from its catalog type). This formatting does not normalize ACLs or relax definition/security/ownership equality.

### Private report transport

`PRIVATE_RELEASE_ACCEPTANCE_REPORT` accepts either the original raw JSON text or `gzip-base64-v1:` followed by canonical padded base64 of its gzip bytes. The complete compressed envelope must be smaller than 48 KiB; decompressed output is limited to 1 MiB and must be valid UTF-8. Raw JSON also has a 1 MiB byte limit. Unsupported prefixes, malformed/truncated data, invalid base64/UTF-8 and oversized input fail with a generic error before external checks or deployment. No payload is logged.

The trusted gate decodes once per private-evidence invocation and passes the same original text to digest approval verification and accounting activation validation. The approved SHA256 always covers original uncompressed report bytes, including their exact whitespace; it never covers the gzip/base64 envelope. No report reserialization or approval regeneration is implied by encoding. Keep the original receipt/report/digest evidence private and unchanged. Only the acceptance-report secret uses this transport; manifest and approval receipt formats remain unchanged.
