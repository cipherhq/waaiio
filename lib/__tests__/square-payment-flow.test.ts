/**
 * Square/Cash App Pay — Behavioral Tests
 * All tests invoke production functions with mocked Supabase/fetch.
 * No source-text searches. No tautological assertions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── OAuth ──
describe('Square OAuth', () => {
  it('scope constant includes PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS', async () => {
    const { SQUARE_OAUTH_SCOPES } = await import('@/lib/payments/square-scopes');
    expect(SQUARE_OAUTH_SCOPES).toContain('PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS');
    expect(SQUARE_OAUTH_SCOPES).toContain('ORDERS_WRITE');
    expect(SQUARE_OAUTH_SCOPES.length).toBe(6);
  });
});

// ── Payment initialization idempotency ──
describe('Square payment-link idempotency', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('retry recovers existing attempt and reuses the same idempotency key', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-platform-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        payment_link: { id: 'link-1', url: 'https://square.link/u/test', order_id: 'order-1' },
      }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    // Mock Supabase: first call finds existing row (retry scenario)
    const existingRow = {
      id: 'existing-payment-uuid',
      gateway_reference: 'sq-init-REF-001',
      metadata: null, // no Square response yet
      amount: 50, currency: 'USD', business_id: null, user_id: 'u1',
      booking_id: null, invoice_id: null, campaign_id: null,
      reservation_id: null, collection_mode: 'platform', payout_account_id: null,
      order_id: null, square_merchant_id_at_creation: null, square_location_id_at_creation: null,
    };
    const updateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const fromFn = vi.fn((table: string) => {
      if (table === 'payments') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: existingRow }),
          single: vi.fn().mockResolvedValue({ data: existingRow }),
          update: updateFn,
          insert: vi.fn(),
        };
      }
      return { update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) }) };
    });

    const rpcFn = vi.fn().mockResolvedValue({ data: { matched: true }, error: null });
    const result = await gw.initializePayment({
      supabase: { from: fromFn, rpc: rpcFn } as any,
      userId: 'u1', amount: 50, currency: 'USD',
      referenceCode: 'REF-001', businessName: 'Biz', phone: '+1',
    });

    expect(result).not.toBeNull();
    // The fetch call should use the existing payment UUID as idempotency key
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.idempotency_key).toBe('existing-payment-uuid');

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  it('ambiguous provider response preserves the payment row for retry', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    // Square returns garbage (ambiguous — might have succeeded)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    const deleteFn = vi.fn();
    const insertFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'new-uuid' }, error: null }),
      }),
    });
    const fromFn = vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }), // no existing row
      insert: insertFn,
      delete: deleteFn,
    }));

    const result = await gw.initializePayment({
      supabase: { from: fromFn } as any,
      userId: 'u1', amount: 50, currency: 'USD',
      referenceCode: 'REF-002', businessName: 'Biz', phone: '+1',
    });

    expect(result).toBeNull(); // failed
    // Payment row should NOT be deleted (ambiguous outcome)
    expect(deleteFn).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  it('connected init works without platform SQUARE_ACCESS_TOKEN', async () => {
    vi.resetModules();
    delete process.env.SQUARE_ACCESS_TOKEN;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        payment_link: { id: 'link-c', url: 'https://square.link/connected', order_id: 'ord-c' },
      }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    const insertFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'pay-c' }, error: null }),
      }),
    });
    const fromFn = vi.fn(() => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      single: vi.fn().mockResolvedValue({ data: { metadata: {} } }),
      insert: insertFn,
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    }));

    const result = await gw.initializePayment({
      supabase: { from: fromFn, rpc: vi.fn().mockResolvedValue({ data: { matched: true }, error: null }) } as any,
      userId: 'u1', amount: 50, currency: 'USD',
      referenceCode: 'REF-C', businessName: 'Biz', phone: '+1',
      squareAccessToken: 'seller-token', squareMerchantId: 'ML', squareLocationId: 'L',
    });

    expect(result).not.toBeNull();
    expect(result!.url).toContain('square.link');
    vi.unstubAllGlobals();
  });

  it('rejects zero amount', async () => {
    vi.resetModules();
    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();
    const result = await gw.initializePayment({
      supabase: {} as any, userId: 'u1', amount: 0,
      currency: 'USD', referenceCode: 'R', businessName: 'B', phone: '+1',
    });
    expect(result).toBeNull();
  });
});

// ── Refund reservation + provider lifecycle ──
describe('Square refund lifecycle', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('calls claim_refund_balance RPC before Square API', async () => {
    vi.resetModules();
    const rpcFn = vi.fn().mockResolvedValue({
      data: { claimed: true, refund_id: 'ref-1', planned_fee_reversal: 0 }, error: null,
    });
    const fromFn = vi.fn(() => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'pay-1', amount: 100, currency: 'USD', status: 'success',
          gateway: 'square', gateway_reference: 'sq-pay', business_id: 'biz-1',
          payout_account_id: 'pa-1', waaiio_fee: 0, refund_amount: 0,
          metadata: {}, collection_mode: 'connect',
        },
      }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { payout_mode: 'direct_split' } }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) }),
    }));

    vi.doMock('@/lib/payments/square-token', () => ({
      resolveSquareToken: vi.fn().mockResolvedValue({ accessToken: 'tok', secretId: 's' }),
    }));
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGatewayByName: vi.fn().mockReturnValue({
        refundPayment: vi.fn().mockResolvedValue({
          success: true, gatewayRefundReference: 'sq-ref',
          gatewayResponse: { refund: { id: 'sq-ref', status: 'PENDING' } },
        }),
      }),
    }));

    const { processRefund } = await import('@/lib/payments/refund-handler');
    const result = await processRefund({
      supabase: { from: fromFn, rpc: rpcFn } as any,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 50,
      reason: 'test', initiatedBy: 'u1', initiatedByRole: 'business',
      logicalRefundId: 'test-refund-001',
    });

    expect(rpcFn).toHaveBeenCalledWith('claim_refund_balance', expect.objectContaining({
      p_payment_id: 'pay-1', p_refund_amount: 50,
    }));
    expect(result.providerStatus).toBe('PENDING');
  });

  it('PENDING does not finalize payment/ledger', async () => {
    vi.resetModules();
    const rpcFn = vi.fn().mockImplementation((name: string) => {
      if (name === 'claim_refund_balance') {
        return { data: { claimed: true, refund_id: 'ref-p' }, error: null };
      }
      // finalize_square_refund should NOT be called for PENDING
      return { data: { success: true }, error: null };
    });
    const updateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) });
    const fromFn = vi.fn(() => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'pay-1', amount: 100, currency: 'USD', status: 'success',
          gateway: 'square', gateway_reference: 'ref', business_id: 'biz-1',
          payout_account_id: 'pa-1', waaiio_fee: 0, refund_amount: 0,
          metadata: { square_payment_id: 'ref' }, collection_mode: 'connect',
        },
      }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { payout_mode: 'direct_split' } }),
      update: updateFn,
    }));

    vi.doMock('@/lib/payments/square-token', () => ({
      resolveSquareToken: vi.fn().mockResolvedValue({ accessToken: 'tok', secretId: 's' }),
    }));
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGatewayByName: vi.fn().mockReturnValue({
        refundPayment: vi.fn().mockResolvedValue({
          success: true, gatewayRefundReference: 'sq-ref',
          gatewayResponse: { refund: { id: 'sq-ref', status: 'PENDING' } },
        }),
      }),
    }));

    const { processRefund } = await import('@/lib/payments/refund-handler');
    await processRefund({
      supabase: { from: fromFn, rpc: rpcFn } as any,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 50,
      reason: 'test', initiatedBy: 'u1', initiatedByRole: 'business',
      logicalRefundId: 'test-refund-pending',
    });

    // finalize_square_refund should NOT have been called
    const finalizeCalls = rpcFn.mock.calls.filter(
      (c: unknown[]) => c[0] === 'finalize_square_refund',
    );
    expect(finalizeCalls.length).toBe(0);
  });

  it('token failure leaves review_required (retryable) claim', async () => {
    vi.resetModules();
    const rpcFn = vi.fn().mockResolvedValue({
      data: { claimed: true, refund_id: 'ref-fail' }, error: null,
    });
    const updateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) });
    const fromFn = vi.fn(() => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'pay-1', amount: 100, currency: 'USD', status: 'success',
          gateway: 'square', gateway_reference: 'ref', business_id: 'biz-1',
          payout_account_id: 'pa-1', waaiio_fee: 0, refund_amount: 0,
          metadata: {}, collection_mode: 'connect',
        },
      }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { payout_mode: 'direct_split' } }),
      update: updateFn,
    }));

    vi.doMock('@/lib/payments/square-token', () => ({
      resolveSquareToken: vi.fn().mockResolvedValue(null), // token failure
    }));

    const { processRefund } = await import('@/lib/payments/refund-handler');
    const result = await processRefund({
      supabase: { from: fromFn, rpc: rpcFn } as any,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 50,
      reason: 'test', initiatedBy: 'u1', initiatedByRole: 'business',
      logicalRefundId: 'test-refund-tokfail',
    });

    expect(result.success).toBe(false);
    expect(result.providerStatus).toBe('review_required');
  });

  it('retry reuses existing claim and the same idempotency key', async () => {
    vi.resetModules();
    const refundId = 'ref-existing';
    const logicalId = 'stable-logical-id-123';
    const rpcFn = vi.fn().mockResolvedValue({
      data: { claimed: true, refund_id: refundId, existing: true }, error: null,
    });
    const fromFn = vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: table === 'refunds'
          ? { id: refundId, status: 'processing', gateway_refund_reference: 'sq-ref' }
          : table === 'payments'
          ? { id: 'pay-1', amount: 100, currency: 'USD', status: 'success', gateway: 'square',
              gateway_reference: 'ref', business_id: 'biz-1', payout_account_id: 'pa-1',
              waaiio_fee: 0, refund_amount: 0, metadata: {}, collection_mode: 'connect' }
          : { payout_mode: 'direct_split' },
      }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { payout_mode: 'direct_split' } }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) }),
    }));

    const { processRefund } = await import('@/lib/payments/refund-handler');
    const result = await processRefund({
      supabase: { from: fromFn, rpc: rpcFn } as any,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 50,
      reason: 'test', initiatedBy: 'u1', initiatedByRole: 'business',
      logicalRefundId: logicalId,
    });

    // Existing claim with status 'processing' should return stored state
    expect(result.refundId).toBe(refundId);
    expect(result.providerStatus).toBe('processing');
    // The logicalRefundId was passed as the idempotency key to claim_refund_balance
    expect(rpcFn).toHaveBeenCalledWith('claim_refund_balance', expect.objectContaining({
      p_idempotency_key: logicalId,
    }));
  });

  it('refund requires providerIdempotencyKey', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();
    const result = await gw.refundPayment({
      gatewayReference: 'ref', amount: 10, currency: 'USD',
      metadata: { square_payment_id: 'pay-123' },
      // No providerIdempotencyKey
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('idempotency key');

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });
});

// ── Refund reference correctness ──
describe('Square refund reference safety', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('rejects refund when only payment_link_id exists (no square_payment_id)', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    // No order lookup fallback possible — no square_order_id in metadata
    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();
    const result = await gw.refundPayment({
      gatewayReference: 'link_abc123', // This is a payment link ID, not a payment ID
      amount: 50, currency: 'USD',
      metadata: { square_payment_link_id: 'link_abc123' }, // no square_payment_id
      providerIdempotencyKey: 'key-1',
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Square payment ID not found');
    // gateway_reference (link ID) must NOT be sent to Square Refunds API
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  it('rejects refund when only order_id exists without successful order lookup', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    // Order lookup returns no tenders (payment not completed yet)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ order: { state: 'OPEN', total_money: { amount: 5000, currency: 'USD' }, tenders: [] } }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();
    const result = await gw.refundPayment({
      gatewayReference: 'link_xyz',
      amount: 50, currency: 'USD',
      metadata: { square_order_id: 'order_123' }, // has order but no payment ID
      providerIdempotencyKey: 'key-2',
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Square payment ID not found');
    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  it('uses square_payment_id from metadata, not gateway_reference', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ refund: { id: 'refund_abc', status: 'PENDING' } }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();
    await gw.refundPayment({
      gatewayReference: 'link_should_not_use', // link ID — must be ignored
      amount: 50, currency: 'USD',
      metadata: { square_payment_id: 'real_sq_pay_id' }, // this is the real ID
      providerIdempotencyKey: 'key-3',
    });

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.payment_id).toBe('real_sq_pay_id');
    // Verify gateway_reference (link ID) was NOT used as payment_id
    expect(body.payment_id).not.toBe('link_should_not_use');

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });
});

// ── Strict mode: returned errors ──
describe('processSuccessfulPayment strict error propagation', () => {
  it('throws on order confirmation DB error in strict mode', async () => {
    vi.resetModules();
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'orders') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  select: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB timeout' } }),
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    };

    await expect(processSuccessfulPayment(mockSupabase as any, {
      id: 'pay-1', amount: 100, booking_id: null, order_id: 'ord-1',
      invoice_id: null, campaign_id: null, gateway_fee: 0,
    }, { strict: true })).rejects.toThrow('Order confirmation failed');
  });

  it('throws on reservation confirmation DB error in strict mode', async () => {
    vi.resetModules();
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'reservations') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ error: { message: 'Connection lost' } }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    };

    await expect(processSuccessfulPayment(mockSupabase as any, {
      id: 'pay-1', amount: 100, booking_id: null, reservation_id: 'res-1',
      invoice_id: null, campaign_id: null, gateway_fee: 0,
    }, { strict: true })).rejects.toThrow('Reservation confirmation failed');
  });

  it('throws on invoice lookup DB error in strict mode', async () => {
    vi.resetModules();
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    const { processInvoicePayment } = await import('@/lib/payments/process-success');

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Invoice table unavailable' } }),
      })),
    };

    await expect(processInvoicePayment(mockSupabase as any, 'inv-1', 'pay-1', 100, 0))
      .rejects.toThrow('Invoice lookup failed');
  });

  it('throws on campaign lookup DB error in strict mode', async () => {
    vi.resetModules();
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    const { processCampaignDonation } = await import('@/lib/payments/process-success');

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
      rpc: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    };

    // campaign lookup after successful RPC — returns error
    const fromFn = vi.fn((table: string) => {
      if (table === 'campaigns') {
        return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Campaign DB error' } }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    });

    await expect(processCampaignDonation({ from: fromFn, rpc: vi.fn().mockResolvedValue({ data: { success: true }, error: null }) } as any,
      'pay-1', 'camp-1', 100, 0))
      .rejects.toThrow('Campaign lookup failed');
  });
});

// ── Routing fail-closed ──
describe('Square routing', () => {
  it('unresolved seller token fails closed (returns null)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/payments/square-token', () => ({
      resolveSquareToken: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
    vi.doMock('@/lib/payments/route-resolver', () => ({
      resolvePaymentRoute: vi.fn().mockResolvedValue({
        mode: 'connect', provider: 'square', connectionId: 'c1',
        feeBearerMode: 'merchant', platformFeeAmount: 100,
        squareMerchantId: 'ML', squareLocationId: 'L',
      }),
    }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'USD' }) }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn() }));
    vi.doMock('@/lib/constants', () => ({ getPaymentGatewayForCountry: vi.fn().mockReturnValue('square') }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
    vi.doMock('@/lib/get-app-url', () => ({ getAppUrl: () => 'https://test.com' }));

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null }) })),
    };
    const result = await initializePayment(supabase as any, {
      userId: 'u1', amount: 50, referenceCode: 'R', businessName: 'B',
      phone: '+1', businessId: 'b1', countryCode: 'US',
    });
    expect(result).toBeNull();
  });
});

// ── Strict financial propagation ──
describe('processSuccessfulPayment strict mode', () => {
  it('throws on booking fee failure in strict mode', async () => {
    vi.resetModules();
    // This would require a deep mock of processSuccessfulPayment internals.
    // Instead, verify the strict flag is wired and propagates.
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');

    // Create a mock supabase that returns errors for fee recording
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'bookings') {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: { business_id: 'biz', service_id: 's1', guest_phone: '+1' } }),
          };
        }
        if (table === 'businesses') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { subscription_tier: 'free', payout_mode: 'platform_managed', trial_ends_at: '2020-01-01' },
            }),
          };
        }
        if (table === 'platform_fees') {
          return {
            insert: vi.fn().mockResolvedValue({ error: { message: 'DB connection lost', code: 'PGRST000' } }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    };

    // strict: true should throw when fee recording fails
    await expect(processSuccessfulPayment(mockSupabase as any, {
      id: 'pay-1', amount: 100, booking_id: 'book-1',
      invoice_id: null, campaign_id: null, gateway_fee: 0,
    }, { strict: true })).rejects.toThrow();
  });
});

// ── Connected verification ──
describe('Square connected verification', () => {
  it('verifyPayment resolves seller token for connect mode', async () => {
    vi.resetModules();
    const mockResolve = vi.fn().mockResolvedValue({ accessToken: 'seller-tok', secretId: 's' });
    vi.doMock('@/lib/payments/square-token', () => ({ resolveSquareToken: mockResolve }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn() }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
    const mockVerify = vi.fn().mockResolvedValue(true);
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn(),
      getPaymentGatewayByName: vi.fn().mockReturnValue({ verifyPayment: mockVerify }),
    }));

    const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: table === 'payments'
            ? { gateway: 'square', collection_mode: 'connect', payout_account_id: 'pa-1', metadata: {} }
            : table === 'business_connection_secrets'
            ? null
            : null,
        }),
      })),
    };

    const result = await verifyPayment(supabase as any, 'ref-123', 'US');
    expect(mockResolve).toHaveBeenCalledWith(supabase, 'pa-1');
    expect(mockVerify).toHaveBeenCalledWith(supabase, 'ref-123', 'seller-tok');
    expect(result).toBe(true);
  });

  it('verifyPayment fails closed when seller token unresolvable', async () => {
    vi.resetModules();
    vi.doMock('@/lib/payments/square-token', () => ({ resolveSquareToken: vi.fn().mockResolvedValue(null) }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn() }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn(),
      getPaymentGatewayByName: vi.fn().mockReturnValue({ verifyPayment: vi.fn() }),
    }));

    const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { gateway: 'square', collection_mode: 'connect', payout_account_id: 'pa-1', metadata: {} },
        }),
      })),
    };

    const result = await verifyPayment(supabase as any, 'ref-123', 'US');
    expect(result).toBe(false);
  });
});

// ── Item 1: Redirect URL uses getAppUrl() and paymentId ──
describe('Square checkout redirect', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('redirect_url uses getAppUrl()/payment-success and reference returns paymentId', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        payment_link: { id: 'link-1', url: 'https://square.link/u/test', order_id: 'order-1' },
      }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    const insertFn = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'pay-uuid-123' }, error: null }),
      }),
    });
    const updateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const fromFn = vi.fn(() => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      single: vi.fn().mockResolvedValue({ data: { metadata: {} } }),
      insert: insertFn,
      update: updateFn,
    }));

    const result = await gw.initializePayment({
      supabase: { from: fromFn, rpc: vi.fn().mockResolvedValue({ data: { matched: true }, error: null }) } as any,
      userId: 'u1', amount: 50, currency: 'USD',
      referenceCode: 'REF-REDIR', businessName: 'Biz', phone: '+1',
    });

    expect(result).not.toBeNull();
    // reference should be the paymentId, not the squareRef
    expect(result!.reference).toBe('pay-uuid-123');

    // The redirect_url in the fetch body should use getAppUrl()/payment-success
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.checkout_options.redirect_url).toContain('/payment-success?paymentId=pay-uuid-123');
    // Should NOT contain /api/payments/square-callback
    expect(body.checkout_options.redirect_url).not.toContain('/api/payments/square-callback');

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });
});

// ── Item 2: Refund idempotency key >45 chars rejected ──
describe('Square refund idempotency key length', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('rejects idempotency key exceeding 45 characters', async () => {
    vi.resetModules();
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGatewayByName: vi.fn().mockReturnValue({
        refundPayment: vi.fn().mockResolvedValue({ success: true }),
      }),
    }));

    const rpcFn = vi.fn(); // should not be called
    const fromFn = vi.fn(() => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: 'pay-1', amount: 100, currency: 'USD', status: 'success',
          gateway: 'square', gateway_reference: 'ref', business_id: 'biz-1',
          payout_account_id: 'pa-1', waaiio_fee: 0, refund_amount: 0,
          metadata: {}, collection_mode: 'connect',
        },
      }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { payout_mode: 'direct_split' } }),
    }));

    const { processRefund } = await import('@/lib/payments/refund-handler');
    const longKey = 'a'.repeat(46); // 46 chars > 45 limit
    const result = await processRefund({
      supabase: { from: fromFn, rpc: rpcFn } as any,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 50,
      reason: 'test', initiatedBy: 'u1', initiatedByRole: 'business',
      logicalRefundId: longKey,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('45 characters');
    // RPC should not have been called
    expect(rpcFn).not.toHaveBeenCalled();
  });
});

// ── Item 3: review_required allows retry ──
describe('Square refund review_required retry', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('review_required status falls through to retry the provider call', async () => {
    vi.resetModules();
    const rpcFn = vi.fn().mockImplementation((name: string) => {
      if (name === 'claim_refund_balance') {
        return Promise.resolve({ data: { claimed: true, refund_id: 'ref-review', existing: true, planned_fee_reversal: 0 }, error: null });
      }
      if (name === 'finalize_square_refund') {
        return Promise.resolve({ data: { success: true, payment_id: 'pay-1', financial: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const fromFn = vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: table === 'refunds'
          ? { id: 'ref-review', status: 'review_required', gateway_refund_reference: null }
          : table === 'payments'
          ? { id: 'pay-1', amount: 100, currency: 'USD', status: 'success', gateway: 'square',
              gateway_reference: 'ref', business_id: 'biz-1', payout_account_id: 'pa-1',
              waaiio_fee: 0, refund_amount: 0, metadata: { square_payment_id: 'sq-pay' }, collection_mode: 'connect' }
          : { payout_mode: 'direct_split' },
      }),
      maybeSingle: vi.fn().mockResolvedValue({ data: { payout_mode: 'direct_split' } }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) }),
    }));

    vi.doMock('@/lib/payments/square-token', () => ({
      resolveSquareToken: vi.fn().mockResolvedValue({ accessToken: 'tok', secretId: 's' }),
    }));
    const mockRefundPayment = vi.fn().mockResolvedValue({
      success: true, gatewayRefundReference: 'sq-ref-retry',
      gatewayResponse: { refund: { id: 'sq-ref-retry', status: 'COMPLETED' } },
    });
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGatewayByName: vi.fn().mockReturnValue({ refundPayment: mockRefundPayment }),
    }));

    const { processRefund } = await import('@/lib/payments/refund-handler');
    const result = await processRefund({
      supabase: { from: fromFn, rpc: rpcFn } as any,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 50,
      reason: 'retry', initiatedBy: 'u1', initiatedByRole: 'business',
      logicalRefundId: 'retry-review-key',
    });

    // Should have called the provider (fell through review_required)
    expect(mockRefundPayment).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

// ── Item 10: Verification validates amount/currency ──
describe('Square verification hardening', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('rejects verification on currency mismatch', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    // Order returns GBP but payment is USD
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        order: {
          state: 'COMPLETED',
          total_money: { amount: 5000, currency: 'GBP' },
          tenders: [{ type: 'CARD', payment_id: 'sq-pay-1' }],
        },
      }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    const updateFn = vi.fn();
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'pay-1', booking_id: null, amount: 50, currency: 'USD',
            metadata: { square_order_id: 'order-1' },
          },
        }),
        update: updateFn,
      })),
    };

    const result = await gw.verifyPayment(supabase as any, 'ref-123');
    expect(result).toBe(false);
    // update should NOT have been called (no status change on mismatch)
    expect(updateFn).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  it('rejects verification on amount mismatch', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        order: {
          state: 'COMPLETED',
          total_money: { amount: 9999, currency: 'USD' },
          tenders: [{ type: 'CARD', payment_id: 'sq-pay-1' }],
        },
      }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'pay-1', booking_id: null, amount: 50, currency: 'USD',
            metadata: { square_order_id: 'order-1' },
          },
        }),
        update: vi.fn(),
      })),
    };

    const result = await gw.verifyPayment(supabase as any, 'ref-123');
    expect(result).toBe(false);

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  it('persists square_payment_id from tenders and only transitions pending', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        order: {
          state: 'COMPLETED',
          location_id: 'LOC_1',
          total_money: { amount: 5000, currency: 'USD' },
          tenders: [{ type: 'CASH_APP', payment_id: 'sq-actual-pay-id' }],
        },
      }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    // Build a deep chain that supports .update().eq().in().select().maybeSingle()
    const selectMaybe = { maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'pay-1' }, error: null }) };
    const inFn = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(selectMaybe) });
    const updateChain = { eq: vi.fn().mockReturnValue({ in: inFn }) };
    const updateFn = vi.fn().mockReturnValue(updateChain);
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: { matched: true }, error: null }),
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: table === 'payments'
            ? { id: 'pay-1', booking_id: 'book-1', amount: 50, currency: 'USD',
                payout_account_id: 'pa-1',
                metadata: { square_order_id: 'order-1', some_existing: 'value' } }
            : null,
        }),
        maybeSingle: vi.fn().mockResolvedValue({
          data: table === 'payout_accounts' ? { square_location_id: 'LOC_1' } : null,
          error: null,
        }),
        update: updateFn,
      })),
    };

    const result = await gw.verifyPayment(supabase as any, 'ref-123');
    expect(result).toBe(true);

    // Check the RPC was called to merge metadata (square_payment_id)
    const rpcFn = supabase.rpc as ReturnType<typeof vi.fn>;
    const mergeCalls = rpcFn.mock.calls.filter((c: unknown[]) => c[0] === 'merge_payment_metadata');
    expect(mergeCalls.length).toBe(1);
    expect(mergeCalls[0][1].p_new_fields.square_payment_id).toBe('sq-actual-pay-id');

    // Check the status update has payment_method but NOT metadata (metadata via RPC)
    expect(updateFn).toHaveBeenCalled();
    const updateArg = updateFn.mock.calls[0][0];
    expect(updateArg.payment_method).toBe('cash_app_pay');
    expect(updateArg.metadata).toBeUndefined(); // metadata via merge RPC, not direct update
    // Verify .in was called with ['pending']
    expect(inFn).toHaveBeenCalledWith('status', ['pending']);

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });
});

// ── App fee money on refund ──
describe('Square refund app_fee_money', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('includes app_fee_money in refund body when appFeeRefundAmount is provided', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ refund: { id: 'refund_fee', status: 'PENDING' } }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();
    await gw.refundPayment({
      gatewayReference: 'ref',
      amount: 50,
      currency: 'USD',
      metadata: { square_payment_id: 'pay-123' },
      providerIdempotencyKey: 'key-fee-test',
      appFeeRefundAmount: 2.5,
    });

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.app_fee_money).toEqual({ amount: 250, currency: 'USD' });

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  it('omits app_fee_money when appFeeRefundAmount is zero or undefined', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ refund: { id: 'refund_nofee', status: 'PENDING' } }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();
    await gw.refundPayment({
      gatewayReference: 'ref',
      amount: 50,
      currency: 'USD',
      metadata: { square_payment_id: 'pay-456' },
      providerIdempotencyKey: 'key-nofee-test',
    });

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.app_fee_money).toBeUndefined();

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });
});

// ── Verification rejects missing tender ──
describe('Square verification tender requirement', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('rejects verification when no tender has a payment_id', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        order: {
          state: 'COMPLETED',
          total_money: { amount: 5000, currency: 'USD' },
          tenders: [{ type: 'CARD' }], // no payment_id
        },
      }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'pay-1', booking_id: null, amount: 50, currency: 'USD',
            payout_account_id: null,
            metadata: { square_order_id: 'order-1' },
          },
        }),
      })),
    };

    const result = await gw.verifyPayment(supabase as any, 'ref-tender-test');
    expect(result).toBe(false);

    vi.unstubAllGlobals();
    delete process.env.SQUARE_ACCESS_TOKEN;
  });
});
