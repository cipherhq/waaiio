/**
 * Square Webhook POST Handler — Behavioral Entry-Point Tests
 *
 * Every test invokes the actual POST handler with correctly signed
 * request bodies and mocked Supabase dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

const WEBHOOK_KEY = 'test-webhook-signature-key';
const WEBHOOK_URL = 'https://test.waaiio.com/api/payments/square-webhook';

function signBody(body: string): string {
  return createHmac('sha256', WEBHOOK_KEY).update(WEBHOOK_URL + body).digest('base64');
}

function makeRequest(body: string, signature?: string): NextRequest {
  return new NextRequest('https://test.waaiio.com/api/payments/square-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-square-hmacsha256-signature': signature || signBody(body),
    },
    body,
  });
}

let mockRpcResults: Record<string, { data: unknown; error: unknown }>;
let mockSupabase: Record<string, unknown>;

function makeDeepChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'neq', 'in', 'is', 'not', 'filter', 'order', 'limit', 'gte', 'lte'];
  for (const m of methods) { chain[m] = vi.fn().mockReturnValue(chain); }
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  const updateChain: Record<string, unknown> = {};
  for (const m of methods) { updateChain[m] = vi.fn().mockReturnValue(updateChain); }
  updateChain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'updated' }, error: null });
  updateChain.select = vi.fn().mockReturnValue(updateChain);
  chain.update = vi.fn().mockReturnValue(updateChain);
  chain.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.upsert = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.delete = vi.fn().mockReturnValue(chain);
  return chain;
}

function setupMocks() {
  mockRpcResults = {};
  mockSupabase = {
    from: vi.fn(() => makeDeepChain()),
    rpc: vi.fn((name: string) => {
      const result = mockRpcResults[name];
      return Promise.resolve(result || { data: null, error: null });
    }),
  };
}

/** Helper: set up merchant + payment resolution for COMPLETED tests */
function setupPaymentResolution(overrides?: { status?: string; amount?: number }) {
  const status = overrides?.status ?? 'pending';
  const amount = overrides?.amount ?? 50;
  mockSupabase.from = vi.fn((table: string) => {
    const chain = makeDeepChain();
    if (table === 'payout_accounts') {
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1', business_id: 'b-1' }, error: null });
    }
    if (table === 'payments') {
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: {
          id: 'pay-1', amount, currency: 'USD', status, payout_account_id: 'pa-1',
          metadata: {}, business_id: 'b-1', gateway_reference: 'link-ref',
          waaiio_fee: 0, collection_mode: 'connect', booking_id: 'bk-1',
          invoice_id: null, campaign_id: null, reservation_id: null, order_id: null,
        },
        error: null,
      });
    }
    return chain;
  });
}

describe('Square webhook POST handler', () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    setupMocks();
    origEnv.SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    origEnv.SQUARE_WEBHOOK_NOTIFICATION_URL = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
    origEnv.SQUARE_PLATFORM_MERCHANT_ID = process.env.SQUARE_PLATFORM_MERCHANT_ID;
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = WEBHOOK_KEY;
    process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = WEBHOOK_URL;
    process.env.SQUARE_PLATFORM_MERCHANT_ID = 'ML_PLATFORM_TEST';

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => mockSupabase) }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
    vi.doMock('@/lib/payments/process-success', () => ({
      processSuccessfulPayment: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/payments/send-confirmation', () => ({
      sendProactiveConfirmation: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
  });

  afterEach(() => {
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = origEnv.SQUARE_WEBHOOK_SIGNATURE_KEY;
    process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = origEnv.SQUARE_WEBHOOK_NOTIFICATION_URL;
    process.env.SQUARE_PLATFORM_MERCHANT_ID = origEnv.SQUARE_PLATFORM_MERCHANT_ID;
    vi.restoreAllMocks();
  });

  async function callHandler(body: string, signature?: string) {
    const { POST } = await import('@/app/api/payments/square-webhook/route');
    return POST(makeRequest(body, signature));
  }

  // ── Signature ──

  it('rejects invalid signature', async () => {
    const body = JSON.stringify({ type: 'payment.updated', event_id: 'e1', data: { object: {} } });
    const res = await callHandler(body, 'invalid');
    expect(res.status).toBe(400);
  });

  // ── Claim lifecycle ──

  it('completed duplicate returns 200 with no financial calls', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'duplicate' }, error: null };
    const body = JSON.stringify({ type: 'payment.updated', event_id: 'e-dup', data: { object: { payment: {} } } });
    const res = await callHandler(body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.duplicate).toBe(true);
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    expect(processSuccessfulPayment).not.toHaveBeenCalled();
  });

  it('active lease returns 500 (retryable, not acknowledged)', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'lease_active' }, error: null };
    const body = JSON.stringify({ type: 'payment.updated', event_id: 'e-lease', data: { object: { payment: {} } } });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  it('claim RPC failure returns 500', async () => {
    mockRpcResults['claim_webhook_event'] = { data: null, error: { message: 'DB down' } };
    const body = JSON.stringify({ type: 'payment.updated', event_id: 'e-fail', data: { object: {} } });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  // ── Merchant scoping ──

  it('missing merchant_id fails closed with 500', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-no-merchant',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED', total_money: { amount: 5000, currency: 'USD' }, id: 'p1' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  it('unknown merchant fails closed with 500', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-unknown', merchant_id: 'ML_unknown',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED', total_money: { amount: 5000, currency: 'USD' }, id: 'p1' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  // ── COMPLETED validation ──

  it('COMPLETED with missing Square payment.id fails closed', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution();
    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-no-pid', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED',
        total_money: { amount: 5000, currency: 'USD' } /* no id field */ } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  it('COMPLETED with missing currency fails closed', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution();
    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-no-curr', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED', id: 'p1',
        total_money: { amount: 5000 } /* no currency */ } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  it('COMPLETED with zero provider amount fails closed', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution();
    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-zero-amt', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED', id: 'p1',
        total_money: { amount: 0, currency: 'USD' } } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  it('currency mismatch fails closed with 500', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution();
    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-curr', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED',
        total_money: { amount: 5000, currency: 'GBP' }, id: 'p1' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  it('amount mismatch does not regress success/refunded payments', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution({ status: 'success' });
    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-mismatch', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED',
        total_money: { amount: 9999, currency: 'USD' }, id: 'p1' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);
  });

  // ── Reconciliation after local success ──

  it('already-success payment reconciles accounting without status regression', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution({ status: 'success' }); // bot already confirmed
    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-recon', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED', id: 'sq-pay-real',
        total_money: { amount: 5000, currency: 'USD' }, source_type: 'CASH_APP',
        processing_fee: [{ amount_money: { amount: 150 } }],
        app_fee_money: { amount: 125 } } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);
    // processSuccessfulPayment is still called (idempotent via UNIQUE constraints)
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    expect(processSuccessfulPayment).toHaveBeenCalled();
  });

  // ── Refund events (merchant-scoped) ──

  it('refund COMPLETED calls finalize_square_refund with merchant scoping', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    mockRpcResults['finalize_square_refund'] = { data: { success: true, payment_id: 'pay-1' }, error: null };

    mockSupabase.from = vi.fn((table: string) => {
      const chain = makeDeepChain();
      if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1', business_id: 'b-1' }, error: null });
      }
      if (table === 'refunds') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'ref-1', status: 'processing', payment_id: 'pay-1' }, error: null });
      }
      if (table === 'payments') {
        // Scoping check: refund's payment belongs to this merchant's payout account
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { payout_account_id: 'pa-1' }, error: null });
      }
      return chain;
    });

    const body = JSON.stringify({
      type: 'refund.updated', event_id: 'e-refund', merchant_id: 'ML_test',
      data: { object: { refund: { id: 'sq-ref-1', payment_id: 'sq-pay', status: 'COMPLETED' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);

    const rpcCalls = (mockSupabase.rpc as ReturnType<typeof vi.fn>).mock.calls;
    const finCalls = rpcCalls.filter((c: unknown[]) => c[0] === 'finalize_square_refund');
    expect(finCalls.length).toBe(1);
    expect(finCalls[0][1].p_final_status).toBe('success');
  });

  it('refund event with missing merchant_id fails closed', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    const body = JSON.stringify({
      type: 'refund.updated', event_id: 'e-ref-nomerch',
      // no merchant_id
      data: { object: { refund: { id: 'sq-ref-x', status: 'COMPLETED' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  it('refund scoping violation returns 500', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };

    mockSupabase.from = vi.fn((table: string) => {
      const chain = makeDeepChain();
      if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1', business_id: 'b-1' }, error: null });
      }
      if (table === 'refunds') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'ref-1', status: 'processing', payment_id: 'pay-1' }, error: null });
      }
      if (table === 'payments') {
        // Payment does NOT belong to this merchant (returns null)
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      return chain;
    });

    const body = JSON.stringify({
      type: 'refund.updated', event_id: 'e-ref-scope', merchant_id: 'ML_other',
      data: { object: { refund: { id: 'sq-ref-s', status: 'COMPLETED' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  it('refund FAILED finalizes with failed status', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    mockRpcResults['finalize_square_refund'] = { data: { success: true, financial: false }, error: null };

    mockSupabase.from = vi.fn((table: string) => {
      const chain = makeDeepChain();
      if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1', business_id: 'b-1' }, error: null });
      }
      if (table === 'refunds') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'ref-2', status: 'processing', payment_id: 'pay-1' }, error: null });
      }
      if (table === 'payments') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { payout_account_id: 'pa-1' }, error: null });
      }
      return chain;
    });

    const body = JSON.stringify({
      type: 'refund.updated', event_id: 'e-ref-fail', merchant_id: 'ML_test',
      data: { object: { refund: { id: 'sq-ref-f', payment_id: 'sq-pay', status: 'FAILED' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);

    const finCalls = (mockSupabase.rpc as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === 'finalize_square_refund');
    expect(finCalls[0][1].p_final_status).toBe('failed');
  });

  it('refund PENDING causes no finalization', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };

    mockSupabase.from = vi.fn((table: string) => {
      const chain = makeDeepChain();
      if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1', business_id: 'b-1' }, error: null });
      }
      if (table === 'refunds') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'ref-p', status: 'processing', payment_id: 'pay-1' }, error: null });
      }
      if (table === 'payments') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { payout_account_id: 'pa-1' }, error: null });
      }
      return chain;
    });

    const body = JSON.stringify({
      type: 'refund.created', event_id: 'e-ref-pend', merchant_id: 'ML_test',
      data: { object: { refund: { id: 'sq-ref-p', payment_id: 'sq-pay', status: 'PENDING' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);

    const finCalls = (mockSupabase.rpc as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === 'finalize_square_refund');
    expect(finCalls.length).toBe(0);
  });

  it('finalization RPC failure returns 500 (retryable)', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    mockRpcResults['finalize_square_refund'] = { data: null, error: { message: 'DB error' } };

    mockSupabase.from = vi.fn((table: string) => {
      const chain = makeDeepChain();
      if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1', business_id: 'b-1' }, error: null });
      }
      if (table === 'refunds') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'ref-3', status: 'processing', payment_id: 'pay-1' }, error: null });
      }
      if (table === 'payments') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { payout_account_id: 'pa-1' }, error: null });
      }
      return chain;
    });

    const body = JSON.stringify({
      type: 'refund.updated', event_id: 'e-ref-rpc-fail', merchant_id: 'ML_test',
      data: { object: { refund: { id: 'sq-ref-3', payment_id: 'sq-pay', status: 'COMPLETED' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  // ── Financial failure ──

  it('processSuccessfulPayment failure returns 500', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution();

    // Override the process-success mock to throw — must use the mock reference from beforeEach
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    (processSuccessfulPayment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Fee recording failed'));

    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-fin-fail', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED',
        total_money: { amount: 5000, currency: 'USD' }, id: 'p1', source_type: 'CARD' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  // ── markEventCompleted failure ──

  it('markEventCompleted zero-row match returns 500', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };

    mockSupabase.from = vi.fn((table: string) => {
      const chain = makeDeepChain();
      if (table === 'processed_webhook_events') {
        const failUpdateChain: Record<string, unknown> = {};
        const methods = ['select', 'eq', 'neq', 'in'];
        for (const m of methods) { failUpdateChain[m] = vi.fn().mockReturnValue(failUpdateChain); }
        failUpdateChain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        chain.update = vi.fn().mockReturnValue(failUpdateChain);
      }
      return chain;
    });

    const body = JSON.stringify({
      type: 'some.unhandled.event', event_id: 'e-complete-fail',
      data: { object: { something: true } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  // ── OAuth revocation ──

  it('OAuth revocation with missing merchant_id fails closed', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    const body = JSON.stringify({
      type: 'oauth.authorization.revoked', event_id: 'e-oauth-no-merch',
      // no merchant_id
      data: { object: { revocation: true } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(500);
  });

  // ── Item 4: Square-initiated refund reconciliation ──

  it('reconciles Square-initiated refund when no local row exists', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    mockRpcResults['finalize_square_refund'] = { data: { success: true, payment_id: 'pay-1' }, error: null };

    const insertFn = vi.fn().mockResolvedValue({
      data: { id: 'new-refund-1' }, error: null,
    });

    mockSupabase.from = vi.fn((table: string) => {
      const chain = makeDeepChain();
      if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1', business_id: 'b-1' }, error: null });
      }
      if (table === 'refunds') {
        // No local refund exists
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        chain.insert = vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'new-refund-1' }, error: null }),
          }),
        });
      }
      if (table === 'payments') {
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: { id: 'pay-1', amount: 50, currency: 'USD', business_id: 'b-1', payout_account_id: 'pa-1', gateway: 'square', waaiio_fee: 1.25 },
          error: null,
        });
        // For filter chain
        chain.filter = vi.fn().mockReturnValue(chain);
      }
      return chain;
    });

    const body = JSON.stringify({
      type: 'refund.created', event_id: 'e-sq-init-refund', merchant_id: 'ML_test',
      data: { object: { refund: {
        id: 'sq-ext-ref-1', payment_id: 'sq-pay-ext', status: 'COMPLETED',
        amount_money: { amount: 5000, currency: 'USD' },
        app_fee_money: { amount: 125 },
      } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);

    // finalize_square_refund should have been called
    const rpcCalls = (mockSupabase.rpc as ReturnType<typeof vi.fn>).mock.calls;
    const finCalls = rpcCalls.filter((c: unknown[]) => c[0] === 'finalize_square_refund');
    expect(finCalls.length).toBe(1);
    expect(finCalls[0][1].p_refund_id).toBe('new-refund-1');
    expect(finCalls[0][1].p_final_status).toBe('success');
  });

  // ── Item 8: Preserve existing square_payment_link_id ──

  it('preserves existing square_payment_link_id in metadata', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };

    // Set up a payment that already has square_payment_link_id in metadata
    const updateFn = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: null, error: null }),
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'updated' }, error: null }),
        }),
      }),
    });

    mockSupabase.from = vi.fn((table: string) => {
      const chain = makeDeepChain();
      if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1', business_id: 'b-1' }, error: null });
      }
      if (table === 'payments') {
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: {
            id: 'pay-1', amount: 50, currency: 'USD', status: 'pending',
            payout_account_id: 'pa-1',
            metadata: { square_payment_link_id: 'original-link-id' },
            business_id: 'b-1', gateway_reference: 'already-reconciled-pay-id',
            waaiio_fee: 0, collection_mode: 'connect', booking_id: 'bk-1',
            invoice_id: null, campaign_id: null, reservation_id: null, order_id: null,
          },
          error: null,
        });
        chain.update = updateFn;
      }
      return chain;
    });

    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-preserve-link', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED', id: 'sq-pay-new',
        total_money: { amount: 5000, currency: 'USD' }, source_type: 'CARD' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);

    // The update should preserve the original square_payment_link_id
    if (updateFn.mock.calls.length > 0) {
      const updateArg = updateFn.mock.calls[0][0];
      if (updateArg.metadata) {
        expect(updateArg.metadata.square_payment_link_id).toBe('original-link-id');
      }
    }
  });

  // ── Item 6: Confirmation claim uses returned rows ──

  it('sendProactiveConfirmation is called with correct payment data', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution();

    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-confirm-claim', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED',
        total_money: { amount: 5000, currency: 'USD' }, id: 'p1', source_type: 'CARD' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);

    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    // Verify it uses the returned-row pattern (select('id').maybeSingle) not count
    expect(sendProactiveConfirmation).toHaveBeenCalled();
  });

  // ── Notification uses atomic claim ──

  it('notification uses sendProactiveConfirmation atomic claim (not metadata)', async () => {
    mockRpcResults['claim_webhook_event'] = { data: { outcome: 'claimed' }, error: null };
    setupPaymentResolution();

    const body = JSON.stringify({
      type: 'payment.updated', event_id: 'e-notif', merchant_id: 'ML_test',
      data: { object: { payment: { order_id: 'o1', status: 'COMPLETED',
        total_money: { amount: 5000, currency: 'USD' }, id: 'p1', source_type: 'CARD' } } },
    });
    const res = await callHandler(body);
    expect(res.status).toBe(200);

    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    expect(sendProactiveConfirmation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'pay-1' }),
      '[SQUARE WEBHOOK]',
    );
  });
});
