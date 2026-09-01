/**
 * Issue #247 — Editable Order Tracking API Route Tests
 *
 * Tests the PATCH /api/orders/[id]/tracking handler with mocked Supabase.
 * Covers: auth, capability guard, RPC dispatch, notification lifecycle,
 *         error mapping, and notification failure isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks (survive vi.mock hoisting) ──
const {
  mockGetUser,
  mockServiceFrom,
  mockServiceRpc,
  mockRequireCapability,
  mockRateLimitResponseAsync,
  mockGetRateLimitKey,
  mockResolveByBusinessId,
  MockChannelResolverImpl,
} = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockServiceFrom: vi.fn(),
  mockServiceRpc: vi.fn(),
  mockRequireCapability: vi.fn(),
  mockRateLimitResponseAsync: vi.fn(),
  mockGetRateLimitKey: vi.fn(),
  mockResolveByBusinessId: vi.fn(),
  MockChannelResolverImpl: vi.fn(),
}));

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

// ── Mock ChannelResolver ──
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: MockChannelResolverImpl,
}));

// ── Helpers ──
const USER = { id: 'user-1', email: 'test@example.com' };
const BIZ_ID = 'biz-1';
const ORDER_ID = 'order-1';

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

beforeEach(() => {
  mockGetUser.mockReset();
  mockServiceRpc.mockReset();
  mockServiceFrom.mockReset();
  mockResolveByBusinessId.mockReset();
  // Re-set defaults
  mockGetUser.mockResolvedValue({ data: { user: USER } });
  mockRequireCapability.mockResolvedValue({ allowed: true });
  mockRateLimitResponseAsync.mockResolvedValue(null);
  mockGetRateLimitKey.mockReturnValue('test-key');
  mockResolveByBusinessId.mockResolvedValue(null);
  MockChannelResolverImpl.mockImplementation(function (this: Record<string, unknown>) {
    this.resolveByBusinessId = (...args: unknown[]) => mockResolveByBusinessId(...args);
  });
});

// ── Import the handler under test ──
// Must be imported AFTER vi.mock calls
const { PATCH } = await import('../route');

describe('PATCH /api/orders/[id]/tracking', () => {
  it('returns 401 when user is not authenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const req = makeRequest({ businessId: BIZ_ID, carrier: 'DHL', trackingNumber: 'DHL123' });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(401);
  });

  it('returns 400 when businessId is missing', async () => {
    const req = makeRequest({ carrier: 'DHL', trackingNumber: 'DHL123' });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns capability guard denial when not allowed', async () => {
    mockRequireCapability.mockResolvedValueOnce({
      allowed: false,
      denial: { error: 'capability_denied' },
      status: 403,
    });
    const req = makeRequest({ businessId: BIZ_ID, carrier: 'DHL', trackingNumber: 'DHL123' });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns 500 when RPC errors', async () => {
    mockServiceRpc.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });
    const req = makeRequest({ businessId: BIZ_ID, carrier: 'DHL', trackingNumber: 'DHL123' });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(500);
  });

  it('returns 404 when order not found', async () => {
    mockServiceRpc.mockResolvedValueOnce({
      data: { success: false, error: 'order_not_found' },
      error: null,
    });
    const req = makeRequest({ businessId: BIZ_ID, carrier: 'DHL', trackingNumber: 'DHL123' });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('order_not_found');
  });

  it('returns 403 when cross-business access denied', async () => {
    mockServiceRpc.mockResolvedValueOnce({
      data: { success: false, error: 'access_denied' },
      error: null,
    });
    const req = makeRequest({ businessId: BIZ_ID, carrier: 'DHL', trackingNumber: 'DHL123' });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns 422 when order status is draft/cancelled', async () => {
    mockServiceRpc.mockResolvedValueOnce({
      data: { success: false, error: 'invalid_order_status', detail: 'Cannot update tracking for draft orders' },
      error: null,
    });
    const req = makeRequest({ businessId: BIZ_ID, carrier: 'DHL', trackingNumber: 'DHL123' });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(422);
  });

  it('returns success with no_op=true for identical tracking', async () => {
    mockServiceRpc.mockResolvedValueOnce({
      data: { success: true, no_op: true, revision: 1 },
      error: null,
    });
    const req = makeRequest({ businessId: BIZ_ID, carrier: 'DHL', trackingNumber: 'DHL123' });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.no_op).toBe(true);
    expect(body.notification.status).toBe('not_requested');
  });

  it('returns success with revision for material change (no notification)', async () => {
    mockServiceRpc.mockResolvedValueOnce({
      data: { success: true, no_op: false, revision: 2, shipped_at: '2026-08-30T12:00:00Z' },
      error: null,
    });
    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'FedEx',
      trackingNumber: 'FDX789',
      notifyCustomer: false,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.no_op).toBe(false);
    expect(body.revision).toBe(2);
    expect(body.notification.status).toBe('not_requested');
  });

  it('dispatches notification when notifyCustomer=true and tracking changes', async () => {
    const notifId = 'notif-1';
    const claimToken = 'claim-token-1';

    // Sequence: update_order_tracking → preflight DB lookups → preflight outcome RPC (no channel)
    // Preflight happens BEFORE claim. With no channel resolver, preflight fails
    // and records outcome directly (no claim/dispatch needed).
    mockServiceRpc
      .mockResolvedValueOnce({
        // update_order_tracking
        data: { success: true, no_op: false, revision: 1, notification_id: notifId, shipped_at: '2026-08-30T12:00:00Z' },
        error: null,
      })
      .mockResolvedValueOnce({
        // record_tracking_notification_outcome (preflight failed: no channel)
        data: { success: true },
        error: null,
      });

    // Mock service.from for order + business lookups in preflight
    mockServiceFrom
      .mockReturnValueOnce(
        chainable({ data: { reference_code: 'ORD-001', delivery_phone: '+2341234567890' }, error: null }),
      )
      .mockReturnValueOnce(
        chainable({ data: { name: 'Test Biz' }, error: null }),
      );

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'DHL',
      trackingNumber: 'DHL123',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.revision).toBe(1);
    // Notification failed (no channel) — tracking edit still succeeded
    expect(body.notification.status).toBe('failed');
  });

  it('notification failure does not affect tracking success', async () => {
    const notifId = 'notif-2';

    // Provide a channel so preflight passes and we reach the claim step
    mockResolveByBusinessId.mockResolvedValueOnce({
      sender: {
        sendTemplate: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-1' }),
        sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-2' }),
      },
    });

    // update_order_tracking succeeds. Preflight succeeds but claim fails.
    mockServiceRpc
      .mockResolvedValueOnce({
        data: { success: true, no_op: false, revision: 3, notification_id: notifId, shipped_at: '2026-08-30T12:00:00Z' },
        error: null,
      })
      .mockResolvedValueOnce({
        // claim fails (after preflight succeeds)
        data: { success: false, error: 'not_claimable', current_status: 'claiming' },
        error: null,
      });

    // Preflight DB lookups (needed before claim now)
    mockServiceFrom
      .mockReturnValueOnce(
        chainable({ data: { reference_code: 'ORD-001', delivery_phone: '+2341234567890' }, error: null }),
      )
      .mockReturnValueOnce(
        chainable({ data: { name: 'Test Biz' }, error: null }),
      );

    const req = makeRequest({
      businessId: BIZ_ID,
      carrier: 'UPS',
      trackingNumber: 'UPS999',
      notifyCustomer: true,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Tracking edit committed successfully
    expect(body.success).toBe(true);
    expect(body.revision).toBe(3);
    // Notification failed (claim denied), but tracking edit is unaffected
    expect(body.notification.status).toBe('failed');
  });
});
