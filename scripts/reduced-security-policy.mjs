import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { SECURITY_POLICY, SCHEMA_MAX_AGE_MS } from './reduced-release-evidence.mjs';
import { ACCOUNTING_TARGETS, ACCOUNTING_EVIDENCE_POLICY, ACCOUNTING_SQL_TESTS, ACCOUNTING_RUNTIME_SOURCES } from './reduced-accounting-policy.mjs';

export const SECURITY_IDENTITIES = JSON.parse(readFileSync(new URL('./reduced-security-targets.json', import.meta.url), 'utf8'));
export const SECURITY_STORAGE_CONTRACTS = JSON.parse(readFileSync(new URL('./reduced-security-storage-contracts.json', import.meta.url), 'utf8'));
export const SECURITY_MIGRATIONS = [
  { name: '491_private_document_storage.sql', sha256: 'a89883986b2cfe77da04e219777dadbea8e36abaf8114a41462dc4f026fa204a' },
  { name: '492_verification_public_upload_guard.sql', sha256: '18377b0c9e8ebb890a8a5fa1b640781c9ec3894ff3738673a4af8a3d8ba353dc' },
];
export const SECURITY_TARGETS = {
  merchant: { ...ACCOUNTING_TARGETS.merchant, allowed: Object.keys(SECURITY_IDENTITIES.merchant.blobs), blobs: SECURITY_IDENTITIES.merchant.blobs,
    suites: [...ACCOUNTING_TARGETS.merchant.suites, { tz: 'UTC', files: {
      'lib/__tests__/verification-document-access.test.ts': 7,
      'lib/__tests__/verification-private-upload.test.ts': 6,
      'lib/__tests__/webhook-registration-security.test.ts': 5,
      'lib/verification/documents.test.ts': 9,
      'lib/verification/relocate.test.ts': 8,
      'lib/webhooks/dispatcher.test.ts': 2,
      'lib/webhooks/public-destination.test.ts': 38,
      'lib/__tests__/verification-private-upload-render.test.tsx': 2,
    } }] },
  admin: { ...ACCOUNTING_TARGETS.admin, allowed: Object.keys(SECURITY_IDENTITIES.admin.blobs), blobs: SECURITY_IDENTITIES.admin.blobs,
    suites: [...ACCOUNTING_TARGETS.admin.suites, { tz: 'UTC', files: { 'src/__tests__/verification-private-view.test.tsx': 5 } }] },
};
export const SECURITY_STORAGE_TESTS = { 'lib/__tests__/private-storage-491.pg.test.ts': 17 };
export const SECURITY_SQL_TESTS = { ...ACCOUNTING_SQL_TESTS, ...SECURITY_STORAGE_TESTS };
export const SECURITY_RUNTIME_SOURCES = [...ACCOUNTING_RUNTIME_SOURCES, 'scripts/reduced-security-storage-tests.mjs',
  'lib/verification/documents.ts', 'lib/webhooks/public-destination.ts', 'lib/webhooks/dispatcher.ts',
  'app/api/verification/document/route.ts', 'app/api/admin/verification/document/route.ts',
  'app/api/verification/upload/route.ts', 'app/api/webhooks/route.ts'];
export const SECURITY_EVIDENCE_POLICY = {
  ...ACCOUNTING_EVIDENCE_POLICY, id: SECURITY_POLICY,
  acceptance_cases: [...ACCOUNTING_EVIDENCE_POLICY.acceptance_cases,
    { id: 'private-document-access', observed: { scope: 'exact-target-handler-and-disposable-sql-evidence', owner_allowed: true, other_tenant_denied: true, admin_aal2_required: true, arbitrary_locator_denied: true, no_hosted_document_mutation: true } },
    { id: 'private-document-viewers', observed: { scope: 'exact-target-rendered-fixtures', merchant_document_id: true, admin_document_id: true, signing_failure_denied: true } },
    { id: 'public-webhook-destination', observed: { scope: 'exact-target-mocked-network-evidence', public_allowed: true, private_denied: true, redirect_denied: true, dns_pinning: true, provider_calls: 0 } },
  ],
};
const fail = () => { throw new Error('Security prerequisite evidence is absent, stale, or mismatched'); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const ledgerName = name => name.replace(/\.sql$/, '');
const stage491 = '5d5d6acb547e6fe5c42ca770d3ad8844e0774d6ab4b1c27afd6bace30f80b481';
function rows(value) {
  if (!Array.isArray(value) || value.some(x => !x || Object.keys(x).sort().join(',') !== 'name,row_sha256,statement_sha256,version'
    || !hash(x.row_sha256) || !/^\d+$/.test(x.version) || !text(x.name) || !hash(x.statement_sha256))
    || new Set(value.map(x => x.version)).size !== value.length) fail();
  return value;
}
// Complete baseline rows are immutable. Only the explicitly bound M491 addition
// is allowed before application deployment; M492 and object closure are later
// operations, never instructions executed by this code-only gate.
export function verifySecurityPrerequisites(report, manifest, now = Date.now(), approvedAt = now) {
  if (manifest?.schema_version !== 4 || manifest.policy !== SECURITY_POLICY) fail();
  for (const environment of ['staging', 'production']) {
    const expected = manifest.storage_prerequisite?.[environment];
    const actual = report.storage_prerequisite?.[environment];
    const project = environment === 'staging' ? SECURITY_EVIDENCE_POLICY.staging_projects.merchant.supabase_project_ref : SECURITY_EVIDENCE_POLICY.production_project_ref;
    if (!expected || !actual || expected.environment !== environment || expected.project_ref !== project
      || !isDeepStrictEqual(actual.binding, expected) || actual.method !== 'authorized-connector-read-only'
      || !hash(actual.raw_evidence_sha256) || !text(actual.independent_review_reference)
      || actual.business_mutations !== 0 || actual.provider_calls !== 0 || actual.legacy_closure_complete !== false
      || actual.application_phase !== 'not-deployed'
      || !isDeepStrictEqual(actual.contracts, SECURITY_STORAGE_CONTRACTS[environment])) fail();
    const observed = Date.parse(actual.observed_at);
    if (!Number.isFinite(observed) || !Number.isFinite(now) || !Number.isFinite(approvedAt)
      || observed > now || now - observed > SCHEMA_MAX_AGE_MS || approvedAt < observed || approvedAt > now) fail();
    const before = rows(expected.baseline_ledger), after = rows(actual.ledger);
    if (!isDeepStrictEqual(after, rows(expected.expected_ledger))) fail();
    for (const row of before) if (!isDeepStrictEqual(after.find(x => x.version === row.version), row)) fail();
    const added = after.filter(x => !before.some(y => y.version === x.version));
    const one = (name, collection = after) => {
      const found = collection.filter(x => x.name === ledgerName(name) || x.name === ledgerName(name).replace(/^\d+_/, ''));
      if (found.length !== 1) fail(); return found[0];
    };
    const first = one(SECURITY_MIGRATIONS[0].name);
    if (environment === 'staging') {
      if (added.length || first.version !== '491' || first.statement_sha256 !== stage491
        || one(SECURITY_MIGRATIONS[1].name).statement_sha256 !== SECURITY_MIGRATIONS[1].sha256
        || actual.m492_phase !== 'already-installed'
        || !isDeepStrictEqual(actual.m491_provenance, { kind: 'historical-delimiter-reconciliation', canonical_sha256: SECURITY_MIGRATIONS[0].sha256, recorded_sha256: stage491, canonical_execution_proven: false })) fail();
    } else {
      if (added.length !== 1 || !isDeepStrictEqual(added[0], first)
        || after.some(x => [ledgerName(SECURITY_MIGRATIONS[1].name), ledgerName(SECURITY_MIGRATIONS[1].name).replace(/^\d+_/, '')].includes(x.name))
        || actual.m492_phase !== 'deferred-until-application'
        || actual.m491_provenance?.kind !== 'approved-canonical-prerequisite'
        || actual.m491_provenance.canonical_sha256 !== SECURITY_MIGRATIONS[0].sha256
        || !hash(expected.m491_envelope_sha256) || first.statement_sha256 !== expected.m491_envelope_sha256
        || actual.m491_provenance.executed_envelope_sha256 !== expected.m491_envelope_sha256
        || !hash(expected.m491_approval_receipt_sha256)
        || actual.m491_provenance.approval_receipt_sha256 !== expected.m491_approval_receipt_sha256
        || !text(actual.m491_provenance.execution_reference)) fail();
    }
  }
  return true;
}
