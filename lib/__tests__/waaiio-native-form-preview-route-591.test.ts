import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockUser = vi.fn();
const mockFrom = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockUser }, from: mockFrom }),
}));

const BIZ = '00000000-0000-4000-8000-000000000111';
const BIZ_OTHER = '00000000-0000-4000-8000-000000000999';
const FORM = '00000000-0000-4000-8000-000000000222';
const makeRequest = (id = FORM, biz = BIZ) =>
  new NextRequest('http://localhost/api/forms/native-flow/preview?formId=' + id + '&businessId=' + biz);

const record = (overrides?: Partial<Record<string, unknown>>) => ({
  id: FORM, business_id: BIZ, title: 'Lead Registration',
  description: 'Let us know about you.',
  fields: [{ id: 'full_name', label: 'Full name', required: true, type: 'text' }],
  settings: null,
  ...overrides,
});

/**
 * Defect 3 fix: .eq() now records column/value pairs so tests can assert
 * that the route applies the correct authorization predicates.
 */
const query = (result: { data: unknown; error: unknown }) => {
  const eqCalls: Array<{ column: string; value: unknown }> = [];
  const selectCalls: string[] = [];
  const obj = {
    select(columns?: string) { if (columns !== undefined) selectCalls.push(columns); return this; },
    eq(column: string, value: unknown) { eqCalls.push({ column, value }); return this; },
    maybeSingle: vi.fn(async () => result),
    _eqCalls: eqCalls,
    _selectCalls: selectCalls,
  };
  return obj;
};

describe('#591 GET native Flow preview route — real handler with mocked database', () => {
  let businessQuery: ReturnType<typeof query>;
  let formQuery: ReturnType<typeof query>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
    businessQuery = query({ data: { id: BIZ }, error: null });
    formQuery = query({ data: record(), error: null });
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? businessQuery
      : formQuery);
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
    const bq = query({ data: null, error: null });
    mockFrom.mockImplementation(() => bq);
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    expect((await GET(makeRequest())).status).toBe(403);
    expect(mockFrom.mock.calls.map((c: unknown[]) => c[0])).toEqual(['businesses']);
  });

  it('DB ownership failure is fail-closed, not treated as missing', async () => {
    mockFrom.mockImplementation(() => query({ data: null, error: { message: 'db down' } }));
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    expect((await GET(makeRequest())).status).toBe(503);
    expect(mockFrom.mock.calls.map((c: unknown[]) => c[0])).toEqual(['businesses']);
  });

  // ── Defect 3: assert exact eq() column/value predicates ──

  it('business query filters by owner_id = user.id', async () => {
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    await GET(makeRequest());
    expect(businessQuery._eqCalls).toEqual(
      expect.arrayContaining([
        { column: 'id', value: BIZ },
        { column: 'owner_id', value: 'owner-1' },
      ]),
    );
  });

  it('form query filters by business_id = businessId', async () => {
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    await GET(makeRequest());
    expect(formQuery._eqCalls).toEqual(
      expect.arrayContaining([
        { column: 'id', value: FORM },
        { column: 'business_id', value: BIZ },
      ]),
    );
  });

  it('cross-tenant denial: form owned by different business returns 403', async () => {
    // User owns BIZ_OTHER, not BIZ — business ownership lookup returns null
    const bq = query({ data: null, error: null });
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? bq
      : query({ data: record(), error: null }));
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const res = await GET(makeRequest(FORM, BIZ));
    expect(res.status).toBe(403);
    // Form query must NOT be called — ownership check is the gate
    expect(mockFrom.mock.calls.map((c: unknown[]) => c[0])).toEqual(['businesses']);
  });

  it('cross-tenant denial: requesting another business ID returns 403 even if form exists', async () => {
    // Authenticated user requests a business they don't own
    const bq = query({ data: null, error: null });
    mockFrom.mockImplementation(() => bq);
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const res = await GET(makeRequest(FORM, BIZ_OTHER));
    expect(res.status).toBe(403);
    // Verify business query did filter by the requested business ID and the authenticated user
    expect(bq._eqCalls).toEqual(
      expect.arrayContaining([
        { column: 'id', value: BIZ_OTHER },
        { column: 'owner_id', value: 'owner-1' },
      ]),
    );
  });

  // ── Defect A: assert select() includes 'settings' column ──

  it('form SELECT projection includes settings column for consent support', async () => {
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    await GET(makeRequest());
    // formQuery._selectCalls records the columns string passed to select()
    expect(formQuery._selectCalls.length).toBeGreaterThan(0);
    const selectString = formQuery._selectCalls[0];
    expect(selectString).toContain('settings');
  });

  // ── Consent preview tests against real route ──

  it('preview includes consent OptIn when form has settings.consent_label', async () => {
    const fq = query({
      data: record({ settings: { consent_label: 'I agree to marketing' } }),
      error: null,
    });
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? query({ data: { id: BIZ }, error: null })
      : fq);
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(response.status).toBe(200);
    const children = payload.flowJson.screens[0].layout.children;
    const optIn = children.find((c: Record<string, unknown>) => c.type === 'OptIn');
    expect(optIn).toBeDefined();
    expect(optIn.label).toBe('I agree to marketing');
  });

  it('preview omits consent OptIn when settings is null', async () => {
    const fq = query({ data: record({ settings: null }), error: null });
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? query({ data: { id: BIZ }, error: null })
      : fq);
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(response.status).toBe(200);
    const children = payload.flowJson.screens[0].layout.children;
    expect(children.find((c: Record<string, unknown>) => c.type === 'OptIn')).toBeUndefined();
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
    expect(mockFrom.mock.calls.map((c: unknown[]) => c[0])).toEqual(['businesses', 'forms']);
  });

  // ── Defect D: non-string consent_label returns 422, not 500 ──

  it('non-string consent_label (number) returns 422 validation error', async () => {
    const fq = query({
      data: record({ settings: { consent_label: 42 } }),
      error: null,
    });
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? query({ data: { id: BIZ }, error: null })
      : fq);
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(422);
  });

  it('non-string consent_label (object) returns 422 validation error', async () => {
    const fq = query({
      data: record({ settings: { consent_label: { nested: true } } }),
      error: null,
    });
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? query({ data: { id: BIZ }, error: null })
      : fq);
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(422);
  });

  it('overlong consent_label returns 422 validation error', async () => {
    const fq = query({
      data: record({ settings: { consent_label: 'A'.repeat(257) } }),
      error: null,
    });
    mockFrom.mockImplementation((table: string) => table === 'businesses'
      ? query({ data: { id: BIZ }, error: null })
      : fq);
    const { GET } = await import('@/app/api/forms/native-flow/preview/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(422);
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
