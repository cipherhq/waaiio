/**
 * M393 Route behavioral tests (#352 Phase 2B+2C, R33).
 *
 * Tests actual route handler code paths by importing + invoking handlers
 * with fully mocked dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Pre-declare all shared mock functions ──
const mockRpc = vi.fn();
const mockFromChain: any = {};
const mockResolveByBusinessId = vi.fn();
const mockResolveByChannelIdForBusiness = vi.fn();
const mockSendOrEmail = vi.fn();
const mockFindCustomerEmail = vi.fn();
const mockSendText = vi.fn();
const channelResolverInstances: any[] = [];

// ── Module-level mocks (hoisted by Vitest) ──
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class MockChannelResolver {
    constructor() { channelResolverInstances.push(this); }
    resolveByBusinessId = mockResolveByBusinessId;
    resolveByChannelIdForBusiness = mockResolveByChannelIdForBusiness;
  },
}));

vi.mock('@/lib/channels/send-or-email', () => ({
  sendOrEmail: (...a: any[]) => mockSendOrEmail(...a),
  findCustomerEmail: (...a: any[]) => mockFindCustomerEmail(...a),
}));
vi.mock('@/lib/email/templates', () => ({
  businessNotificationEmail: () => ({ subject: 'T', html: '<p/>' }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn() })) },
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({
  createNotification: vi.fn().mockReturnValue(Promise.resolve()),
}));
vi.mock('@/lib/constants', () => ({
  formatCurrency: (amt: number) => `₦${amt}`,
}));

// Create a chainable mock for supabase .from()
function chain(resolveData: any = null) {
  const c: any = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'lt', 'in', 'is', 'or', 'order', 'limit']) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn().mockResolvedValue({ data: resolveData, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null });
  c.then = (resolve: any) => resolve({ data: resolveData ? (Array.isArray(resolveData) ? resolveData : [resolveData]) : [], error: null });
  return c;
}

let mockFromHandler: (table: string) => any;

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: (...a: any[]) => mockRpc(...a),
    from: (table: string) => mockFromHandler(table),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'biz-1', subscription_tier: 'growth' },
        error: null,
      }),
    }),
  }),
}));

beforeEach(() => {
  channelResolverInstances.length = 0;
  mockRpc.mockReset();
  mockSendOrEmail.mockReset().mockResolvedValue(undefined);
  mockFindCustomerEmail.mockReset().mockResolvedValue(null);
  mockSendText.mockReset().mockResolvedValue(undefined);
  mockResolveByBusinessId.mockReset().mockResolvedValue(null);
  mockResolveByChannelIdForBusiness.mockReset().mockResolvedValue(null);
  mockFromHandler = () => chain();
});

// ═══ 1. expire-transfers POST ═══

describe('R33-1: expire-transfers actual POST', () => {
  it('cancelled=false → expired=0, no notification', async () => {
    const transfer = {
      id: 'xf-1', order_id: 'ord-1', booking_id: null,
      customer_phone: '+234900', business_id: 'biz-1',
      reference_code: 'WA-X1', metadata: { _inbound_channel_id: 'ch-a' },
      businesses: { name: 'TestBiz' },
    };

    mockFromHandler = (table: string) => {
      if (table === 'pending_transfers') {
        const c = chain();
        c.then = (r: any) => r({ data: [transfer], error: null });
        return c;
      }
      return chain();
    };
    mockRpc.mockResolvedValue({ data: { cancelled: false, reason: 'has_successful_payment' }, error: null });

    const { POST } = await import('@/app/api/cron/expire-transfers/route');
    const res = await POST(new Request('http://x', { method: 'POST' }) as any);
    const body = await res.json();

    expect(mockRpc).toHaveBeenCalledWith('cancel_stale_order_atomic', { p_order_id: 'ord-1' });
    expect(mockSendOrEmail).not.toHaveBeenCalled();
    expect(mockResolveByChannelIdForBusiness).not.toHaveBeenCalled();
    expect(body.expired).toBe(0);
  });

  it('cancelled=true → expired=1, notification with channel A', async () => {
    vi.resetModules();
    const transfer = {
      id: 'xf-2', order_id: 'ord-2', booking_id: null,
      customer_phone: '+234900', business_id: 'biz-1',
      reference_code: 'WA-X2', metadata: { _inbound_channel_id: 'ch-a' },
      businesses: { name: 'TestBiz' },
    };

    mockFromHandler = (table: string) => {
      if (table === 'pending_transfers') {
        const c = chain();
        c.then = (r: any) => r({ data: [transfer], error: null });
        return c;
      }
      return chain();
    };
    mockRpc.mockResolvedValue({ data: { cancelled: true, stock_restored: true }, error: null });
    mockResolveByChannelIdForBusiness.mockResolvedValue({ sender: { sendText: mockSendText } });

    const { POST } = await import('@/app/api/cron/expire-transfers/route');
    const res = await POST(new Request('http://x', { method: 'POST' }) as any);
    const body = await res.json();

    expect(body.expired).toBe(1);
    expect(mockResolveByChannelIdForBusiness).toHaveBeenCalledWith('ch-a', 'biz-1');
    expect(mockResolveByBusinessId).not.toHaveBeenCalled();
  });
});

// ═══ 2+3. pending-transfers PATCH ═══

describe('R33-2: pending-transfers PATCH — exact channel A', () => {
  it('order-linked confirm: uses channel A, never B', async () => {
    vi.resetModules();
    const transfer = {
      id: 'xf-c1', order_id: 'ord-c1', booking_id: null, invoice_id: null,
      business_id: 'biz-1', customer_phone: '+234900', status: 'pending',
      metadata: { _inbound_channel_id: 'ch-a' }, reference_code: 'WA-C1',
      expected_amount: 500000, currency: 'NGN',
    };

    mockFromHandler = (table: string) => {
      if (table === 'pending_transfers') return chain(transfer);
      if (table === 'businesses') {
        const c = chain({ name: 'Biz', country_code: 'NG' });
        c.single = vi.fn().mockResolvedValue({ data: { name: 'Biz', country_code: 'NG' }, error: null });
        return c;
      }
      if (table === 'platform_fees') {
        const c = chain(); c.insert = vi.fn(() => ({ then: (r: any) => r({ error: null }) })); return c;
      }
      return chain();
    };
    mockRpc.mockResolvedValue({
      data: { confirmed: true, order_total: 5000, payment_id: 'pay-d1', inbound_channel_id: 'ch-a' },
      error: null,
    });
    mockResolveByChannelIdForBusiness.mockResolvedValue({ sender: { sendText: mockSendText } });

    const { PATCH } = await import('@/app/api/dashboard/pending-transfers/[id]/route');
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'confirm', business_id: 'biz-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PATCH(req as any, { params: Promise.resolve({ id: 'xf-c1' }) });
    const body = await res.json();

    expect(body.status).toBe('confirmed');
    expect(mockResolveByChannelIdForBusiness).toHaveBeenCalledWith('ch-a', 'biz-1');
    expect(mockResolveByBusinessId).not.toHaveBeenCalled();
  });

  it('order-linked reject: uses channel A from transfer.metadata', async () => {
    vi.resetModules();
    const transfer = {
      id: 'xf-r1', order_id: 'ord-r1', booking_id: null, invoice_id: null,
      business_id: 'biz-1', customer_phone: '+234900', status: 'pending',
      metadata: { _inbound_channel_id: 'ch-a' }, reference_code: 'WA-R1',
      expected_amount: 500000, currency: 'NGN',
    };

    mockFromHandler = (table: string) => {
      if (table === 'pending_transfers') return chain(transfer);
      if (table === 'businesses') {
        const c = chain({ name: 'Biz' });
        c.single = vi.fn().mockResolvedValue({ data: { name: 'Biz' }, error: null });
        return c;
      }
      return chain();
    };
    mockRpc.mockResolvedValue({ data: { rejected: true, reason: 'merchant_rejected' }, error: null });
    mockResolveByChannelIdForBusiness.mockResolvedValue({ sender: { sendText: mockSendText } });

    const { PATCH } = await import('@/app/api/dashboard/pending-transfers/[id]/route');
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'reject', reason: 'test', business_id: 'biz-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PATCH(req as any, { params: Promise.resolve({ id: 'xf-r1' }) });
    const body = await res.json();

    expect(body.status).toBe('rejected');
    expect(mockResolveByChannelIdForBusiness).toHaveBeenCalledWith('ch-a', 'biz-1');
    expect(mockResolveByBusinessId).not.toHaveBeenCalled();
  });

  it('non-order confirm: uses resolveByBusinessId (control)', async () => {
    vi.resetModules();
    const transfer = {
      id: 'xf-no', order_id: null, booking_id: 'book-1', invoice_id: null,
      business_id: 'biz-1', customer_phone: '+234900', customer_name: 'Test',
      status: 'pending', metadata: {}, reference_code: 'WA-NO',
      expected_amount: 100000, currency: 'NGN', proof_type: null,
    };

    mockFromHandler = (table: string) => {
      if (table === 'pending_transfers') {
        const c = chain(transfer);
        c.update = vi.fn(() => ({
          eq: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [{ id: 'xf-no' }], error: null }) })) })),
        }));
        return c;
      }
      if (table === 'businesses') {
        const c = chain({ name: 'Biz', country_code: 'NG' });
        c.single = vi.fn().mockResolvedValue({ data: { name: 'Biz', country_code: 'NG' }, error: null });
        return c;
      }
      if (table === 'bookings') return { update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) };
      if (table === 'platform_fees') return { insert: vi.fn(() => ({ then: (r: any) => r({ error: null }) })) };
      if (table === 'payments') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      return chain();
    };
    mockResolveByBusinessId.mockResolvedValue({ sender: { sendText: mockSendText } });

    const { PATCH } = await import('@/app/api/dashboard/pending-transfers/[id]/route');
    const req = new Request('http://x', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'confirm', business_id: 'biz-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await PATCH(req as any, { params: Promise.resolve({ id: 'xf-no' }) });
    const body = await res.json();

    expect(body.status).toBe('confirmed');
    expect(mockResolveByBusinessId).toHaveBeenCalled();
    expect(mockResolveByChannelIdForBusiness).not.toHaveBeenCalled();
  });
});
