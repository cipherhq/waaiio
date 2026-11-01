import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const { user, business, save, fetchMock } = vi.hoisted(() => ({ user: vi.fn(), business: vi.fn(), save: vi.fn(), fetchMock: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: user }, from: () => ({ select: () => ({ eq: () => ({ single: business }) }) }) }) }));
vi.mock('@/lib/whatsapp/embedded-signup-session', () => ({ assertSignupSessionConfigured: () => {}, createSignupSession: save }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => '' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
import { POST } from '@/app/api/auth/facebook/discover/route';
const req = (body: object, origin = 'https://waaiio.test') => new NextRequest('https://waaiio.test/api/auth/facebook/discover', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
let tokenApp = 'app-1';
beforeEach(() => {
  vi.clearAllMocks(); tokenApp = 'app-1';
  vi.stubEnv('NEXT_PUBLIC_META_APP_ID', 'app-1'); vi.stubEnv('META_APP_SECRET', 'app-secret');
  user.mockResolvedValue({ data: { user: { id: 'u' } } });
  business.mockResolvedValue({ data: { owner_id: 'u' }, error: null });
  save.mockResolvedValue('opaque-handle');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('oauth/access_token')) return Response.json({ access_token: 'private-meta-token', expires_in: 3600 });
    if (url.includes('debug_token')) return Response.json({ data: { is_valid: true, app_id: tokenApp, granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['account-1'] }] } });
    if (url.includes('phone_numbers')) return Response.json({ data: [{ id: 'phone-1', display_phone_number: '+15551234567' }] });
    return Response.json({ id: 'account-1', name: 'Merchant account' });
  });
});
it('exchanges a code and returns assets and a handle, never credentials', async () => {
  const response = await POST(req({ code: 'code', business_id: 'b' }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.connection_id).toBe('opaque-handle');
  expect(body.wabas[0].phones[0].id).toBe('phone-1');
  expect(JSON.stringify(body)).not.toContain('private-meta-token');
  expect(body).not.toHaveProperty('access_token');
  expect(save).toHaveBeenCalledWith('u', 'b', expect.objectContaining({ accessToken: 'private-meta-token' }));
});
it('rejects unauthenticated discovery before contacting Meta', async () => {
  user.mockResolvedValue({ data: { user: null } });
  expect((await POST(req({ code: 'c', business_id: 'b' }))).status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('rejects discovery for another merchant before exchanging the code', async () => {
  business.mockResolvedValue({ data: { owner_id: 'other' }, error: null });
  expect((await POST(req({ code: 'c', business_id: 'b' }))).status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('rejects browser access tokens', async () => {
  expect((await POST(req({ code: 'c', business_id: 'b', access_token: 'untrusted' }))).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('rejects a token issued to a different application', async () => {
  tokenApp = 'other-app';
  expect((await POST(req({ code: 'c', business_id: 'b' }))).status).toBe(403);
  expect(save).not.toHaveBeenCalled();
});
it('rejects cross-origin requests', async () => {
  expect((await POST(req({ code: 'c', business_id: 'b' }, 'https://elsewhere.test'))).status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('does not store a partial discovery after a provider failure', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'private-meta-token' }))
    .mockResolvedValueOnce(Response.json({ data: { is_valid: true, app_id: 'app-1', granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['account-1'] }] } }))
    .mockResolvedValueOnce(Response.json({ name: 'Merchant' }))
    .mockResolvedValueOnce(Response.json({ error: 'denied' }, { status: 403 }));
  expect((await POST(req({ code: 'c', business_id: 'b' }))).status).toBe(500);
  expect(save).not.toHaveBeenCalled();
});
