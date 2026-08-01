/**
 * Security tests for GET/POST/DELETE /api/whatsapp/templates
 *
 * Proves:
 * 1. Unauthenticated → 401
 * 2. Ordinary user cannot use default shared-WABA mode (admin path)
 * 3. Platform admin can use shared-WABA mode
 * 4. Business owner with business_id can GET templates
 * 5. Non-owner with business_id → 403 before service-role lookup
 * 6. Channel lookup DB error fails closed (not shared fallback)
 * 7. POST/DELETE are admin-only (no business_id path)
 * 8. Unauthorized never instantiates MetaCloudService with shared/privileged credentials
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Track MetaCloudService instantiation ──
let metaInstantiations: Array<{ hasCredentials: boolean; wabaId?: string }> = [];

vi.mock('@/lib/channels/meta-cloud', () => {
  return {
    MetaCloudService: class MockMetaCloudService {
      constructor(creds?: { accessToken?: string; wabaId?: string; phoneNumberId?: string }) {
        metaInstantiations.push({
          hasCredentials: !!creds?.accessToken,
          wabaId: creds?.wabaId,
        });
      }
      getTemplates() { return Promise.resolve({ data: [] }); }
      createTemplate() { return Promise.resolve({ status: 'PENDING' }); }
      deleteTemplate() { return Promise.resolve({ success: true }); }
    },
  };
});

// ── Mock admin auth ──
const mockRequirePlatformAdmin = vi.fn();
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: (...args: unknown[]) => mockRequirePlatformAdmin(...args),
}));

// ── Mock supabase ──
const mockGetUser = vi.fn();
const mockAuthFrom = vi.fn();
let serviceClientUsed = false;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockAuthFrom,
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => {
    serviceClientUsed = true;
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { waba_id: 'test-waba', meta_access_token: 'test-token' }, error: null }),
              }),
            }),
          }),
        }),
      }),
    };
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn() }) },
}));

function makeGetRequest(params?: Record<string, string>) {
  const url = new URL('http://localhost:3000/api/whatsapp/templates');
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, { method: 'GET' });
}

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/whatsapp/templates'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDeleteRequest(params?: Record<string, string>) {
  const url = new URL('http://localhost:3000/api/whatsapp/templates');
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, { method: 'DELETE' });
}

describe('GET /api/whatsapp/templates — authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metaInstantiations = [];
    serviceClientUsed = false;
    mockRequirePlatformAdmin.mockResolvedValue(null);
  });

  it('unauthenticated request without business_id (admin path) → 403', async () => {
    // No admin auth → 403
    const { GET } = await import('@/app/api/whatsapp/templates/route');
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    expect(metaInstantiations).toHaveLength(0);
  });

  it('ordinary user cannot reach shared WABA without business_id', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(null); // not admin
    const { GET } = await import('@/app/api/whatsapp/templates/route');
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    // No MetaCloudService instantiated
    expect(metaInstantiations).toHaveLength(0);
  });

  it('platform admin can GET shared WABA templates', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1', userId: 'admin-1', email: 'admin@test.com', role: 'admin' });
    const { GET } = await import('@/app/api/whatsapp/templates/route');
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    // MetaCloudService instantiated without explicit credentials (shared WABA)
    expect(metaInstantiations).toHaveLength(1);
    expect(metaInstantiations[0].hasCredentials).toBe(false);
  });

  it('business owner with business_id can GET their templates', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockAuthFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: '11111111-1111-1111-1111-111111111111', status: 'active' }, error: null }),
          }),
        }),
      }),
    }));

    const { GET } = await import('@/app/api/whatsapp/templates/route');
    const res = await GET(makeGetRequest({ business_id: '11111111-1111-1111-1111-111111111111' }));
    expect(res.status).toBe(200);
    expect(serviceClientUsed).toBe(true); // channel lookup happened after auth
  });

  it('non-owner with business_id → 403 BEFORE service-role channel lookup', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'attacker' } } });
    mockAuthFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    }));

    const { GET } = await import('@/app/api/whatsapp/templates/route');
    const res = await GET(makeGetRequest({ business_id: '11111111-1111-1111-1111-111111111111' }));
    expect(res.status).toBe(403);
    expect(serviceClientUsed).toBe(false); // never reached
    expect(metaInstantiations).toHaveLength(0);
  });

  it('unauthenticated with business_id → 401', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const { GET } = await import('@/app/api/whatsapp/templates/route');
    const res = await GET(makeGetRequest({ business_id: '11111111-1111-1111-1111-111111111111' }));
    expect(res.status).toBe(401);
  });

  it('invalid business_id format → 400', async () => {
    const { GET } = await import('@/app/api/whatsapp/templates/route');
    const res = await GET(makeGetRequest({ business_id: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('channel lookup DB error fails closed (does not fall through to shared WABA)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockAuthFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: '11111111-1111-1111-1111-111111111111', status: 'active' }, error: null }),
          }),
        }),
      }),
    }));

    // Override service client to return a DB error
    vi.mocked(await import('@/lib/supabase/service')).createServiceClient = () => {
      serviceClientUsed = true;
      return {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  single: () => Promise.resolve({ data: null, error: { code: 'PGRST500', message: 'connection error' } }),
                }),
              }),
            }),
          }),
        }),
      } as any;
    };

    const { GET } = await import('@/app/api/whatsapp/templates/route');
    const res = await GET(makeGetRequest({ business_id: '11111111-1111-1111-1111-111111111111' }));
    expect(res.status).toBe(500);
    // MetaCloudService never instantiated
    expect(metaInstantiations).toHaveLength(0);
  });
});

describe('POST /api/whatsapp/templates — admin-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metaInstantiations = [];
    serviceClientUsed = false;
    mockRequirePlatformAdmin.mockResolvedValue(null);
  });

  it('ordinary user → 403', async () => {
    const { POST } = await import('@/app/api/whatsapp/templates/route');
    const res = await POST(makePostRequest({ template: { name: 'test', language: 'en_US', category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }] } }));
    expect(res.status).toBe(403);
    expect(metaInstantiations).toHaveLength(0);
  });

  it('platform admin can create templates', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1', userId: 'admin-1', email: 'admin@test.com', role: 'admin' });
    const { POST } = await import('@/app/api/whatsapp/templates/route');
    const res = await POST(makePostRequest({ template: { name: 'test_template', language: 'en_US', category: 'UTILITY', components: [{ type: 'BODY', text: 'hi {{1}}' }] } }));
    expect(res.status).toBe(200);
    expect(metaInstantiations).toHaveLength(1);
  });
});

describe('DELETE /api/whatsapp/templates — admin-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metaInstantiations = [];
    serviceClientUsed = false;
    mockRequirePlatformAdmin.mockResolvedValue(null);
  });

  it('ordinary user → 403', async () => {
    const { DELETE } = await import('@/app/api/whatsapp/templates/route');
    const res = await DELETE(makeDeleteRequest({ name: 'test_template' }));
    expect(res.status).toBe(403);
    expect(metaInstantiations).toHaveLength(0);
  });

  it('platform admin can delete templates', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({ id: 'admin-1', userId: 'admin-1', email: 'admin@test.com', role: 'admin' });
    const { DELETE } = await import('@/app/api/whatsapp/templates/route');
    const res = await DELETE(makeDeleteRequest({ name: 'test_template' }));
    expect(res.status).toBe(200);
    expect(metaInstantiations).toHaveLength(1);
  });
});
