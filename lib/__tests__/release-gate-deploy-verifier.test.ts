/**
 * Release Gate V2 — Deploy Verifier Tests (B4b)
 *
 * All tests use mocked HTTP responses. No live staging/provider calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyDeployment, parseIdentity, fetchWithTimeout } from '../release-gate/deploy-verifier';

// ═══════════════════════════════════════════════════════════════════
// Mock fetch
// ═══════════════════════════════════════════════════════════════════

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(status: number, body: unknown, opts?: { delay?: number }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      if (opts?.delay) await new Promise(r => setTimeout(r, opts.delay));
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    headers: new Headers(),
  } as unknown as Response;
}

const GOOD_IDENTITY = {
  sha: 'abc123def456abc123def456abc123def456abc1',
  projectId: 'prj_test123',
  deploymentId: 'dpl_test456',
  vercelEnv: 'production',
  timestamp: '2026-09-26T00:00:00Z',
};

const GOOD_HEALTH = { status: 'ok', timestamp: '2026-09-26T00:00:00Z' };

function setupMocks(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const defaults: Record<string, { status: number; body: unknown }> = {
    '/api/release-identity': { status: 200, body: GOOD_IDENTITY },
    '/api/health': { status: 200, body: GOOD_HEALTH },
    '/': { status: 200, body: '<html><title>Waaiio</title></html>' },
    '/pricing': { status: 200, body: '<html>Starter plan</html>' },
    '/features': { status: 200, body: '<html>Features page</html>' },
    '/login': { status: 200, body: '<html>Sign in</html>' },
    '/terms': { status: 200, body: '<html>Terms</html>' },
    '/privacy': { status: 200, body: '<html>Privacy</html>' },
  };
  const merged = { ...defaults, ...overrides };

  mockFetch.mockImplementation(async (url: string | URL) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [path, resp] of Object.entries(merged)) {
      if (urlStr.endsWith(path) || urlStr.endsWith(path + '/')) {
        return mockResponse(resp.status, resp.body);
      }
    }
    return mockResponse(404, 'Not found');
  });
}

// ═══════════════════════════════════════════════════════════════════
// parseIdentity
// ═══════════════════════════════════════════════════════════════════

describe('parseIdentity', () => {
  it('parses valid identity JSON', () => {
    const result = parseIdentity(JSON.stringify(GOOD_IDENTITY));
    expect(result).toMatchObject({ sha: GOOD_IDENTITY.sha, projectId: GOOD_IDENTITY.projectId });
  });

  it('returns null for missing sha', () => {
    expect(parseIdentity(JSON.stringify({ projectId: 'x', deploymentId: 'y' }))).toBeNull();
  });

  it('returns null for non-string sha', () => {
    expect(parseIdentity(JSON.stringify({ sha: 123, projectId: 'x', deploymentId: 'y' }))).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseIdentity('not json')).toBeNull();
  });

  it('returns null for SHA that is not 40 hex chars', () => {
    expect(parseIdentity(JSON.stringify({
      ...GOOD_IDENTITY, sha: 'abc123', // too short
    }))).toBeNull();
    expect(parseIdentity(JSON.stringify({
      ...GOOD_IDENTITY, sha: 'ZZZZ23def456abc123def456abc123def456abc1', // non-hex
    }))).toBeNull();
  });

  it('returns null for projectId without prj_ prefix', () => {
    expect(parseIdentity(JSON.stringify({
      ...GOOD_IDENTITY, projectId: 'not_a_project',
    }))).toBeNull();
  });

  it('returns null for deploymentId without dpl_ prefix', () => {
    expect(parseIdentity(JSON.stringify({
      ...GOOD_IDENTITY, deploymentId: 'not_a_deployment',
    }))).toBeNull();
  });

  it('returns null for empty vercelEnv', () => {
    expect(parseIdentity(JSON.stringify({
      ...GOOD_IDENTITY, vercelEnv: '',
    }))).toBeNull();
  });

  it('returns null for invalid timestamp', () => {
    expect(parseIdentity(JSON.stringify({
      ...GOOD_IDENTITY, timestamp: 'not-a-date',
    }))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// verifyDeployment — identity checks
// ═══════════════════════════════════════════════════════════════════

describe('verifyDeployment — identity', () => {
  it('exact SHA + project match passes', async () => {
    setupMocks();
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('PASS');
    expect(result.checks.find(c => c.name === 'sha-match')?.status).toBe('pass');
    expect(result.checks.find(c => c.name === 'project-match')?.status).toBe('pass');
  });

  it('SHA mismatch fails', async () => {
    setupMocks();
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: 'wrong_sha_000000000000000000000000000000000',
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'sha-match')?.status).toBe('fail');
  });

  it('project mismatch fails', async () => {
    setupMocks();
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: 'prj_wrong',
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'project-match')?.status).toBe('fail');
  });

  it('malformed identity JSON fails', async () => {
    setupMocks({
      '/api/release-identity': { status: 200, body: '{"broken": true}' },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'identity-parseable')?.status).toBe('fail');
  });

  it('missing identity fields fail closed', async () => {
    setupMocks({
      '/api/release-identity': { status: 200, body: '{"sha":"abc"}' },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: 'abc',
      expectedProject: 'prj_test',
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'identity-parseable')?.status).toBe('fail');
  });

  it('identity 404 fails', async () => {
    setupMocks({
      '/api/release-identity': { status: 404, body: 'Not found' },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'identity-reachable')?.status).toBe('fail');
  });

  it('identity 500 fails', async () => {
    setupMocks({
      '/api/release-identity': { status: 500, body: '{"error":"missing SHA"}' },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'identity-reachable')?.status).toBe('fail');
  });

  it('unreachable target fails', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'identity-reachable')?.status).toBe('fail');
  });

  it('required identity fields absent in env returns 500 and fails', async () => {
    setupMocks({
      '/api/release-identity': { status: 500, body: '{"error":"Missing or malformed deployment SHA"}' },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
  });

  it('malformed-but-present SHA (short hex) fails identity parse', async () => {
    setupMocks({
      '/api/release-identity': { status: 200, body: JSON.stringify({
        ...GOOD_IDENTITY, sha: 'abc123', // valid hex but not 40 chars
      })},
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: 'abc123',
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'identity-parseable')?.status).toBe('fail');
  });

  it('malformed projectId without prj_ prefix fails identity parse', async () => {
    setupMocks({
      '/api/release-identity': { status: 200, body: JSON.stringify({
        ...GOOD_IDENTITY, projectId: 'wrong_prefix_123',
      })},
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: 'wrong_prefix_123',
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'identity-parseable')?.status).toBe('fail');
  });

  it('timeout on identity request fails', async () => {
    mockFetch.mockImplementation(async (_url: string, opts?: RequestInit) => {
      // Simulate a fetch that hangs until abort
      return new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new Error('The operation was aborted'));
          });
        }
      });
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
      timeoutMs: 50, // very short timeout to trigger abort
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'identity-reachable')?.status).toBe('fail');
    expect(result.checks.find(c => c.name === 'identity-reachable')?.detail).toContain('Timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════
// verifyDeployment — health checks
// ═══════════════════════════════════════════════════════════════════

describe('verifyDeployment — health', () => {
  it('health critical fails', async () => {
    setupMocks({
      '/api/health': { status: 503, body: { status: 'critical', timestamp: '2026-09-26T00:00:00Z' } },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'health-status')?.status).toBe('fail');
  });

  it('health degraded produces advisory warning but not hard failure', async () => {
    setupMocks({
      '/api/health': { status: 200, body: { status: 'degraded', timestamp: '2026-09-26T00:00:00Z' } },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('WARN');
    expect(result.checks.find(c => c.name === 'health-status')?.status).toBe('warn');
  });
});

// ═══════════════════════════════════════════════════════════════════
// verifyDeployment — canary checks
// ═══════════════════════════════════════════════════════════════════

describe('verifyDeployment — canary', () => {
  it('canary 5xx fails', async () => {
    setupMocks({
      '/pricing': { status: 500, body: 'Internal Server Error' },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'canary:/pricing')?.status).toBe('fail');
  });

  it('all canary requests are GET only', async () => {
    setupMocks();
    await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });

    // Every fetch call must use GET (default) or have method: 'GET'
    for (const call of mockFetch.mock.calls) {
      const opts = call[1] as RequestInit | undefined;
      const method = opts?.method || 'GET';
      expect(method).toBe('GET');
    }
  });

  it('canary 301/302 redirect fails (not followed, not treated as success)', async () => {
    setupMocks({
      '/terms': { status: 301, body: '' },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find(c => c.name === 'canary:/terms')?.status).toBe('fail');
    expect(result.checks.find(c => c.name === 'canary:/terms')?.detail).toContain('Non-2xx');
  });

  it('canary skipped when identity fails', async () => {
    setupMocks({
      '/api/release-identity': { status: 404, body: 'Not found' },
    });
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    // Canary routes should not appear in checks since identity failed
    const canaryChecks = result.checks.filter(c => c.name.startsWith('canary:'));
    expect(canaryChecks).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Full pass scenario
// ═══════════════════════════════════════════════════════════════════

describe('verifyDeployment — full pass', () => {
  it('all checks pass with correct identity, healthy, and responsive canary', async () => {
    setupMocks();
    const result = await verifyDeployment({
      targetUrl: 'https://staging.test',
      expectedSha: GOOD_IDENTITY.sha,
      expectedProject: GOOD_IDENTITY.projectId,
    });
    expect(result.verdict).toBe('PASS');
    expect(result.checks.every(c => c.status === 'pass')).toBe(true);
    // Should have: identity-reachable, identity-parseable, sha-match, project-match,
    //              health-reachable, health-status, plus 6 canary routes = 12 total
    expect(result.checks.length).toBe(12);
  });
});
