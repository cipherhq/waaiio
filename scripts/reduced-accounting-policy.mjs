import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { ACCOUNTING_POLICY, digest, SCHEMA_MAX_AGE_MS } from './reduced-release-evidence.mjs';
import { PAYOUT_TARGETS, PAYOUT_EVIDENCE_POLICY, INTEGRATION_SQL_TESTS, INTEGRATION_RUNTIME_SOURCES } from './reduced-payout-policy.mjs';

const inventory = JSON.parse(readFileSync(new URL('./reduced-accounting-targets.json', import.meta.url), 'utf8'));
export const ACCOUNTING_TARGETS = {
  merchant: { ...PAYOUT_TARGETS.merchant, allowed: Object.keys(inventory.merchant), blobs: inventory.merchant,
    suites: [...PAYOUT_TARGETS.merchant.suites, { tz: 'UTC', files: {
      'lib/__tests__/accounting-hold-payout-boundaries.test.ts': 14,
      'lib/__tests__/payout-accounting-hold-balance.test.ts': 10,
      'app/dashboard/payouts/__tests__/accounting-hold-display.test.tsx': 7,
    } }] },
  admin: { ...PAYOUT_TARGETS.admin, blobs: inventory.admin },
};
const bytes = readFileSync(new URL('./reduced-accounting-schema-contract.json', import.meta.url), 'utf8');
export const ACCOUNTING_EVIDENCE_POLICY = {
  ...PAYOUT_EVIDENCE_POLICY, id: ACCOUNTING_POLICY,
  schema_contract_sha256: digest(bytes), schema_contracts: JSON.parse(bytes),
  acceptance_cases: [...PAYOUT_EVIDENCE_POLICY.acceptance_cases,
    { id: 'held-balance-display', observed: { scope: 'intercepted-ui-fixtures', provisional_totals: true, held_notice: true, stale_business_ignored: true } },
    { id: 'connected-custody-display', observed: { scope: 'intercepted-ui-fixtures', direct_split_unchanged: true, no_duplicate_manual_obligation: true } },
    { id: 'held-authority-proof', observed: { scope: 'exact-target-handler-and-disposable-sql-evidence', held_denied: true, unheld_allowed: true, lookup_error_denied: true, no_hosted_financial_request: true } },
  ],
};
export const ACCOUNTING_SQL_TESTS = { ...INTEGRATION_SQL_TESTS,
  'lib/__tests__/accounting-migration-installation.pg.test.ts': 42,
  'lib/__tests__/legacy-accounting-hold.pg.test.ts': 42,
  'lib/__tests__/recurring-payment-provenance.pg.test.ts': 13,
};
export const ACCOUNTING_RUNTIME_SOURCES = [...INTEGRATION_RUNTIME_SOURCES, 'lib/payouts/accounting-hold.ts'];
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const text = x => typeof x === 'string' && x.trim().length > 0;
const fail = () => { throw new Error('Accounting activation evidence is absent, stale, or mismatched'); };

// Authenticated Owner-managed report transport and independent report approval
// are checked by verifyPrivateEvidence first. These are observed activation
// receipts, never instructions to CALL a procedure or mutate a cohort.
export function verifyAccountingActivation(report, manifest, now = Date.now(), approvedAt = now) {
  if (manifest?.schema_version !== 3 || manifest.policy !== ACCOUNTING_POLICY) fail();
  const sources = ACCOUNTING_EVIDENCE_POLICY.schema_contracts.canonical_sources.filter(x => /^50[01]_/.test(x.name));
  for (const environment of ['staging', 'production']) {
    const expected = manifest.accounting_activation?.[environment];
    const actual = report.accounting_activation?.[environment];
    const project = environment === 'staging' ? ACCOUNTING_EVIDENCE_POLICY.staging_projects.merchant.supabase_project_ref : ACCOUNTING_EVIDENCE_POLICY.production_project_ref;
    if (!expected || !actual || expected.environment !== environment || expected.project_ref !== project
      || !uuid(expected.actor_id) || !hash(expected.approved_manifest_sha256) || !hash(expected.executed_envelope_sha256)
      || !hash(expected.cohort_sha256) || !hash(expected.approval_receipt_sha256)
      || !isDeepStrictEqual(actual.binding, expected) || !text(actual.owner_approval_reference)
      || !text(actual.independent_review_reference) || actual.method !== 'authorized-connector-read-only'
      || actual.active !== true || actual.installation_only !== false
      || actual.schema_contract_sha256 !== ACCOUNTING_EVIDENCE_POLICY.schema_contract_sha256
      || !isDeepStrictEqual(actual.contracts, ACCOUNTING_EVIDENCE_POLICY.schema_contracts)
      || !isDeepStrictEqual(actual.canonical_installers, sources)
      || !hash(actual.raw_evidence_sha256) || !hash(actual.audit_rows_sha256)
      || !hash(actual.hold_rows_sha256) || !hash(actual.membership_rows_sha256)
      || actual.existing_financial_rows_changed !== 0 || actual.provider_calls !== 0) fail();
    const observed = Date.parse(actual.observed_at), committed = Date.parse(actual.committed_at);
    if (!Number.isFinite(observed) || !Number.isFinite(committed) || committed > observed || observed > now
      || now - observed > SCHEMA_MAX_AGE_MS || !Number.isFinite(approvedAt) || approvedAt < observed) fail();
    for (const field of ['holds', 'memberships', 'audit_rows', 'preserved_pending_payments']) {
      if (!Number.isSafeInteger(expected.counts?.[field]) || expected.counts[field] < 0
        || actual.counts?.[field] !== expected.counts[field]) fail();
    }
    if (expected.counts.audit_rows !== expected.counts.holds + expected.counts.memberships) fail();
    if (!hash(expected.preserved_pending_rows_sha256)
      || actual.preserved_pending_rows_sha256 !== expected.preserved_pending_rows_sha256) fail();
  }
  if (manifest.accounting_activation.staging.approval_receipt_sha256 === manifest.accounting_activation.production.approval_receipt_sha256) fail();
  return true;
}
