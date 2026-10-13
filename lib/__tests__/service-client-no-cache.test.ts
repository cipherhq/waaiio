/**
 * Asserts that createServiceClient always passes cache:'no-store' to fetch,
 * preventing Next.js 14 Data Cache from serving stale PostgREST responses.
 *
 * Regression test for #620: admin payout list showed stale data because the
 * service client's default fetch allowed Data Cache hits on GET requests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the fetch wrapper that createServiceClient passes to supabase-js
let capturedFetchFn: typeof fetch | undefined;

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, _key: string, options: any) => {
    capturedFetchFn = options?.global?.fetch;
    return { from: vi.fn() };
  }),
}));

describe('createServiceClient cache behavior', () => {
  beforeEach(() => {
    capturedFetchFn = undefined;
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  });

  it('always provides a fetch wrapper with cache:no-store (default call)', async () => {
    const { createServiceClient } = await import('@/lib/supabase/service');
    createServiceClient();

    expect(capturedFetchFn).toBeDefined();

    // Spy on global fetch to capture the init argument
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await capturedFetchFn!('https://test.supabase.co/rest/v1/payouts', {});
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test.supabase.co/rest/v1/payouts',
      expect.objectContaining({ cache: 'no-store' }),
    );
    fetchSpy.mockRestore();
  });

  it('provides the same fetch wrapper when noStore:true is passed (backward compat)', async () => {
    const { createServiceClient } = await import('@/lib/supabase/service');
    createServiceClient({ noStore: true });

    expect(capturedFetchFn).toBeDefined();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    await capturedFetchFn!('https://test.supabase.co/rest/v1/payouts', { method: 'GET' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test.supabase.co/rest/v1/payouts',
      expect.objectContaining({ cache: 'no-store', method: 'GET' }),
    );
    fetchSpy.mockRestore();
  });

  it('preserves caller init properties alongside cache:no-store', async () => {
    const { createServiceClient } = await import('@/lib/supabase/service');
    createServiceClient();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    const customHeaders = { Authorization: 'Bearer test' };
    await capturedFetchFn!('https://test.supabase.co/rest/v1/payouts', {
      method: 'POST',
      headers: customHeaders,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test.supabase.co/rest/v1/payouts',
      expect.objectContaining({
        cache: 'no-store',
        method: 'POST',
        headers: customHeaders,
      }),
    );
    fetchSpy.mockRestore();
  });
});
