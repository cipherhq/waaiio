import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { FULL_POLICY, manifestBinding } from '../reduced-release-evidence.mjs';
import { FULL_IDENTITIES, fullInventoryDigest, FULL_TARGETS, FULL_SCHEMA_CONTRACT, FULL_MAIN_SQL_TESTS, requireFrozenFullRelease } from '../full-release-policy.mjs';
import { parseManifest, checkDelta, TARGETS, inspectTarget, deployReduced } from '../reduced-release-gate.mjs';
const integration = FULL_IDENTITIES.merchant.target_sha;
const manifest = () => ({ schema_version: 5, policy: FULL_POLICY, integration_sha: integration,
  projects: Object.fromEntries(Object.entries(FULL_IDENTITIES).map(([kind,p]:any) => [kind, {
    baseline_sha:p.baseline_sha,target_sha:p.target_sha,target_tree:p.target_tree,
    project_id:TARGETS[kind].project,baseline_deployment_id:`dpl_${kind}Baseline`,
    source_inventory_sha256:fullInventoryDigest(kind),
  }])) });
describe('fixed full-source profile', () => {
  it('accepts the same exact reviewed target only for the named profile', () => {
    const m=manifest(); expect(parseManifest(JSON.stringify(m),integration)).toEqual(m);
    expect(manifestBinding(JSON.stringify(m),m).policy).toBe(FULL_POLICY);
  });
  it.each([1,2,3,4])('does not grant the shared-target exception to schema %i', schema => {
    const m=manifest();m.schema_version=schema;
    m.policy=({1:'',2:'admin-payout-mfa-v1',3:'accounting-hold-v1',4:'security-storage-webhook-v1'} as any)[schema];
    expect(()=>parseManifest(JSON.stringify(m),integration)).toThrow();
  });
  it('rejects unknown schema5 policy',()=>{const m=manifest();m.policy='another-full-profile';expect(()=>parseManifest(JSON.stringify(m),integration)).toThrow();});
  it('rejects a different full target even when both projects agree',()=>{const m=manifest();for(const p of Object.values(m.projects) as any[])p.target_sha='a'.repeat(40);expect(()=>parseManifest(JSON.stringify(m),integration)).toThrow();});
  it('requires all four reviewed merchant deletions',()=>{
    const deleted=Object.keys(FULL_IDENTITIES.merchant.deleted_blobs);expect(deleted).toHaveLength(4);
    expect(()=>checkDelta('merchant',FULL_TARGETS.merchant.allowed,deleted,manifest())).not.toThrow();
    expect(()=>checkDelta('merchant',FULL_TARGETS.merchant.allowed,deleted.slice(1),manifest())).toThrow();
    expect(()=>checkDelta('merchant',FULL_TARGETS.merchant.allowed,[...deleted,'unexpected.ts'],manifest())).toThrow();
  });
  it('rejects missing or extra changed files',()=>{
    expect(()=>checkDelta('merchant',FULL_TARGETS.merchant.allowed.slice(1),Object.keys(FULL_IDENTITIES.merchant.deleted_blobs),manifest())).toThrow();
    expect(()=>checkDelta('merchant',[...FULL_TARGETS.merchant.allowed,'unexpected.ts'],Object.keys(FULL_IDENTITIES.merchant.deleted_blobs),manifest())).toThrow();
  });
  it('binds actual Git target and baseline deletion bytes',()=>{
    const m=manifest();expect(inspectTarget(process.cwd(),'merchant',m.projects.merchant,integration,m)).toHaveLength(FULL_TARGETS.merchant.allowed.length);
    m.projects.merchant.source_inventory_sha256='0'.repeat(64);
    expect(()=>inspectTarget(process.cwd(),'merchant',m.projects.merchant,integration,m)).toThrow('source inventory binding');
  },300000);
  it('validates the complete admin Git inventory',()=>{
    const m=manifest();expect(inspectTarget(process.cwd(),'admin',m.projects.admin,integration,m)).toHaveLength(FULL_TARGETS.admin.allowed.length);
    m.projects.admin.source_inventory_sha256='0'.repeat(64);
    expect(()=>parseManifest(JSON.stringify(m),integration)).toThrow('source inventory binding');
  },300000);
  it('denies exported deployment before any network or CLI without genuine evidence',async()=>{
    const fetch=vi.fn(()=>{throw new Error('Network must not run');});vi.stubGlobal('fetch',fetch);
    try {
      await expect(deployReduced(manifest(),'/not-a-checkout',{},'123',1,{VERCEL_TOKEN:'fixture-only'})).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally {vi.unstubAllGlobals();}
  });
  it('pins every migration source delta and both forward foundations',()=>{
    const changed=execFileSync('git',['diff','--name-only',FULL_IDENTITIES.merchant.baseline_sha,integration,'--','supabase/migrations'],{encoding:'utf8'}).trim().split('\n').map(p=>p.split('/').pop());
    const rows=FULL_SCHEMA_CONTRACT.migration_reconciliation;
    for(const name of [...changed,'503_recurring_cancellation_compatibility.sql','504_party_slug_foundation.sql']) expect(rows.filter(x=>x.name===name)).toHaveLength(1);
    expect(new Set(rows.map(x=>x.name)).size).toBe(rows.length);
    for(const n of ['430','496'])expect(rows.find(x=>x.name.startsWith(n+'_')).classification).toMatch(/^held-/);
    for(const n of ['455','458'])expect(rows.find(x=>x.name.startsWith(n+'_')).classification).toMatch(/^excluded-/);
  });
  it('cannot treat installation or caller-provided schema as deployment authority',()=>{
    expect(FULL_SCHEMA_CONTRACT.status).toBe('frozen');
    expect(()=>requireFrozenFullRelease({status:'unfrozen',profiles:{}})).not.toThrow();
    expect(FULL_SCHEMA_CONTRACT.profiles.staging.required_phase).toBe('post_app');
    expect(FULL_SCHEMA_CONTRACT.profiles.production.required_phase).toBe('pre_app');
  });
  it('requires mandatory cumulative SQL tests with nonzero counts',()=>{
    expect(FULL_MAIN_SQL_TESTS['lib/__tests__/recurring-cancellation-503.pg.test.ts']).toBe(23);
    expect(FULL_MAIN_SQL_TESTS['lib/__tests__/party-slug-foundation-504.pg.test.ts']).toBe(8);
    expect(readFileSync('scripts/reduced-release-gate.mjs','utf8')).toContain('if (full(manifest)) requireFrozenFullRelease();');
  });
});
