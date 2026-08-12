/**
 * P1-QUEUE-2: Executable route-level tests for /api/queue/toggle-pause
 *
 * Proves:
 * 1. Paused business → Resume → subscribers notified via sendText
 * 2. Successful send + successful bookkeeping → notifiedCount incremented
 * 3. Successful send + failed bookkeeping → notifiedCount NOT incremented
 * 4. Failed send → subscription stays waiting, later subscribers still attempted
 * 5. Pausing an open queue → ZERO reopen notifications
 * 6. No resolved WhatsApp channel → ZERO notifications, ZERO rows notified
 * 7. Zero waiting subscriptions → resume succeeds with notifiedCount=0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mutable refs for per-test configuration ──
const state = {
  bizData: null as { metadata: Record<string, unknown>; name: string } | null,
  subData: [] as Array<{ id: string; customer_phone: string }>,
  resolvedSender: null as { sender: { sendText: ReturnType<typeof vi.fn> } } | null,
  subUpdateResults: {} as Record<string, { data: unknown; error: unknown }>,
  sendText: vi.fn(),
  loggerWarn: vi.fn(),
  withContext: vi.fn(),
  withContextError: vi.fn(),
};

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => state.loggerWarn(...a),
    error: vi.fn(),
    withContext: (...a: unknown[]) => {
      state.withContext(...a);
      return { error: (...e: unknown[]) => state.withContextError(...e), info: vi.fn(), warn: vi.fn() };
    },
  },
}));

vi.mock('@/lib/api-auth', () => ({
  authenticateRequest: vi.fn().mockResolvedValue({ user: { id: 'owner-001' } }),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test'),
}));

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class MockChannelResolver {
    resolveByBusinessId() { return Promise.resolve(state.resolvedSender); }
  },
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({ eq: () => ({
            single: () => Promise.resolve({
              data: state.bizData,
              error: state.bizData ? null : { message: 'not found' },
            }),
          }) }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      if (table === 'queue_reopen_subscriptions') {
        return {
          select: () => ({ eq: () => ({
            eq: () => Promise.resolve({ data: state.subData, error: null }),
          }) }),
          update: () => ({
            eq: (_col: string, subId: string) => ({
              eq: () => ({
                select: () => Promise.resolve(
                  state.subUpdateResults[subId] || { data: [{ id: subId }], error: null }
                ),
              }),
            }),
          }),
        };
      }
      return {};
    },
  }),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/queue/toggle-pause', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/queue/toggle-pause — executable route tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.bizData = null;
    state.subData = [];
    state.resolvedSender = null;
    state.subUpdateResults = {};
    state.sendText = vi.fn();
  });

  it('1. resume paused queue → subscribers notified via sendText', async () => {
    state.bizData = { metadata: { queue_paused: true }, name: 'Test Biz' };
    state.subData = [{ id: 'sub-1', customer_phone: '+2348011111111' }];
    state.sendText.mockResolvedValue(undefined);
    state.resolvedSender = { sender: { sendText: state.sendText } };

    const { POST } = await import('@/app/api/queue/toggle-pause/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.paused).toBe(false);
    expect(state.sendText).toHaveBeenCalledTimes(1);
    expect(state.sendText).toHaveBeenCalledWith(expect.objectContaining({
      to: '2348011111111',
      text: expect.stringContaining('queue at *Test Biz* is now open'),
    }));
  });

  it('2. successful send + successful bookkeeping → notifiedCount incremented', async () => {
    state.bizData = { metadata: { queue_paused: true }, name: 'Test Biz' };
    state.subData = [
      { id: 'sub-1', customer_phone: '+2348011111111' },
      { id: 'sub-2', customer_phone: '+2348022222222' },
    ];
    state.sendText.mockResolvedValue(undefined);
    state.resolvedSender = { sender: { sendText: state.sendText } };

    const { POST } = await import('@/app/api/queue/toggle-pause/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.notifiedCount).toBe(2);
    expect(state.sendText).toHaveBeenCalledTimes(2);
  });

  it('3. successful send + failed bookkeeping → notifiedCount NOT incremented', async () => {
    state.bizData = { metadata: { queue_paused: true }, name: 'Test Biz' };
    state.subData = [{ id: 'sub-fail', customer_phone: '+2348033333333' }];
    state.sendText.mockResolvedValue(undefined);
    state.resolvedSender = { sender: { sendText: state.sendText } };
    state.subUpdateResults = { 'sub-fail': { data: null, error: { message: 'db error' } } };

    const { POST } = await import('@/app/api/queue/toggle-pause/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    const json = await res.json();

    expect(state.sendText).toHaveBeenCalledTimes(1);
    expect(json.notifiedCount).toBe(0);
    expect(state.withContext).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'queue.reopen-mark-notified', subId: 'sub-fail' })
    );
  });

  it('4. failed send → subscription stays waiting, later subscribers still attempted', async () => {
    state.bizData = { metadata: { queue_paused: true }, name: 'Test Biz' };
    state.subData = [
      { id: 'sub-1', customer_phone: '+2348011111111' },
      { id: 'sub-2', customer_phone: '+2348022222222' },
    ];
    state.sendText
      .mockRejectedValueOnce(new Error('WhatsApp API error'))
      .mockResolvedValueOnce(undefined);
    state.resolvedSender = { sender: { sendText: state.sendText } };

    const { POST } = await import('@/app/api/queue/toggle-pause/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    const json = await res.json();

    expect(state.sendText).toHaveBeenCalledTimes(2);
    expect(json.notifiedCount).toBe(1);
  });

  it('5. pausing an open queue → ZERO reopen notifications', async () => {
    state.bizData = { metadata: { queue_paused: false }, name: 'Test Biz' };
    state.resolvedSender = { sender: { sendText: state.sendText } };

    const { POST } = await import('@/app/api/queue/toggle-pause/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.paused).toBe(true);
    expect(json.notifiedCount).toBe(0);
    expect(state.sendText).not.toHaveBeenCalled();
  });

  it('6. no resolved WhatsApp channel → ZERO notifications, ZERO notified', async () => {
    state.bizData = { metadata: { queue_paused: true }, name: 'Test Biz' };
    state.subData = [{ id: 'sub-1', customer_phone: '+2348011111111' }];
    state.resolvedSender = null;

    const { POST } = await import('@/app/api/queue/toggle-pause/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.notifiedCount).toBe(0);
    expect(state.sendText).not.toHaveBeenCalled();
    expect(state.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('No WhatsApp channel resolved')
    );
  });

  it('7. zero waiting subscriptions → resume succeeds with notifiedCount=0', async () => {
    state.bizData = { metadata: { queue_paused: true }, name: 'Test Biz' };
    state.subData = [];
    state.resolvedSender = { sender: { sendText: state.sendText } };

    const { POST } = await import('@/app/api/queue/toggle-pause/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.paused).toBe(false);
    expect(json.notifiedCount).toBe(0);
    expect(state.sendText).not.toHaveBeenCalled();
  });

  it('8. send succeeds but UPDATE matches zero rows → notifiedCount NOT incremented', async () => {
    state.bizData = { metadata: { queue_paused: true }, name: 'Test Biz' };
    state.subData = [{ id: 'sub-ghost', customer_phone: '+2348099999999' }];
    state.sendText.mockResolvedValue(undefined);
    state.resolvedSender = { sender: { sendText: state.sendText } };
    // UPDATE returns no error but zero rows matched (subscription already notified or deleted)
    state.subUpdateResults = { 'sub-ghost': { data: [], error: null } };

    const { POST } = await import('@/app/api/queue/toggle-pause/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    const json = await res.json();

    // sendText was called (message sent)
    expect(state.sendText).toHaveBeenCalledTimes(1);
    // But bookkeeping didn't transition a row → not counted
    expect(json.notifiedCount).toBe(0);
    // Zero-row case logged
    expect(state.withContext).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'queue.reopen-mark-notified', subId: 'sub-ghost', rowsUpdated: 0 })
    );
  });
});
