/**
 * Deploy-staging workflow contract test (Blocker 10)
 *
 * Static analysis of .github/workflows/deploy-staging.yml to prove
 * critical release-safety invariants hold. No live calls.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load as parseYaml } from 'js-yaml';

let workflow: Record<string, unknown>;
let raw: string;

beforeAll(() => {
  const path = resolve(__dirname, '../../.github/workflows/deploy-staging.yml');
  raw = readFileSync(path, 'utf-8');
  workflow = parseYaml(raw) as unknown as Record<string, unknown>;
});

describe('deploy-staging workflow contract', () => {
  // ── Trigger: manual-only ──
  it('is triggered only by workflow_dispatch', () => {
    const on = workflow.on as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(['workflow_dispatch']);
  });

  it('requires SHA input', () => {
    const on = workflow.on as Record<string, unknown>;
    const wd = on.workflow_dispatch as Record<string, unknown>;
    const inputs = wd.inputs as Record<string, unknown>;
    expect(inputs.sha).toBeDefined();
    expect((inputs.sha as Record<string, unknown>).required).toBe(true);
  });

  // ── Permissions: minimum required ──
  it('sets workflow permissions to contents: read only', () => {
    const perms = workflow.permissions as Record<string, string>;
    expect(perms).toEqual({ contents: 'read' });
  });

  // ── Concurrency: serialized deployments ──
  it('has a concurrency group that does not cancel in-progress', () => {
    const conc = workflow.concurrency as Record<string, unknown>;
    expect(conc.group).toBeTruthy();
    expect(conc['cancel-in-progress']).toBe(false);
  });

  // ── Owner actor gate ──
  it('gates on Owner actor cipherhq', () => {
    const env = workflow.env as Record<string, string>;
    expect(env.OWNER_ACTOR).toBe('cipherhq');
    // The workflow must reference OWNER_ACTOR in an authorization check
    expect(raw).toContain('github.actor');
    expect(raw).toContain('env.OWNER_ACTOR');
  });

  // ── Hardcoded staging org/project only ──
  it('hardcodes staging org and project IDs', () => {
    const env = workflow.env as Record<string, string>;
    expect(env.STAGING_ORG_ID).toBe('team_AEcg69CktrGEptXDznpae8Rp');
    expect(env.STAGING_PROJECT_ID).toBe('prj_h7YmC4fvpxhn429znCy34OjLZ6se');
  });

  it('does not contain any production project ID', () => {
    // The production Vercel project ID must never appear in this workflow
    expect(raw).not.toContain('prj_production');
    // Ensure no other prj_ IDs beyond the staging one
    const prjMatches = raw.match(/prj_[A-Za-z0-9]+/g) || [];
    const uniqueIds = [...new Set(prjMatches)];
    expect(uniqueIds).toEqual(['prj_h7YmC4fvpxhn429znCy34OjLZ6se']);
  });

  // ── SHA provenance guards ──
  it('validates SHA is 40 hex chars', () => {
    expect(raw).toContain('^[0-9a-f]{40}$');
  });

  it('verifies SHA is ancestor of origin/main', () => {
    expect(raw).toContain('merge-base --is-ancestor');
    expect(raw).toContain('origin/main');
  });

  it('verifies clean checkout', () => {
    expect(raw).toContain('git status --porcelain');
  });

  // ── Deploy uses --prod against staging project ──
  it('deploys with --prod flag', () => {
    expect(raw).toContain('vercel deploy --prod');
  });

  // ── Rollback target is required before deploy (fail-closed) ──
  it('captures rollback target before deployment and fails closed', () => {
    const steps = getSteps();
    const captureIdx = steps.findIndex(s => stepName(s).includes('rollback'));
    const deployIdx = steps.findIndex(s => stepName(s).includes('Deploy exact SHA'));
    expect(captureIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(captureIdx);

    // The capture step must hard-fail (exit 1) not warn-and-proceed
    const captureRun = steps[captureIdx].run as string;
    expect(captureRun).toContain('exit 1');
    expect(captureRun).not.toContain('Proceeding');
  });

  // ── Mutation marker gates rollback ──
  it('sets DEPLOY_MUTATED after deployment', () => {
    expect(raw).toContain('DEPLOY_MUTATED=true');
  });

  it('rollback step requires DEPLOY_MUTATED', () => {
    const steps = getSteps();
    const rollbackStep = steps.find(s => stepName(s).includes('Rollback'));
    expect(rollbackStep).toBeDefined();
    const condition = rollbackStep!.if as string;
    expect(condition).toContain('DEPLOY_MUTATED');
    expect(condition).toContain('failure()');
  });

  // ── Expected deployment ID is passed to verifier ──
  it('passes --expected-deployment-id to deploy verifier', () => {
    expect(raw).toContain('--expected-deployment-id');
    expect(raw).toContain('NEW_DEPLOYMENT_ID');
  });

  // ── Vercel CLI is pinned ──
  it('pins Vercel CLI to a specific version (not @latest)', () => {
    const env = workflow.env as Record<string, string>;
    expect(env.VERCEL_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(raw).not.toContain('vercel@latest');
    expect(raw).toContain('vercel@${{ env.VERCEL_CLI_VERSION }}');
  });

  // ── No dummy NEXT_PUBLIC_* env values ──
  it('does not define dummy NEXT_PUBLIC_* env values', () => {
    // These should come from the Vercel project, not CI placeholders
    const jobEnv = (workflow.jobs as Record<string, unknown>)['deploy-staging'] as Record<string, unknown>;
    const envBlock = jobEnv.env as Record<string, string> | undefined;
    if (envBlock) {
      const publicKeys = Object.keys(envBlock).filter(k => k.startsWith('NEXT_PUBLIC_'));
      expect(publicKeys).toHaveLength(0);
    }
  });

  // ── Rollback verification is independent (Vercel API check) ──
  it('verifies rollback independently via Vercel API', () => {
    const steps = getSteps();
    const rollbackStep = steps.find(s => stepName(s).includes('Rollback'));
    const rollbackRun = rollbackStep?.run as string;
    expect(rollbackRun).toContain('api.vercel.com');
    expect(rollbackRun).toContain('EMERGENCY');
  });

  // ── Rollback discovery bound to staging project via API ──
  it('captures rollback target via Vercel API bound to staging project', () => {
    const steps = getSteps();
    const captureStep = steps.find(s => stepName(s).toLowerCase().includes('capture'));
    const captureRun = captureStep?.run as string;
    expect(captureRun).toContain('api.vercel.com');
    expect(captureRun).toContain('STAGING_PROJECT_ID');
    expect(captureRun).toContain('STAGING_ORG_ID');
    expect(captureRun).toContain('target=production');
    expect(captureRun).toContain('state=READY');
  });

  // ── Readiness exhaustion exits non-zero ──
  it('readiness timeout exits non-zero', () => {
    const steps = getSteps();
    const readinessStep = steps.find(s => stepName(s).toLowerCase().includes('readiness') || stepName(s).toLowerCase().includes('wait'));
    const readinessRun = readinessStep?.run as string;
    // After the loop, must exit 1
    const afterLoop = readinessRun.split('done').pop() || '';
    expect(afterLoop).toContain('exit 1');
  });
});

// Helpers

function getSteps(): Array<Record<string, unknown>> {
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  return jobs['deploy-staging'].steps as Array<Record<string, unknown>>;
}

function stepName(step: Record<string, unknown>): string {
  return (step.name as string) || '';
}
