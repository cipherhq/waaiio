/**
 * Issue #456 — Pending onboarding bot-code self-collision on resume.
 *
 * Proves:
 * 1. Same pending business resume: business_id matches pending business owned by user → excluded from collision
 * 2. Different business collision: another business has the same code → taken
 * 3. Active business collision: same user's ACTIVE business has the code → taken (only pending excluded)
 * 4. Invalid/foreign business ID: business_id owned by different user → ignored, collision check runs normally
 * 5. No business_id behavior: existing behavior preserved — no exclusion
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const MOCK_USER_ID = 'user-111';
const MOCK_BUSINESS_ID = 'biz-222';
const MOCK_SLUG = 'test-biz';
const MOCK_BOT_CODE = 'TEST-BIZ';

const mockGetUser = vi.fn();

// Track query chains for slug and bot_code checks
type QueryChain = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

let slugChain: QueryChain;
let codeChain: QueryChain;
let ownershipChain: QueryChain;

function createChain(result: { data: unknown }): QueryChain {
  const chain: QueryChain = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.neq.mockReturnValue(chain);
  chain.maybeSingle.mockReturnValue(Promise.resolve(result));
  return chain;
}

const mockServiceFrom = vi.fn();

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

vi.mock('@/lib/constants', () => ({
  generateSlug: () => MOCK_SLUG,
  generateBotCode: () => MOCK_BOT_CODE,
}));

// Import GET handler after mocks
const { GET } = await import('@/app/api/onboarding/check-name/route');

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/onboarding/check-name');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

describe('check-name self-collision (#456)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no collisions
    slugChain = createChain({ data: null });
    codeChain = createChain({ data: null });
    ownershipChain = createChain({ data: null });

    // mockServiceFrom returns different chains depending on which call it is.
    // The ownership check is the first .from('businesses') call when business_id is provided,
    // followed by slug check and code check.
    let callCount = 0;
    mockServiceFrom.mockImplementation(() => {
      callCount++;
      // When business_id is provided: call 1 = ownership, 2 = slug, 3 = code
      // When no business_id: call 1 = slug, 2 = code
      if (callCount === 1) return slugChain;
      if (callCount === 2) return codeChain;
      return ownershipChain;
    });
  });

  it('1. excludes own pending business from collision check', async () => {
    // User is authenticated
    mockGetUser.mockResolvedValue({ data: { user: { id: MOCK_USER_ID } } });

    // Ownership verification: pending business exists and belongs to user
    const ownerChain = createChain({ data: { id: MOCK_BUSINESS_ID } });

    // Slug and code queries return null (no collision after exclusion)
    const sChain = createChain({ data: null });
    const cChain = createChain({ data: null });

    let callCount = 0;
    mockServiceFrom.mockImplementation(() => {
      callCount++;
      // Call 1: ownership check
      if (callCount === 1) return ownerChain;
      // Call 2: slug collision check
      if (callCount === 2) return sChain;
      // Call 3: code collision check
      return cChain;
    });

    const res = await GET(makeRequest({ name: 'Test Biz', business_id: MOCK_BUSINESS_ID }));
    const json = await res.json();

    expect(json.available).toBe(true);
    expect(json.slug_available).toBe(true);
    expect(json.code_available).toBe(true);

    // Verify .neq was called on both slug and code queries to exclude own business
    expect(sChain.neq).toHaveBeenCalledWith('id', MOCK_BUSINESS_ID);
    expect(cChain.neq).toHaveBeenCalledWith('id', MOCK_BUSINESS_ID);
  });

  it('2. another business with same code → taken', async () => {
    // User is authenticated
    mockGetUser.mockResolvedValue({ data: { user: { id: MOCK_USER_ID } } });

    // Ownership verification: pending business exists
    const ownerChain = createChain({ data: { id: MOCK_BUSINESS_ID } });

    // Slug is available, but code collides with a DIFFERENT business
    const sChain = createChain({ data: null });
    const cChain = createChain({ data: { bot_code: MOCK_BOT_CODE } });

    let callCount = 0;
    mockServiceFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return ownerChain;
      if (callCount === 2) return sChain;
      return cChain;
    });

    const res = await GET(makeRequest({ name: 'Test Biz', business_id: MOCK_BUSINESS_ID }));
    const json = await res.json();

    expect(json.available).toBe(false);
    expect(json.code_available).toBe(false);
  });

  it('3. active business with same code → taken (only pending excluded)', async () => {
    // User is authenticated
    mockGetUser.mockResolvedValue({ data: { user: { id: MOCK_USER_ID } } });

    // Ownership check returns null — business exists but is NOT pending (status=active)
    const ownerChain = createChain({ data: null });

    // Code collision exists
    const sChain = createChain({ data: null });
    const cChain = createChain({ data: { bot_code: MOCK_BOT_CODE } });

    let callCount = 0;
    mockServiceFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return ownerChain;
      if (callCount === 2) return sChain;
      return cChain;
    });

    const res = await GET(makeRequest({ name: 'Test Biz', business_id: MOCK_BUSINESS_ID }));
    const json = await res.json();

    expect(json.available).toBe(false);
    expect(json.code_available).toBe(false);

    // .neq should NOT have been called since ownership check failed
    expect(sChain.neq).not.toHaveBeenCalled();
    expect(cChain.neq).not.toHaveBeenCalled();
  });

  it('4. foreign business ID → ignored, collision check runs normally', async () => {
    // User is authenticated but a different user
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-other' } } });

    // Ownership check returns null — business belongs to different user
    const ownerChain = createChain({ data: null });

    // Code collision exists
    const sChain = createChain({ data: { slug: MOCK_SLUG } });
    const cChain = createChain({ data: { bot_code: MOCK_BOT_CODE } });

    let callCount = 0;
    mockServiceFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return ownerChain;
      if (callCount === 2) return sChain;
      return cChain;
    });

    const res = await GET(makeRequest({ name: 'Test Biz', business_id: MOCK_BUSINESS_ID }));
    const json = await res.json();

    expect(json.available).toBe(false);
    expect(json.slug_available).toBe(false);
    expect(json.code_available).toBe(false);

    // .neq should NOT have been called
    expect(sChain.neq).not.toHaveBeenCalled();
    expect(cChain.neq).not.toHaveBeenCalled();
  });

  it('5. no business_id → existing behavior preserved, no exclusion', async () => {
    // No business_id param — existing behavior
    // Code collision exists
    slugChain = createChain({ data: { slug: MOCK_SLUG } });
    codeChain = createChain({ data: { bot_code: MOCK_BOT_CODE } });

    let callCount = 0;
    mockServiceFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return slugChain;
      return codeChain;
    });

    const res = await GET(makeRequest({ name: 'Test Biz' }));
    const json = await res.json();

    expect(json.available).toBe(false);
    expect(json.slug_available).toBe(false);
    expect(json.code_available).toBe(false);

    // .neq should NOT have been called
    expect(slugChain.neq).not.toHaveBeenCalled();
    expect(codeChain.neq).not.toHaveBeenCalled();

    // Auth should NOT have been called
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('6. resumed-URL businessId (not pendingRetryId) excludes own pending business', async () => {
    // Scenario: user created a pending business, left, came back via URL with
    // ?business_id=xxx. OnboardingWizard sets businessId (not pendingRetryId).
    // The frontend now sends businessId as business_id param to check-name.
    // Server must exclude that pending business from collision checks.
    mockGetUser.mockResolvedValue({ data: { user: { id: MOCK_USER_ID } } });

    const RESUMED_BIZ_ID = 'biz-resumed-url';
    const ownerChain = createChain({ data: { id: RESUMED_BIZ_ID } });
    const sChain = createChain({ data: null });
    const cChain = createChain({ data: null });

    let callCount = 0;
    mockServiceFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return ownerChain;
      if (callCount === 2) return sChain;
      return cChain;
    });

    const res = await GET(makeRequest({ name: 'Test Biz', business_id: RESUMED_BIZ_ID }));
    const json = await res.json();

    expect(json.available).toBe(true);
    expect(sChain.neq).toHaveBeenCalledWith('id', RESUMED_BIZ_ID);
    expect(cChain.neq).toHaveBeenCalledWith('id', RESUMED_BIZ_ID);
  });
});
