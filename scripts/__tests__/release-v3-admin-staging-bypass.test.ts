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

  // Node's fetch rejects a redirect under redirect: 'error' like this.
  const redirectRejection = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });

  it('says the secret is missing when staging admin answers 401 without it', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    await expect(checkServing('staging', 'admin', {}, fetchImpl, {})).rejects.toThrow('needs VERCEL_ADMIN_STAGING_BYPASS');
  });

  it('says the secret is missing when Vercel redirects to its login without it', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      throw redirectRejection();
    });
    await expect(checkServing('staging', 'admin', {}, fetchImpl, {})).rejects.toThrow('needs VERCEL_ADMIN_STAGING_BYPASS');
  });

  it('says the secret was rejected when Vercel still redirects or answers 401 with it', async () => {
    const redirecting = vi.fn(async () => { throw redirectRejection(); });
    await expect(checkServing('staging', 'admin', {}, redirecting, { VERCEL_ADMIN_STAGING_BYPASS: BYPASS })).rejects.toThrow('rejected VERCEL_ADMIN_STAGING_BYPASS');
    const unauthorized = vi.fn(async () => new Response('', { status: 401 }));
    await expect(checkServing('staging', 'admin', {}, unauthorized, { VERCEL_ADMIN_STAGING_BYPASS: BYPASS })).rejects.toThrow('rejected VERCEL_ADMIN_STAGING_BYPASS');
  });

  it('keeps other network errors as they are, with or without the secret', async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND') }); });
    await expect(checkServing('staging', 'admin', {}, fetchImpl, {})).rejects.toThrow('fetch failed');
    await expect(checkServing('staging', 'admin', {}, fetchImpl, {})).rejects.not.toThrow('BYPASS');
    await expect(checkServing('staging', 'admin', {}, fetchImpl, { VERCEL_ADMIN_STAGING_BYPASS: BYPASS })).rejects.not.toThrow('BYPASS');
    await expect(checkServing('production', 'admin', {}, fetchImpl, {})).rejects.toThrow('fetch failed');
  });
});
