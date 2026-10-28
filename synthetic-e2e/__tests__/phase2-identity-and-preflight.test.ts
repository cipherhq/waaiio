/**
 * Phase 2 identity generation and staging preflight tests.
 *
 * CTO R1 corrections:
 * - Collision-free within run, no cross-run uniqueness claims
 * - G1/G2 require authoritative Vercel project + deployment
 * - G4/G5 fail closed when unverified
 * - G7 fails without manifest
 * - Negative tests for missing credentials, mismatched deployments,
 *   absent capture, missing manifests, identity collisions
 */

import { describe, it, expect } from 'vitest';
import {
  generateCustomerIdentity,
  generateBulkCustomers,
  isValidSyntheticPhone,
  createRunIdentity,
} from '../lib/synthetic-identity';
import { runStagingPreflight, type PreflightConfig } from '../staging/staging-preflight';
import {
  STAGING_SUPABASE_REF,
  STAGING_VERCEL_PROJECT_ID,
  PRODUCTION_SUPABASE_REF,
} from '../lib/environment-guard';

// ── Helpers ──

/** Fully-verified config (all gates should pass) */
const fullConfig: PreflightConfig = {
  stagingUrl: 'https://staging.waaiio.com',
  deploymentSha: '39d86a93f65ca5e38d52e37f5b29a9675a68d4bc',
  vercelProjectId: STAGING_VERCEL_PROJECT_ID,
  supabaseRef: STAGING_SUPABASE_REF,
  providerSandboxVerified: true,
  serverSideMetaCaptureVerified: true,
  serverSideSmsCaptureVerified: true,
  serverSideEmailCaptureVerified: true,
  cleanupManifestPath: '/tmp/manifest.json',
  businessCount: 5,
  customersPerBusiness: 100,
};

// ── Identity tests ──

describe('Phase 2: collision-free identity allocation', () => {
  it('500 customers across 5 businesses have zero within-run collisions', () => {
    const run = createRunIdentity();
    const allPhones = new Set<string>();

    for (let biz = 0; biz < 5; biz++) {
      const customers = generateBulkCustomers(run.runId, 100, biz);
      expect(customers).toHaveLength(100);
      for (const c of customers) {
        expect(isValidSyntheticPhone(c.phone)).toBe(true);
        expect(c.phone).toMatch(/^15550\d{6}$/);
        expect(allPhones.has(c.phone)).toBe(false);
        allPhones.add(c.phone);
      }
    }
    expect(allPhones.size).toBe(500);
  });

  it('all phones are strictly numeric (no hex chars)', () => {
    const run = createRunIdentity();
    const customers = generateBulkCustomers(run.runId, 100, 0);
    for (const c of customers) {
      const suffix = c.phone.replace('15550', '');
      expect(suffix).toMatch(/^\d{6}$/);
    }
  });

  it('rejects >1000 customers per business', () => {
    const run = createRunIdentity();
    expect(() => generateBulkCustomers(run.runId, 1001, 0)).toThrow('Max 1000');
  });

  it('generateCustomerIdentity produces run-scoped phones', () => {
    const r1 = createRunIdentity();
    const r2 = createRunIdentity();
    const c1 = generateCustomerIdentity(r1.runId, 'j1', 0);
    const c2 = generateCustomerIdentity(r2.runId, 'j1', 0);
    // Different runs → likely different phones (not guaranteed — no cross-run claim)
    // But both are valid synthetic phones
    expect(isValidSyntheticPhone(c1.phone)).toBe(true);
    expect(isValidSyntheticPhone(c2.phone)).toBe(true);
  });
});

// ── Preflight gate tests ──

describe('Phase 2: preflight gates — positive', () => {
  it('all gates pass with fully verified config', () => {
    const report = runStagingPreflight(fullConfig);
    expect(report.allPassed).toBe(true);
    expect(report.gates.every(g => g.passed)).toBe(true);
    // executionReady is always false (requires separate authorization)
    expect(report.executionReady).toBe(false);
  });

  it('reports 500 unique numeric phones', () => {
    const report = runStagingPreflight(fullConfig);
    expect(report.identityValidation.totalCustomers).toBe(500);
    expect(report.identityValidation.allPhonesNumeric).toBe(true);
    expect(report.identityValidation.allPhonesUnique).toBe(true);
    expect(report.identityValidation.collisions).toBe(0);
  });

  it('lists blocked capabilities even when gates pass', () => {
    const report = runStagingPreflight(fullConfig);
    expect(report.blockedCapabilities.length).toBeGreaterThanOrEqual(3);
    expect(report.blockedCapabilities.some(c => c.includes('M470'))).toBe(true);
  });
});

describe('Phase 2: preflight gates — negative (fail closed)', () => {
  it('G1 fails without Vercel project ID', () => {
    const report = runStagingPreflight({ ...fullConfig, vercelProjectId: undefined });
    expect(report.allPassed).toBe(false);
    expect(report.gates.find(g => g.id === 'G1')?.passed).toBe(false);
  });

  it('G1 fails with wrong Vercel project ID', () => {
    const report = runStagingPreflight({ ...fullConfig, vercelProjectId: 'prj_WRONG' });
    expect(report.allPassed).toBe(false);
    expect(report.gates.find(g => g.id === 'G1')?.passed).toBe(false);
  });

  it('G1 fails with production URL', () => {
    const report = runStagingPreflight({ ...fullConfig, stagingUrl: 'https://waaiio.com' });
    expect(report.allPassed).toBe(false);
  });

  it('G2 fails without Vercel project binding (SHA format alone insufficient)', () => {
    const report = runStagingPreflight({ ...fullConfig, vercelProjectId: undefined });
    expect(report.gates.find(g => g.id === 'G2')?.passed).toBe(false);
  });

  it('G2 fails with invalid SHA format', () => {
    const report = runStagingPreflight({ ...fullConfig, deploymentSha: 'not-a-sha' });
    expect(report.gates.find(g => g.id === 'G2')?.passed).toBe(false);
  });

  it('G3 fails with production Supabase ref', () => {
    const report = runStagingPreflight({ ...fullConfig, supabaseRef: PRODUCTION_SUPABASE_REF });
    expect(report.gates.find(g => g.id === 'G3')?.passed).toBe(false);
  });

  it('G4 fails when provider sandbox is not authoritatively verified', () => {
    const report = runStagingPreflight({ ...fullConfig, providerSandboxVerified: false });
    expect(report.gates.find(g => g.id === 'G4')?.passed).toBe(false);
    expect(report.gates.find(g => g.id === 'G4')?.message).toContain('not authoritatively verified');
  });

  it('G4 fails with live payment keys', () => {
    const liveKey = ['sk', 'live'].join('_') + '_DANGEROUS';
    const report = runStagingPreflight({ ...fullConfig, stripeSecretKey: liveKey });
    expect(report.gates.find(g => g.id === 'G4')?.passed).toBe(false);
  });

  it('G5 fails when Meta capture is unverified', () => {
    const report = runStagingPreflight({ ...fullConfig, serverSideMetaCaptureVerified: false });
    expect(report.gates.find(g => g.id === 'G5')?.passed).toBe(false);
    expect(report.gates.find(g => g.id === 'G5')?.message).toContain('Meta WhatsApp');
  });

  it('G5 fails when SMS capture is unverified', () => {
    const report = runStagingPreflight({ ...fullConfig, serverSideSmsCaptureVerified: false });
    expect(report.gates.find(g => g.id === 'G5')?.passed).toBe(false);
    expect(report.gates.find(g => g.id === 'G5')?.message).toContain('SMS');
  });

  it('G5 fails when Email capture is unverified', () => {
    const report = runStagingPreflight({ ...fullConfig, serverSideEmailCaptureVerified: false });
    expect(report.gates.find(g => g.id === 'G5')?.passed).toBe(false);
    expect(report.gates.find(g => g.id === 'G5')?.message).toContain('Email');
  });

  it('G5 fails with real Meta token', () => {
    const report = runStagingPreflight({
      ...fullConfig,
      metaAccessToken: 'EAABsbCS1IWsBAIZCm7ZAkZBrT9yKhVzD7ZBvd',
    });
    expect(report.gates.find(g => g.id === 'G5')?.passed).toBe(false);
  });

  it('G7 fails without cleanup manifest path', () => {
    const report = runStagingPreflight({ ...fullConfig, cleanupManifestPath: undefined });
    expect(report.allPassed).toBe(false);
    expect(report.gates.find(g => g.id === 'G7')?.passed).toBe(false);
    expect(report.gates.find(g => g.id === 'G7')?.message).toContain('FAIL-CLOSED');
  });

  it('executionReady is always false (requires separate authorization)', () => {
    const report = runStagingPreflight(fullConfig);
    expect(report.executionReady).toBe(false);
  });

  it('allPassed is false when any single gate fails', () => {
    // Each gate alone should make allPassed false
    for (const override of [
      { vercelProjectId: undefined },
      { deploymentSha: 'bad' },
      { supabaseRef: PRODUCTION_SUPABASE_REF },
      { providerSandboxVerified: false },
      { serverSideMetaCaptureVerified: false },
      { cleanupManifestPath: undefined },
    ] as Partial<PreflightConfig>[]) {
      const report = runStagingPreflight({ ...fullConfig, ...override });
      expect(report.allPassed).toBe(false);
    }
  });
});
