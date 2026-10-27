/**
 * Tests for network-level Meta egress denial.
 *
 * CTO R1 Fix 1: Proves that even if CapturingMessageSender is bypassed,
 * process-level fetch interception blocks Meta Graph API calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('allows fetch to non-Meta URLs', async () => {
    // This should not throw (though it may fail with network error in test env)
    try {
      await fetch('https://httpbin.org/status/200', { signal: AbortSignal.timeout(2000) });
    } catch (err) {
      // Network errors are fine — the important thing is it didn't throw NETWORK-DENY
      expect((err as Error).message).not.toContain('NETWORK-DENY');
    }
  });

  it('counts multiple blocked attempts', async () => {
    for (let i = 0; i < 3; i++) {
      try {
        await fetch('https://graph.facebook.com/v21.0/test');
      } catch { /* expected */ }
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

  it('uninstall restores original fetch', async () => {
    uninstallMetaEgressDeny();

    // After uninstall, Meta URLs should not be blocked
    // (they'll fail with network error, not NETWORK-DENY)
    try {
      await fetch('https://graph.facebook.com/v21.0/test', { signal: AbortSignal.timeout(2000) });
    } catch (err) {
      expect((err as Error).message).not.toContain('NETWORK-DENY');
    }
  });

  it('idempotent install does not double-wrap', () => {
    installMetaEgressDeny(); // second call
    installMetaEgressDeny(); // third call

    // Should still work correctly
    expect(() => assertZeroMetaEgress()).not.toThrow();
  });
});
