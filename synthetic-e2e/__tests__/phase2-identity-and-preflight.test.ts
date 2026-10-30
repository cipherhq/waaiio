/**
 * Phase 2 identity allocation and staging preflight tests.
 *
 * CTO R2 corrections:
 * - G6 uses generateBulkCustomers() (same as bulk tests)
 * - G2/G4/G5/G7 report UNVERIFIED, not PASSED on caller booleans
 * - Arbitrary wrong SHA + all claimed booleans must NOT yield all-passed
 * - staticChecksPassed only covers statically verifiable gates
 * - executionReady always false
 */

import { describe, it, expect } from 'vitest';
import {
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

// ── Identity tests (using generateBulkCustomers) ──

describe('Phase 2: collision-free bulk identity allocation', () => {
  it('500 customers across 5 businesses, zero within-run collisions', () => {
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

  it('all phones are strictly numeric (no hex a-f)', () => {
    const run = createRunIdentity();
    const customers = generateBulkCustomers(run.runId, 100, 0);
    for (const c of customers) {
      const suffix = c.phone.replace('15550', '');
      expect(suffix).toMatch(/^\d{6}$/);
    }
  });

  it('rejects >1000 customers per business', () => {
    expect(() => generateBulkCustomers(createRunIdentity().runId, 1001, 0))
      .toThrow('Max 1000');
  });
});

// ── Preflight: statically verifiable gates ──

describe('Phase 2: preflight — statically verifiable gates', () => {
  const baseConfig: PreflightConfig = {
    stagingUrl: 'https://staging.waaiio.com',
    deploymentSha: '39d86a93f65ca5e38d52e37f5b29a9675a68d4bc',
    vercelProjectId: STAGING_VERCEL_PROJECT_ID,
    supabaseRef: STAGING_SUPABASE_REF,
    businessCount: 5,
    customersPerBusiness: 100,
  };

  it('G1 passes with valid staging URL', () => {
    const report = runStagingPreflight(baseConfig);
    expect(report.gates.find(g => g.id === 'G1')?.status).toBe('PASSED');
  });

  it('G1 fails with production URL', () => {
    const report = runStagingPreflight({ ...baseConfig, stagingUrl: 'https://waaiio.com' });
    expect(report.gates.find(g => g.id === 'G1')?.status).toBe('FAILED');
  });

  it('G3 passes with staging Supabase ref', () => {
    const report = runStagingPreflight(baseConfig);
    expect(report.gates.find(g => g.id === 'G3')?.status).toBe('PASSED');
  });

  it('G3 fails with production Supabase ref', () => {
    const report = runStagingPreflight({ ...baseConfig, supabaseRef: PRODUCTION_SUPABASE_REF });
    expect(report.gates.find(g => g.id === 'G3')?.status).toBe('FAILED');
  });

  it('G6 passes with 500 collision-free identities via bulk allocator', () => {
    const report = runStagingPreflight(baseConfig);
    const g6 = report.gates.find(g => g.id === 'G6');
    expect(g6?.status).toBe('PASSED');
    expect(report.identityValidation.totalCustomers).toBe(500);
    expect(report.identityValidation.collisions).toBe(0);
    expect(report.identityValidation.allPhonesNumeric).toBe(true);
  });

  it('staticChecksPassed is true when all static gates pass', () => {
    const report = runStagingPreflight(baseConfig);
    expect(report.staticChecksPassed).toBe(true);
  });

  it('staticChecksPassed is false when any static gate fails', () => {
    const report = runStagingPreflight({ ...baseConfig, stagingUrl: 'https://waaiio.com' });
    expect(report.staticChecksPassed).toBe(false);
  });
});

// ── Preflight: runtime-evidence gates report UNVERIFIED ──

describe('Phase 2: preflight — runtime gates are UNVERIFIED', () => {
  const baseConfig: PreflightConfig = {
    stagingUrl: 'https://staging.waaiio.com',
    deploymentSha: '39d86a93f65ca5e38d52e37f5b29a9675a68d4bc',
    vercelProjectId: STAGING_VERCEL_PROJECT_ID,
    supabaseRef: STAGING_SUPABASE_REF,
    businessCount: 5,
    customersPerBusiness: 100,
  };

  it('G2 is always UNVERIFIED (caller SHA is not authoritative)', () => {
    const report = runStagingPreflight(baseConfig);
    expect(report.gates.find(g => g.id === 'G2')?.status).toBe('UNVERIFIED');
  });

  it('G4 is UNVERIFIED even with no live-mode key prefix', () => {
    const report = runStagingPreflight(baseConfig);
    expect(report.gates.find(g => g.id === 'G4')?.status).toBe('UNVERIFIED');
  });

  it('G4 is FAILED with live-mode key prefix', () => {
    const liveKey = ['sk', 'live'].join('_') + '_DANGEROUS';
    const report = runStagingPreflight({ ...baseConfig, stripeSecretKey: liveKey });
    expect(report.gates.find(g => g.id === 'G4')?.status).toBe('FAILED');
  });

  it('G5 is UNVERIFIED even without real Meta token', () => {
    const report = runStagingPreflight(baseConfig);
    expect(report.gates.find(g => g.id === 'G5')?.status).toBe('UNVERIFIED');
  });

  it('G5 is FAILED with real Meta token', () => {
    const report = runStagingPreflight({
      ...baseConfig,
      metaAccessToken: 'EAABsbCS1IWsBAIZCm7ZAkZBrT9yKhVzD7ZBvd',
    });
    expect(report.gates.find(g => g.id === 'G5')?.status).toBe('FAILED');
  });

  it('G7 is always UNVERIFIED (path string is not validation)', () => {
    const report = runStagingPreflight(baseConfig);
    expect(report.gates.find(g => g.id === 'G7')?.status).toBe('UNVERIFIED');
  });

  it('executionReady is always false', () => {
    const report = runStagingPreflight(baseConfig);
    expect(report.executionReady).toBe(false);
  });
});

// ── Critical negative: arbitrary inputs must NOT yield all-passed ──

describe('Phase 2: preflight — negative safety proofs', () => {
  it('arbitrary wrong SHA + claimed booleans + path does NOT yield all-passed', () => {
    const report = runStagingPreflight({
      stagingUrl: 'https://staging.waaiio.com',
      deploymentSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // arbitrary valid-format wrong SHA
      vercelProjectId: STAGING_VERCEL_PROJECT_ID,
      supabaseRef: STAGING_SUPABASE_REF,
      callerClaims: {
        providerSandboxVerified: true,
        serverSideMetaCaptureVerified: true,
        serverSideSmsCaptureVerified: true,
        serverSideEmailCaptureVerified: true,
        cleanupManifestPath: '/tmp/nonexistent-manifest.json',
      },
      businessCount: 5,
      customersPerBusiness: 100,
    });

    // G2, G4, G5, G7 must NOT be PASSED — caller claims are ignored
    expect(report.gates.find(g => g.id === 'G2')?.status).not.toBe('PASSED');
    expect(report.gates.find(g => g.id === 'G4')?.status).not.toBe('PASSED');
    expect(report.gates.find(g => g.id === 'G5')?.status).not.toBe('PASSED');
    expect(report.gates.find(g => g.id === 'G7')?.status).not.toBe('PASSED');
    expect(report.executionReady).toBe(false);
  });

  it('unverifiedPrerequisites list is non-empty', () => {
    const report = runStagingPreflight({
      stagingUrl: 'https://staging.waaiio.com',
      deploymentSha: '39d86a93f65ca5e38d52e37f5b29a9675a68d4bc',
      vercelProjectId: STAGING_VERCEL_PROJECT_ID,
      supabaseRef: STAGING_SUPABASE_REF,
      businessCount: 5,
      customersPerBusiness: 100,
    });
    expect(report.unverifiedPrerequisites.length).toBeGreaterThanOrEqual(5);
  });

  it('blockedCapabilities includes M470, M471, M472', () => {
    const report = runStagingPreflight({
      stagingUrl: 'https://staging.waaiio.com',
      deploymentSha: '39d86a93f65ca5e38d52e37f5b29a9675a68d4bc',
      supabaseRef: STAGING_SUPABASE_REF,
      businessCount: 5,
      customersPerBusiness: 100,
    });
    expect(report.blockedCapabilities.some(c => c.includes('M470'))).toBe(true);
    expect(report.blockedCapabilities.some(c => c.includes('M471'))).toBe(true);
    expect(report.blockedCapabilities.some(c => c.includes('M472'))).toBe(true);
  });
});
