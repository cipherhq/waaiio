/**
 * Tests for network-level Meta egress denial.
 *
 * CTO R2 Fix 4: All tests are fully local — no live network requests.
 * Uses mocked fetch to verify interception behavior without hitting
 * external hosts (graph.facebook.com, httpbin.org, etc.).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installMetaEgressDeny,
  uninstallMetaEgressDeny,
  getBlockedMetaAttempts,
  assertZeroMetaEgress,
  resetMetaEgressCounter,
} from '../lib/network-deny';

describe('network-deny', () => {
  beforeEach(() => {
    installMetaEgressDeny();
  });

  afterEach(() => {
    uninstallMetaEgressDeny();
    resetMetaEgressCounter();
  });

  it('blocks fetch to graph.facebook.com', async () => {
    await expect(
      fetch('https://graph.facebook.com/v21.0/123/messages')
    ).rejects.toThrow('NETWORK-DENY');

    expect(getBlockedMetaAttempts()).toBe(1);
  });

  it('does not throw NETWORK-DENY for non-Meta URLs', async () => {
    // Use a local/mocked URL pattern to verify non-Meta URLs pass the interceptor.
    // Do NOT make real network requests in unit tests.
    try {
      // This will fail with a network error (no server listening), but
      // the important assertion is that it does NOT throw NETWORK-DENY.
      await fetch('http://127.0.0.1:19999/synthetic-e2e-test', {
        signal: AbortSignal.timeout(100),
      });
    } catch (err) {
      // Expected: connection refused or timeout — NOT a NETWORK-DENY block
      expect((err as Error).message).not.toContain('NETWORK-DENY');
    }
  });

  it('counts multiple blocked attempts', async () => {
    for (let i = 0; i < 3; i++) {
      try {
        await fetch('https://graph.facebook.com/v21.0/test');
      } catch { /* expected NETWORK-DENY */ }
    }

    expect(getBlockedMetaAttempts()).toBe(3);
  });

  it('assertZeroMetaEgress passes when no Meta calls attempted', () => {
    expect(() => assertZeroMetaEgress()).not.toThrow();
  });

  it('assertZeroMetaEgress fails when Meta calls were blocked', async () => {
    try {
      await fetch('https://graph.facebook.com/v21.0/test');
    } catch { /* expected */ }

    expect(() => assertZeroMetaEgress()).toThrow('SAFETY VIOLATION');
  });

  it('uninstall restores original fetch (verified by reference)', () => {
    const fetchDuringDeny = globalThis.fetch;
    uninstallMetaEgressDeny();
    const fetchAfterUninstall = globalThis.fetch;

    // After uninstall, the fetch function reference should differ
    // (the deny wrapper is removed, original is restored)
    expect(fetchAfterUninstall).not.toBe(fetchDuringDeny);
  });

  it('idempotent install does not double-wrap', () => {
    const fetchAfterFirst = globalThis.fetch;
    installMetaEgressDeny(); // second call — should be no-op
    const fetchAfterSecond = globalThis.fetch;

    // Same wrapper — not double-wrapped
    expect(fetchAfterSecond).toBe(fetchAfterFirst);
    expect(() => assertZeroMetaEgress()).not.toThrow();
  });
});
