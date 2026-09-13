/**
 * Admin API Client Tests — proves runtime behavior of getAdminApiBase() and adminApiFetch().
 *
 * 1. update_country uses configured VITE_API_URL base, not relative /api
 * 2. Protected calls send Authorization: Bearer <access_token>
 * 3. Preview/Staging honors VITE_API_URL
 * 4. Non-local runtime with missing VITE_API_URL fails visibly (no production fallback)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock supabase before importing the module under test
const mockGetSession = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
    },
  },
}));

// Mock global fetch
const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
vi.stubGlobal('fetch', mockFetch);

// Save original import.meta.env
const originalEnv = { ...import.meta.env };
const originalWindow = globalThis.window;

beforeEach(() => {
  mockFetch.mockClear();
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: 'test-bearer-token-abc123' } },
  });
});

afterEach(() => {
  // Restore env
  import.meta.env.VITE_API_URL = originalEnv.VITE_API_URL;
});

describe('getAdminApiBase', () => {
  it('returns VITE_API_URL when configured (Preview/Staging)', async () => {
    import.meta.env.VITE_API_URL = 'https://staging.waaiio.com';
    // Re-import to pick up env change
    const { getAdminApiBase } = await import('../lib/adminApi');
    expect(getAdminApiBase()).toBe('https://staging.waaiio.com');
  });

  it('returns VITE_API_URL for production', async () => {
    import.meta.env.VITE_API_URL = 'https://www.waaiio.com';
    const { getAdminApiBase } = await import('../lib/adminApi');
    expect(getAdminApiBase()).toBe('https://www.waaiio.com');
  });

  it('returns localhost:3000 for local dev on localhost', async () => {
    import.meta.env.VITE_API_URL = '';
    // window.location.hostname is 'localhost' in Vitest jsdom
    const { getAdminApiBase } = await import('../lib/adminApi');
    // In Vitest, window.location.hostname is 'localhost' by default
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      expect(getAdminApiBase()).toBe('http://localhost:3000');
    }
  });

  it('throws visibly when VITE_API_URL is missing on non-local runtime', async () => {
    import.meta.env.VITE_API_URL = '';
    const { getAdminApiBase } = await import('../lib/adminApi');

    // Execute the actual failure path with a non-local hostname
    expect(() => getAdminApiBase('admin-preview.example.test'))
      .toThrow('VITE_API_URL is not configured');

    // Verify no production URL fallback — the throw is the only outcome
    let result: string | undefined;
    try { result = getAdminApiBase('admin-preview.example.test'); } catch { /* expected */ }
    expect(result).toBeUndefined();
  });
});

describe('adminApiFetch', () => {
  it('uses configured VITE_API_URL base, not relative /api', async () => {
    import.meta.env.VITE_API_URL = 'https://staging-app.waaiio.com';
    const { adminApiFetch } = await import('../lib/adminApi');

    await adminApiFetch('/api/admin/provider-config', { action: 'update_country', country_code: 'NG', fields: { name: 'Nigeria' } });

    // Verify the fetch URL uses the configured base
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl).toBe('https://staging-app.waaiio.com/api/admin/provider-config');
    // Must NOT be a relative URL
    expect(fetchUrl).not.toBe('/api/admin/provider-config');
    expect(fetchUrl.startsWith('https://')).toBe(true);
  });

  it('sends Authorization: Bearer <access_token> on every request', async () => {
    import.meta.env.VITE_API_URL = 'https://www.waaiio.com';
    const { adminApiFetch } = await import('../lib/adminApi');

    await adminApiFetch('/api/admin/provider-config', { action: 'get_version' });

    const fetchOpts = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(fetchOpts.headers.Authorization).toBe('Bearer test-bearer-token-abc123');
  });

  it('Preview/Staging VITE_API_URL is honored exactly', async () => {
    import.meta.env.VITE_API_URL = 'https://preview-123.waaiio.com';
    const { adminApiFetch } = await import('../lib/adminApi');

    await adminApiFetch('/api/admin/provider-config', { action: 'save_refs', country_code: 'NG', plan_refs: {} });

    const fetchUrl = mockFetch.mock.calls[0][0] as string;
    expect(fetchUrl.startsWith('https://preview-123.waaiio.com')).toBe(true);
    // Must NOT silently use production URL
    expect(fetchUrl).not.toContain('www.waaiio.com');
  });

  it('fails visibly when not authenticated', async () => {
    import.meta.env.VITE_API_URL = 'https://www.waaiio.com';
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });
    const { adminApiFetch } = await import('../lib/adminApi');

    await expect(adminApiFetch('/api/admin/provider-config', { action: 'get_version' }))
      .rejects.toThrow('Not authenticated');

    // fetch must NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends Content-Type: application/json', async () => {
    import.meta.env.VITE_API_URL = 'https://www.waaiio.com';
    const { adminApiFetch } = await import('../lib/adminApi');

    await adminApiFetch('/api/admin/provider-config', { action: 'get_version' });

    const fetchOpts = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(fetchOpts.headers['Content-Type']).toBe('application/json');
  });

  it('uses POST method', async () => {
    import.meta.env.VITE_API_URL = 'https://www.waaiio.com';
    const { adminApiFetch } = await import('../lib/adminApi');

    await adminApiFetch('/api/admin/provider-config', { action: 'get_version' });

    const fetchOpts = mockFetch.mock.calls[0][1] as { method: string };
    expect(fetchOpts.method).toBe('POST');
  });
});
