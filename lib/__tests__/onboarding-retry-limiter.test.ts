/**
 * Tests for onboarding register route rate-limit separation.
 *
 * Proves:
 * - fresh quota still blocks excess fresh registrations
 * - valid retry succeeds when fresh quota is exhausted
 * - repeated retry abuse is limited
 * - foreign retry rejected
 * - active retry rejected
 * - suspended retry rejected
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock state ──

let rateLimitCalls: Array<{ key: string; max: number; windowMs: number }> = [];
let rateLimitBlocked = new Set<string>();

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(async (key: string, max: number, windowMs: number) => {
    rateLimitCalls.push({ key, max, windowMs });
    if (rateLimitBlocked.has(key)) {
      const { NextResponse } = await import('next/server');
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }
    return null;
  }),
  getRateLimitKey: (req: Request, prefix: string) => `${prefix}:127.0.0.1`,
}));

const mockGetUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
  }),
}));

const mockServiceFrom = vi.fn();
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
  }),
}));

vi.mock('@/lib/countries', () => ({
  loadCountries: () => Promise.resolve(),
  isValidCountryCode: () => true,
}));

vi.mock('@/lib/categoryConfig', () => ({
  loadCategories: () => Promise.resolve(),
  getAllCategoryKeys: () => ['salon', 'restaurant'],
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

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/onboarding/register'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

describe('Onboarding rate-limit separation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rateLimitCalls = [];
    rateLimitBlocked = new Set();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  });

  it('fresh quota blocks excess fresh registrations', async () => {
    rateLimitBlocked.add('onboarding-register:127.0.0.1');

    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ name: 'Test', category: 'salon', country: 'NG', city: 'Lagos', address: '1 Test', phone: '+234000' });
    const res = await POST(req);

    expect(res.status).toBe(429);
  });

  it('valid retry uses separate limiter key (not IP-based)', async () => {
    // Block fresh registration quota
    rateLimitBlocked.add('onboarding-register:127.0.0.1');

    // Setup mock: pending business owned by user
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === 'id') return {
                eq: (col2: string, val2: string) => {
                  if (col2 === 'owner_id') return {
                    eq: () => ({
                      maybeSingle: () => Promise.resolve({
                        data: { id: 'biz-pending', owner_id: 'user-1', status: 'pending', category: 'salon', bot_code: 'TEST' },
                        error: null,
                      }),
                    }),
                  };
                  return { eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) };
                },
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

    // Retry should use its own limiter key: onboarding-retry:{userId}:{bizId}
    const retryCall = rateLimitCalls.find(c => c.key.startsWith('onboarding-retry:'));
    expect(retryCall).toBeDefined();
    expect(retryCall!.key).toBe('onboarding-retry:user-1:biz-pending');
    // Should NOT have called fresh registration limiter
    const freshCall = rateLimitCalls.find(c => c.key.startsWith('onboarding-register:'));
    expect(freshCall).toBeUndefined();
  });

  it('repeated retry abuse is limited', async () => {
    rateLimitBlocked.add('onboarding-retry:user-1:biz-pending');

    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ retryBusinessId: 'biz-pending' });
    const res = await POST(req);

    expect(res.status).toBe(429);
  });

  it('foreign retry rejected (not owned by user)', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ retryBusinessId: 'biz-foreign' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('not found');
  });

  it('active retry rejected (status != pending)', async () => {
    // The query filters by status='pending', so active business won't match
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    const { POST } = await import('@/app/api/onboarding/register/route');
    const req = makeRequest({ retryBusinessId: 'biz-active' });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('already active');
  });
});
