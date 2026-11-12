/**
 * A booking paid by card must not later get "your booking has been cancelled".
 *
 * Staging trace 2026-11-12 (TestBiz): every bot checkout offers card and bank
 * transfer and saves a pending_transfers row. Orders close that row when the
 * card payment wins (M393/M400); bookings did not. Four hours later the
 * expire-transfers cron expired the leftover row and told the customer their
 * booking was cancelled, although the booking stayed confirmed.
 *
 * 1. processSuccessfulPayment closes the booking's open transfer offers.
 * 2. The cron sends the cancellation notice only when it really cancelled the booking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendOrEmail = vi.fn();
const mockResolveByBusinessId = vi.fn();

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    withContext: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/redact', () => ({ isSafeIdentifier: () => true }));
vi.mock('@/lib/waitlist/auto-notify', () => ({ markWaitlistConverted: vi.fn() }));
vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2, feeFlat: 0, feeTotal: 100 }),
}));
vi.mock('@/lib/trial-status', () => ({
  resolveFeatureTrialEndsAt: vi.fn().mockResolvedValue(null),
  resolveLimitTier: vi.fn().mockResolvedValue('free'),
  resolveTrialStatus: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByBusinessId = mockResolveByBusinessId;
    resolveByChannelIdForBusiness = vi.fn();
  },
}));
vi.mock('@/lib/channels/send-or-email', () => ({
  sendOrEmail: (...args: unknown[]) => mockSendOrEmail(...args),
  findCustomerEmail: vi.fn().mockResolvedValue('guest@example.com'),
}));
vi.mock('@/lib/email/templates', () => ({
  businessNotificationEmail: () => ({ subject: 's', html: 'h' }),
}));

type Op = { table: string; op: string; args: unknown[] };

/** Chainable fake Supabase table that records every call made on it. */
function table(name: string, ops: Op[], result: { data: unknown; error: unknown }) {
  const c: any = {};
  for (const m of ['select', 'eq', 'neq', 'not', 'is', 'in', 'order', 'limit', 'update', 'lt', 'gt', 'or', 'like']) {
    c[m] = vi.fn((...args: unknown[]) => { ops.push({ table: name, op: m, args }); return c; });
  }
  c.single = vi.fn().mockResolvedValue(result);
  c.maybeSingle = vi.fn().mockResolvedValue(result);
  c.insert = vi.fn((...args: unknown[]) => { ops.push({ table: name, op: 'insert', args }); return Promise.resolve({ data: null, error: null }); });
  c.then = (resolve: any) => resolve(result);
  return c;
}

let cronService: any;
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => cronService }));

describe('processSuccessfulPayment closes the paid booking\'s open bank-transfer offer', () => {
  beforeEach(() => vi.clearAllMocks());

  function paidBookingSupabase(transferCloseError: unknown = null) {
    const ops: Op[] = [];
    const supabase: any = {
      from: vi.fn((name: string) => {
        if (name === 'bookings') {
          return table(name, ops, {
            data: { status: 'confirmed', deposit_status: 'paid', promo_code_id: null, metadata: {},
              business_id: 'biz-1', service_id: 'svc-1', guest_phone: '+2348000000000' },
            error: null,
          });
        }
        if (name === 'pending_transfers') return table(name, ops, { data: null, error: transferCloseError });
        if (name === 'businesses') {
          return table(name, ops, { data: { subscription_tier: 'free', trial_ends_at: null, payout_mode: 'platform_managed' }, error: null });
        }
        return table(name, ops, { data: null, error: null });
      }),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    return { supabase, ops };
  }

  const cardPayment = {
    id: 'pay-card', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null,
    reservation_id: null, order_id: null, gateway: 'paystack', gateway_fee: 0,
    metadata: { payment_origin: 'byo' },
  };

  it('sets only this booking\'s pending transfers to cancelled', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const { supabase, ops } = paidBookingSupabase();

    await processSuccessfulPayment(supabase, cardPayment);

    const transferOps = ops.filter((o) => o.table === 'pending_transfers');
    expect(transferOps).toEqual([
      { table: 'pending_transfers', op: 'update', args: [{ status: 'cancelled' }] },
      { table: 'pending_transfers', op: 'eq', args: ['booking_id', 'bk-1'] },
      { table: 'pending_transfers', op: 'eq', args: ['status', 'pending'] },
    ]);
  });

  it('a failure to close the transfer does not fail the booking payment', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const withoutError = await processSuccessfulPayment(paidBookingSupabase().supabase, cardPayment);
    const withError = await processSuccessfulPayment(paidBookingSupabase({ message: 'boom' }).supabase, cardPayment);

    expect(withError).toEqual(withoutError);
  });
});

describe('expire-transfers cron notifies only when it cancelled the booking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveByBusinessId.mockResolvedValue({ sender: { sendText: vi.fn() } });
  });

  function cronFor(bookingStillPending: boolean) {
    const ops: Op[] = [];
    const transfer = {
      id: 'xf-1', booking_id: 'bk-1', order_id: null, customer_phone: '+2348000000000',
      business_id: 'biz-1', reference_code: 'WA-2243', metadata: {}, businesses: { name: 'TestBiz' },
    };
    cronService = {
      from: vi.fn((name: string) => {
        if (name === 'pending_transfers') return table(name, ops, { data: [transfer], error: null });
        // update(...).in('status',['pending']).select('id') returns the rows it really changed
        if (name === 'bookings') return table(name, ops, { data: bookingStillPending ? [{ id: 'bk-1' }] : [], error: null });
        return table(name, ops, { data: null, error: null });
      }),
      rpc: vi.fn(),
    };
    return ops;
  }

  async function runCron() {
    const { POST } = await import('@/app/api/cron/expire-transfers/route');
    const res = await POST(new Request('http://x', { method: 'POST' }) as any);
    return res.json();
  }

  it('booking already paid (no longer pending): transfer expires, no cancellation notice', async () => {
    const ops = cronFor(false);
    const body = await runCron();

    expect(ops).toContainEqual({ table: 'pending_transfers', op: 'update', args: [{ status: 'expired' }] });
    expect(ops).toContainEqual({ table: 'bookings', op: 'in', args: ['status', ['pending']] });
    expect(mockSendOrEmail).not.toHaveBeenCalled();
    expect(body.expired).toBe(1);
  });

  it('unpaid booking really cancelled: customer still gets the expiry notice', async () => {
    cronFor(true);
    const body = await runCron();

    expect(mockSendOrEmail).toHaveBeenCalledTimes(1);
    const sent = mockSendOrEmail.mock.calls[0][0] as { text: string };
    expect(sent.text).toContain('your booking has been cancelled');
    expect(sent.text).toContain('WA-2243');
    expect(body.expired).toBe(1);
  });
});
