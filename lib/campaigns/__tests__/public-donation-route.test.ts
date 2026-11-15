import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const state = vi.hoisted(() => ({ campaign: null as any, readError: false, allowed: true, limited: false,
  tier: true, currency: 'USD', initialize: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: () => {
  const filters: Array<[string, unknown]> = [];
  const chain: any = { select: () => chain, eq: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
    is: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
    maybeSingle: async () => ({ error: state.readError ? { message: 'unavailable' } : null,
      data: state.campaign && filters.every(([key, value]) => state.campaign[key] === value) ? state.campaign : null }) };
  return chain;
} }) }));
vi.mock('@/lib/bot/flows/shared/capability-guard', () => ({ requireCurrentCapability: async () => ({ allowed: state.allowed }) }));
vi.mock('@/lib/payments/gateway-resolver', () => ({ resolveBusinessGateway: async () => ({ gateway: 'stripe', currency: state.currency }) }));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: async () => ({ allowed: state.tier }) }));
vi.mock('@/lib/rate-limit', () => ({ getRateLimitKey: () => 'ip', rateLimitResponseAsync: async () => state.limited ? NextResponse.json({}, { status: 429 }) : null }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: state.initialize }));
import { POST } from '@/app/api/campaigns/[id]/donate/route';
import { parseDonationInput } from '@/lib/campaigns/public-donation';
const ID = '11111111-1111-4111-8111-111111111111';
const input = { attemptId: '22222222-2222-4222-8222-222222222222', amount: 25, phone: '+1 (202) 555-0123', name: 'A Donor', email: '' };
const request = (body: unknown = input) => new NextRequest(`https://www.waaiio.com/api/campaigns/${ID}/donate`, {
  method: 'POST', headers: { origin: 'https://www.waaiio.com', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const run = (body: unknown = input) => POST(request(body), { params: Promise.resolve({ id: ID }) });
beforeEach(() => {
  vi.clearAllMocks(); state.allowed = true; state.limited = false; state.tier = true; state.currency = 'USD'; state.readError = false;
  state.campaign = { id: ID, business_id: 'merchant', status: 'active', deleted_at: null, title: 'Fundraiser',
    currency: 'USD', goal_amount: 100, raised_amount: 0, min_donation: 5, max_donation: 50,
    start_date: null, end_date: null, allow_after_end_date: true, allow_after_goal_met: true,
    businesses: { name: 'Merchant', status: 'active', country_code: 'US', subscription_tier: 'growth' } };
  state.initialize.mockResolvedValue({ url: 'https://checkout.test/session', reference: 'provider' });
});
describe('anonymous campaign donation route', () => {
  it('uses server campaign, merchant, currency authority and canonical donor identity', async () => {
    expect((await run({ ...input, businessId: 'attacker', currency: 'NGN', userId: 'attacker' })).status).toBe(200);
    expect(state.initialize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      businessId: 'merchant', campaignId: ID, userId: null, countryCode: 'US', phone: '+12025550123',
      transactionCategory: 'giving', confirmationOrigin: 'web', amount: 25, campaignAttemptKey: input.attemptId,
    }));
  });
  it.each([0, -1, 4, 51, 10_000_001, 5.001, '25', null])('rejects invalid or out-of-bounds amount %s before provider', async amount => {
    expect((await run({ ...input, amount })).status).toBe(400); expect(state.initialize).not.toHaveBeenCalled();
  });
  it.each([{ phone: '' }, { phone: '123' }, { email: 'broken' }, { attemptId: 'bad' }, { name: 'x'.repeat(121) }])('rejects malformed donor input %s', async patch => {
    expect((await run({ ...input, ...patch })).status).toBe(400); expect(state.initialize).not.toHaveBeenCalled();
  });
  it.each([{ status: 'draft' }, { deleted_at: '2026-01-01' }, { start_date: '2999-01-01' },
    { end_date: '2000-01-01', allow_after_end_date: false }, { raised_amount: 100, allow_after_goal_met: false }])('denies unavailable campaign %s', async patch => {
    Object.assign(state.campaign, patch); expect((await run()).status).toBe(404); expect(state.initialize).not.toHaveBeenCalled();
  });
  it('honors explicit allow-after-goal and end settings', async () => {
    Object.assign(state.campaign, { raised_amount: 100, end_date: '2000-01-01' });
    expect((await run()).status).toBe(200);
  });
  it('denies inactive merchant, disabled capability, currency mismatch and tier exhaustion', async () => {
    state.campaign.businesses.status = 'suspended'; expect((await run()).status).toBe(404);
    state.campaign.businesses.status = 'active'; state.allowed = false; expect((await run()).status).toBe(404);
    state.allowed = true; state.currency = 'NGN'; expect((await run()).status).toBe(404);
    state.currency = 'USD'; state.tier = false; expect((await run()).status).toBe(409);
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it('returns rate limit and database errors without provider dispatch', async () => {
    state.limited = true; expect((await run()).status).toBe(429);
    state.limited = false; state.readError = true; expect((await run()).status).toBe(503);
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it('retains attempt identity on retry after ambiguous initialization', async () => {
    state.initialize.mockResolvedValue(null); expect((await run()).status).toBe(409); await run();
    expect(state.initialize.mock.calls[0][1].campaignAttemptKey).toBe(state.initialize.mock.calls[1][1].campaignAttemptKey);
  });
  it('rejects nonfinite input and canonicalizes phone', () => {
    expect(parseDonationInput({ ...input, amount: Infinity }).error).toBe('Enter a valid donation amount.');
    expect(parseDonationInput(input).value?.phone).toBe('+12025550123');
  });
});
