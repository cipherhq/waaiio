/** Actual chat POST and tier/accounting helpers; auth, database and model are mocked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  user: { id: 'owner-1' } as { id: string } | null,
  count: 0,
  events: [] as string[],
  lookups: [] as Record<string, unknown>[],
  model: vi.fn(),
  serviceRpc: vi.fn(),
  sessionRpc: vi.fn(),
  serviceFactory: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: h.user } }) },
  rpc: h.sessionRpc,
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      single: async () => {
        h.lookups.push({ ...filters });
        const owned = filters.id === 'business-1' && filters.owner_id === 'owner-1';
        return { data: owned ? { id: 'business-1', name: 'Fixture Salon', category: 'salon', country_code: 'NG', subscription_tier: 'free' } : null };
      },
      maybeSingle: async () => {
        expect(table).toBe('ai_usage');
        expect(filters.business_id).toBe('business-1');
        return { data: { ace_setup_count: h.count } };
      },
    };
    return chain;
  },
}) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => h.serviceFactory() }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: (...args: unknown[]) => h.rateLimit(...args) }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: (...args: unknown[]) => h.model(...args) }; } }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { POST } from '../chat/route';

function request(businessId = 'business-1', message = 'Set up haircuts') {
  return new NextRequest('http://localhost/api/ai-setup/chat', {
    method: 'POST', body: JSON.stringify({ business_id: businessId, message }),
  });
}

beforeEach(() => {
  h.user = { id: 'owner-1' };
  h.count = 0;
  h.events = [];
  h.lookups = [];
  h.rateLimit.mockReset().mockResolvedValue(null);
  h.sessionRpc.mockReset().mockResolvedValue({ error: { message: 'permission denied' } });
  h.serviceRpc.mockReset().mockImplementation(async () => {
    h.events.push('count'); h.count += 1;
    return { error: null };
  });
  h.serviceFactory.mockReset().mockReturnValue({ rpc: h.serviceRpc });
  h.model.mockReset().mockImplementation(async () => {
    h.events.push('model');
    return { content: [{ type: 'text', text: 'Which haircuts do you offer?' }] };
  });
});

describe('ACE chat usage accounting', () => {
  it('records one successful response through service authority after the model returns', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toBe('Which haircuts do you offer?');
    expect(h.lookups).toEqual([{ id: 'business-1', owner_id: 'owner-1' }]);
    expect(h.events).toEqual(['model', 'count']);
    expect(h.serviceRpc).toHaveBeenCalledExactlyOnceWith('increment_ai_usage', {
      p_business_id: 'business-1', p_month_key: new Date().toISOString().slice(0, 7), p_field: 'ace_setup_count',
    });
    expect(h.sessionRpc).not.toHaveBeenCalled();
  });

  it('the recorded usage makes the next request respect the existing allowance', async () => {
    h.count = 2;
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(403);
    expect(h.model).toHaveBeenCalledTimes(1);
    expect(h.serviceRpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unauthenticated', 401], ['other business', 404], ['allowance exhausted', 403], ['invalid message', 400], ['rate limited', 429],
  ])('does not call the model or service accounting when %s', async (scenario, status) => {
    if (scenario === 'unauthenticated') h.user = null;
    if (scenario === 'allowance exhausted') h.count = 3;
    if (scenario === 'rate limited') h.rateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const res = await POST(request(scenario === 'other business' ? 'business-2' : 'business-1', scenario === 'invalid message' ? '' : 'Hello'));
    expect(res.status).toBe(status);
    expect(h.model).not.toHaveBeenCalled();
    expect(h.serviceFactory).not.toHaveBeenCalled();
    expect(h.serviceRpc).not.toHaveBeenCalled();
    expect(h.sessionRpc).not.toHaveBeenCalled();
  });

  it('retains no usage charge when the model call fails', async () => {
    h.model.mockRejectedValue(new Error('model unavailable'));
    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(h.serviceFactory).not.toHaveBeenCalled();
    expect(h.serviceRpc).not.toHaveBeenCalled();
  });

  it.each(['returned error', 'thrown error'])('withholds the model result when accounting fails with a %s', async (failure) => {
    if (failure === 'returned error') h.serviceRpc.mockResolvedValue({ error: { message: 'database unavailable' } });
    else h.serviceRpc.mockRejectedValue(new Error('database unavailable'));
    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'AI service unavailable' });
    expect(h.model).toHaveBeenCalledTimes(1);
    expect(h.serviceRpc).toHaveBeenCalledTimes(1);
    expect(h.sessionRpc).not.toHaveBeenCalled();
  });
});
