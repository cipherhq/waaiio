import { describe, expect, it, vi } from 'vitest';
import { checkServing } from '../release-v3/platform.mjs';

// Staging admin sits behind Vercel's login. The release gate reaches it with
// Vercel's automation bypass secret; nothing else gets that secret.

const BYPASS = 'bypass-secret-for-tests-0123456789';

function okFetch() {
  return vi.fn(async (url: string) => new Response(url.endsWith('/api/release-identity') ? JSON.stringify({}) : 'ok', { status: 200 }));
}

function headersOf(call: unknown[]) {
  return new Headers((call[1] as RequestInit | undefined)?.headers);
}

describe('release gate: staging admin bypass', () => {
  it('sends the bypass header to staging admin when the secret is set', async () => {
    const fetchImpl = okFetch();
    await checkServing('staging', 'admin', {}, fetchImpl, { VERCEL_ADMIN_STAGING_BYPASS: BYPASS });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://admin-staging.waaiio.com/login');
    expect(headersOf(fetchImpl.mock.calls[0]).get('x-vercel-protection-bypass')).toBe(BYPASS);
  });

  it('sends no bypass header when the secret is not set', async () => {
    const fetchImpl = okFetch();
    await checkServing('staging', 'admin', {}, fetchImpl, {});
    expect(headersOf(fetchImpl.mock.calls[0]).has('x-vercel-protection-bypass')).toBe(false);
  });

  it('never sends the secret to production admin', async () => {
    const fetchImpl = okFetch();
    await checkServing('production', 'admin', {}, fetchImpl, { VERCEL_ADMIN_STAGING_BYPASS: BYPASS });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://admin.waaiio.com/login');
    expect(headersOf(fetchImpl.mock.calls[0]).has('x-vercel-protection-bypass')).toBe(false);
  });

  it('never sends the secret to the staging or production merchant site', async () => {
    for (const environment of ['staging', 'production'] as const) {
      const fetchImpl = okFetch();
      await expect(checkServing(environment, 'merchant', { sha: 'x', id: 'y' }, fetchImpl, { VERCEL_ADMIN_STAGING_BYPASS: BYPASS })).rejects.toThrow('identity mismatch');
      for (const call of fetchImpl.mock.calls) expect(headersOf(call).has('x-vercel-protection-bypass')).toBe(false);
    }
  });

  it('says the secret is missing when staging admin answers 401 without it', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    await expect(checkServing('staging', 'admin', {}, fetchImpl, {})).rejects.toThrow('VERCEL_ADMIN_STAGING_BYPASS');
  });

  it('says the secret is missing when Vercel redirects to its login without it', async () => {
    // Vercel answers a protected custom domain with a 302 to its login page;
    // the gate fetches with redirect: 'error', so fetch rejects.
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('fetch failed: unexpected redirect');
    });
    await expect(checkServing('staging', 'admin', {}, fetchImpl, {})).rejects.toThrow('VERCEL_ADMIN_STAGING_BYPASS');
  });

  it('keeps the original network error when the secret is set or the check is not staging admin', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed: ECONNRESET'); });
    await expect(checkServing('staging', 'admin', {}, fetchImpl, { VERCEL_ADMIN_STAGING_BYPASS: BYPASS })).rejects.toThrow('ECONNRESET');
    await expect(checkServing('production', 'admin', {}, fetchImpl, {})).rejects.toThrow('ECONNRESET');
  });
});
