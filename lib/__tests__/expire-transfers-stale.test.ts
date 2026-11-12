/**
 * expire-transfers cron — staging trace 2026-11-12: 7 overdue transfers, none
 * ever expired, because the route only answered POST and Vercel Cron sends GET.
 * Before turning it on, overdue non-order transfers must not:
 *   - cancel a booking whose customer sent a receipt in time (contract #736 §5.4);
 *   - tell a customer who paid by card that their transfer "expired" (Option A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendOrEmail = vi.fn();
const mockResolveByBusinessId = vi.fn();

vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByBusinessId = mockResolveByBusinessId;
    resolveByChannelIdForBusiness = vi.fn();
  },
}));
vi.mock('@/lib/channels/send-or-email', () => ({
  sendOrEmail: (...a: unknown[]) => mockSendOrEmail(...a),
  findCustomerEmail: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: () => ({ subject: 'T', html: '<p/>' }) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn() })) },
}));

type Call = { table: string; op: string; row?: Record<string, unknown>; filters: Array<[string, string, unknown]> };
let calls: Call[] = [];
let overdue: Record<string, unknown>[] = [];
let paidBookings: string[] = [];

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: vi.fn(),
    from: (table: string) => {
      const call: Call = { table, op: 'select', filters: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      for (const m of ['eq', 'lt', 'in', 'is', 'limit']) {
        b[m] = vi.fn((col: string, val: unknown) => { call.filters.push([m, col, val]); return b; });
      }
      b.select = vi.fn(() => b);
      b.update = vi.fn((row: Record<string, unknown>) => { call.op = 'update'; call.row = row; return b; });
      b.then = (resolve: (v: unknown) => void) => {
        if (table === 'pending_transfers' && call.op === 'select') return resolve({ data: overdue, error: null });
        if (table === 'payments') {
          const id = call.filters.find(f => f[1] === 'booking_id')?.[2] as string | undefined;
          return resolve({ data: id && paidBookings.includes(id) ? [{ id: 'pay-1' }] : [], error: null });
        }
        return resolve({ data: null, error: null });
      };
      return b;
    },
  }),
}));

const base = {
  order_id: null, reservation_id: null, invoice_id: null,
  customer_phone: '+12404844862', business_id: 'biz-1', metadata: {},
  businesses: { name: 'TestBiz' }, expires_at: '2026-11-11T22:45:16Z',
  proof_protected: false, proof_submitted_at: null, proof_image_url: null, proof_text: null,
};

const updatesTo = (table: string) => calls.filter(c => c.table === table && c.op === 'update');

beforeEach(() => {
  vi.resetModules();
  calls = [];
  paidBookings = [];
  mockSendOrEmail.mockReset().mockResolvedValue(undefined);
  mockResolveByBusinessId.mockReset().mockResolvedValue({ sender: { sendText: vi.fn() } });
});

async function runCron() {
  const { GET } = await import('@/app/api/cron/expire-transfers/route');
  const res = await GET(new Request('http://x/api/cron/expire-transfers') as never);
  return res.json();
}

describe('expire-transfers cron', () => {
  it('answers GET, the method Vercel Cron uses', async () => {
    const route = await import('@/app/api/cron/expire-transfers/route');
    expect(typeof route.GET).toBe('function');
  });

  it('unpaid, no receipt → expired, booking cancelled, customer told (unchanged)', async () => {
    overdue = [{ ...base, id: 'xf-1', booking_id: 'bk-unpaid', reference_code: 'WA-71A8' }];
    const body = await runCron();

    expect(body.expired).toBe(1);
    expect(updatesTo('pending_transfers')[0].row).toEqual({ status: 'expired' });
    expect(updatesTo('bookings')[0].row).toEqual({ status: 'cancelled' });
    expect(mockSendOrEmail).toHaveBeenCalledTimes(1);
  });

  it('expiry notice carries a WhatsApp message category, so the financial guard accepts it', async () => {
    // Real sendOrEmail; the sender refuses a send with no category, as the
    // financial authorization guard (M370/M371/M461) does on staging.
    const actual = await vi.importActual<typeof import('@/lib/channels/send-or-email')>('@/lib/channels/send-or-email');
    const sendText = vi.fn(async (msg: { messageCategory?: string }) => {
      if (!msg.messageCategory) throw new Error('Financial authorization denied: missing_message_category');
      return { success: true };
    });
    mockResolveByBusinessId.mockResolvedValue({ sender: { sendText } });
    const results: unknown[] = [];
    mockSendOrEmail.mockImplementation(async (opts: Parameters<typeof actual.sendOrEmail>[0]) => {
      const r = await actual.sendOrEmail(opts);
      results.push(r);
      return r;
    });
    overdue = [{ ...base, id: 'xf-6', booking_id: 'bk-unpaid-2', reference_code: 'WA-71A9' }];
    const body = await runCron();

    expect(body.expired).toBe(1);
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ messageCategory: 'service' }));
    expect(results).toEqual([expect.objectContaining({ whatsapp: 'sent' })]);
  });

  it('booking already paid by card, no receipt → transfer cancelled quietly, booking untouched', async () => {
    overdue = [{ ...base, id: 'xf-2', booking_id: 'bk-card-paid', reference_code: 'WA-2753' }];
    paidBookings = ['bk-card-paid'];
    const body = await runCron();

    expect(body.expired).toBe(0);
    expect(updatesTo('pending_transfers')).toHaveLength(1);
    expect(updatesTo('pending_transfers')[0].row).toEqual({ status: 'cancelled' });
    expect(updatesTo('pending_transfers')[0].filters).toEqual(expect.arrayContaining([['eq', 'status', 'pending']]));
    expect(updatesTo('bookings')).toHaveLength(0);
    expect(mockSendOrEmail).not.toHaveBeenCalled();
  });

  it('receipt sent before the deadline → held for the merchant, never expired or cancelled', async () => {
    overdue = [{ ...base, id: 'xf-3', booking_id: 'bk-proof', reference_code: 'WA-53A0', proof_submitted_at: '2026-11-11T20:00:00Z' }];
    const body = await runCron();

    expect(body.expired).toBe(0);
    expect(updatesTo('pending_transfers')).toHaveLength(1);
    expect(updatesTo('pending_transfers')[0].row).toEqual({ proof_protected: true });
    expect(updatesTo('bookings')).toHaveLength(0);
    expect(mockSendOrEmail).not.toHaveBeenCalled();
  });

  it('paid by card AND a receipt sent → stays pending for the merchant (possible double payment)', async () => {
    overdue = [{ ...base, id: 'xf-4', booking_id: 'bk-both', reference_code: 'WA-862E', proof_text: 'FT998877' }];
    paidBookings = ['bk-both'];
    const body = await runCron();

    expect(body.expired).toBe(0);
    expect(updatesTo('pending_transfers').map(u => u.row)).toEqual([{ proof_protected: true }]);
    expect(mockSendOrEmail).not.toHaveBeenCalled();
  });

  it('already protected → left alone with no writes', async () => {
    overdue = [{ ...base, id: 'xf-5', booking_id: 'bk-held', reference_code: 'WA-0001', proof_protected: true }];
    const body = await runCron();

    expect(body.expired).toBe(0);
    expect(updatesTo('pending_transfers')).toHaveLength(0);
    expect(mockSendOrEmail).not.toHaveBeenCalled();
  });
});
