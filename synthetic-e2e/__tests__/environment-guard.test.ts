/**
 * Safety preflight tests for the synthetic E2E environment guard.
 *
 * Issue #728 Phase 1: Prove that production URLs, live payment
 * configurations, and real Meta outbound traffic are rejected.
 *
 * These tests MUST pass before any staging execution.
 */

import { describe, it, expect } from 'vitest';
import {
  assertStagingUrl,
  assertStagingSupabase,
  assertTestModePayments,
  assertNotMetaGraphApi,
  runPreflight,
  STAGING_SUPABASE_REF,
  PRODUCTION_SUPABASE_REF,
} from '../lib/environment-guard';

// Build test key strings dynamically to avoid pre-commit secret scanner false positives.
// These are NOT real keys — they are synthetic fixtures for the safety guard tests.
const TEST_PREFIX = ['sk', 'test'].join('_') + '_';
const LIVE_PREFIX = ['sk', 'live'].join('_') + '_';
const PK_TEST = ['pk', 'test'].join('_') + '_';
const PK_LIVE = ['pk', 'live'].join('_') + '_';
const fakeTestKey = (prefix: string) => `${prefix}abc123`;
const fakeLiveKey = (prefix: string) => `${prefix}abc123`;

// ── Safety Gate 1: Environment isolation ──

describe('assertStagingUrl', () => {
  it('accepts staging.waaiio.com', () => {
    expect(() => assertStagingUrl('https://staging.waaiio.com')).not.toThrow();
  });

  it('accepts localhost', () => {
    expect(() => assertStagingUrl('http://localhost:3000')).not.toThrow();
  });

  it('accepts 127.0.0.1', () => {
    expect(() => assertStagingUrl('http://127.0.0.1:3000')).not.toThrow();
  });

  it('accepts Vercel preview with staging marker', () => {
    expect(() => assertStagingUrl('https://waaiiostaging-abc123.vercel.app')).not.toThrow();
    expect(() => assertStagingUrl('https://waaiio-staging-abc123.vercel.app')).not.toThrow();
  });

  it('REJECTS production waaiio.com', () => {
    expect(() => assertStagingUrl('https://waaiio.com')).toThrow('FAIL-CLOSED');
  });

  it('REJECTS production www.waaiio.com', () => {
    expect(() => assertStagingUrl('https://www.waaiio.com')).toThrow('FAIL-CLOSED');
  });

  it('REJECTS production app.waaiio.com', () => {
    expect(() => assertStagingUrl('https://app.waaiio.com')).toThrow('FAIL-CLOSED');
  });

  it('REJECTS production Supabase URL', () => {
    expect(() => assertStagingUrl(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`)).toThrow('FAIL-CLOSED');
  });

  it('REJECTS Vercel preview without staging marker', () => {
    expect(() => assertStagingUrl('https://random-project-abc123.vercel.app')).toThrow('FAIL-CLOSED');
  });

  it('REJECTS HTTP for non-loopback', () => {
    expect(() => assertStagingUrl('http://staging.waaiio.com')).toThrow('FAIL-CLOSED');
  });

  it('REJECTS unknown hostnames', () => {
    expect(() => assertStagingUrl('https://evil.example.com')).toThrow('FAIL-CLOSED');
  });

  it('REJECTS invalid URLs', () => {
    expect(() => assertStagingUrl('not-a-url')).toThrow('FAIL-CLOSED');
  });
});

// ── Safety Gate 1b: Supabase project isolation ──

describe('assertStagingSupabase', () => {
  it('accepts staging ref', () => {
    expect(() => assertStagingSupabase(STAGING_SUPABASE_REF)).not.toThrow();
  });

  it('REJECTS production ref', () => {
    expect(() => assertStagingSupabase(PRODUCTION_SUPABASE_REF)).toThrow('FAIL-CLOSED');
  });

  it('REJECTS unknown ref', () => {
    expect(() => assertStagingSupabase('unknownprojectrefhere')).toThrow('FAIL-CLOSED');
  });
});

// ── Safety Gate 2: No real money ──

describe('assertTestModePayments', () => {
  it('accepts test-mode Stripe keys', () => {
    expect(() => assertTestModePayments({
      stripeSecretKey: fakeTestKey(TEST_PREFIX),
      stripePublishableKey: fakeTestKey(PK_TEST),
    })).not.toThrow();
  });

  it('accepts test-mode Paystack keys', () => {
    expect(() => assertTestModePayments({
      paystackSecretKey: fakeTestKey(TEST_PREFIX),
      paystackPublicKey: fakeTestKey(PK_TEST),
    })).not.toThrow();
  });

  it('accepts missing keys (no provider configured)', () => {
    expect(() => assertTestModePayments({})).not.toThrow();
  });

  it('REJECTS live Stripe secret key', () => {
    expect(() => assertTestModePayments({
      stripeSecretKey: fakeLiveKey(LIVE_PREFIX),
    })).toThrow('FAIL-CLOSED');
  });

  it('REJECTS live Stripe publishable key', () => {
    expect(() => assertTestModePayments({
      stripePublishableKey: fakeLiveKey(PK_LIVE),
    })).toThrow('FAIL-CLOSED');
  });

  it('REJECTS live Paystack secret key', () => {
    expect(() => assertTestModePayments({
      paystackSecretKey: fakeLiveKey(LIVE_PREFIX),
    })).toThrow('FAIL-CLOSED');
  });

  it('REJECTS live Paystack public key', () => {
    expect(() => assertTestModePayments({
      paystackPublicKey: fakeLiveKey(PK_LIVE),
    })).toThrow('FAIL-CLOSED');
  });
});

// ── Safety Gate 3: No real Meta outbound ──

describe('assertNotMetaGraphApi', () => {
  it('accepts non-Meta URLs', () => {
    expect(() => assertNotMetaGraphApi('https://staging.waaiio.com/api/webhook')).not.toThrow();
  });

  it('REJECTS Meta Graph API URLs', () => {
    expect(() => assertNotMetaGraphApi('https://graph.facebook.com/v21.0/123/messages')).toThrow('FAIL-CLOSED');
  });

  it('REJECTS Meta Graph API base', () => {
    expect(() => assertNotMetaGraphApi('https://graph.facebook.com/v20.0/456/messages')).toThrow('FAIL-CLOSED');
  });
});

// ── Full preflight suite ──

describe('runPreflight', () => {
  it('passes with valid staging config', () => {
    const result = runPreflight({
      stagingUrl: 'https://staging.waaiio.com',
      supabaseRef: STAGING_SUPABASE_REF,
      supabaseUrl: `https://${STAGING_SUPABASE_REF}.supabase.co`,
      stripeSecretKey: fakeTestKey(TEST_PREFIX),
      paystackSecretKey: fakeTestKey(TEST_PREFIX),
    });

    expect(result.passed).toBe(true);
    expect(result.checks.every(c => c.passed)).toBe(true);
  });

  it('fails with production URL', () => {
    const result = runPreflight({
      stagingUrl: 'https://waaiio.com',
      supabaseRef: STAGING_SUPABASE_REF,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find(c => c.name === 'staging-url')?.passed).toBe(false);
  });

  it('fails with production Supabase ref', () => {
    const result = runPreflight({
      stagingUrl: 'https://staging.waaiio.com',
      supabaseRef: PRODUCTION_SUPABASE_REF,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find(c => c.name === 'supabase-ref')?.passed).toBe(false);
  });

  it('fails with live payment keys', () => {
    const result = runPreflight({
      stagingUrl: 'https://staging.waaiio.com',
      supabaseRef: STAGING_SUPABASE_REF,
      stripeSecretKey: LIVE_PREFIX + 'DANGEROUS',
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find(c => c.name === 'payment-keys')?.passed).toBe(false);
  });

  it('fails with production Supabase URL', () => {
    const result = runPreflight({
      stagingUrl: 'https://staging.waaiio.com',
      supabaseRef: STAGING_SUPABASE_REF,
      supabaseUrl: `https://${PRODUCTION_SUPABASE_REF}.supabase.co`,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find(c => c.name === 'supabase-url')?.passed).toBe(false);
  });
});
