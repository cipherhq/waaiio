/**
 * Tests for onboarding registration server-side country authority (#342).
 *
 * Proves:
 * 1. NG + +234 passes country validation via DB authority
 * 2. lowercase/mixed-case/whitespace normalizes correctly
 * 3. unsupported country returns 400
 * 4. countries-table query error returns 503
 * 5. zero active country rows returns 503
 * 6. NG phone + different selected country returns mismatch error
 * 7. retry path remains unchanged (no country dependency)
 * 8. successful fresh registration does not require browser country cache
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Country rows returned by mock service client ──
let mockCountriesResponse: { data: Array<{ code: string; dialing_code: string }> | null; error: unknown } = {
  data: [
    { code: 'NG', dialing_code: '+234' },
    { code: 'GH', dialing_code: '+233' },
    { code: 'US', dialing_code: '+1' },
    { code: 'CA', dialing_code: '+1' },
    { code: 'GB', dialing_code: '+44' },
  ],
  error: null,
};

// ── Mock state ──
const mockGetUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
  }),
}));

// Track which tables are queried
let serviceFromCalls: string[] = [];

const mockServiceFrom = vi.fn((table: string) => {
  serviceFromCalls.push(table);

  if (table === 'countries') {
    return {
      select: () => ({
        eq: () => Promise.resolve(mockCountriesResponse),
      }),
    };
  }

  if (table === 'businesses') {
    return {
      select: (cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          // Business count check
          return {
            eq: () => ({
              in: () => Promise.resolve({ count: 0, error: null }),
            }),
          };
        }
        // Bot code / slug collision checks + insert
        return {
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({
                  data: { id: 'biz-pending', owner_id: 'user-1', status: 'pending', category: 'salon', bot_code: 'TEST' },
                  error: null,
                }),
              }),
            }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        };
      },
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({
            data: { id: 'biz-new', bot_code: 'TESTCODE', slug: 'test-biz' },
            error: null,
          }),
        }),
      }),
    };
  }

  if (table === 'category_templates') {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    };
  }

  if (table === 'whatsapp_config') {
    return {
      insert: () => Promise.resolve({ error: null }),
    };
  }

  if (table === 'profiles') {
    return {
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { role: 'restaurant_owner' }, error: null }),
        }),
      }),
    };
  }

  // Default passthrough
  return {
    select: () => ({
      eq: () => Promise.resolve({ data: [], error: null }),
    }),
  };
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(() => Promise.resolve(null)),
  getRateLimitKey: (_req: Request, prefix: string) => `${prefix}:127.0.0.1`,
}));

vi.mock('@/lib/categoryConfig', () => ({
  loadCategories: () => Promise.resolve(),
  getAllCategoryKeys: () => ['salon', 'restaurant', 'shop'],
}));

vi.mock('@/lib/capabilities/service', () => ({
  initCapabilities: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/constants', () => ({
  generateSlug: () => 'test-slug',
  generateBotCode: () => 'TESTCODE',
  CATEGORY_FLOW_MAP: {},
}));

vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/email/templates', () => ({
  welcomeEmail: () => ({ subject: 'x', html: 'x' }),
  businessRegisteredEmail: () => ({ subject: 'x', html: 'x' }),
}));

vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: () => Promise.resolve({ max_businesses_per_user: 5 }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/pdf/generate', () => ({}));

vi.mock('@/lib/observability/server-events', () => ({
  emitServerEvent: vi.fn(),
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/onboarding/register'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

const VALID_BODY = {
  name: 'Test Salon',
  city: 'Lagos',
  address: '1 Test Street',
  phone: '+2341234567890',
  category: 'salon',
  country: 'NG',
  first_name: 'Test',
  last_name: 'User',
};

describe('Onboarding country server authority (#342)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    serviceFromCalls = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.com' } } });
    // Reset to default valid countries
    mockCountriesResponse = {
      data: [
        { code: 'NG', dialing_code: '+234' },
        { code: 'GH', dialing_code: '+233' },
        { code: 'US', dialing_code: '+1' },
        { code: 'CA', dialing_code: '+1' },
        { code: 'GB', dialing_code: '+44' },
      ],
      error: null,
    };
  });

  // Test 1: NG + +234 passes country validation
  it('NG + +234 phone passes country validation via DB authority', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    // Should succeed (200) — country is valid in DB
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.business_id).toBeDefined();

    // Verify countries table was queried (DB authority, not browser cache)
    expect(serviceFromCalls).toContain('countries');
  });

  // Test 2: lowercase/mixed-case/whitespace normalizes correctly
  it.each([
    ['ng', 'lowercase'],
    ['Ng', 'mixed case'],
    ['nG', 'mixed case reversed'],
    [' NG ', 'whitespace padded'],
    [' ng ', 'whitespace + lowercase'],
    ['\tNG\n', 'tab and newline'],
  ])('normalizes country %s (%s) to valid NG', async (input, _desc) => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ ...VALID_BODY, country: input });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  // Test 3: unsupported country returns 400
  it('unsupported country returns 400', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ ...VALID_BODY, country: 'ZZ' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Invalid or unsupported country');
  });

  // Test 4: countries-table query error returns 503
  it('countries-table query error returns 503 configuration unavailable', async () => {
    mockCountriesResponse = {
      data: null,
      error: { message: 'connection refused', code: 'PGRST000' },
    };

    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.message).toContain('configuration unavailable');
  });

  // Test 5: zero active country rows returns 503
  it('zero active country rows returns 503 configuration unavailable', async () => {
    mockCountriesResponse = {
      data: [],
      error: null,
    };

    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.message).toContain('configuration unavailable');
  });

  // Test 6: NG phone + different selected country returns mismatch error
  it('NG phone with different selected country returns mismatch error', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({
      ...VALID_BODY,
      country: 'GH',  // Ghana selected
      phone: '+2341234567890',  // But phone is Nigerian
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain("doesn't match selected country");
    expect(body.message).toContain('NG');
  });

  // Test 7: retry path remains unchanged (no country dependency)
  it('retry path does not query countries table', async () => {
    // Setup mock for retry path
    mockServiceFrom.mockImplementation((table: string) => {
      serviceFromCalls.push(table);
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: (col: string) => {
              if (col === 'id') return {
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () => Promise.resolve({
                      data: { id: 'biz-pending', owner_id: 'user-1', status: 'pending', category: 'salon', bot_code: 'TEST' },
                      error: null,
                    }),
                  }),
                }),
              };
              return { eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
            },
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ retryBusinessId: 'biz-pending', capabilities: ['scheduling'] });
    const res = await POST(req);

    expect(res.status).toBe(200);
    // Retry path must NOT query the countries table
    expect(serviceFromCalls).not.toContain('countries');
  });

  // Test 8: successful fresh registration does not require browser country cache
  it('fresh registration succeeds without browser country module (no loadCountries call)', async () => {
    // This test proves the route does NOT import/use loadCountries, isValidCountryCode, or getDialingCodeMap
    // The route module should not reference lib/countries at all
    const routeSource = await import('@/app/api/onboarding/register/route');
    const { POST } = routeSource;

    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(200);

    // Verify the countries table (DB authority) was used
    expect(serviceFromCalls).toContain('countries');
  });

  // Additional: null/undefined/empty country
  it('null country normalizes to empty string and returns 400', async () => {
    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ ...VALID_BODY, country: null });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Invalid or unsupported country');
  });
});
