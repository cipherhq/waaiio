/**
 * Tests for synthetic identity generation.
 *
 * Verifies that identities are unique, identifiable, and use
 * reserved test ranges.
 */

import { describe, it, expect } from 'vitest';
import {
  createRunIdentity,
  generateMerchantIdentity,
  generateCustomerIdentity,
  isSyntheticEmail,
  isSyntheticPhone,
  isSyntheticBusinessName,
} from '../lib/synthetic-identity';

describe('createRunIdentity', () => {
  it('generates unique run IDs', () => {
    const a = createRunIdentity();
    const b = createRunIdentity();
    expect(a.runId).not.toBe(b.runId);
  });

  it('includes synth-e2e tag', () => {
    const run = createRunIdentity();
    expect(run.runId).toContain('synth-e2e');
    expect(run.tag).toBe('synth-e2e');
  });

  it('includes ISO timestamp', () => {
    const run = createRunIdentity();
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('generateMerchantIdentity', () => {
  it('generates identifiable synthetic email', () => {
    const merchant = generateMerchantIdentity('run-123');
    expect(merchant.email).toContain('synth-e2e-merchant');
    expect(merchant.email).toContain('@test.waaiio.internal');
    expect(isSyntheticEmail(merchant.email)).toBe(true);
  });

  it('generates identifiable business name', () => {
    const merchant = generateMerchantIdentity('run-123');
    expect(merchant.businessName).toContain('SynthBiz');
    expect(isSyntheticBusinessName(merchant.businessName)).toBe(true);
  });

  it('includes run ID in identity', () => {
    const merchant = generateMerchantIdentity('run-abc');
    expect(merchant.runId).toBe('run-abc');
  });

  it('sanitized version redacts password', () => {
    const merchant = generateMerchantIdentity('run-123');
    expect(merchant.sanitized.password).toBe('[REDACTED]');
    expect(merchant.password).not.toBe('[REDACTED]');
  });

  it('generates different identities with different indices', () => {
    const m1 = generateMerchantIdentity('run-123', 0);
    const m2 = generateMerchantIdentity('run-123', 1);
    expect(m1.email).not.toBe(m2.email);
    expect(m1.businessName).not.toBe(m2.businessName);
  });
});

describe('generateCustomerIdentity', () => {
  it('uses reserved 1-555-000 phone range', () => {
    const customer = generateCustomerIdentity('run-123', 'journey-1');
    expect(customer.phone).toMatch(/^1555000/);
    expect(isSyntheticPhone(customer.phone)).toBe(true);
  });

  it('generates different phones for different journeys', () => {
    const c1 = generateCustomerIdentity('run-123', 'journey-1');
    const c2 = generateCustomerIdentity('run-123', 'journey-2');
    expect(c1.phone).not.toBe(c2.phone);
  });

  it('includes journey ID', () => {
    const customer = generateCustomerIdentity('run-123', 'journey-abc');
    expect(customer.journeyId).toBe('journey-abc');
  });

  it('sanitized version masks phone', () => {
    const customer = generateCustomerIdentity('run-123', 'journey-1');
    expect(customer.sanitized.phone).toContain('****');
  });
});

describe('identification helpers', () => {
  it('isSyntheticEmail correctly identifies synthetic emails', () => {
    expect(isSyntheticEmail('synth-e2e-merchant-abc123@test.waaiio.internal')).toBe(true);
    expect(isSyntheticEmail('real-user@gmail.com')).toBe(false);
    expect(isSyntheticEmail('synth-e2e-merchant@wrong-domain.com')).toBe(false);
  });

  it('isSyntheticPhone correctly identifies reserved phones', () => {
    expect(isSyntheticPhone('15550001234')).toBe(true);
    expect(isSyntheticPhone('+15550001234')).toBe(true);
    expect(isSyntheticPhone('2348012345678')).toBe(false);
  });

  it('isSyntheticBusinessName correctly identifies synthetic businesses', () => {
    expect(isSyntheticBusinessName('SynthBiz abc123')).toBe(true);
    expect(isSyntheticBusinessName('Real Business Name')).toBe(false);
  });
});
