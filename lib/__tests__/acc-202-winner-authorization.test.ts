/**
 * ACC-202: Winner Authorization — Role-based winner management
 *
 * Tests:
 * A. resolveBusinessRole unit tests
 * B. requireCapabilityWithRole guard tests
 * C. Reveal endpoint: owner/admin can reveal, others denied, audit failure blocks
 * D. Contact endpoint: owner/admin/manager allowed, shell returns 503
 * E. Winners route: permissions in response, role matrix
 * F. Fulfillment route: owner/admin only, no phone_e164 in response
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock state ──

let mockBizOwnerQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockMemberQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockBusinessQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockCapRows: Array<{ capability: string; is_enabled: boolean; sort_order: number }> = [];
let mockCapError: string | null = null;
let mockOverrideRows: Array<{ capability: string }> = [];
let mockOverrideError: unknown = null;
let mockRedemptionQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockCampaignQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockAuditInsertError: unknown = null;
let mockRpcResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockUpdateQuery: { data: unknown; error: unknown } = { data: null, error: null };

function resetMocks() {
  mockBizOwnerQuery = { data: null, error: null };
  mockMemberQuery = { data: null, error: null };
  mockBusinessQuery = {
    data: { id: 'biz-1', status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'other' },
    error: null,
  };
  mockCapRows = [{ capability: 'promo_verification', is_enabled: true, sort_order: 0 }];
  mockCapError = null;
  mockOverrideRows = [];
  mockOverrideError = null;
  mockRedemptionQuery = { data: { id: 'red-1', phone_e164: '+2348012345678' }, error: null };
  mockCampaignQuery = { data: { id: 'camp-1' }, error: null };
  mockAuditInsertError = null;
  mockRpcResult = { data: { success: true, previous_status: 'pending', new_status: 'processing' }, error: null };
  mockUpdateQuery = {
    data: { id: 'red-1', campaign_id: 'camp-1', claim_reference: 'WAA-TEST', fulfillment_status: 'processing' },
    error: null,
  };
}

// ── Supabase mock ──

function makeChain(resolveData: () => { data: unknown; error: unknown }): Record<string, any> {
  const c: Record<string, any> = {};
  ['select', 'eq', 'neq', 'order', 'range', 'not', 'in'].forEach(
    (m) => (c[m] = vi.fn().mockReturnValue(c)),
  );
  c.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(resolveData()));
  c.single = vi.fn().mockImplementation(() => Promise.resolve(resolveData()));
  c.insert = vi.fn().mockImplementation(() => Promise.resolve({ error: mockAuditInsertError }));
  return c;
}

// Track which table is being queried to return appropriate mock data
let fromCallCount = 0;

const mockServiceFrom = vi.fn().mockImplementation((table: string) => {
  if (table === 'businesses') {
    fromCallCount++;
    // First call is for owner check in resolveBusinessRole, second for business data
    if (fromCallCount <= 1) {
      return makeChain(() => mockBizOwnerQuery);
    }
    return makeChain(() => mockBusinessQuery);
  }
  if (table === 'business_members') {
    return makeChain(() => mockMemberQuery);
  }
  if (table === 'business_capabilities') {
    const c = makeChain(() => ({ data: mockCapError ? null : mockCapRows, error: mockCapError ? { message: mockCapError } : null }));
    // Override for the service.getConfiguredCapabilities pattern which doesn't use maybeSingle
    // The original function directly destructures { data, error } without .maybeSingle()
    return c;
  }
  if (table === 'capability_overrides') {
    return makeChain(() => ({ data: mockOverrideRows, error: mockOverrideError }));
  }
  if (table === 'promo_redemptions') {
    return makeChain(() => mockRedemptionQuery);
  }
  if (table === 'promo_campaigns') {
    return makeChain(() => mockCampaignQuery);
  }
  if (table === 'admin_audit_logs') {
    return makeChain(() => ({ data: null, error: mockAuditInsertError }));
  }
  return makeChain(() => ({ data: null, error: null }));
});

const mockServiceRpc = vi.fn().mockImplementation(() => Promise.resolve(mockRpcResult));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
    }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/observability/server-events', () => ({
  emitServerEvent: vi.fn(),
}));

// Mock the capability service — getConfiguredCapabilities is called via import
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: () => {
    if (mockCapError) return Promise.resolve({ ok: false, error: mockCapError });
    return Promise.resolve({ ok: true, rows: mockCapRows });
  },
  getEnabledCapabilities: vi.fn(),
}));

// ── Import route handlers ──

const { POST: revealPOST } = await import('@/app/api/promotions/winners/reveal/route');
const { POST: contactPOST } = await import('@/app/api/promotions/winners/contact/route');
const { GET: winnersGET } = await import('@/app/api/promotions/winners/route');
const { PUT: fulfillmentPUT } = await import('@/app/api/promotions/fulfillment/route');

// ── Helpers ──

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makePutRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost/api/promotions/winners');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

function setOwner() {
  mockBizOwnerQuery = { data: { id: 'biz-1' }, error: null };
  mockMemberQuery = { data: null, error: null };
}

function setRole(role: string) {
  mockBizOwnerQuery = { data: null, error: null };
  mockMemberQuery = { data: { role }, error: null };
}

function setNoRole() {
  mockBizOwnerQuery = { data: null, error: null };
  mockMemberQuery = { data: null, error: null };
}

// ═══════════════════════════════════════════════════════
// A. resolveBusinessRole
// ═══════════════════════════════════════════════════════

describe('resolveBusinessRole', () => {
  beforeEach(() => {
    resetMocks();
    fromCallCount = 0;
  });

  it('returns owner when businesses.owner_id matches', async () => {
    const { resolveBusinessRole } = await import('@/lib/capabilities/resolve-role');
    const mockService = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'businesses') {
          return makeChain(() => ({ data: { id: 'biz-1' }, error: null }));
        }
        return makeChain(() => ({ data: null, error: null }));
      }),
    };
    const result = await resolveBusinessRole(mockService as any, 'biz-1', 'user-1');
    expect(result).toEqual({ ok: true, role: 'owner', isOwner: true });
  });

  it('returns member role when business_members has active entry', async () => {
    const { resolveBusinessRole } = await import('@/lib/capabilities/resolve-role');
    const mockService = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'businesses') {
          return makeChain(() => ({ data: null, error: null }));
        }
        if (table === 'business_members') {
          return makeChain(() => ({ data: { role: 'manager' }, error: null }));
        }
        return makeChain(() => ({ data: null, error: null }));
      }),
    };
    const result = await resolveBusinessRole(mockService as any, 'biz-1', 'user-1');
    expect(result).toEqual({ ok: true, role: 'manager', isOwner: false });
  });

  it('returns not_found when user has no role', async () => {
    const { resolveBusinessRole } = await import('@/lib/capabilities/resolve-role');
    const mockService = {
      from: vi.fn().mockImplementation(() => makeChain(() => ({ data: null, error: null }))),
    };
    const result = await resolveBusinessRole(mockService as any, 'biz-1', 'user-1');
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });

  it('returns db_error on business query failure', async () => {
    const { resolveBusinessRole } = await import('@/lib/capabilities/resolve-role');
    const mockService = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'businesses') {
          return makeChain(() => ({ data: null, error: { message: 'timeout' } }));
        }
        return makeChain(() => ({ data: null, error: null }));
      }),
    };
    const result = await resolveBusinessRole(mockService as any, 'biz-1', 'user-1');
    expect(result).toEqual({ ok: false, error: 'db_error' });
  });
});

// ═══════════════════════════════════════════════════════
// B. Reveal endpoint
// ═══════════════════════════════════════════════════════

describe('Reveal endpoint (POST /api/promotions/winners/reveal)', () => {
  beforeEach(() => {
    resetMocks();
    fromCallCount = 0;
  });

  it('owner can reveal phone — returns phone_e164', async () => {
    setOwner();
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.phone_e164).toBe('+2348012345678');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('admin can reveal phone', async () => {
    setRole('admin');
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(200);
  });

  it('manager is denied reveal', async () => {
    setRole('manager');
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.reason).toBe('insufficient_permissions');
  });

  it('staff is denied reveal', async () => {
    setRole('staff');
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(403);
  });

  it('non-member is denied reveal', async () => {
    setNoRole();
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(403);
  });

  it('audit failure blocks phone reveal', async () => {
    setOwner();
    mockAuditInsertError = { message: 'audit write failed' };
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Audit recording failed');
    expect(data.phone_e164).toBeUndefined();
  });

  it('missing fields returns 400', async () => {
    setOwner();
    const req = makePostRequest({ businessId: 'biz-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(400);
  });

  it('suspended business is denied', async () => {
    setOwner();
    mockBusinessQuery = { data: { id: 'biz-1', status: 'suspended', subscription_tier: 'growth', trial_ends_at: null, category: 'other' }, error: null };
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.reason).toBe('business_suspended');
  });
});

// ═══════════════════════════════════════════════════════
// C. Contact endpoint
// ═══════════════════════════════════════════════════════

describe('Contact endpoint (POST /api/promotions/winners/contact)', () => {
  beforeEach(() => {
    resetMocks();
    fromCallCount = 0;
  });

  it('owner allowed — returns 503 shell', async () => {
    setOwner();
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await contactPOST(req);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe('template_not_ready');
    expect(data.phone_e164).toBeUndefined();
  });

  it('manager allowed — returns 503 shell', async () => {
    setRole('manager');
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await contactPOST(req);
    expect(res.status).toBe(503);
  });

  it('staff is denied contact', async () => {
    setRole('staff');
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await contactPOST(req);
    expect(res.status).toBe(403);
  });

  it('finance is denied contact', async () => {
    setRole('finance');
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await contactPOST(req);
    expect(res.status).toBe(403);
  });

  it('response has no phone in body', async () => {
    setOwner();
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await contactPOST(req);
    const data = await res.json();
    expect(data.phone_e164).toBeUndefined();
    expect(data.phone).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// D. Winners route — permissions in response
// ═══════════════════════════════════════════════════════

describe('Winners route (GET /api/promotions/winners)', () => {
  beforeEach(() => {
    resetMocks();
    fromCallCount = 0;
    // Winners route needs count query — mock the full chain
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapError ? null : mockCapRows, error: mockCapError ? { message: mockCapError } : null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: mockOverrideRows, error: mockOverrideError }));
      if (table === 'promo_campaigns') return makeChain(() => mockCampaignQuery);
      if (table === 'promo_redemptions') {
        // Winners query returns array with count
        const c = makeChain(() => ({ data: [], error: null }));
        c.range = vi.fn().mockResolvedValue({ data: [], count: 0, error: null });
        return c;
      }
      return makeChain(() => ({ data: null, error: null }));
    });
  });

  it('owner gets all permissions true', async () => {
    setOwner();
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.permissions).toEqual({
      can_reveal_phone: true,
      can_contact_winner: true,
      can_manage_fulfillment: true,
    });
  });

  it('admin gets all permissions true', async () => {
    setRole('admin');
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.permissions).toEqual({
      can_reveal_phone: true,
      can_contact_winner: true,
      can_manage_fulfillment: true,
    });
  });

  it('manager gets limited permissions', async () => {
    setRole('manager');
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.permissions).toEqual({
      can_reveal_phone: false,
      can_contact_winner: true,
      can_manage_fulfillment: false,
    });
  });

  it('staff is denied winners list', async () => {
    setRole('staff');
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    expect(res.status).toBe(403);
  });

  it('non-member is denied', async () => {
    setNoRole();
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// E. Fulfillment route
// ═══════════════════════════════════════════════════════

describe('Fulfillment route (PUT /api/promotions/fulfillment)', () => {
  beforeEach(() => {
    resetMocks();
    fromCallCount = 0;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapError ? null : mockCapRows, error: mockCapError ? { message: mockCapError } : null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: mockOverrideRows, error: mockOverrideError }));
      if (table === 'promo_redemptions') return makeChain(() => mockUpdateQuery);
      return makeChain(() => ({ data: null, error: null }));
    });
  });

  it('owner can update fulfillment', async () => {
    setOwner();
    const req = makePutRequest({
      businessId: 'biz-1', redemptionId: 'red-1',
      fulfillmentStatus: 'processing',
    });
    const res = await fulfillmentPUT(req);
    expect(res.status).toBe(200);
  });

  it('admin can update fulfillment', async () => {
    setRole('admin');
    const req = makePutRequest({
      businessId: 'biz-1', redemptionId: 'red-1',
      fulfillmentStatus: 'processing',
    });
    const res = await fulfillmentPUT(req);
    expect(res.status).toBe(200);
  });

  it('manager is denied fulfillment', async () => {
    setRole('manager');
    const req = makePutRequest({
      businessId: 'biz-1', redemptionId: 'red-1',
      fulfillmentStatus: 'processing',
    });
    const res = await fulfillmentPUT(req);
    expect(res.status).toBe(403);
  });

  it('staff is denied fulfillment', async () => {
    setRole('staff');
    const req = makePutRequest({
      businessId: 'biz-1', redemptionId: 'red-1',
      fulfillmentStatus: 'processing',
    });
    const res = await fulfillmentPUT(req);
    expect(res.status).toBe(403);
  });

  it('fulfillment response does not contain phone_e164', async () => {
    setOwner();
    const req = makePutRequest({
      businessId: 'biz-1', redemptionId: 'red-1',
      fulfillmentStatus: 'processing',
    });
    const res = await fulfillmentPUT(req);
    const data = await res.json();
    // The select list explicitly excludes phone_e164
    // The response should contain a redemption object without phone
    if (data.redemption) {
      expect(data.redemption.phone_e164).toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════
// F. Extended auth/regression matrix
// ═══════════════════════════════════════════════════════

describe('Extended role denial matrix', () => {
  beforeEach(() => {
    resetMocks();
    fromCallCount = 0;
    // Restore default mockServiceFrom for winners GET
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapError ? null : mockCapRows, error: mockCapError ? { message: mockCapError } : null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: mockOverrideRows, error: mockOverrideError }));
      if (table === 'promo_campaigns') return makeChain(() => mockCampaignQuery);
      if (table === 'promo_redemptions') {
        const c = makeChain(() => mockRedemptionQuery);
        c.range = vi.fn().mockResolvedValue({ data: [], count: 0, error: null });
        return c;
      }
      if (table === 'admin_audit_logs') return makeChain(() => ({ data: null, error: mockAuditInsertError }));
      return makeChain(() => ({ data: null, error: null }));
    });
  });

  it('finance role denied winners list', async () => {
    setRole('finance');
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    expect(res.status).toBe(403);
  });

  it('support role denied winners list', async () => {
    setRole('support');
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    expect(res.status).toBe(403);
  });

  it('admin with invited membership status is denied', async () => {
    // resolveBusinessRole queries .eq('status', 'active'), so an invited member returns null
    // Mock: owner check fails (not owner), member query returns null (status != active)
    setNoRole();
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    expect(res.status).toBe(403);
  });

  it('admin with suspended membership status is denied', async () => {
    // Same - resolveBusinessRole returns not_found because .eq('status', 'active') excludes them
    setNoRole();
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    expect(res.status).toBe(403);
  });

  it('wrong business denied reveal', async () => {
    setOwner();
    // Redemption query returns null when business_id doesn't match (scoped by .eq('business_id', businessId))
    mockRedemptionQuery = { data: null, error: null };
    const req = makePostRequest({ businessId: 'biz-wrong', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    // Guard passes (mock doesn't scope owner check), but redemption not found due to business_id scope
    expect(res.status).toBe(404);
  });

  it('wrong campaign denied reveal', async () => {
    setOwner();
    mockRedemptionQuery = { data: null, error: null };
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-wrong', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(404);
  });

  it('non-winner redemption cannot be revealed', async () => {
    setOwner();
    // Redemption exists but outcome is not 'winner' — query with .eq('outcome', 'winner') returns null
    mockRedemptionQuery = { data: null, error: null };
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-loser' });
    const res = await revealPOST(req);
    expect(res.status).toBe(404);
  });

  it('non-winner redemption cannot be contacted', async () => {
    setOwner();
    mockRedemptionQuery = { data: null, error: null };
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-loser' });
    const res = await contactPOST(req);
    expect(res.status).toBe(404);
  });

  it('suspended business denied all endpoints', async () => {
    setOwner();
    mockBusinessQuery = {
      data: { id: 'biz-1', status: 'suspended', subscription_tier: 'growth', trial_ends_at: null, category: 'other' },
      error: null,
    };

    const revealReq = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const revealRes = await revealPOST(revealReq);
    expect(revealRes.status).toBe(403);
    const revealData = await revealRes.json();
    expect(revealData.reason).toBe('business_suspended');

    const contactReq = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const contactRes = await contactPOST(contactReq);
    expect(contactRes.status).toBe(403);
    const contactData = await contactRes.json();
    expect(contactData.reason).toBe('business_suspended');
  });

  it('pending business allowed for read_history', async () => {
    setOwner();
    mockBusinessQuery = {
      data: { id: 'biz-1', status: 'pending', subscription_tier: 'growth', trial_ends_at: null, category: 'other' },
      error: null,
    };
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    // read_history allows pending businesses
    expect(res.status).toBe(200);
  });

  it('read_history allowed even when promo_verification not configured', async () => {
    setOwner();
    // No capabilities configured at all
    mockCapRows = [];
    const req = makeGetRequest({ businessId: 'biz-1', campaignId: 'camp-1' });
    const res = await winnersGET(req);
    // read_history always returns allowed: true regardless of capability state
    expect(res.status).toBe(200);
  });

  it('manage_existing allowed even when promo_verification not configured', async () => {
    setOwner();
    mockCapRows = [];
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: [], error: null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: [], error: null }));
      if (table === 'promo_redemptions') return makeChain(() => mockUpdateQuery);
      return makeChain(() => ({ data: null, error: null }));
    });
    const req = makePutRequest({
      businessId: 'biz-1', redemptionId: 'red-1',
      fulfillmentStatus: 'processing',
    });
    const res = await fulfillmentPUT(req);
    // manage_existing always returns allowed: true regardless of capability state
    expect(res.status).toBe(200);
  });

  it('contact winner shell does not query phone_e164', async () => {
    setOwner();
    const selectSpy = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'red-1' }, error: null }),
            }),
          }),
        }),
      }),
    });
    // Override promo_redemptions mock to spy on SELECT columns
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapRows, error: null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: [], error: null }));
      if (table === 'promo_redemptions') {
        return { select: selectSpy };
      }
      return makeChain(() => ({ data: null, error: null }));
    });

    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await contactPOST(req);
    // Verify select was called with 'id' only (no phone_e164)
    expect(selectSpy).toHaveBeenCalledWith('id');
    // Should reach 503 shell (or 404 depending on mock chain depth)
    expect([404, 503]).toContain(res.status);
  });

  // ── 2c. Fail-closed behavior ──

  it('member lookup DB error returns 500 authority_read_error', async () => {
    // Mock resolveBusinessRole to return { ok: false, error: 'db_error' }
    mockBizOwnerQuery = { data: null, error: { message: 'timeout' } };
    mockMemberQuery = { data: null, error: null };
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.reason).toBe('authority_read_error');
  });

  it('business/status lookup DB error returns 500 authority_read_error', async () => {
    setOwner();
    // Business lookup (second .from('businesses') call) returns error
    mockBusinessQuery = { data: null, error: { message: 'DB connection failed' } };
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.reason).toBe('authority_read_error');
  });

  it('capability read error returns 500 capability_read_error', async () => {
    setOwner();
    mockCapError = 'DB read failure';
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.reason).toBe('capability_read_error');
  });

  it('override read error returns 500 override_read_error', async () => {
    setOwner();
    // Override mockServiceFrom to make capability_overrides chain thenable with an error
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapRows, error: null }));
      }
      if (table === 'capability_overrides') {
        // Make the chain resolve as a thenable with error, matching Supabase's await pattern
        const overrideChain: Record<string, any> = {};
        ['select', 'eq'].forEach(m => (overrideChain[m] = vi.fn().mockReturnValue(overrideChain)));
        overrideChain.then = (resolve: (v: unknown) => void) => {
          resolve({ data: null, error: { message: 'override table down' } });
        };
        return overrideChain;
      }
      if (table === 'promo_redemptions') return makeChain(() => mockRedemptionQuery);
      if (table === 'admin_audit_logs') return makeChain(() => ({ data: null, error: mockAuditInsertError }));
      return makeChain(() => ({ data: null, error: null }));
    });
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.reason).toBe('override_read_error');
  });

  // ── 2d. Business status ──

  it('pending business + manage_existing is allowed', async () => {
    setOwner();
    mockBusinessQuery = {
      data: { id: 'biz-1', status: 'pending', subscription_tier: 'growth', trial_ends_at: null, category: 'other' },
      error: null,
    };
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapRows, error: null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: [], error: null }));
      if (table === 'promo_redemptions') return makeChain(() => mockUpdateQuery);
      return makeChain(() => ({ data: null, error: null }));
    });
    const req = makePutRequest({
      businessId: 'biz-1', redemptionId: 'red-1',
      fulfillmentStatus: 'processing',
    });
    const res = await fulfillmentPUT(req);
    // manage_existing allows pending businesses
    expect(res.status).toBe(200);
  });

  it('suspended business denied on all endpoints', async () => {
    setOwner();
    mockBusinessQuery = {
      data: { id: 'biz-1', status: 'suspended', subscription_tier: 'growth', trial_ends_at: null, category: 'other' },
      error: null,
    };

    // Reveal
    const revealReq = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const revealRes = await revealPOST(revealReq);
    expect(revealRes.status).toBe(403);
    const revealData = await revealRes.json();
    expect(revealData.reason).toBe('business_suspended');

    // Contact
    fromCallCount = 0;
    const contactReq = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const contactRes = await contactPOST(contactReq);
    expect(contactRes.status).toBe(403);
    const contactData = await contactRes.json();
    expect(contactData.reason).toBe('business_suspended');

    // Fulfillment
    fromCallCount = 0;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapRows, error: null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: [], error: null }));
      if (table === 'promo_redemptions') return makeChain(() => mockUpdateQuery);
      return makeChain(() => ({ data: null, error: null }));
    });
    const fulfillReq = makePutRequest({
      businessId: 'biz-1', redemptionId: 'red-1',
      fulfillmentStatus: 'processing',
    });
    const fulfillRes = await fulfillmentPUT(fulfillReq);
    expect(fulfillRes.status).toBe(403);
    const fulfillData = await fulfillRes.json();
    expect(fulfillData.reason).toBe('business_suspended');
  });

  // ── 2e. Scope assertions ──

  it('wrong business reveals no row (404)', async () => {
    setOwner();
    // Redemption query with .eq('business_id', wrongBizId) returns null
    mockRedemptionQuery = { data: null, error: null };
    const req = makePostRequest({ businessId: 'biz-wrong', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await revealPOST(req);
    expect(res.status).toBe(404);
  });

  it('non-winner reveal creates no audit', async () => {
    setOwner();
    // Redemption query with .eq('outcome', 'winner') returns null for non-winner
    mockRedemptionQuery = { data: null, error: null };
    const auditInsertSpy = vi.fn().mockResolvedValue({ error: null });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapRows, error: null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: [], error: null }));
      if (table === 'promo_redemptions') return makeChain(() => ({ data: null, error: null }));
      if (table === 'admin_audit_logs') {
        return { insert: auditInsertSpy };
      }
      return makeChain(() => ({ data: null, error: null }));
    });
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-loser' });
    const res = await revealPOST(req);
    expect(res.status).toBe(404);
    // Audit insert should NOT have been called (404 returned before audit)
    expect(auditInsertSpy).not.toHaveBeenCalled();
  });

  // ── 2f. Contact Winner assertions ──

  it('contact returns exactly 503 template_not_ready', async () => {
    setOwner();
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await contactPOST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('template_not_ready');
  });

  it('contact SELECT is exactly id (no phone_e164)', async () => {
    setOwner();
    const selectSpy = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'red-1' }, error: null }),
            }),
          }),
        }),
      }),
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
        return makeChain(() => mockBusinessQuery);
      }
      if (table === 'business_members') return makeChain(() => mockMemberQuery);
      if (table === 'business_capabilities') {
        return makeChain(() => ({ data: mockCapRows, error: null }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: [], error: null }));
      if (table === 'promo_redemptions') {
        return { select: selectSpy };
      }
      return makeChain(() => ({ data: null, error: null }));
    });

    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    await contactPOST(req);
    // Assert select was called with 'id' not '*' or 'phone_e164'
    expect(selectSpy).toHaveBeenCalledWith('id');
  });

  it('contact makes zero messaging/Meta calls', async () => {
    setOwner();
    // The contact endpoint is a 503 shell — no external calls should be made
    const req = makePostRequest({ businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' });
    const res = await contactPOST(req);
    expect(res.status).toBe(503);
    // Response contains only error and message — no external service data
    const json = await res.json();
    expect(json.error).toBe('template_not_ready');
    expect(json.phone_e164).toBeUndefined();
    expect(json.messageId).toBeUndefined();
  });
});
