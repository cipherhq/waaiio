/**
 * Phase 2D R13 — route-level recovery contention.
 * Exercises the real dashboard confirm and reconciliation-cron route handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResume = vi.fn();
const mockProcess = vi.fn();
const mockSendConfirmation = vi.fn();
const mockReconcile = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })) },
}));
vi.mock('@/lib/observability/cron', () => ({
  createCronLogger: () => ({ started: vi.fn(), completed: vi.fn(), failed: vi.fn() }),
}));
vi.mock('@/lib/payments/authority', () => ({
  resumeSuccessfulPaymentFinalization: (...args: any[]) => mockResume(...args),
}));
vi.mock('@/lib/payments/process-success', () => ({
  processSuccessfulPayment: (...args: any[]) => mockProcess(...args),
}));
vi.mock('@/lib/payments/send-confirmation', () => ({
  sendProactiveConfirmation: (...args: any[]) => mockSendConfirmation(...args),
}));
vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: (...args: any[]) => mockReconcile(...args),
}));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByChannelIdForBusiness = vi.fn().mockResolvedValue(null);
    resolveByBusinessId = vi.fn().mockResolvedValue(null);
  },
}));
vi.mock('@/lib/channels/send-or-email', () => ({
  sendOrEmail: vi.fn(),
  findCustomerEmail: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/email/templates', () => ({
  businessNotificationEmail: () => ({ subject: 'T', html: '<p/>' }),
}));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (n: number) => `₦${n}` }));

function chain(data: any = null, error: any = null): any {
  const c: any = {};
  for (const method of ['select','eq','neq','not','is','or','lt','gt','in','order','limit','update','insert','delete']) {
    c[method] = vi.fn(() => c);
  }
  c.single = vi.fn().mockResolvedValue({ data, error });
  c.maybeSingle = vi.fn().mockResolvedValue({ data, error });
  c.then = (resolve: any) => resolve({ data: Array.isArray(data) ? data : (data == null ? [] : [data]), error });
  return c;
}

let paymentsQueryCount = 0;
const transfer = {
  id: 'xf-race', order_id: 'ord-race', booking_id: null, invoice_id: null,
  business_id: 'biz-1', customer_phone: '+234900', customer_name: 'Cust',
  status: 'pending', metadata: { _inbound_channel_id: 'ch-a' },
  reference_code: 'WA-RACE', expected_amount: 500000, currency: 'NGN',
};
const directPayment = {
  id: 'pay-race', amount: 5000, gateway: 'direct', gateway_reference: 'transfer:WA-RACE',
  booking_id: null, invoice_id: null, campaign_id: null, order_id: 'ord-race',
  metadata: { _direct_transfer: true, pending_transfer_id: 'xf-race', _inbound_channel_id: 'ch-a' },
  status: 'success', payment_authority_version: 1,
  finalization_completed_at: null, confirmation_sent_at: null,
  fee_policy_version: null, provider_init_state: null,
};

const serviceClient: any = {
  from: vi.fn((table: string) => {
    if (table === 'pending_transfers') return chain(transfer);
    if (table === 'businesses') return chain({ id: 'biz-1', name: 'Biz', country_code: 'NG', subscription_tier: 'growth' });
    if (table === 'payments') {
      paymentsQueryCount++;
      if (paymentsQueryCount === 1) return chain([directPayment]);
      if (paymentsQueryCount === 2) return chain([]);
      return chain([]);
    }
    return chain();
  }),
  rpc: vi.fn(async (name: string) => {
    if (name === 'confirm_order_transfer_atomic') {
      return { data: { confirmed: true, order_total: 5000, payment_id: 'pay-race', inbound_channel_id: 'ch-a' }, error: null };
    }
    return { data: null, error: null };
  }),
};

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => serviceClient }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'biz-1', subscription_tier: 'growth' }, error: null }),
    }),
  }),
}));

describe('Phase 2D dashboard-confirm vs recovery-cron contention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentsQueryCount = 0;
    vi.stubGlobal('fetch', mockFetch);
  });

  it('two route entry points produce one Stage 2 / Stage 3 effect set and direct cron does zero provider verification', async () => {
    let owned = false;
    let releaseProcess!: () => void;
    let processStarted!: () => void;
    const processStartedPromise = new Promise<void>(resolve => { processStarted = resolve; });
    const processGate = new Promise<void>(resolve => { releaseProcess = resolve; });

    mockProcess.mockImplementationOnce(async () => {
      processStarted();
      await processGate;
      return { criticalSuccess: true };
    });
    mockSendConfirmation.mockResolvedValue({ status: 'completed' });
    mockReconcile.mockResolvedValue({ lifecycle: { status: 'completed' } });

    mockResume.mockImplementation(async (sb: any, paymentId: string, processCb: any, sendCb: any) => {
      if (owned) {
        return {
          status: 'processing', retryable: true, reason: 'processing_in_progress',
          stages: { providerPaid: true, businessFinalized: false, customerConfirmed: false },
        };
      }
      owned = true;
      const processResult = await processCb(sb, {
        id: paymentId, amount: 5000, booking_id: null, invoice_id: null, campaign_id: null,
        reservation_id: null, order_id: 'ord-race',
        metadata: directPayment.metadata, gateway_fee: 0, gateway: 'direct', payment_authority_version: 1,
      });
      if (!processResult.criticalSuccess) throw new Error('unexpected Stage2 failure');
      const confirmation = await sendCb(sb, {
        id: paymentId, amount: 5000, booking_id: null, invoice_id: null, campaign_id: null,
        reservation_id: null, order_id: 'ord-race',
      }, { exactEntityFamily: true });
      owned = false;
      return {
        status: confirmation.status === 'completed' ? 'completed' : confirmation.status,
        retryable: confirmation.status !== 'completed',
        stages: { providerPaid: true, businessFinalized: true, customerConfirmed: confirmation.status === 'completed' },
      };
    });

    const { PATCH } = await import('@/app/api/dashboard/pending-transfers/[id]/route');
    const dashboardReq = new Request('http://x/api/dashboard/pending-transfers/xf-race', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'confirm', business_id: 'biz-1' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const dashboardPromise = PATCH(dashboardReq as any, { params: Promise.resolve({ id: 'xf-race' }) });
    await processStartedPromise;

    const { GET } = await import('@/app/api/cron/payment-reconciliation/route');
    const cronResponse = await GET(new Request('http://x/api/cron/payment-reconciliation') as any);

    releaseProcess();
    const dashboardResponse = await dashboardPromise;

    expect(dashboardResponse.status).toBe(200);
    expect(cronResponse.status).toBe(200);
    expect(mockResume).toHaveBeenCalledTimes(2);
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(mockSendConfirmation).toHaveBeenCalledTimes(1);

    // Direct recovery bypasses provider verification / generic reconciliation.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
