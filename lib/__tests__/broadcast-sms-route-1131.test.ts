/**
 * #1131: POST /api/broadcasts/send with channel 'sms' and the estimate route.
 * The campaign module is stubbed here; its charging and skip rules are
 * proved in sms-channel-1131.test.ts and the database rules in
 * sms-billing-551-db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), capability: vi.fn(), estimate: vi.fn(), send: vi.fn(), resolve: vi.fn(),
  country: 'NG' as string | null,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }) } }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: m.capability }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByBusinessId = m.resolve; } }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ broadcast_limits: { growth: { maxBroadcasts: 100, maxRecipients: 1000 } } }) }));
vi.mock('@/lib/trial-status', () => ({ resolveLimitTier: async () => 'growth' }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/sms/campaign', () => ({ estimateSmsCampaign: m.estimate, sendSmsCampaign: m.send }));
import { POST as send } from '@/app/api/broadcasts/send/route';
import { POST as estimate } from '@/app/api/broadcasts/sms-estimate/route';

const REQUEST_ID = '6f1c2a0e-1d2b-4c3d-9e4f-5a6b7c8d9e0f';
const ESTIMATE = {
  available: true, problem: null, pages: 1, unicode: false, characters: 20, perPage: 160, tooLong: false,
  currency: 'NGN', pricePerPageMinor: 838, recipients: 2, notSmsNumbers: 0, totalMinor: 1676, quietHoursNow: false,
};
const req = (body: unknown) => new NextRequest('https://example.test/api', { method: 'POST', body: JSON.stringify(body) });
const body = { business_id: 'biz', channel: 'sms', request_id: REQUEST_ID, message: 'Sale today', phones: ['08031234567', '08039999999'] };

beforeEach(() => {
  vi.clearAllMocks();
  m.country = 'NG';
  m.capability.mockResolvedValue({ allowed: true });
  m.estimate.mockResolvedValue(ESTIMATE);
  m.send.mockResolvedValue({ sent: 2, chargedMinor: 1676, currency: 'NGN', failed: 0, unknown: 0, alreadySent: 0, skipped: {} });
  m.rpc.mockResolvedValue({ error: null });
  m.from.mockImplementation((table: string) => {
    const data = table === 'businesses' ? { id: 'biz', owner_id: 'owner', name: 'Shop', country_code: m.country, subscription_tier: 'growth' } : null;
    const result = { data, error: null };
    const chain: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order', 'limit']) chain[k] = () => chain;
    chain.single = chain.maybeSingle = async () => result;
    return chain;
  });
});

describe('POST /api/broadcasts/send — SMS campaigns (#1131)', () => {
  it('sends through the charged SMS campaign with the request id and never uses WhatsApp', async () => {
    const res = await send(req(body));
    expect(res.status).toBe(200);
    expect(m.send).toHaveBeenCalledWith(expect.anything(), {
      businessId: 'biz', businessCountry: 'NG', requestId: REQUEST_ID, phones: body.phones, message: 'Sale today',
    });
    expect(m.resolve).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ channel: 'sms', sent: 2, chargedMinor: 1676, currency: 'NGN', pages: 1, price_per_page_minor: 838 });
    expect(m.rpc).toHaveBeenCalledWith('increment_broadcast_usage', { p_business_id: 'biz', p_recipient_count: 2 });
  });

  it('needs a request id, so a retry can never text anyone twice', async () => {
    const res = await send(req({ ...body, request_id: undefined }));
    expect(res.status).toBe(400);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('refuses during quiet hours, for unsupported countries, when unpriced or switched off, and when too long', async () => {
    for (const [patch, status, text] of [
      [{ quietHoursNow: true }, 422, 'between 8pm and 8am'],
      [{ available: false, problem: 'country_not_supported' }, 400, 'Nigeria and Ghana only'],
      [{ available: false, problem: 'not_priced' }, 400, 'pricing is not set up'],
      [{ available: false, problem: 'not_configured' }, 400, 'not switched on'],
      [{ tooLong: true }, 400, 'too long'],
    ] as const) {
      m.estimate.mockResolvedValueOnce({ ...ESTIMATE, ...patch });
      const res = await send(req(body));
      expect(res.status).toBe(status);
      expect((await res.json()).message).toContain(text);
    }
    expect(m.send).not.toHaveBeenCalled();
  });

  it('the estimate route shows the cost before sending and sends nothing', async () => {
    const res = await estimate(req({ business_id: 'biz', message: 'Sale today', phones: body.phones }));
    expect(res.status).toBe(200);
    expect((await res.json()).estimate).toEqual(ESTIMATE);
    expect(m.estimate).toHaveBeenCalledWith(expect.anything(), { businessCountry: 'NG', phones: body.phones, message: 'Sale today' });
    expect(m.send).not.toHaveBeenCalled();
  });

  it('the estimate route enforces the broadcast capability', async () => {
    m.capability.mockResolvedValue({ allowed: false, status: 403, denial: { message: 'No' } });
    const res = await estimate(req({ business_id: 'biz', message: 'x', phones: [] }));
    expect(res.status).toBe(403);
    expect(m.estimate).not.toHaveBeenCalled();
  });
});
