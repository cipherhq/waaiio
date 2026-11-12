/**
 * #963 lane 3: a bank-transfer booking that becomes confirmed sends its
 * after-booking intake. Both confirm routes run as handlers with mocked
 * dependencies (harness pattern from m393-route-behavioral); the intake send
 * itself is a spy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.hoisted(() => vi.fn(async () => ({ status: 'sent', intakeId: 'in-1' })));
const mockRpc = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ fromHandler: (_t: string): unknown => null }));

vi.mock('@/lib/intake/send', () => ({ deliverAfterBookingIntake: deliver }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByBusinessId = vi.fn(async () => ({ sender: { sendText: vi.fn(async () => undefined) } }));
    resolveByChannelIdForBusiness = vi.fn(async () => null);
  },
}));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: vi.fn(async () => undefined), findCustomerEmail: vi.fn(async () => null) }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: () => ({ subject: 'T', html: '<p/>' }) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) },
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (n: number) => `₦${n}` }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a), from: (t: string) => state.fromHandler(t) }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c; c.eq = () => c;
      c.maybeSingle = async () => ({ data: { id: 'biz-1', subscription_tier: 'growth' }, error: null });
      return c;
    },
  }),
}));

function chain(data: unknown = null) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'lt', 'in', 'is', 'or', 'order', 'limit']) c[m] = () => c;
  c.single = async () => ({ data, error: null });
  c.maybeSingle = async () => ({ data, error: null });
  c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: data ? (Array.isArray(data) ? data : [data]) : [], error: null }).then(r);
  return c;
}

const TRANSFER = {
  id: 'xf-1', order_id: null, booking_id: 'book-1', invoice_id: null, reservation_id: null,
  business_id: 'biz-1', customer_phone: '+234900', customer_name: 'Test', status: 'pending', metadata: {},
  reference_code: 'WA-1', expected_amount: 100000, currency: 'NGN', proof_type: null,
};
const json = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  deliver.mockClear();
  mockRpc.mockReset();
  state.fromHandler = (t: string) => {
    if (t === 'pending_transfers') return chain(TRANSFER);
    if (t === 'businesses') return chain({ name: 'Biz', country_code: 'NG' });
    if (t === 'bookings') return chain({ id: 'book-1' });
    return chain();
  };
});

describe('PATCH pending-transfers/[id] (confirm, one step)', () => {
  async function confirm(approved: boolean) {
    mockRpc.mockResolvedValue({ data: { confirmed: true, payment_id: 'pay-1', entity_type: 'booking', approved, amount_major: 1000 }, error: null });
    const { PATCH } = await import('@/app/api/dashboard/pending-transfers/[id]/route');
    const res = await PATCH(json({ action: 'confirm', business_id: 'biz-1', approve_fulfillment: approved }) as never, { params: Promise.resolve({ id: 'xf-1' }) });
    return res.json();
  }

  it('confirmed and approved: sends the intake for that booking, once', async () => {
    const body = await confirm(true);
    expect(body).toMatchObject({ status: 'confirmed', approved: true });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.anything(), 'book-1');
  });

  it('payment confirmed but booking still awaiting approval: sends nothing yet', async () => {
    const body = await confirm(false);
    expect(body.status).toBe('confirmed');
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('POST pending-transfers/[id]/approve (approve later)', () => {
  it('approve_booking: sends the intake for that booking, once', async () => {
    const { POST } = await import('@/app/api/dashboard/pending-transfers/[id]/approve/route');
    const res = await POST(json({ action: 'approve_booking', business_id: 'biz-1' }) as never, { params: Promise.resolve({ id: 'xf-1' }) });
    expect(await res.json()).toEqual({ success: true, action: 'approved' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.anything(), 'book-1');
  });

  it('a booking that could not be approved sends nothing', async () => {
    state.fromHandler = (t: string) => (t === 'pending_transfers' ? chain(TRANSFER) : t === 'bookings' ? chain(null) : chain());
    const { POST } = await import('@/app/api/dashboard/pending-transfers/[id]/approve/route');
    const res = await POST(json({ action: 'approve_booking', business_id: 'biz-1' }) as never, { params: Promise.resolve({ id: 'xf-1' }) });
    expect(res.status).toBe(409);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a failing intake send never changes the approval answer', async () => {
    deliver.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import('@/app/api/dashboard/pending-transfers/[id]/approve/route');
    const res = await POST(json({ action: 'approve_booking', business_id: 'biz-1' }) as never, { params: Promise.resolve({ id: 'xf-1' }) });
    expect(await res.json()).toEqual({ success: true, action: 'approved' });
  });
});
