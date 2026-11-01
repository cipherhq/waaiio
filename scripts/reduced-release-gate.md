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
admin from its separate target checkout. Both projects are rechecked before each
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
