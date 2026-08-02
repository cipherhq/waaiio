/**
 * CAS-001 — Onboarding behavioral test coverage.
 *
 * Proves:
 * 1. Fresh registration creates a pending business with trial_ends_at
 * 2. Capability initialization success proceeds to finalization
 * 3. Capability initialization failure returns recoverable error, business remains pending
 * 4. Finalization failure returns recoverable error, business remains pending
 * 5. Retry requires pending business owned by user
 * 6. Retry reruns initCapabilities + finalizeOnboarding idempotently
 * 7. Retry does not create a second business
 * 8. Retry on foreign/non-pending business is rejected
 * 9. Successful registration preserves the same business ID
 * 10. trial_ends_at uses TRIAL_DAYS constant (CAS-002)
 *
 * Does NOT duplicate:
 * - verify route activation tests (onboarding-verify-activation.test.ts)
 * - rate-limit separation tests (onboarding-retry-limiter.test.ts)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Track mutations ──
let businessInserts: unknown[] = [];
let initCapsCalls: Array<{ businessId: string; category: string; overrides?: unknown }> = [];
let finalizeCalls: Array<{ businessId: string; userId: string }> = [];

const mockGetUser = vi.fn();
const mockServiceFrom = vi.fn();
const mockInitCapabilities = vi.fn();
const mockFinalize = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
  }),
}));

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
  getAllCategoryKeys: () => ['salon', 'restaurant', 'shop'],
}));

vi.mock('@/lib/capabilities/service', () => ({
  initCapabilities: (...args: unknown[]) => {
    const [_svc, businessId, category, overrides] = args;
    initCapsCalls.push({ businessId: businessId as string, category: category as string, overrides });
    return mockInitCapabilities(...args);
  },
}));

vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: (...args: unknown[]) => {
    const [_svc, params] = args as [unknown, { businessId: string; userId: string }];
    finalizeCalls.push({ businessId: params.businessId, userId: params.userId });
    return mockFinalize(...args);
  },
}));

vi.mock('@/lib/constants', () => ({
  generateSlug: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  generateBotCode: (name: string) => name.toUpperCase().replace(/\s+/g, '-').slice(0, 10),
  CATEGORY_FLOW_MAP: { salon: 'appointment', restaurant: 'ordering', shop: 'ordering' },
  TRIAL_DAYS: 30,
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

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(() => Promise.resolve(null)),
  getRateLimitKey: (_req: Request, prefix: string) => `${prefix}:127.0.0.1`,
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const FRESH_BODY = {
  first_name: 'Test',
  last_name: 'User',
  name: 'Test Salon',
  city: 'Lagos',
  state: 'Lagos',
  address: '1 Test Street',
  phone: '+2340000000',
  category: 'salon',
  country: 'NG',
  capabilities: ['scheduling', 'payment'],
};

const INSERTED_BUSINESS = {
  id: 'biz-fresh-1',
  bot_code: 'TEST-SALON',
  slug: 'test-salon',
};

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/onboarding/register'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

function setupDefaultServiceMock(overrides?: {
  insertResult?: { data: unknown; error: unknown };
  pendingBizResult?: { data: unknown; error: unknown };
}) {
  const insertResult = overrides?.insertResult ?? { data: INSERTED_BUSINESS, error: null };

  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'businesses') {
      return {
        insert: (data: unknown) => {
          businessInserts.push(data);
          return {
            select: () => ({
              single: () => Promise.resolve(insertResult),
            }),
          };
        },
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count === 'exact') {
            return {
              eq: () => ({
                in: () => Promise.resolve({ count: 0, error: null }),
              }),
            };
          }
          return {
            eq: (_col: string, _val: string) => {
              if (_col === 'id') {
                return {
                  eq: (_c2: string, _v2: string) => ({
                    eq: () => ({
                      maybeSingle: () => Promise.resolve(
                        overrides?.pendingBizResult ?? { data: null, error: null },
                      ),
                    }),
                  }),
                };
              }
              return {
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              };
            },
          };
        },
      };
    }
    if (table === 'whatsapp_config') {
      return { insert: () => Promise.resolve({ error: null }) };
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
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: { role: 'restaurant_owner' }, error: null }),
          }),
        }),
      };
    }
    return {
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      insert: () => Promise.resolve({ error: null }),
    };
  });
}

describe('Onboarding behavioral coverage (CAS-001)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    businessInserts = [];
    initCapsCalls = [];
    finalizeCalls = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.com' } } });
    mockInitCapabilities.mockResolvedValue(undefined);
    mockFinalize.mockResolvedValue(undefined);
  });

  describe('fresh registration', () => {
    it('creates a pending business with correct fields', async () => {
      setupDefaultServiceMock();
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest(FRESH_BODY));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.business_id).toBe('biz-fresh-1');
      expect(body.bot_code).toBe('TEST-SALON');
      expect(businessInserts).toHaveLength(1);
      const inserted = businessInserts[0] as Record<string, unknown>;
      expect(inserted.status).toBe('pending');
      expect(inserted.owner_id).toBe('user-1');
      expect(inserted.category).toBe('salon');
    });

    it('sets trial_ends_at using TRIAL_DAYS constant (30 days from now)', async () => {
      setupDefaultServiceMock();
      const before = Date.now();
      const { POST } = await import('@/app/api/onboarding/register/route');
      await POST(makeRequest(FRESH_BODY));
      const after = Date.now();
      expect(businessInserts).toHaveLength(1);
      const inserted = businessInserts[0] as Record<string, unknown>;
      const trialEnd = new Date(inserted.trial_ends_at as string).getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(trialEnd).toBeGreaterThanOrEqual(before + thirtyDaysMs);
      expect(trialEnd).toBeLessThanOrEqual(after + thirtyDaysMs);
    });

    it('proceeds to initCapabilities and finalizeOnboarding on success', async () => {
      setupDefaultServiceMock();
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest(FRESH_BODY));
      expect(res.status).toBe(200);
      expect(initCapsCalls).toHaveLength(1);
      expect(initCapsCalls[0].businessId).toBe('biz-fresh-1');
      expect(initCapsCalls[0].category).toBe('salon');
      expect(finalizeCalls).toHaveLength(1);
      expect(finalizeCalls[0].businessId).toBe('biz-fresh-1');
      expect(finalizeCalls[0].userId).toBe('user-1');
    });

    it('preserves the same business ID in the response', async () => {
      setupDefaultServiceMock();
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest(FRESH_BODY));
      const body = await res.json();
      expect(body.business_id).toBe(INSERTED_BUSINESS.id);
      expect(initCapsCalls[0].businessId).toBe(INSERTED_BUSINESS.id);
      expect(finalizeCalls[0].businessId).toBe(INSERTED_BUSINESS.id);
    });
  });

  describe('capability initialization failure', () => {
    it('returns recoverable error with businessId', async () => {
      setupDefaultServiceMock();
      mockInitCapabilities.mockRejectedValue(new Error('Capability initialization failed: timeout'));
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest(FRESH_BODY));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.recoverable).toBe(true);
      expect(body.businessId).toBe('biz-fresh-1');
      expect(body.error).toContain('Capability setup failed');
    });

    it('does not call finalizeOnboarding when initCapabilities fails', async () => {
      setupDefaultServiceMock();
      mockInitCapabilities.mockRejectedValue(new Error('DB error'));
      const { POST } = await import('@/app/api/onboarding/register/route');
      await POST(makeRequest(FRESH_BODY));
      expect(initCapsCalls).toHaveLength(1);
      expect(finalizeCalls).toHaveLength(0);
    });

    it('does not report successful setup', async () => {
      setupDefaultServiceMock();
      mockInitCapabilities.mockRejectedValue(new Error('DB error'));
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest(FRESH_BODY));
      const body = await res.json();
      expect(body.business_id).toBeUndefined();
      expect(body.bot_code).toBeUndefined();
      expect(res.status).not.toBe(200);
    });
  });

  describe('finalization failure', () => {
    it('returns recoverable error with businessId', async () => {
      setupDefaultServiceMock();
      mockFinalize.mockRejectedValue(new Error('Profile read failed'));
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest(FRESH_BODY));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.recoverable).toBe(true);
      expect(body.businessId).toBe('biz-fresh-1');
      expect(body.error).toContain('finalization failed');
    });

    it('initCapabilities was called before finalize failure', async () => {
      setupDefaultServiceMock();
      mockFinalize.mockRejectedValue(new Error('Profile update failed'));
      const { POST } = await import('@/app/api/onboarding/register/route');
      await POST(makeRequest(FRESH_BODY));
      expect(initCapsCalls).toHaveLength(1);
      expect(finalizeCalls).toHaveLength(1);
    });

    it('does not report successful setup on finalization failure', async () => {
      setupDefaultServiceMock();
      mockFinalize.mockRejectedValue(new Error('Profile update failed'));
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest(FRESH_BODY));
      const body = await res.json();
      expect(body.business_id).toBeUndefined();
      expect(body.bot_code).toBeUndefined();
      expect(res.status).not.toBe(200);
    });
  });

  describe('retry path', () => {
    const PENDING_BIZ = {
      id: 'biz-pending-1',
      owner_id: 'user-1',
      status: 'pending',
      category: 'salon',
      bot_code: 'PENDING-CODE',
    };

    it('requires pending business owned by user — reruns init + finalize', async () => {
      setupDefaultServiceMock({ pendingBizResult: { data: PENDING_BIZ, error: null } });
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest({ retryBusinessId: 'biz-pending-1', capabilities: ['scheduling'] }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.business_id).toBe('biz-pending-1');
      expect(body.bot_code).toBe('PENDING-CODE');
      expect(initCapsCalls).toHaveLength(1);
      expect(initCapsCalls[0].businessId).toBe('biz-pending-1');
      expect(finalizeCalls).toHaveLength(1);
      expect(finalizeCalls[0].businessId).toBe('biz-pending-1');
    });

    it('does not create a second business (no insert call)', async () => {
      setupDefaultServiceMock({ pendingBizResult: { data: PENDING_BIZ, error: null } });
      const { POST } = await import('@/app/api/onboarding/register/route');
      await POST(makeRequest({ retryBusinessId: 'biz-pending-1' }));
      expect(businessInserts).toHaveLength(0);
    });

    it('preserves the same business ID through retry', async () => {
      setupDefaultServiceMock({ pendingBizResult: { data: PENDING_BIZ, error: null } });
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest({ retryBusinessId: 'biz-pending-1' }));
      const body = await res.json();
      expect(body.business_id).toBe('biz-pending-1');
      expect(initCapsCalls[0].businessId).toBe('biz-pending-1');
      expect(finalizeCalls[0].businessId).toBe('biz-pending-1');
    });

    it('rejects foreign business (not owned by user)', async () => {
      setupDefaultServiceMock({ pendingBizResult: { data: null, error: null } });
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest({ retryBusinessId: 'biz-foreign' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('not found');
      expect(initCapsCalls).toHaveLength(0);
      expect(finalizeCalls).toHaveLength(0);
    });

    it('rejects non-pending business (status != pending)', async () => {
      setupDefaultServiceMock({ pendingBizResult: { data: null, error: null } });
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest({ retryBusinessId: 'biz-active' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain('already active');
      expect(initCapsCalls).toHaveLength(0);
      expect(finalizeCalls).toHaveLength(0);
    });

    it('returns recoverable error when retry initCapabilities fails', async () => {
      setupDefaultServiceMock({ pendingBizResult: { data: PENDING_BIZ, error: null } });
      mockInitCapabilities.mockRejectedValue(new Error('DB timeout'));
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest({ retryBusinessId: 'biz-pending-1' }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.recoverable).toBe(true);
      expect(body.businessId).toBe('biz-pending-1');
      expect(finalizeCalls).toHaveLength(0);
    });

    it('returns recoverable error when retry finalization fails', async () => {
      setupDefaultServiceMock({ pendingBizResult: { data: PENDING_BIZ, error: null } });
      mockFinalize.mockRejectedValue(new Error('Profile update failed'));
      const { POST } = await import('@/app/api/onboarding/register/route');
      const res = await POST(makeRequest({ retryBusinessId: 'biz-pending-1' }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.recoverable).toBe(true);
      expect(body.businessId).toBe('biz-pending-1');
    });
  });

  it('does not introduce provider or deployment behavior', async () => {
    setupDefaultServiceMock();
    const { POST } = await import('@/app/api/onboarding/register/route');
    const res = await POST(makeRequest(FRESH_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('deployment');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('webhook_url');
  });
});
