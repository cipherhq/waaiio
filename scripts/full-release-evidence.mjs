import { verifyCatalogTransition, verifyCatalogSequence, catalogDigest } from './full-release-catalog.mjs';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { FULL_POLICY, SCHEMA_MAX_AGE_MS, digest } from './reduced-release-evidence.mjs';
import { ACCOUNTING_SCHEMA_PROFILES, verifyAccountingActivationWithTrustedProfiles } from './reduced-accounting-policy.mjs';
import { observeSecurityLedger, SECURITY_LEDGER_RECIPE } from './reduced-security-policy.mjs';
const schema = JSON.parse(readFileSync(new URL('./full-release-schema-contract.json', import.meta.url), 'utf8'));
export const FULL_CATALOG_CONTRACTS = JSON.parse(readFileSync(new URL('./full-release-catalog-contracts.json', import.meta.url), 'utf8'));
const catalogQuery=readFileSync(new URL('./full-release-catalog-query.sql', import.meta.url));
if (digest(catalogQuery) !== FULL_CATALOG_CONTRACTS.query_sha256) throw new Error('Full catalog query source changed');
for (const [authority, sources] of Object.entries(FULL_CATALOG_CONTRACTS.source_authorities)) {
  if (!Array.isArray(sources) || !sources.length || sources.some(s=>!schema.canonical_sources.some(c=>c.name===s.name && c.sha256===s.sha256))
    || authority !== (sources.length===1?sources[0].sha256:catalogDigest(sources))) throw new Error('Full catalog patch source changed');
}
for (const environment of Object.values(FULL_CATALOG_CONTRACTS.profiles)) for (const phase of Object.values(environment.phases)) {
  if (phase.query_sha256!==FULL_CATALOG_CONTRACTS.query_sha256 || phase.patches.some(p=>!FULL_CATALOG_CONTRACTS.source_authorities[p.source_sha256])) throw new Error('Full catalog patch authority is missing');
}
export function verifyFullCatalogPhase(environment, phase, actual, binding) {
  const trusted=FULL_CATALOG_CONTRACTS.profiles?.[environment]?.phases?.[phase];
  if (!trusted) fail();
  return verifyCatalogTransition(actual,binding,trusted);
}
export function verifyFullDeploymentCatalog(environment, actual, binding) {
  const phases=FULL_CATALOG_CONTRACTS.profiles?.[environment]?.phases;
  if (!phases || !['staging','production'].includes(environment)) fail();
  // Staging acceptance has completed its post-app contract; production is
  // intentionally still expanded before this invocation deploys its apps.
  const sequence=environment==='staging'?[phases.pre_app,phases.post_app]:[phases.pre_app];
  return verifyCatalogSequence(actual,binding,sequence);
}
export const FULL_COMPONENT_CONTRACTS = JSON.parse(readFileSync(new URL('./full-release-component-contracts.json', import.meta.url), 'utf8'));
const canonical = value => JSON.stringify(sortKeys(value));
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
export const FULL_ACCOUNTING_SCHEMA_PROFILES = Object.fromEntries(Object.entries(ACCOUNTING_SCHEMA_PROFILES).map(([environment, original]) => {
  const contracts = structuredClone(original.schema_contracts);
  const patch = FULL_COMPONENT_CONTRACTS.accounting_finalizer_patch;
  const functions = contracts.accounting_active.functions.filter(fn => fn.schema === patch.schema && fn.name === patch.name);
  if (functions.length !== 1 || functions[0].body_sha256 !== patch.previous_body_sha256) throw new Error('Unexpected prior accounting finalizer contract');
  functions[0].body_sha256 = patch.body_sha256;
  return [environment, {schema_contracts:contracts,schema_contract_sha256:digest(canonical(contracts))}];
}));
const fail = () => { throw new Error('Full release evidence is incomplete, stale, or differs from its fixed environment contract'); };
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const text = x => typeof x === 'string' && x.trim().length > 0;
const full = m => m?.schema_version === 5 && m.policy === FULL_POLICY;
function fresh(actual, now, approvedAt) {
  const at = Date.parse(actual?.observed_at);
  if (!Number.isFinite(at) || !Number.isFinite(now) || !Number.isFinite(approvedAt) || at > now
    || now - at > SCHEMA_MAX_AGE_MS || approvedAt < at || approvedAt > now
    || actual.method !== 'authorized-connector-read-only' || !hash(actual.raw_evidence_sha256)
    || !text(actual.independent_review_reference) || actual.business_mutations !== 0 || actual.provider_calls !== 0) fail();
}
// Partial component proof is intentionally separate from full catalog authority.
// It cannot satisfy verifyFullReleaseEvidence or enable deployment on its own.
export function fullKnownComponentProjection(environment, phase = 'post_app') {
  const original=FULL_COMPONENT_CONTRACTS.projections[environment];
  if (!original || !['pre_app','post_app'].includes(phase)) fail();
  const expected=structuredClone(original);
  // Production435 deliberately follows the application switch. Its existing
  // complete metadata remains bound by the pre-app catalog preservation proof.
  if (environment==='production' && phase==='pre_app') expected.financial_functions=expected.financial_functions.filter(f=>!f.identity.startsWith('create_order_atomic('));
  return expected;
}
export function verifyFullKnownComponents(environment, observed, phase = 'post_app') {
  const expected = fullKnownComponentProjection(environment, phase);
  if (!expected || !isDeepStrictEqual(observed, expected)) fail();
  return true;
}
export function verifyFullReleaseEvidence(report, manifest, now = Date.now(), approvedAt = now) {
  if (!full(manifest) || schema.status !== 'frozen' || schema.missing_contracts.length
    || !schema.profiles?.staging || !schema.profiles?.production) fail();
  return verifyFullPreparedEvidence(report, manifest, now, approvedAt);
}
// Executable contract proof while deployment remains gated by the reviewed freeze.
// This helper performs no network/CLI work and never supplies deployment authority.
export function verifyFullPreparedEvidence(report, manifest, now = Date.now(), approvedAt = now) {
  if (!full(manifest) || !schema.profiles?.staging || !schema.profiles?.production) fail();
  const profiles = schema.profiles;
  verifyFullAccountingActivation(report, manifest, now, approvedAt);
  for (const environment of ['staging', 'production']) {
    const fixed = profiles[environment];
    const expected = manifest.full_release?.[environment];
    const actual = report.full_release?.[environment];
    if (!actual || !expected || actual.environment !== environment || expected.environment !== environment
      || expected.project_ref !== fixed.project_ref || actual.project_ref !== fixed.project_ref
      || !isDeepStrictEqual(actual.binding, expected)) fail();
    fresh(actual, now, approvedAt);
    // Pre-app expansion is a distinct fixed contract; contracted metadata is checked after the application switch.
    const phase=environment==='staging'?'post_app':'pre_app';
    if (actual.catalog?.phase !== phase) fail();
    verifyFullDeploymentCatalog(environment, actual.catalog, expected.catalog);
    verifyFullKnownComponents(environment, actual.components, phase);
    if (!isDeepStrictEqual(actual.runtime_controls, fixed.runtime_controls)
      || actual.runtime_controls?.channel_operations?.project !== false
      || actual.runtime_controls?.channel_operations?.build !== false
      || actual.runtime_controls?.channel_operations?.runtime !== false) fail();
    if (!isDeepStrictEqual(actual.migration_dispositions, fixed.migration_dispositions)) fail();
    verifyFullLedger(actual.ledger_rows, expected, fixed.ledger_additions);
    if (actual.storage_closure?.status !== 'existing-legacy-scope-preserved-deferred'
      || !Number.isSafeInteger(expected.storage_closure?.legacy_verification_references)
      || expected.storage_closure.legacy_verification_references < 0
      || !Number.isSafeInteger(expected.storage_closure?.legacy_verification_objects)
      || expected.storage_closure.legacy_verification_objects < 0
      || actual.storage_closure.legacy_verification_references !== expected.storage_closure.legacy_verification_references
      || actual.storage_closure.legacy_verification_objects !== expected.storage_closure.legacy_verification_objects
      || !hash(actual.storage_closure?.preserved_object_rows_sha256)
      || actual.storage_closure.preserved_object_rows_sha256 !== expected.storage_closure?.preserved_object_rows_sha256
      || !hash(actual.storage_closure?.preserved_reference_rows_sha256)
      || actual.storage_closure.preserved_reference_rows_sha256 !== expected.storage_closure?.preserved_reference_rows_sha256) fail();
  }
  return true;
}

// Called with fixed source rules, never with rules selected from report content.
export function verifyFullLedger(rows, expected, rules) {
  if (!Array.isArray(expected.allowed_additions) || !Array.isArray(rules)
    || expected.allowed_additions.length !== rules.length) fail();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i], row = expected.allowed_additions[i];
    if (row.name !== rule.name || row.statement_sha256 !== rule.statement_sha256) fail();
  }
  // Recompute complete-set aggregates from observed rows, never trust a
  // report's assertion that only the allowed versions changed.
  const ledger = observeSecurityLedger(rows, expected.allowed_additions);
  if (expected.ledger_digest_recipe !== SECURITY_LEDGER_RECIPE
    || ledger.baseline_count !== expected.baseline_ledger?.count
    || ledger.baseline_sha256 !== expected.baseline_ledger?.sha256
    || ledger.count !== expected.expected_ledger?.count || ledger.sha256 !== expected.expected_ledger?.sha256
    || ledger.count !== ledger.baseline_count + expected.allowed_additions.length) fail();
  return true;
}

export function verifyFullAccountingActivation(report, manifest, now = Date.now(), approvedAt = now) {
  if (!full(manifest)) fail();
  return verifyAccountingActivationWithTrustedProfiles(report, manifest, FULL_ACCOUNTING_SCHEMA_PROFILES, now, approvedAt);
}
