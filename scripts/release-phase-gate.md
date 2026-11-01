# Phased release gate contract

Release manifests, prepared receipts and acceptance reports are private inputs,
not embedded operational records. Do not provision secrets from synthetic test
fixtures or treat test results as evidence of a production deployment.

## Execution contract

1. Review and merge the ancestry reconciliation and workflow/helper changes
   through protected-main gates. Independently review the complete manifest and
   provision its exact bytes as the Owner-managed `PRIVATE_RELEASE_MANIFEST`
   secret; never commit its operational mappings to the repository. Do not
   publish code changes without the Owner's audience authorization.
2. Manifest schema1 pins `baseline_sha` to the original live merchant revision.
   Its `migrations` object must exactly cover the original baseline-to-target
   migration delta. Entries carry `phase`, file `sha256`, `ledger_name`, and
   predeploy `ledger_version`. No general exemptions or equivalence flags exist.
3. Only the exact reviewed M492 file/hash can use `phase: post`. Its actual
   ledger version is discovered by unique exact name/hash after MCP application.
   M431/M432 may use `bundle: 431_432` only with a shared manifest-bound numeric ledger
   version, the fixed bundle name and exact `BEGIN;\n` + M431 + `\n` + M432 + `\nCOMMIT;` hash.
4. Owner dispatches `prepare` on the exact reviewed target ref/SHA. Gate checks
   successful exact protected-main CI, both live app ancestries, original
   merchant baseline, aliases, all predeploy SQL, and absent M492. The workflow
   deploys merchant/admin and verifies both exact READY identities and aliases.
   A successful prepare is explicitly **not** a completed release.
5. Independently record and review the actual prepared app IDs and hosted
   acceptance evidence. Intercept all fixture writes; do not create business
   data, run payouts, contact providers, or relocate legacy storage objects.
   Apply approved M492 separately through MCP only after required acceptance.
6. Owner provisions the private secrets below from the actual reviewed evidence,
   then dispatches `finalize` for the same exact target. Finalize never deploys
   apps or executes DDL. It rechecks the original delta and all actual ledger SQL,
   both app IDs, protected-main CI and the referenced successful prepare attempt.
   It verifies the actual merchant/admin deployment and pre-postcheck steps ran,
   so a successful finalize run cannot masquerade as prepare evidence.

## Owner-managed private evidence secrets

These are the authenticated private evidence transport and approval boundary.
The workflow does not create or modify these secrets, sign its own evidence, or
accept a caller-provided `passed: true` in place of a reviewed report.

- `PRIVATE_RELEASE_MANIFEST`: complete schema1 manifest JSON bytes. The gate
  reads only this secret, never a checked-in manifest file. Keep identical bytes
  through prepare and finalize: the receipt binds their exact SHA256. Missing
  or malformed input fails closed without logging its contents.
- `PRIVATE_RELEASE_RECEIPT`: JSON schema1 binding `baseline_sha`, `target_sha`,
  exact `manifest_sha256`, `deployments.merchant` and `deployments.admin` IDs,
  `prepare_run_id`, integer `prepare_run_attempt`, and
  `acceptance_artifact_sha256`.
- `PRIVATE_RELEASE_ACCEPTANCE_REPORT`: complete independently reviewed JSON
  evidence bytes. Must bind those same identities and run fields; include
  `started_at`, `completed_at`, `suite`, runner name/version/command/run_id and
  exact `source_sha`, independent reviewer/reference, and Owner acceptance
  reference. `network` must record fixture writes intercepted, zero business
  mutations and zero provider calls. Summary has exactly six passed cases,
  zero failed and zero skipped. Each case includes the exact expected contract,
  actual observed outcomes, `outcome: passed`, and actual evidence SHA256.
- `PRIVATE_RELEASE_ACCEPTANCE_SHA256`: separately approved SHA256 of the exact
  full report bytes, matching the receipt. Any byte change requires renewed
  independent review and Owner-managed evidence provisioning.

Required named cases are defined in `ACCEPTANCE_CASES`: merchant owner viewer,
other-tenant denial without disclosure/redirect (403 or RLS-filtered404), full
admin AAL2 viewer, password-only admin denial, intercepted private uploader path
with private bucket/locator destination, and public catalog media compatibility.
Source/fixture evidence is bounded acceptance, not live provider or business-write
certification, and it does not certify legacy-object relocation/privacy.

Receipt IDs must match currently active project targets and public aliases,
not merely another deployment of the same SHA. Report hashes are compared before
parsing. Secrets/report contents and ledger metadata are never logged; stdout
contains phase state and counts only. Missing or malformed evidence fails closed.

## Recovery

No automatic rollback occurs. Previous app IDs are recorded only during prepare;
postdeployment checks cannot overwrite them with the newly active IDs. Any
recovery requires Owner authorization and schema/application compatibility review.
After M492, do not restore the old public uploader without a separately approved
recovery plan. Report partial state honestly.

## Local verification

From the repository root with dependencies installed:

```
npx vitest run scripts/__tests__/release-phase-gate.test.ts scripts/__tests__/release-phase-gate-integration.test.ts
```

The tests execute the real validator and `runGate` using temporary local Git
repositories, completely mocked fetch, and a rejection of unknown network calls.
Admin promotion shell tests execute the actual workflow shell with fake
`vercel`/`curl` binaries. Tests use synthetic identities and evidence only; they
perform no live API calls, deployment, SQL execution or secret provisioning.
Passing these tests does not establish a real release acceptance report exists.
