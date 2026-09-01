/**
 * Issue #247 — Dispatch Boundary Behavioral Tests
 *
 * Proves actual provider-call counts and dispatch-barrier correctness.
 * These tests verify the notification dispatch path enforces:
 *   - At most ONE provider API call per logical revision
 *   - No automatic retry after dispatch barrier
 *   - No template-to-text fallback on ambiguous outcome
 *   - Deterministic preflight failures produce ZERO provider calls
 *   - Concurrent workers cannot issue duplicate external calls
 *   - New tracking revisions independently create notification intents
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks (must be declared before vi.mock to survive hoisting) ──
const {
  mockSendTemplate,
  mockSendText,
  mockGetUser,
  mockServiceRpc,
  mockServiceFrom,
  mockResolveByBusinessId,
  MockChannelResolverImpl,
  mockRequireCapability,
  mockRateLimitResponseAsync,
  mockGetRateLimitKey,
} = vi.hoisted(() => ({
  mockSendTemplate: vi.fn(),
  mockSendText: vi.fn(),
  mockGetUser: vi.fn(),
  mockServiceRpc: vi.fn(),
  mockServiceFrom: vi.fn(),
  mockResolveByBusinessId: vi.fn(),
  MockChannelResolverImpl: vi.fn(),
  mockRequireCapability: vi.fn(),
  mockRateLimitResponseAsync: vi.fn(),
  mockGetRateLimitKey: vi.fn(),
}));

// ── Track provider call counts ──
let providerCallCount = 0;

// ── Mock Supabase server client ──
vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      auth: { getUser: mockGetUser },
      from: vi.fn(),
    }),
}));

// ── Mock Supabase service client ──
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
  }),
}));

// ── Mock capability guard ──
vi.mock('@/lib/capabilities/api-guard', () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

// ── Mock rate limiter ──
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: (...args: unknown[]) => mockRateLimitResponseAsync(...args),
  getRateLimitKey: (...args: unknown[]) => mockGetRateLimitKey(...args),
}));

// ── Mock logger ──
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Mock ChannelResolver with call-counting sender ──
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: MockChannelResolverImpl,
}));

// ── Helpers ──
const USER = { id: 'user-1', email: 'test@example.com' };
const BIZ_ID = 'biz-1';
const ORDER_ID = 'order-1';
const NOTIF_ID = 'notif-dispatch-1';
const CLAIM_TOKEN = 'claim-token-dispatch-1';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    new URL(`http://localhost:3000/api/orders/${ORDER_ID}/tracking`),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

function chainable(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}

/**
 * Sets up a full notification dispatch scenario.
 * Configures: update_order_tracking -> preflight DB lookups -> claim -> dispatch -> outcome
 */
function setupFullNotificationScenario(opts: {
  templateBehavior: 'success' | 'failure' | 'throw' | 'no_template';
  claimBehavior?: 'success' | 'fail';
  dispatchBehavior?: 'success' | 'fail';
  outcomePersistBehavior?: 'success' | 'fail';
  hasPhone?: boolean;
  hasChannel?: boolean;
}) {
  const {
    templateBehavior,
    claimBehavior = 'success',
    dispatchBehavior = 'success',
    outcomePersistBehavior = 'success',
    hasPhone = true,
    hasChannel = true,
  } = opts;

  providerCallCount = 0;
  mockSendTemplate.mockReset();
  mockSendText.mockReset();

  // Configure sender based on template behavior
  if (templateBehavior === 'success') {
    mockSendTemplate.mockImplementation(() => {
      providerCallCount++;
      return Promise.resolve({ success: true, messageId: 'wamid-tmpl-1' });
    });
  } else if (templateBehavior === 'failure') {
    mockSendTemplate.mockImplementation(() => {
      providerCallCount++;
      return Promise.resolve({ success: false });
    });
  } else if (templateBehavior === 'throw') {
    mockSendTemplate.mockImplementation(() => {
      providerCallCount++;
      throw new Error('Network error: ECONNRESET');
    });
  }

  mockSendText.mockImplementation(() => {
    providerCallCount++;
    return Promise.resolve({ success: true, messageId: 'wamid-text-1' });
  });

  const sender = templateBehavior === 'no_template'
    ? { sendText: mockSendText }
    : { sendTemplate: mockSendTemplate, sendText: mockSendText };

  // Channel resolver
  mockResolveByBusinessId.mockResolvedValue(
    hasChannel ? { sender } : null,
  );

  // RPC sequence: update_order_tracking
  const rpcCalls: Array<{ data: unknown; error: unknown }> = [
    {
      data: {
        success: true,
        no_op: false,
        revision: 1,
        notification_id: NOTIF_ID,
        shipped_at: '2026-08-31T12:00:00Z',
      },
      error: null,
    },
  ];

  // Preflight failure: no RPC calls after update_order_tracking — notification stays pending.
  // Only proceed to claim/dispatch/outcome RPCs if preflight data is available.
  if (!hasPhone || !hasChannel) {
    // No additional RPCs — preflight_failed, notification remains in 'pending'
  } else {
    // claim
    if (claimBehavior === 'success') {
      rpcCalls.push({
        data: { success: true, claim_token: CLAIM_TOKEN },
        error: null,
      });
    } else {
      rpcCalls.push({
        data: { success: false, error: 'not_claimable' },
        error: null,
      });
      // No further RPCs after failed claim
      mockServiceRpc.mockReset();
      for (const call of rpcCalls) {
        mockServiceRpc.mockResolvedValueOnce(call);
      }
      // Preflight DB lookups
      mockServiceFrom.mockReset();
      mockServiceFrom
        .mockReturnValueOnce(
          chainable({ data: { reference_code: 'ORD-001', delivery_phone: '+2341234567890' }, error: null }),
        )
        .mockReturnValueOnce(
          chainable({ data: { name: 'Test Biz' }, error: null }),
        );
      return;
    }

    // dispatch
    if (dispatchBehavior === 'success') {
      rpcCalls.push({ data: { success: true }, error: null });
    } else {
      rpcCalls.push({ data: { success: false }, error: null });
      mockServiceRpc.mockReset();
      for (const call of rpcCalls) {
        mockServiceRpc.mockResolvedValueOnce(call);
      }
      mockServiceFrom.mockReset();
      mockServiceFrom
        .mockReturnValueOnce(
          chainable({ data: { reference_code: 'ORD-001', delivery_phone: '+2341234567890' }, error: null }),
        )
        .mockReturnValueOnce(
          chainable({ data: { name: 'Test Biz' }, error: null }),
        );
      return;
    }

    // record_tracking_notification_outcome
    if (outcomePersistBehavior === 'success') {
      rpcCalls.push({ data: { success: true }, error: null });
    } else {
      rpcCalls.push({ data: null, error: { message: 'DB write failed', code: 'PGRST' } });
    }
  }

  mockServiceRpc.mockReset();
  for (const call of rpcCalls) {
    mockServiceRpc.mockResolvedValueOnce(call);
  }

  // Preflight DB lookups
  mockServiceFrom.mockReset();
  if (hasPhone) {
    mockServiceFrom
      .mockReturnValueOnce(
        chainable({ data: { reference_code: 'ORD-001', delivery_phone: '+2341234567890' }, error: null }),
      )
      .mockReturnValueOnce(
        chainable({ data: { name: 'Test Biz' }, error: null }),
      );
  } else {
    mockServiceFrom
      .mockReturnValueOnce(
        chainable({ data: { reference_code: 'ORD-001', delivery_phone: null }, error: null }),
      )
      .mockReturnValueOnce(
        chainable({ data: { name: 'Test Biz' }, error: null }),
      );
  }
}

beforeEach(() => {
  providerCallCount = 0;
  // Reset mock queues (mockResolvedValueOnce) without clearing implementations
  mockGetUser.mockReset();
  mockServiceRpc.mockReset();
  mockServiceFrom.mockReset();
  mockResolveByBusinessId.mockReset();
  mockSendTemplate.mockReset();
  mockSendText.mockReset();
  // Re-set defaults
  mockGetUser.mockResolvedValue({ data: { user: USER } });
  mockRequireCapability.mockResolvedValue({ allowed: true });
  mockRateLimitResponseAsync.mockResolvedValue(null);
  mockGetRateLimitKey.mockReturnValue('test-key');
  MockChannelResolverImpl.mockImplementation(function (this: Record<string, unknown>) {
    this.resolveByBusinessId = (...args: unknown[]) => mockResolveByBusinessId(...args);
  });
});

const { PATCH } = await import('../route');

describe('Dispatch boundary — provider call counts', () => {
  it('successful template send: exactly ONE provider call, outcome=sent', async () => {
    setupFullNotificationScenario({ templateBehavior: 'success' });

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.notification.status).toBe('sent');
    expect(providerCallCount).toBe(1);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendText).not.toHaveBeenCalled();

    // Verify noRetry was passed
    expect(mockSendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ noRetry: true }),
    );
  });

  it('template throws network error: ONE call, indeterminate, NO text fallback', async () => {
    setupFullNotificationScenario({ templateBehavior: 'throw' });

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.notification.status).toBe('indeterminate');
    // Exactly one provider call — the failed template attempt
    expect(providerCallCount).toBe(1);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    // NO text fallback after ambiguous template outcome
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('template returns definitive failure: ONE call, outcome=failed, NO text fallback', async () => {
    setupFullNotificationScenario({ templateBehavior: 'failure' });

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.notification.status).toBe('failed');
    expect(providerCallCount).toBe(1);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    // No text fallback — template outcome was known (definitive failure)
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('no template support: single-attempt text send with noRetry', async () => {
    setupFullNotificationScenario({ templateBehavior: 'no_template' });

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'UPS',
      trackingNumber: 'UPS999',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.notification.status).toBe('sent');
    expect(providerCallCount).toBe(1);
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate).not.toHaveBeenCalled();

    // Verify noRetry was passed
    expect(mockSendText).toHaveBeenCalledWith(
      expect.objectContaining({ noRetry: true }),
    );
  });

  it('deterministic preflight failure (no phone): ZERO provider calls, notification stays pending', async () => {
    setupFullNotificationScenario({ templateBehavior: 'success', hasPhone: false });

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Notification row stays in 'pending' — no claim/dispatch occurred, safely retryable
    expect(body.notification.status).toBe('preflight_failed');
    // ZERO provider calls — failed before dispatch barrier
    expect(providerCallCount).toBe(0);
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('deterministic preflight failure (no channel): ZERO provider calls, notification stays pending', async () => {
    setupFullNotificationScenario({ templateBehavior: 'success', hasChannel: false });

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Notification row stays in 'pending' — safely retryable
    expect(body.notification.status).toBe('preflight_failed');
    expect(providerCallCount).toBe(0);
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('concurrent workers: second claim fails, ZERO additional provider calls', async () => {
    // First worker succeeds
    setupFullNotificationScenario({ templateBehavior: 'success' });

    const req1 = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res1 = await PATCH(req1, { params: Promise.resolve({ id: ORDER_ID }) });
    const body1 = await res1.json();

    expect(body1.notification.status).toBe('sent');
    expect(providerCallCount).toBe(1);

    // Second worker: claim fails (notification already claimed/dispatched)
    setupFullNotificationScenario({ templateBehavior: 'success', claimBehavior: 'fail' });

    const req2 = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res2 = await PATCH(req2, { params: Promise.resolve({ id: ORDER_ID }) });
    const body2 = await res2.json();

    expect(body2.notification.status).toBe('failed');
    // ZERO additional provider calls — claim blocked the second worker
    expect(providerCallCount).toBe(0);
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('later tracking revision: independently allowed once', async () => {
    // First revision
    setupFullNotificationScenario({ templateBehavior: 'success' });

    const req1 = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res1 = await PATCH(req1, { params: Promise.resolve({ id: ORDER_ID }) });
    const body1 = await res1.json();

    expect(body1.success).toBe(true);
    expect(body1.notification.status).toBe('sent');
    expect(providerCallCount).toBe(1);

    // Second revision — new notification_id, independently dispatchable
    const NOTIF_ID_2 = 'notif-dispatch-2';
    providerCallCount = 0;
    mockSendTemplate.mockReset();
    mockSendText.mockReset();
    mockSendTemplate.mockImplementation(() => {
      providerCallCount++;
      return Promise.resolve({ success: true, messageId: 'wamid-tmpl-2' });
    });

    mockResolveByBusinessId.mockResolvedValue({
      sender: { sendTemplate: mockSendTemplate, sendText: mockSendText },
    });

    mockServiceRpc.mockReset();
    mockServiceRpc
      .mockResolvedValueOnce({
        data: { success: true, no_op: false, revision: 2, notification_id: NOTIF_ID_2, shipped_at: '2026-08-31T12:00:00Z' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: true, claim_token: 'claim-token-2' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: true },
        error: null,
      });

    mockServiceFrom.mockReset();
    mockServiceFrom
      .mockReturnValueOnce(
        chainable({ data: { reference_code: 'ORD-001', delivery_phone: '+2341234567890' }, error: null }),
      )
      .mockReturnValueOnce(
        chainable({ data: { name: 'Test Biz' }, error: null }),
      );

    const req2 = makeRequest({
      businessId: BIZ_ID,
      carrier: 'FedEx',
      trackingNumber: 'FDX999',
      notifyCustomer: true,
    });
    const res2 = await PATCH(req2, { params: Promise.resolve({ id: ORDER_ID }) });
    const body2 = await res2.json();

    expect(body2.success).toBe(true);
    expect(body2.revision).toBe(2);
    expect(body2.notification.status).toBe('sent');
    // New revision independently sent its own notification
    expect(providerCallCount).toBe(1);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it('provider success + outcome persistence failure: ONE call, returns indeterminate', async () => {
    // Provider returns a WAMID, but record_tracking_notification_outcome RPC fails.
    // Route must return indeterminate (not sent) since durable row remains dispatched.
    setupFullNotificationScenario({
      templateBehavior: 'success',
      outcomePersistBehavior: 'fail',
    });

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Exactly one provider call — message may have been sent
    expect(providerCallCount).toBe(1);
    // But outcome persistence failed, so cannot report 'sent'
    expect(body.notification.status).toBe('indeterminate');
  });

  it('provider exception + outcome persistence failure: ONE call, returns indeterminate', async () => {
    // Provider throws (ambiguous outcome), AND outcome persistence also fails.
    // Route must still return indeterminate and not retry.
    setupFullNotificationScenario({
      templateBehavior: 'throw',
      outcomePersistBehavior: 'fail',
    });

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(providerCallCount).toBe(1);
    expect(body.notification.status).toBe('indeterminate');
  });
});
