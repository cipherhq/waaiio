import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({
  auth: { getUser: async () => ({ data: { user: null } }) },
  from: () => { const query: any = { select: () => query, eq: () => query, single: async () => ({ data: { value: false } }) }; return query; },
}) }));
vi.mock('@/lib/staging-test-mode', () => ({ isStagingTestMode: () => false }));
import { middleware } from '@/middleware';
describe('donation anonymous middleware boundary', () => {
  it('admits the public page and same-origin donation without a login cookie', async () => {
    const page = await middleware(new NextRequest('https://www.waaiio.com/donate/campaign'));
    expect(page.status).toBe(200); expect(page.headers.get('location')).toBeNull();
    const api = await middleware(new NextRequest('https://www.waaiio.com/api/campaigns/campaign/donate', {
      method: 'POST', headers: { origin: 'https://www.waaiio.com' },
    }));
    expect(api.status).toBe(200); expect(api.headers.get('cache-control')).toBe('no-store');
  });
  it('retains cross-origin POST rejection', async () => {
    const response = await middleware(new NextRequest('https://www.waaiio.com/api/campaigns/campaign/donate', {
      method: 'POST', headers: { origin: 'https://untrusted.example' },
    }));
    expect(response.status).toBe(403);
  });
});
