import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyRelease, hash, POST_FILE, POST_HASH, PROJECTS, ENGAGE_BUNDLE, verifyReceiptBinding, verifyReviewedAcceptance, ACCEPTANCE_CASES } from '../release-phase-gate.mjs';

const BASE = 'a'.repeat(40), TARGET = 'b'.repeat(40);
const PRE = 'supabase/migrations/001_example.sql';
function fixture(mode = 'prepare') {
  const pre = '-- synthetic migration\n';
  const post = readFileSync(POST_FILE);
  return {
    mode, target: TARGET, baselineIsAncestor: true,
    manifest: { schema_version: 1, baseline_sha: BASE, migrations: {
      [PRE]: { phase: 'pre', sha256: hash(pre), ledger_name: 'example', ledger_version: '1' },
      [POST_FILE]: { phase: 'post', sha256: POST_HASH, ledger_name: '492_verification_public_upload_guard' },
    } },
    changed: [PRE, POST_FILE], removed: [], files: { [PRE]: pre, [POST_FILE]: post },
    ledger: [{ version: '1', name: 'example', applied_sha256: hash(pre), stmt_count: 1 }],
    deployments: Object.fromEntries(Object.entries(PROJECTS).map(([kind, config]: any) => [kind, {
      id: `dpl_${kind}`, activeId: `dpl_${kind}`, aliasId: `dpl_${kind}`, projectId: config.id,
      readyState: 'READY', sha: mode === 'prepare' ? BASE : TARGET,
    }])),
  };
}
function addPost(input: any) {
  input.ledger.push({ version: '20000102000000', name: '492_verification_public_upload_guard', applied_sha256: POST_HASH, stmt_count: 1 });
}
describe('actual phased production release verifier', () => {
  it('prepares with only exact applied predeploy SQL and pending pinned M492', () => {
    expect(verifyRelease(fixture()).pending).toEqual([POST_FILE]);
  });
  it('does not certify release while awaiting postdeploy', () => {
    expect(verifyRelease(fixture('ready-for-post')).state).toBe('awaiting-postdeployment-verification');
  });
  it('ledger and both app identities alone still await private acceptance', () => {
    const f = fixture('finalize'); addPost(f);
    expect(verifyRelease(f).state).toBe('awaiting-private-acceptance-verification');
  });
  it('rejects finalize with missing postdeploy SQL', () => expect(() => verifyRelease(fixture('finalize'))).toThrow('Missing or ambiguous'));
  it('rejects re-running prepare after app switch', () => {
    const f = fixture(); f.deployments.merchant.sha = TARGET;
    expect(() => verifyRelease(f)).toThrow('baseline changed');
  });
  it('rejects re-running prepare after postdeploy SQL', () => {
    const f = fixture(); addPost(f); expect(() => verifyRelease(f)).toThrow('already present');
  });
  it('rejects missing manifest entry', () => {
    const f: any = fixture(); delete f.manifest.migrations[PRE]; expect(() => verifyRelease(f)).toThrow('accounted for');
  });
  it('rejects unknown manifest entries', () => {
    const f: any = fixture(); f.manifest.migrations.other = {}; expect(() => verifyRelease(f)).toThrow('accounted for');
  });
  it('rejects changed bytes', () => {
    const f = fixture(); f.files[PRE] = '-- tampered'; expect(() => verifyRelease(f)).toThrow('File hash');
  });
  it('rejects tampered production SQL hash', () => {
    const f = fixture(); f.ledger[0].applied_sha256 = 'c'.repeat(64); expect(() => verifyRelease(f)).toThrow('Ledger SQL');
  });
  it('rejects multiple stored statement fragments', () => {
    const f = fixture(); f.ledger[0].stmt_count = 2; expect(() => verifyRelease(f)).toThrow('Ledger SQL');
  });
  it('rejects absent required predeploy migration', () => {
    const f = fixture(); f.ledger = []; expect(() => verifyRelease(f)).toThrow('Missing or ambiguous');
  });
  it('rejects unsafe deferral', () => {
    const f = fixture(); f.manifest.migrations[PRE].phase = 'post'; expect(() => verifyRelease(f)).toThrow('Only the reviewed');
  });
  it('rejects relabeling M492 as predeploy', () => {
    const f = fixture(); f.manifest.migrations[POST_FILE].phase = 'pre'; expect(() => verifyRelease(f)).toThrow('application-first');
  });
  it('rejects a different M492 content even with its matching manifest hash', () => {
    const f: any = fixture(); f.files[POST_FILE] = '-- changed'; f.manifest.migrations[POST_FILE].sha256 = hash('-- changed');
    expect(() => verifyRelease(f)).toThrow('Only the reviewed');
  });
  it('rejects missing admin evidence', () => {
    const f = fixture('ready-for-post'); delete f.deployments.admin; expect(() => verifyRelease(f)).toThrow('admin');
  });
  it('rejects admin still on old code', () => {
    const f = fixture('ready-for-post'); f.deployments.admin.sha = BASE; expect(() => verifyRelease(f)).toThrow('admin is not serving target');
  });
  it('rejects wrong alias despite correct deployment', () => {
    const f = fixture('ready-for-post'); f.deployments.admin.aliasId = 'dpl_other'; expect(() => verifyRelease(f)).toThrow('alias');
  });
  it('rejects unready deployment', () => {
    const f = fixture('ready-for-post'); f.deployments.merchant.readyState = 'BUILDING'; expect(() => verifyRelease(f)).toThrow('deployment');
  });
  it('rejects target-to-target baseline replay', () => {
    const f = fixture('finalize'); f.manifest.baseline_sha = TARGET; expect(() => verifyRelease(f)).toThrow('strict ancestor');
  });
  it('rejects empty live-to-live migration delta', () => {
    const f = fixture('finalize'); f.changed = []; expect(() => verifyRelease(f)).toThrow('Empty');
  });
  it('rejects nonancestor original baseline', () => {
    const f = fixture(); f.baselineIsAncestor = false; expect(() => verifyRelease(f)).toThrow('strict ancestor');
  });
  it('rejects deleted or renamed migrations', () => {
    const f: any = fixture(); f.removed = [PRE]; expect(() => verifyRelease(f)).toThrow('Deleted/renamed');
  });
  it('rejects duplicate postdeploy name evidence', () => {
    const f = fixture('finalize'); addPost(f); addPost(f); expect(() => verifyRelease(f)).toThrow('ambiguous');
  });
  it('rejects malformed ledger version without interpolating SQL', () => {
    const f = fixture(); f.manifest.migrations[PRE].ledger_version = "1';select"; expect(() => verifyRelease(f)).toThrow('ledger version');
  });
  it('rejects unrecognized phase', () => {
    const f = fixture('skip'); expect(() => verifyRelease(f)).toThrow('Unknown');
  });
});

function bundledFixture() {
  const f: any = fixture();
  for (const file of ENGAGE_BUNDLE.files) {
    const bytes = readFileSync(file); f.files[file] = bytes; f.changed.push(file);
    f.manifest.migrations[file] = { phase: 'pre', bundle: '431_432', sha256: hash(bytes), ledger_version: '20000101000000', ledger_name: ENGAGE_BUNDLE.name };
  }
  f.ledger.push({ version: '20000101000000', name: ENGAGE_BUNDLE.name, applied_sha256: ENGAGE_BUNDLE.sha256, stmt_count: 1 });
  return f;
}
describe('exact historical engage bundle', () => {
  it('accepts both canonical files inside the exact recorded transaction', () => expect(verifyRelease(bundledFixture()).verified.length).toBe(3));
  it('rejects missing constituent despite a valid stored bundle hash', () => {
    const f = bundledFixture(); f.changed = f.changed.filter((p: string) => p !== ENGAGE_BUNDLE.files[1]); delete f.manifest.migrations[ENGAGE_BUNDLE.files[1]];
    expect(() => verifyRelease(f)).toThrow('Incomplete historical bundle');
  });
  it('rejects modified constituent even when its entry hash is updated', () => {
    const f = bundledFixture(); f.files[ENGAGE_BUNDLE.files[1]] = '-- modified'; f.manifest.migrations[ENGAGE_BUNDLE.files[1]].sha256 = hash('-- modified');
    expect(() => verifyRelease(f)).toThrow('Historical bundle bytes changed');
  });
  it('rejects other bundle names', () => {
    const f = bundledFixture(); f.manifest.migrations[ENGAGE_BUNDLE.files[0]].bundle = 'equivalent'; expect(() => verifyRelease(f)).toThrow('Unsupported historical bundle');
  });
  it('rejects bundle constituents bound to different ledger versions', () => {
    const f = bundledFixture(); f.manifest.migrations[ENGAGE_BUNDLE.files[1]].ledger_version = '20000101000001';
    expect(() => verifyRelease(f)).toThrow('Incomplete historical bundle');
  });
  it('rejects a ledger row outside the manifest-bound bundle version', () => {
    const f = bundledFixture(); f.ledger[1].version = '20000101000001';
    expect(() => verifyRelease(f)).toThrow('Missing or ambiguous ledger row');
  });
  it('rejects altered recorded SQL', () => {
    const f = bundledFixture(); f.ledger[1].applied_sha256 = 'c'.repeat(64); expect(() => verifyRelease(f)).toThrow('Ledger SQL mismatch');
  });
});

describe('private receipt binding without invented acceptance proof', () => {
  function receiptFixture() {
    const f = fixture('finalize');
    const binding = { baseline: BASE, target: TARGET, manifestHash: hash(JSON.stringify(f.manifest)), deployments: f.deployments };
    const receipt = { schema_version: 1, baseline_sha: BASE, target_sha: TARGET, manifest_sha256: binding.manifestHash,
      prepare_run_id: '123', prepare_run_attempt: 1, acceptance_artifact_sha256: 'a'.repeat(64), deployments: {merchant:'dpl_merchant',admin:'dpl_admin'} };
    return {receipt,binding};
  }
  it('validates only receipt binding, never claims acceptance execution',()=>{const {receipt,binding}=receiptFixture();expect(verifyReceiptBinding(receipt,binding)).toBe(receipt);});
  it('rejects replacement deployments even at same SHA',()=>{const {receipt,binding}=receiptFixture();binding.deployments.admin.id='dpl_replacement';expect(()=>verifyReceiptBinding(receipt,binding)).toThrow('deployment mismatch');});
  it('rejects changed manifest',()=>{const {receipt,binding}=receiptFixture();binding.manifestHash='b'.repeat(64);expect(()=>verifyReceiptBinding(receipt,binding)).toThrow('binding mismatch');});
  it('rejects missing prepare run identity',()=>{const {receipt,binding}=receiptFixture();receipt.prepare_run_id='';expect(()=>verifyReceiptBinding(receipt,binding)).toThrow('immutable run');});
  it('rejects boolean acceptance assertions',()=>{const {receipt,binding}:any=receiptFixture();delete receipt.acceptance_artifact_sha256;receipt.passed=true;expect(()=>verifyReceiptBinding(receipt,binding)).toThrow('immutable run');});
});

function reviewedFixture() {
  const f = fixture('finalize');
  const binding = { baseline: BASE, target: TARGET, manifestHash: hash(JSON.stringify(f.manifest)), deployments: f.deployments };
  const report: any = { schema_version: 1, baseline_sha: BASE, target_sha: TARGET, manifest_sha256: binding.manifestHash,
    deployments:{merchant:'dpl_merchant',admin:'dpl_admin'},prepare_run_id:'123',prepare_run_attempt:1,
    started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:01:00Z',suite:'SYNTHETIC UNIT TEST ONLY',
    runner:{name:'synthetic',version:'1',command:'fixture',run_id:'unit-1',source_sha:TARGET},
    independent_review:{reviewer:'synthetic',reference:'unit-only'},owner_acceptance_reference:'unit-only',
    network:{fixture_writes_intercepted:true,business_mutations:0,provider_calls:0},summary:{passed:6,failed:0,skipped:0},
    cases:Object.entries(ACCEPTANCE_CASES).map(([id,expected])=>({id,expected,observed:id==='merchant_other_tenant_denied'?{route:'/api/verification/document',status:403,document_disclosed:false,redirect:false}:expected,outcome:'passed',evidence_sha256:'a'.repeat(64)})),
  };
  const receipt: any = {schema_version:1,baseline_sha:BASE,target_sha:TARGET,manifest_sha256:binding.manifestHash,
    deployments:report.deployments,prepare_run_id:'123',prepare_run_attempt:1,acceptance_artifact_sha256:hash(JSON.stringify(report))};
  return {binding,report,receipt};
}
function validateReviewed(f: any) { const bytes=JSON.stringify(f.report);const approved=hash(bytes);f.receipt.acceptance_artifact_sha256=approved;return verifyReviewedAcceptance(bytes,approved,f.receipt,f.binding); }
describe('Owner-provisioned independently reviewed report contract — synthetic tests only',()=>{
  it('accepts fully bound observed cases and independent evidence metadata',()=>expect(validateReviewed(reviewedFixture()).passed).toBe(6));
  it('requires separately approved exact report bytes',()=>{const f=reviewedFixture();expect(()=>verifyReviewedAcceptance(JSON.stringify(f.report),'b'.repeat(64),f.receipt,f.binding)).toThrow('digest');});
  it('denies changed report deployment IDs at same SHA',()=>{const f=reviewedFixture();f.report.deployments={...f.report.deployments,admin:'dpl_other'};expect(()=>validateReviewed(f)).toThrow('identity');});
  it('denies missing required case even if totals are rewritten',()=>{const f=reviewedFixture();f.report.cases.pop();f.report.summary.passed=5;expect(()=>validateReviewed(f)).toThrow('incomplete');});
  it('denies arbitrary expected=observed values',()=>{const f=reviewedFixture();f.report.cases[0]={...f.report.cases[0],expected:{status:500},observed:{status:500}};expect(()=>validateReviewed(f)).toThrow('case failed');});
  it('accepts RLS-filtered404 as a nondisclosing tenant denial',()=>{const f=reviewedFixture();f.report.cases[1].observed.status=404;expect(validateReviewed(f).passed).toBe(6);});
  it('denies a cross-tenant redirect even when marked passed',()=>{const f=reviewedFixture();f.report.cases[1].observed.status=307;expect(()=>validateReviewed(f)).toThrow('case failed');});
  it('denies observed denial failure',()=>{const f=reviewedFixture();f.report.cases[1].observed={route:'/api/verification/document',status:200};expect(()=>validateReviewed(f)).toThrow('case failed');});
  it('denies skipped evidence',()=>{const f=reviewedFixture();f.report.summary.skipped=1;expect(()=>validateReviewed(f)).toThrow('incomplete');});
  it('denies missing independent review',()=>{const f=reviewedFixture();delete f.report.independent_review;expect(()=>validateReviewed(f)).toThrow('provenance');});
  it('denies live business mutations',()=>{const f=reviewedFixture();f.report.network.business_mutations=1;expect(()=>validateReviewed(f)).toThrow('mutation scope');});
  it('denies missing observed evidence digest',()=>{const f=reviewedFixture();delete f.report.cases[0].evidence_sha256;expect(()=>validateReviewed(f)).toThrow('case failed');});
});
