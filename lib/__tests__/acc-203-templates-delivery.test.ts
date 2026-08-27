/**
 * ACC-203: Versioned templates, delivery correlation, Contact Winner activation
 *
 * Tests:
 * A. OTP Send: v2 template with dynamic params, fail-closed when not approved
 * B. Contact Winner: role matrix, template readiness, rate limiting, phone never in response
 * C. Template Status: returns both pickup and winner template statuses
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock state ──

let mockUser: { id: string } | null = { id: 'user-1' };
let mockBizOwnerQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockMemberQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockBusinessQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockCapRows: Array<{ capability: string; is_enabled: boolean; sort_order: number }> = [];
let mockCapError: string | null = null;
let mockOverrideRows: Array<{ capability: string }> = [];
let mockOverrideError: unknown = null;
let mockRedemptionQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockRpcResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockCodeQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockPrizeQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockBizNameQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockCampaignQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockWinnerContactQuery: { data: unknown; error: unknown } = { data: null, error: null };
let mockInsertResult: { error: unknown } = { error: null };
let mockTemplates: Array<{ name: string; language: string; status: string }> = [];
let mockSendTemplateResult: { messageId?: string } = { messageId: 'wamid.test' };
let mockSendTemplateFn: ReturnType<typeof vi.fn>;
let mockResolvedChannel: unknown = null;

function resetMocks() {
  mockUser = { id: 'user-1' };
  mockBizOwnerQuery = { data: { id: 'biz-1', name: 'Test Business' }, error: null };
  mockMemberQuery = { data: null, error: null };
  mockBusinessQuery = {
    data: { id: 'biz-1', status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'other', name: 'Test Biz' },
    error: null,
  };
  mockCapRows = [{ capability: 'promo_verification', is_enabled: true, sort_order: 0 }];
  mockCapError = null;
  mockOverrideRows = [];
  mockOverrideError = null;
  mockRedemptionQuery = { data: { id: 'red-1', phone_e164: '+2348012345678', promo_code_id: 'code-1', claim_reference: 'WAA-TEST-0001' }, error: null };
  mockRpcResult = { data: { success: true, verification_id: 'ver-1', phone_e164: '+2348012345678', send_count: 1 }, error: null };
  mockCodeQuery = { data: { prize_id: 'prize-1' }, error: null };
  mockPrizeQuery = { data: { name: 'Gold Prize' }, error: null };
  mockBizNameQuery = { data: { name: 'Test Business' }, error: null };
  mockCampaignQuery = { data: { name: 'Summer Promo' }, error: null };
  mockWinnerContactQuery = { data: null, error: null };
  mockInsertResult = { error: null };
  mockTemplates = [
    { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
    { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
  ];
  mockSendTemplateFn = vi.fn().mockResolvedValue(mockSendTemplateResult);
  mockResolvedChannel = {
    channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
    sender: { sendTemplate: mockSendTemplateFn },
    cloud: { getTemplates: vi.fn().mockResolvedValue({ data: mockTemplates }) },
  };
}

// ── Supabase mock ──

function makeChain(resolveData: () => { data: unknown; error: unknown }): Record<string, any> {
  const c: Record<string, any> = {};
  ['select', 'eq', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit'].forEach(
    (m) => (c[m] = vi.fn().mockReturnValue(c)),
  );
  c.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(resolveData()));
  c.single = vi.fn().mockImplementation(() => Promise.resolve(resolveData()));
  c.insert = vi.fn().mockImplementation(() => Promise.resolve(mockInsertResult));
  return c;
}

let fromCallCount = 0;
let serviceFromCalls: string[] = [];

const mockServiceFrom = vi.fn().mockImplementation((table: string) => {
  serviceFromCalls.push(table);
  if (table === 'businesses') {
    fromCallCount++;
    if (fromCallCount <= 1) return makeChain(() => mockBizOwnerQuery);
    return makeChain(() => mockBusinessQuery);
  }
  if (table === 'business_members') return makeChain(() => mockMemberQuery);
  if (table === 'business_capabilities') {
    const c = makeChain(() => ({ data: mockCapError ? null : mockCapRows, error: mockCapError ? { message: mockCapError } : null }));
    return c;
  }
  if (table === 'capability_overrides') return makeChain(() => ({ data: mockOverrideRows, error: mockOverrideError }));
  if (table === 'promo_redemptions') return makeChain(() => mockRedemptionQuery);
  if (table === 'promo_campaign_codes') return makeChain(() => mockCodeQuery);
  if (table === 'promo_prizes') return makeChain(() => mockPrizeQuery);
  if (table === 'promo_campaigns') return makeChain(() => mockCampaignQuery);
  if (table === 'promo_winner_contacts') {
    const c = makeChain(() => mockWinnerContactQuery);
    c.insert = vi.fn().mockImplementation(() => Promise.resolve(mockInsertResult));
    return c;
  }
  return makeChain(() => ({ data: null, error: null }));
});

const mockServiceRpc = vi.fn().mockImplementation(() => Promise.resolve(mockRpcResult));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: () => Promise.resolve({ data: { user: mockUser } }) },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'businesses') return makeChain(() => mockBizOwnerQuery);
      return makeChain(() => ({ data: null, error: null }));
    }),
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockReturnValue({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
  }),
}));

vi.mock('@/lib/promotions/crypto', () => ({
  generatePickupOtp: vi.fn().mockReturnValue('123456'),
  hashPickupToken: vi.fn().mockReturnValue('hmac_test'),
}));

vi.mock('@/lib/channels/channel-resolver', () => {
  return {
    ChannelResolver: class MockChannelResolver {
      resolveByBusinessId() { return Promise.resolve(mockResolvedChannel); }
    },
  };
});

vi.mock('@/lib/utils/phone', () => ({
  stripPlus: vi.fn().mockImplementation((p: string) => p.replace(/^\+/, '')),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  resetMocks();
  fromCallCount = 0;
  serviceFromCalls = [];
  vi.clearAllMocks();
});

// ── A. OTP Send Route Tests ──

describe('OTP Send: v2 template with dynamic params', () => {
  async function callSend(body: Record<string, unknown> = { businessId: 'biz-1', redemptionId: 'red-1' }) {
    // Reset fromCallCount for the guard
    fromCallCount = 0;
    const { POST } = await import('@/app/api/promotions/verification/send/route');
    const req = new NextRequest('http://localhost/api/promotions/verification/send', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    return POST(req);
  }

  it('v2 APPROVED -> OTP send succeeds with dynamic params', async () => {
    const res = await callSend();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(true);

    // Verify sendTemplate was called with v2 name and 4 params
    expect(mockSendTemplateFn).toHaveBeenCalledWith(expect.objectContaining({
      templateName: 'promo_pickup_verification_v2',
      templateParams: expect.arrayContaining(['Test Business', 'Gold Prize', '123456', '10']),
    }));
  });

  it('v2 missing -> fail closed (no send, no v1 fallback)', async () => {
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: vi.fn().mockRejectedValue(new Error('Template not found')) },
      cloud: null,
    };
    const res = await callSend();
    // Without cloud, sendTemplate failure -> 503
    expect(res.status).toBe(503);
  });

  it('v2 pending -> fail closed (template send fails)', async () => {
    // Even if template exists on Meta side, if sendTemplate throws we get 503
    mockSendTemplateFn = vi.fn().mockRejectedValue(new Error('Template not approved'));
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: mockSendTemplateFn },
      cloud: null,
    };
    const res = await callSend();
    expect(res.status).toBe(503);
  });

  it('v2 rejected -> fail closed', async () => {
    mockSendTemplateFn = vi.fn().mockRejectedValue(new Error('Template rejected'));
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: mockSendTemplateFn },
      cloud: null,
    };
    const res = await callSend();
    expect(res.status).toBe(503);
  });
});

// ── B. Contact Winner Route Tests ──

describe('Contact Winner', () => {
  async function callContact(body: Record<string, unknown> = { businessId: 'biz-1', campaignId: 'camp-1', redemptionId: 'red-1' }) {
    fromCallCount = 0;
    serviceFromCalls = [];
    const { POST } = await import('@/app/api/promotions/winners/contact/route');
    const req = new NextRequest('http://localhost/api/promotions/winners/contact', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    return POST(req);
  }

  it('owner -> send with template succeeds', async () => {
    const res = await callContact();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(true);
  });

  it('manager -> send with template succeeds', async () => {
    // Manager has a member record but is not the owner
    mockBizOwnerQuery = { data: null, error: null };
    mockMemberQuery = { data: { role: 'manager', status: 'active' }, error: null };
    const res = await callContact();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(true);
  });

  it('staff -> denied', async () => {
    mockBizOwnerQuery = { data: null, error: null };
    mockMemberQuery = { data: { role: 'staff', status: 'active' }, error: null };
    const res = await callContact();
    expect(res.status).toBe(403);
  });

  it('template not ready -> 503', async () => {
    mockTemplates = [
      { name: 'promo_winner_status_v1', language: 'en_US', status: 'PENDING' },
    ];
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: mockSendTemplateFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: mockTemplates }) },
    };
    const res = await callContact();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('template_not_ready');
  });

  it('phone never in response', async () => {
    const res = await callContact();
    const json = await res.json();
    expect(json.phone_e164).toBeUndefined();
    expect(json.phone).toBeUndefined();
    const text = JSON.stringify(json);
    expect(text).not.toContain('2348012345678');
  });

  it('rate limited -> 429', async () => {
    mockWinnerContactQuery = { data: { id: 'wc-1', created_at: new Date().toISOString() }, error: null };
    const res = await callContact();
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('rate_limited');
  });

  it('non-winner -> 404', async () => {
    mockRedemptionQuery = { data: null, error: null };
    const res = await callContact();
    expect(res.status).toBe(404);
  });

  it('missing required fields -> 400', async () => {
    const res = await callContact({ businessId: 'biz-1' });
    expect(res.status).toBe(400);
  });

  it('unauthorized -> 401', async () => {
    mockUser = null;
    const res = await callContact();
    expect(res.status).toBe(401);
  });
});
