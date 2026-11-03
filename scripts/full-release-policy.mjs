import { readFileSync } from 'node:fs';
import { FULL_POLICY, digest } from './reduced-release-evidence.mjs';
import { SECURITY_EVIDENCE_POLICY, SECURITY_RUNTIME_SOURCES, SECURITY_STORAGE_TESTS } from './reduced-security-policy.mjs';
import { FULL_ACCOUNTING_SCHEMA_PROFILES, FULL_CATALOG_CONTRACTS } from './full-release-evidence.mjs';
import { ACCOUNTING_SQL_TESTS } from './reduced-accounting-policy.mjs';

export const FULL_IDENTITIES = JSON.parse(readFileSync(new URL('./full-release-targets.json', import.meta.url), 'utf8'));
export const FULL_SCHEMA_CONTRACT = JSON.parse(readFileSync(new URL('./full-release-schema-contract.json', import.meta.url), 'utf8'));
export const isFullRelease = m => m?.schema_version === 5 && m.policy === FULL_POLICY;
const merchantFiles = {
  "lib/verification/documents.test.ts": 9,
  "lib/verification/relocate.test.ts": 8,
  "lib/webhooks/dispatcher.test.ts": 2,
  "lib/webhooks/public-destination.test.ts": 38,
  "lib/__tests__/accounting-hold-payout-boundaries.test.ts": 16,
  "lib/__tests__/admin-bearer-route-handlers.test.ts": 31,
  "lib/__tests__/admin-cors-routes.test.ts": 32,
  "lib/__tests__/admin-mfa-transport.test.ts": 10,
  "lib/__tests__/admin-role-escalation.test.ts": 26,
  "lib/__tests__/admin-step-up-verification-609.test.ts": 11,
  "lib/__tests__/admin-team-api.test.ts": 22,
  "lib/__tests__/calendar-date.test.ts": 6,
  "lib/__tests__/canonical-step-up-compatibility.test.ts": 17,
  "lib/__tests__/channel-operation-admission.test.ts": 33,
  "lib/__tests__/fin-001-containment.test.ts": 89,
  "lib/__tests__/fin-002-atomic-payout.test.ts": 92,
  "lib/__tests__/finance-role-reconciliation.test.ts": 88,
  "lib/__tests__/m468-payout-safety.test.ts": 6,
  "lib/__tests__/manual-settlement-confirmation.test.ts": 20,
  "lib/__tests__/onboarding-whatsapp-all-plans.test.ts": 24,
  "lib/__tests__/p0-admin-capability-authority.test.ts": 22,
  "lib/__tests__/payout-account-autolink-620.test.ts": 6,
  "lib/__tests__/payout-accounting-hold-balance.test.ts": 11,
  "lib/__tests__/payout-approve-balance-logging.test.ts": 5,
  "lib/__tests__/payout-custody-formula.test.ts": 21,
  "lib/__tests__/payout-format-amount.test.ts": 7,
  "lib/__tests__/payout-list-currency.test.ts": 2,
  "lib/__tests__/payout-verification-limit-currency.test.ts": 9,
  "lib/__tests__/payout-verification-limit-enforcement.test.ts": 7,
  "lib/__tests__/paystack-cancellation-boundary-605.test.ts": 19,
  "lib/__tests__/reject-held-payouts-620.test.ts": 12,
  "lib/__tests__/subscribe-now-handler.test.ts": 49,
  "lib/__tests__/subscription-owner-downgrade-route.test.ts": 19,
  "lib/__tests__/subscription-owner-downgrade-ui.test.tsx": 7,
  "lib/__tests__/account-consent-settings-762.test.tsx": 20,
  "lib/__tests__/verification-document-access.test.ts": 7,
  "lib/__tests__/verification-private-upload-render.test.tsx": 2,
  "lib/__tests__/verification-private-upload.test.ts": 6,
  "lib/__tests__/webhook-registration-security.test.ts": 5,
  "lib/__tests__/whatsapp-templates-route-auth.test.ts": 14,
  "lib/onboarding/__tests__/staging-shared-us-routing.test.ts": 38,
  "lib/onboarding/__tests__/whatsapp-readiness.test.ts": 15,
  "app/dashboard/payouts/__tests__/accounting-hold-display.test.tsx": 7,
  "app/dashboard/payouts/__tests__/calendar-period-display.test.tsx": 2
};
export const fullInventoryDigest = kind => digest(JSON.stringify({ blobs: FULL_IDENTITIES[kind].blobs, deleted_blobs: FULL_IDENTITIES[kind].deleted_blobs }));
export const FULL_TARGETS = Object.fromEntries(Object.entries(FULL_IDENTITIES).map(([kind, identity]) => [kind, {
  allowed: [...Object.keys(identity.blobs), ...Object.keys(identity.deleted_blobs)].sort(),
  blobs: identity.blobs, deleted_blobs: identity.deleted_blobs,
  suites: [{ tz: 'UTC', files: kind === 'merchant' ? merchantFiles : { 'src/__tests__/verification-private-view.test.tsx': 5, 'src/__tests__/payout-generation-feedback.test.tsx': 4, 'src/__tests__/payouts-held-review-620.test.tsx': 19, 'src/__tests__/payout-generation-step-up.test.tsx': 9 } }, ...(kind === 'merchant' ? [{ tz: 'America/New_York', files: { 'lib/__tests__/calendar-date.test.ts': 6, 'app/dashboard/payouts/__tests__/calendar-period-display.test.tsx': 2 } }] : [])],
}]));
export const FULL_MAIN_SQL_TESTS = { ...ACCOUNTING_SQL_TESTS,
  'lib/__tests__/recurring-cancellation-503.pg.test.ts': 23,
  'lib/__tests__/manual-payout-reject-race.pg.test.ts': 5,
  'lib/__tests__/party-slug-foundation-504.pg.test.ts': 8,
  'lib/__tests__/subscription-owner-downgrade.pg.test.ts': 13,
  'lib/__tests__/full-release-additive-506.pg.test.ts': 19,
};
export const FULL_SQL_TESTS = { ...FULL_MAIN_SQL_TESTS, ...SECURITY_STORAGE_TESTS };
export const FULL_RUNTIME_SOURCES = [...SECURITY_RUNTIME_SOURCES, 'lib/channels/operation-admission.ts'];
export const FULL_EVIDENCE_POLICY = {
  ...SECURITY_EVIDENCE_POLICY, id: FULL_POLICY,
  // Accounting proof is cumulative; the separate complete-catalog gate remains
  // unfrozen and cannot be satisfied by this component alone.
  ...FULL_ACCOUNTING_SCHEMA_PROFILES.production,
};
export function requireFrozenFullRelease() {
  // Only checked-in reviewed policy is authority; no manifest/report override.
  if (FULL_SCHEMA_CONTRACT.status !== 'frozen' || FULL_SCHEMA_CONTRACT.missing_contracts.length
    || FULL_CATALOG_CONTRACTS.status !== 'frozen'
    || digest(readFileSync(new URL('./full-release-catalog-contracts.json', import.meta.url))) !== FULL_SCHEMA_CONTRACT.catalog_contract_sha256) throw new Error('Full release deployment contract is unfrozen');
  for (const environment of ['staging','production']) {
    const profile=FULL_SCHEMA_CONTRACT.profiles?.[environment];
    const phase=environment==='staging'?'post_app':'pre_app';
    if (!profile || profile.required_phase!==phase || !profile.ledger_additions?.length
      || profile.migration_dispositions?.length!==FULL_SCHEMA_CONTRACT.migration_reconciliation.length
      || !FULL_CATALOG_CONTRACTS.profiles?.[environment]?.phases?.[phase]
      || profile.runtime_controls?.channel_operations?.project!==false
      || profile.runtime_controls?.channel_operations?.build!==false
      || profile.runtime_controls?.channel_operations?.runtime!==false
      || profile.runtime_controls?.scheduled_jobs_paused!==true || profile.runtime_controls?.signup_open!==false) throw new Error('Full release fixed phase contract is incomplete');
  }
}
