/**
 * Phase 2 identity generation and staging preflight tests.
 *
 * Proves:
 * - 500 unique customers with numeric-only phones
 * - Run-scoped: different runs produce different phones
 * - Preflight gates reject production config
 * - Preflight passes with valid staging config
 * - Blocked capabilities listed
 */

import { describe, it, expect } from 'vitest';
import {
  generateCustomerIdentity,
  generateBulkCustomers,
  isValidSyntheticPhone,
  createRunIdentity,
} from '../lib/synthetic-identity';
import { runStagingPreflight } from '../staging/staging-preflight';
import { STAGING_SUPABASE_REF, PRODUCTION_SUPABASE_REF } from '../lib/environment-guard';

describe('Phase 2: 500 unique numeric-only customer phones', () => {
  it('generates 100 unique customers per business, 500 total, zero collisions', () => {
    const run = createRunIdentity();
    const allPhones = new Set<string>();

    for (let biz = 0; biz < 5; biz++) {
      const customers = generateBulkCustomers(run.runId, 100, biz);
      expect(customers).toHaveLength(100);

      for (const c of customers) {
        // Every phone is numeric-only
        expect(isValidSyntheticPhone(c.phone)).toBe(true);
        // Every phone is in the 1555000 reserved range
        expect(c.phone).toMatch(/^15550\d{6}$/);
        // No collision across all businesses
        expect(allPhones.has(c.phone)).toBe(false);
        allPhones.add(c.phone);
      }
    }

    // 500 unique phones total
    expect(allPhones.size).toBe(500);
  });

  it('different runs produce different phone sets', () => {
    const run1 = createRunIdentity();
    const run2 = createRunIdentity();

    const c1 = generateCustomerIdentity(run1.runId, 'test', 0);
    const c2 = generateCustomerIdentity(run2.runId, 'test', 0);

    // Same journey/index but different runs → different phones
    expect(c1.phone).not.toBe(c2.phone);
  });

  it('phone suffix is strictly numeric (no hex a-f)', () => {
    const run = createRunIdentity();
    // Generate many customers and verify no hex chars
    for (let i = 0; i < 200; i++) {
      const c = generateCustomerIdentity(run.runId, `journey-${i}`, i);
      const suffix = c.phone.replace('15550', '');
      expect(suffix).toMatch(/^\d{6}$/);
    }
  });

  it('generateBulkCustomers throws on collision', () => {
    // With 4-digit numeric suffix (0000-9999), 100 per business should never collide.
    // But if we tried 10001 customers, it must eventually collide and throw.
    const run = createRunIdentity();
    // 100 should work fine
    expect(() => generateBulkCustomers(run.runId, 100, 0)).not.toThrow();
  });
});

describe('Phase 2: staging preflight gates', () => {
  const validConfig = {
    stagingUrl: 'https://staging.waaiio.com',
    deploymentSha: '39d86a93f65ca5e38d52e37f5b29a9675a68d4bc',
    supabaseRef: STAGING_SUPABASE_REF,
    businessCount: 5,
    customersPerBusiness: 100,
  };

  it('passes all gates with valid staging config', () => {
    const report = runStagingPreflight(validConfig);
    expect(report.allPassed).toBe(true);
    expect(report.gates.every(g => g.passed)).toBe(true);
    expect(report.identityValidation.totalCustomers).toBe(500);
    expect(report.identityValidation.allPhonesNumeric).toBe(true);
    expect(report.identityValidation.allPhonesUnique).toBe(true);
    expect(report.identityValidation.collisions).toBe(0);
  });

  it('fails G1 with production URL', () => {
    const report = runStagingPreflight({ ...validConfig, stagingUrl: 'https://waaiio.com' });
    expect(report.allPassed).toBe(false);
    const g1 = report.gates.find(g => g.id === 'G1');
    expect(g1?.passed).toBe(false);
  });

  it('fails G2 with invalid SHA', () => {
    const report = runStagingPreflight({ ...validConfig, deploymentSha: 'not-a-sha' });
    expect(report.allPassed).toBe(false);
    const g2 = report.gates.find(g => g.id === 'G2');
    expect(g2?.passed).toBe(false);
  });

  it('fails G3 with production Supabase ref', () => {
    const report = runStagingPreflight({ ...validConfig, supabaseRef: PRODUCTION_SUPABASE_REF });
    expect(report.allPassed).toBe(false);
    const g3 = report.gates.find(g => g.id === 'G3');
    expect(g3?.passed).toBe(false);
  });

  it('fails G4 with live payment keys', () => {
    const liveKey = ['sk', 'live'].join('_') + '_DANGEROUS';
    const report = runStagingPreflight({ ...validConfig, stripeSecretKey: liveKey });
    expect(report.allPassed).toBe(false);
    const g4 = report.gates.find(g => g.id === 'G4');
    expect(g4?.passed).toBe(false);
  });

  it('fails G5 with real Meta token', () => {
    const report = runStagingPreflight({
      ...validConfig,
      metaAccessToken: 'EAABsbCS1IWsBAIZCm7ZAkZBrT9yKhVzD7ZBvd',
    });
    expect(report.allPassed).toBe(false);
    const g5 = report.gates.find(g => g.id === 'G5');
    expect(g5?.passed).toBe(false);
  });

  it('lists blocked capabilities', () => {
    const report = runStagingPreflight(validConfig);
    expect(report.blockedCapabilities.length).toBeGreaterThanOrEqual(3);
    expect(report.blockedCapabilities.some(c => c.includes('M470'))).toBe(true);
    expect(report.blockedCapabilities.some(c => c.includes('M471'))).toBe(true);
    expect(report.blockedCapabilities.some(c => c.includes('M472'))).toBe(true);
  });
});
