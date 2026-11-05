import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h = vi.hoisted(() => ({
  user: true, owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', readError: false,
  rpc: vi.fn(), from: vi.fn(), resolve: vi.fn(), send: vi.fn(),
  recipients: [] as Array<{ id: string; state: string; claim_token?: string }>,
  event: {} as Record<string, unknown>, operation: null as Record<string, any> | null,
  finalizeError: false, markDenied: false,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: h.user ? { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : null }, error: null }) },
  from: h.from,
}) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: h.from, rpc: h.rpc }) }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByBusinessId = h.resolve; } }));
import { GET, POST } from '@/app/api/events/cancel/route';
import { dispatchEventCancellation } from '@/lib/events/event-cancellation-notifications';
import { MetaApiError } from '@/lib/channels/meta-api-error';

const EVENT = '11111111-1111-4111-8111-111111111111';
const BUSINESS = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const REV = '2026-10-30T00:00:00.000Z';
function request(body: unknown = { event_id: EVENT }, query = '') {
  return new NextRequest('https://example.test/api/events/cancel' + query, {
    method: query ? 'GET' : 'POST',
    ...(query ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
}
const service = { from: h.from, rpc: h.rpc };
beforeEach(() => {
  h.user = true; h.owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; h.readError = false;
  h.finalizeError = h.markDenied = false; h.recipients = []; h.operation = null;
  h.event = { id: EVENT, business_id: BUSINESS, name: 'Event', date: '2026-11-12', time: '18:30', venue: 'Hall', price: 100, status: 'published', updated_at: REV };
  h.send.mockReset().mockResolvedValue({ messageId: 'provider-message' });
  h.resolve.mockReset().mockResolvedValue({ sender: { sendText: h.send } });
  h.rpc.mockReset().mockImplementation(async (name: string, args: Record<string, any>) => {
    if (name === 'mutate_event') {
      h.event = { ...h.event, ...args.p_changes };
      h.operation = { success: true, event: { ...h.event }, operation_id: args.p_operation_id, cancelled: true, counts: { cancelled_tickets: 2, recipients: 0, refunds_pending: 1 } };
      return { data: h.operation, error: null };
    }
    const row = h.recipients.find(r => r.id === args.p_recipient_id);
    if (name === 'claim_event_cancellation_notification') {
      if (!row || row.state !== 'pending') return { data: { claimed: false }, error: null };
      row.state = 'claimed'; row.claim_token = 'token-' + row.id;
      return { data: { claimed: true, claim_token: row.claim_token, recipient_phone: '+15550000001', operation_id: OP }, error: null };
    }
    if (name === 'mark_event_cancellation_notification_attempted') {
      if (h.markDenied || !row || row.claim_token !== args.p_claim_token) return { data: { marked: false }, error: null };
      row.state = 'attempted'; return { data: { marked: true }, error: null };
    }
    if (name === 'finalize_event_cancellation_notification') {
      if (h.finalizeError) return { data: null, error: new Error('persist failed') };
      if (row) row.state = args.p_state;
      return { data: { finalized: true }, error: null };
    }
    throw new Error('Unexpected RPC ' + name);
  });
  h.from.mockReset().mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain: any = {
      select: vi.fn(() => chain), eq: vi.fn((key, value) => { filters[key] = value; return chain; }),
      or: vi.fn(() => chain), order: vi.fn(() => chain),
      limit: vi.fn(async () => ({ data: h.recipients.filter(r => r.state === 'pending').map(r => ({ id: r.id })), error: null })),
      range: vi.fn(async () => ({ data: h.recipients.map(r => ({ state: r.state })), error: null })),
      maybeSingle: vi.fn(async () => {
        if (h.readError) return { data: null, error: new Error('db read failed') };
        if (table === 'events') return { data: { ...h.event, businesses: { owner_id: h.owner } }, error: null };
        if (table === 'event_mutation_operations') {
          if (!h.operation || (filters.id && filters.id !== h.operation.operation_id)) return { data: null, error: null };
          return { data: { id: h.operation.operation_id, response_payload: h.operation }, error: null };
        }
        return { data: null, error: null };
      }),
    };
    return chain;
  });
});
function mutations() { return h.rpc.mock.calls.filter(([name]) => name === 'mutate_event'); }
describe('merchant cancellation actual route', () => {
  it('owner cancellation uses the common transaction with server-derived tenant and actor', async () => {
    const response = await POST(request({ event_id: EVENT, operation_id: OP, expected_updated_at: REV, changes: { status: 'cancelled' } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ committed: true, cancelled: true, cancelled_tickets: 2, refunds_pending: 1 });
    expect(mutations()[0][1]).toMatchObject({ p_actor_kind: 'merchant', p_actor_id: h.owner, p_business_id: BUSINESS, p_changes: { status: 'cancelled' } });
    expect(h.rpc.mock.calls.some(([name]) => /refund/i.test(name))).toBe(false);
  });
  it('keeps legacy event_id-only callers and creates a replay identity', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mutations()[0][1].p_operation_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.each([
    ['unauthenticated', () => { h.user = false; }, 401],
    ['other owner', () => { h.owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; }, 403],
    ['read error', () => { h.readError = true; }, 503],
  ] as const)('denies %s without privileged mutations or sends', async (_name, setup, status) => {
    setup(); expect((await POST(request())).status).toBe(status);
    expect(mutations()).toHaveLength(0); expect(h.send).not.toHaveBeenCalled();
  });
  it('rejects tenant reassignment and non-cancel status', async () => {
    expect((await POST(request({ event_id: EVENT, business_id: '44444444-4444-4444-8444-444444444444' }))).status).toBe(403);
    expect((await POST(request({ event_id: EVENT, changes: { status: 'published' } }))).status).toBe(400);
    expect(mutations()).toHaveLength(0);
  });
  it('reads lost-response outcome without executing cancellation again', async () => {
    await POST(request({ event_id: EVENT, operation_id: OP }));
    const response = await GET(request(undefined, '?event_id=' + EVENT + '&operation_id=' + OP));
    expect(response.status).toBe(200);
    expect((await response.json()).committed).toBe(true);
    expect(mutations()).toHaveLength(1);
  });
  it('does not reconstruct or send legacy cancelled history', async () => {
    h.event.status = 'cancelled';
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'legacy_cancellation_unverified' });
    expect(mutations()).toHaveLength(0); expect(h.send).not.toHaveBeenCalled();
  });
});
describe('durable cancellation notification adapter', () => {
  const run = () => dispatchEventCancellation(service as never, OP, h.event as never);
  it('records provider acceptance separately and never requests sender retries', async () => {
    h.recipients = [{ id: 'r1', state: 'pending' }];
    expect(await run()).toMatchObject({ accepted: 1, pending: 0, total: 1 });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ noRetry: true, messageCategory: 'service' }));
    expect(h.rpc.mock.calls.map(([name]) => name)).toEqual([
      'claim_event_cancellation_notification', 'mark_event_cancellation_notification_attempted', 'finalize_event_cancellation_notification',
    ]);
    await run(); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('concurrent requests only send for the successful recipient claimant', async () => {
    h.recipients = [{ id: 'r1', state: 'pending' }];
    await Promise.all([run(), run()]);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('missing channel leaves work pending and unattempted', async () => {
    h.recipients = [{ id: 'r1', state: 'pending' }]; h.resolve.mockResolvedValue(null);
    expect(await run()).toMatchObject({ pending: 1, accepted: 0 });
    expect(h.rpc).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it('failed attempted marker never emits', async () => {
    h.recipients = [{ id: 'r1', state: 'pending' }]; h.markDenied = true;
    await run(); expect(h.send).not.toHaveBeenCalled();
  });
  it('transport ambiguity is durable and not automatically retried', async () => {
    h.recipients = [{ id: 'r1', state: 'pending' }]; h.send.mockRejectedValue(new Error('timeout'));
    expect(await run()).toMatchObject({ ambiguous: 1, accepted: 0 });
    await run(); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('explicit provider rejection is failed, never accepted', async () => {
    h.recipients = [{ id: 'r1', state: 'pending' }]; h.send.mockRejectedValue(new MetaApiError('rejected', 400));
    expect(await run()).toMatchObject({ failed: 1, accepted: 0 });
  });
  it('acceptance-persistence failure only retries DB and preserves uncertain outcome', async () => {
    h.recipients = [{ id: 'r1', state: 'pending' }]; h.finalizeError = true;
    expect(await run()).toMatchObject({ ambiguous: 1, accepted: 0 });
    expect(h.rpc.mock.calls.filter(([name]) => name === 'finalize_event_cancellation_notification')).toHaveLength(2);
    await run(); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('provider response without a message ID is not reported delivered or accepted', async () => {
    h.recipients = [{ id: 'r1', state: 'pending' }]; h.send.mockResolvedValue({ success: true });
    expect(await run()).toMatchObject({ ambiguous: 1, accepted: 0 });
  });
});
