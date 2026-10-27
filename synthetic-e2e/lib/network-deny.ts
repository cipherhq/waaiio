/**
 * Network-level Meta egress denial.
 *
 * CTO R1 Fix 1: Even if CapturingMessageSender is bypassed somehow,
 * this layer blocks any fetch() call to Meta Graph API at the process level.
 *
 * Must be installed BEFORE any BotService invocation in the test harness.
 */

const META_GRAPH_API = 'graph.facebook.com';

let originalFetch: typeof globalThis.fetch | null = null;
let blockedAttempts = 0;

/**
 * Install a global fetch interceptor that blocks Meta Graph API calls.
 * All other requests pass through to the original fetch.
 */
export function installMetaEgressDeny(): void {
  if (originalFetch) return; // Already installed
  originalFetch = globalThis.fetch;
  blockedAttempts = 0;

  globalThis.fetch = async function deniedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.includes(META_GRAPH_API)) {
      blockedAttempts++;
      throw new Error(
        `NETWORK-DENY: Blocked fetch to Meta Graph API: ${url}. ` +
        `Synthetic tests must never reach Meta. Total blocked: ${blockedAttempts}.`
      );
    }

    return originalFetch!(input, init);
  };
}

/**
 * Remove the fetch interceptor and restore the original fetch.
 */
export function uninstallMetaEgressDeny(): void {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

/**
 * Get the count of blocked Meta API attempts.
 */
export function getBlockedMetaAttempts(): number {
  return blockedAttempts;
}

/**
 * Assert that zero Meta API attempts were made during the test.
 * This is a process-level safety proof.
 */
export function assertZeroMetaEgress(): void {
  if (blockedAttempts > 0) {
    throw new Error(
      `SAFETY VIOLATION: ${blockedAttempts} Meta Graph API call(s) were attempted ` +
      `at the network level and blocked. The outbound interception may have a gap.`
    );
  }
}

/**
 * Reset the blocked attempts counter.
 */
export function resetMetaEgressCounter(): void {
  blockedAttempts = 0;
}
