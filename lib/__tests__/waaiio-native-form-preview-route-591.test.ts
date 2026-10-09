import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockUser = vi.fn();
const mockFrom = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockUser }, from: mockFrom }),
}));

const BIZ = '00000000-0000-4000-8000-000000000111';
const FORM = '00000000-0000-4000-8000-000000000222';
const makeRequest = (id = FORM, biz = BIZ) =>
  new NextRequest('http://localhost/api/forms/native-flow/preview?formId=' + id + '&businessId=' + biz);

const record = () => ({
  id: FORM, business_id: BIZ, title: 'Lead Registration',
  description: 'Let us know about you.',
  fields: [{ id: 'full_name', label: 'Full name', required: true, type: 'text' }],
});

const query = (result: { data: unknown; error: unknown }) => ({
  select() { return this; },
  eq() { return this; },
  maybeSingle: vi.fn(async () => result),
});

describe('#591 GET native Flow preview route — real handler with mocked database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? query({ data: { id: BIZ }, error: null })
      : query({ data: record(), error: null }));
  });

  it('invalid form or business ID fails before authentication and database', async () => {
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    expect((await GET(makeRequest('malformed'))).status).toBe(400);
    expect(mockUser).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('unauthenticated user cannot preview or look up forms', async () => {
    mockUser.mockResolvedValue({ data: { user: null }, error: null });
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    expect((await GET(makeRequest())).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('non-owner is denied before forms lookup', async () => {
    mockFrom.mockImplementation(() => query({ data: null, error: null }));
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    expect((await GET(makeRequest())).status).toBe(403);
    expect(mockFrom.mock.calls.map(c => c[0])).toEqual(['businesses']);
  });

  it('DB ownership failure is fail-closed, not treated as missing', async () => {
    mockFrom.mockImplementation(() => query({ data: null, error: { message: 'db down' } }));
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    expect((await GET(makeRequest())).status).toBe(503);
    expect(mockFrom.mock.calls.map(c => c[0])).toEqual(['businesses']);
  });

  it('owner gets draft Meta JSON only, with no provider mutation', async () => {
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(payload.mode).toBe('preview_only');
    expect(payload.flowJson.version).toBe('7.3');
    expect(payload.flowJson.screens[0].layout.children.at(-1)['on-click-action'].payload)
      .toEqual({ full_name: '${form.full_name}' });
    expect(mockFrom.mock.calls.map(c => c[0])).toEqual(['businesses', 'forms']);
  });

  it('malformed underlying form is rejected, never silently rendered', async () => {
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? query({ data: { id: BIZ }, error: null })
      : query({ data: { ...record(), fields: [{ id: 'x', type: 'file', label: 'Upload' }] }, error: null }));
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(422);
  });
});
