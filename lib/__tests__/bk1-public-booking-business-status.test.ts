/**
 * BK-1: Public booking creation must use businesses.status = 'active',
 * NOT businesses.is_active (which does not exist on the businesses table).
 *
 * The businesses table uses restaurant_status enum ('pending', 'active', 'suspended').
 * Querying is_active causes PostgREST to reject the filter, making all
 * public booking creation fail with "Business not found".
 *
 * Tests verify:
 * 1. Active business (status='active') passes business validation
 * 2. Pending business is rejected
 * 3. Suspended business is rejected
 * 4. Unknown business slug is rejected
 * 5. Source code does not query businesses.is_active (regression guard)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Mock infrastructure ──

let mockBusinessResult: { data: unknown; error: unknown };
let mockServiceResult: { data: unknown; error: unknown };
const mockRpcResult = { data: null, error: null };
const mockProfileResult = { data: { id: 'user-1' }, error: null };

function makeChain(resolveWith: () => { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.is = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockReturnValue(resolveWith());
  chain.single = vi.fn().mockReturnValue(resolveWith());
  return chain;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'businesses') return makeChain(() => mockBusinessResult);
      if (table === 'services') return makeChain(() => mockServiceResult);
      if (table === 'profiles') return makeChain(() => mockProfileResult);
      return makeChain(() => ({ data: null, error: null }));
    }),
    rpc: vi.fn().mockReturnValue({
      single: vi.fn().mockReturnValue(mockRpcResult),
    }),
    auth: {
      admin: {
        createUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
      },
    },
  })),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('@/lib/otp-token', () => ({
  verifyOtpToken: vi.fn().mockReturnValue('guest@example.com'),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    withContext: vi.fn().mockReturnValue({ error: vi.fn() }),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn().mockReturnValue({}),
}));

// ── Helpers ──

function makeFutureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().split('T')[0];
}

const VALID_BODY = {
  businessSlug: 'test-biz',
  serviceId: 'svc-1',
  date: makeFutureDate(),
  time: '10:00',
  guestName: 'Test Guest',
  guestEmail: 'guest@example.com',
  guestPhone: '+2341234567890',
  otpToken: 'valid-token',
};

const ACTIVE_BUSINESS = {
  id: 'biz-1',
  name: 'Test Business',
  slug: 'test-biz',
  country_code: 'NG',
  operating_hours: {
    monday: { open: '08:00', close: '18:00' },
    tuesday: { open: '08:00', close: '18:00' },
    wednesday: { open: '08:00', close: '18:00' },
    thursday: { open: '08:00', close: '18:00' },
    friday: { open: '08:00', close: '18:00' },
    saturday: { open: '08:00', close: '18:00' },
    sunday: { open: '08:00', close: '18:00' },
  },
  payment_gateway: 'paystack',
  subscription_tier: 'growth',
  metadata: {},
  owner_id: 'owner-1',
};

const ACTIVE_SERVICE = {
  id: 'svc-1',
  name: 'Haircut',
  price: 5000,
  deposit_amount: 0,
  duration_minutes: 30,
  buffer_minutes: 0,
  max_capacity: 1,
  metadata: {},
};

async function callRoute(body = VALID_BODY) {
  const { POST } = await import('@/app/api/bookings/public/create/route');
  const req = new NextRequest('http://localhost:3000/api/bookings/public/create', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return POST(req);
}

// ── Tests ──

describe('BK-1: Public booking business status check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBusinessResult = { data: ACTIVE_BUSINESS, error: null };
    mockServiceResult = { data: ACTIVE_SERVICE, error: null };
  });

  it('accepts booking for active business (status=active)', async () => {
    mockBusinessResult = { data: ACTIVE_BUSINESS, error: null };

    const res = await callRoute();

    // Should pass business validation — will either succeed or fail at
    // a later stage (RPC/payment), NOT at "Business not found"
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.error).not.toBe('Business not found');
  });

  it('rejects booking for pending business', async () => {
    // When status != 'active', the .eq('status', 'active') filter returns no row
    mockBusinessResult = { data: null, error: { code: 'PGRST116', message: 'no rows' } };

    const res = await callRoute();
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('Business not found');
  });

  it('rejects booking for suspended business', async () => {
    mockBusinessResult = { data: null, error: { code: 'PGRST116', message: 'no rows' } };

    const res = await callRoute();
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('Business not found');
  });

  it('rejects booking for unknown business slug', async () => {
    mockBusinessResult = { data: null, error: { code: 'PGRST116', message: 'no rows' } };

    const res = await callRoute({ ...VALID_BODY, businessSlug: 'nonexistent' });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('Business not found');
  });

  it('source code must NOT query businesses.is_active (regression guard)', () => {
    const routePath = resolve(__dirname, '../../app/api/bookings/public/create/route.ts');
    const src = readFileSync(routePath, 'utf-8');

    // Find the businesses query block — ends at the next major section
    // (could be "Fetch service", "Fetch bookable item", or similar)
    const bizStart = src.indexOf('// Fetch business');
    expect(bizStart).toBeGreaterThan(-1);

    // Find end of business section: the next comment starting a new section
    // Look for the first "// Fetch" or "// Validate" after the business section start
    const afterBiz = src.slice(bizStart + 20);
    const nextSectionMatch = afterBiz.match(/\/\/\s+(Fetch |Validate )/);
    const bizSection = nextSectionMatch
      ? src.slice(bizStart, bizStart + 20 + nextSectionMatch.index!)
      : src.slice(bizStart, bizStart + 500);

    expect(bizSection).not.toContain("eq('is_active'");
    expect(bizSection).toContain("eq('status', 'active')");
  });
});
