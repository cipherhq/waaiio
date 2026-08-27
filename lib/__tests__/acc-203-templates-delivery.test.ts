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
import { MetaApiError } from '@/lib/channels/meta-api-error';

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
  mockClaimContactResult = { data: { success: true, contact_id: 'contact-1' }, error: null };
  mockFinalizeContactResult = { data: { success: true }, error: null };
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
    c.insert = vi.fn().mockImplementation(() => {
      if (mockInsertResult.error) {
        return {
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: mockInsertResult.error }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: 'wc-new-1' }, error: null }),
        }),
      };
    });
    c.update = vi.fn().mockImplementation(() => ({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }));
    return c;
  }
  return makeChain(() => ({ data: null, error: null }));
});

let mockClaimContactResult: { data: unknown; error: unknown } = { data: { success: true, contact_id: 'contact-1' }, error: null };
let mockFinalizeContactResult: { data: unknown; error: unknown } = { data: { success: true }, error: null };

const mockServiceRpc = vi.fn().mockImplementation((name: string) => {
  if (name === 'claim_winner_contact_send') return Promise.resolve(mockClaimContactResult);
  if (name === 'finalize_winner_contact_send') return Promise.resolve(mockFinalizeContactResult);
  return Promise.resolve(mockRpcResult);
});

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

  it('v2 missing -> 503, sendTemplate NOT called, no issue_promo_pickup RPC', async () => {
    const sendFn = vi.fn();
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callSend();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('template_not_ready');
    expect(json.detail).toContain('missing');
    expect(sendFn).not.toHaveBeenCalled();
    // No issue_promo_pickup RPC should have been called
    const issueCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'issue_promo_pickup');
    expect(issueCalls.length).toBe(0);
  });

  it('v2 PENDING -> 503, sendTemplate NOT called, no issue_promo_pickup RPC', async () => {
    const sendFn = vi.fn();
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'PENDING' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callSend();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('template_not_ready');
    expect(json.detail).toContain('PENDING');
    expect(sendFn).not.toHaveBeenCalled();
    const issueCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'issue_promo_pickup');
    expect(issueCalls.length).toBe(0);
  });

  it('v2 REJECTED -> 503, sendTemplate NOT called, no issue_promo_pickup RPC', async () => {
    const sendFn = vi.fn();
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'REJECTED' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callSend();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('template_not_ready');
    expect(json.detail).toContain('REJECTED');
    expect(sendFn).not.toHaveBeenCalled();
    const issueCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'issue_promo_pickup');
    expect(issueCalls.length).toBe(0);
  });

  it('no cloud -> 503 (template management unavailable)', async () => {
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: vi.fn() },
      cloud: null,
    };
    const res = await callSend();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('Template management not available on this channel');
  });

  it('missing messageId -> leave pending (ambiguous), error response', async () => {
    // sendTemplate resolves but no messageId — ambiguous, leave pending
    const sendFn = vi.fn().mockResolvedValue({ messageId: undefined });
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callSend();
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toContain('no provider message ID');
    // finalize should NOT have been called — verification stays pending
    const finalizeCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'finalize_promo_pickup_delivery');
    expect(finalizeCalls.length).toBe(0);
  });

  it('OTP ambiguous network error leaves verification pending', async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callSend();
    expect(res.status).toBe(502);
    // finalize should NOT be called — verification stays pending
    const finalizeCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'finalize_promo_pickup_delivery');
    expect(finalizeCalls.length).toBe(0);
  });

  it('OTP definite 4xx rejection finalizes as failed', async () => {
    const sendFn = vi.fn().mockRejectedValue(new MetaApiError('Cloud API error: 400', 400));
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callSend();
    expect(res.status).toBe(503);
    const finalizeCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'finalize_promo_pickup_delivery');
    expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);
    expect(finalizeCalls[finalizeCalls.length - 1][1].p_status).toBe('failed');
  });

  it('OTP noRetry: exactly one provider POST', async () => {
    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.test' });
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    await callSend();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith(expect.objectContaining({ noRetry: true }));
  });

  it('readiness and send use the SAME resolved channel', async () => {
    // The resolved channel's cloud.getTemplates and sender.sendTemplate must be from the same resolution
    const getTemplatesFn = vi.fn().mockResolvedValue({ data: [
      { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
    ] });
    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.same-channel' });
    mockResolvedChannel = {
      channel: { id: 'ch-same', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: getTemplatesFn },
    };
    const res = await callSend();
    expect(res.status).toBe(200);
    // Both getTemplates and sendTemplate were called on the same resolved channel object
    expect(getTemplatesFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledTimes(1);
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

  it('rate limited -> 429 (claim RPC returns cooldown)', async () => {
    // Simulate cooldown via claim RPC
    mockClaimContactResult = { data: { success: false, reason: 'cooldown', minutes: 10 }, error: null };
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

  it('missing messageId -> claim stays pending (cooldown-eligible), no finalize, error response', async () => {
    // sendTemplate resolves but returns no messageId — ambiguous outcome
    const sendFn = vi.fn().mockResolvedValue({ messageId: undefined });
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callContact();
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toContain('no provider message ID');
    expect(json.sent).toBeUndefined();
    // finalize should NOT have been called — claim stays pending
    const finalizeCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'finalize_winner_contact_send');
    expect(finalizeCalls.length).toBe(0);
  });

  it('missing-WAMID claim prevents immediate retry (cooldown protection)', async () => {
    // After a missing-WAMID attempt, the pending claim row prevents another send
    // First attempt: missing WAMID (claim stays pending)
    const sendFn = vi.fn().mockResolvedValue({ messageId: undefined });
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    const res1 = await callContact();
    expect(res1.status).toBe(502);

    // Second attempt: claim RPC returns cooldown because pending row exists
    mockClaimContactResult = { data: { success: false, reason: 'cooldown', minutes: 10 }, error: null };
    const res2 = await callContact();
    expect(res2.status).toBe(429);
    // sendTemplate should NOT have been called on the second attempt
    expect(sendFn).toHaveBeenCalledTimes(1); // only the first attempt
  });

  it('definite 4xx rejection finalizes as failed', async () => {
    // sendTemplate throws MetaApiError with 4xx — definite rejection → finalize failed
    const sendFn = vi.fn().mockRejectedValue(new MetaApiError('Cloud API error: 400', 400));
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callContact();
    expect(res.status).toBe(503);
    // finalize SHOULD have been called with 'failed' for definite 4xx
    const finalizeCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'finalize_winner_contact_send');
    expect(finalizeCalls.length).toBeGreaterThanOrEqual(1);
    const lastFinalize = finalizeCalls[finalizeCalls.length - 1];
    expect(lastFinalize[1].p_status).toBe('failed');
  });

  it('ambiguous network/timeout error leaves claim pending (cooldown-protected)', async () => {
    // sendTemplate throws generic Error (not MetaApiError 4xx) — ambiguous outcome
    const sendFn = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    mockServiceRpc.mockClear();
    const res = await callContact();
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toContain('uncertain');
    expect(json.sent).toBeUndefined();
    // finalize should NOT have been called — claim stays pending
    const finalizeCalls = mockServiceRpc.mock.calls.filter((c: unknown[]) => c[0] === 'finalize_winner_contact_send');
    expect(finalizeCalls.length).toBe(0);
  });

  it('ambiguous Contact Winner error blocks immediate retry', async () => {
    // First attempt: ambiguous error → claim stays pending
    const sendFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    const res1 = await callContact();
    expect(res1.status).toBe(502);

    // Second attempt: claim RPC returns cooldown because pending row exists
    mockClaimContactResult = { data: { success: false, reason: 'cooldown', minutes: 10 }, error: null };
    const res2 = await callContact();
    expect(res2.status).toBe(429);
    // sendTemplate should only have been called once (first attempt)
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('noRetry: exactly one provider POST for Contact Winner', async () => {
    // Verify sendTemplate is called with noRetry: true
    const sendFn = vi.fn().mockResolvedValue({ messageId: 'wamid.test' });
    mockResolvedChannel = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: sendFn },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    await callContact();
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn).toHaveBeenCalledWith(expect.objectContaining({ noRetry: true }));
  });

  it('finalize RPC error -> no {sent:true}', async () => {
    mockFinalizeContactResult = { data: null, error: { message: 'DB down' } };
    const res = await callContact();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.sent).toBeUndefined();
    expect(json.error).toContain('tracking failed');
  });

  it('finalize success:false -> no {sent:true}', async () => {
    mockFinalizeContactResult = { data: { success: false, reason: 'already_finalized' }, error: null };
    const res = await callContact();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.sent).toBeUndefined();
    expect(json.error).toContain('tracking failed');
  });
});
