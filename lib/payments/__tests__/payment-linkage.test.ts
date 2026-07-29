import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InitPaymentOpts } from '../types';

/**
 * Regression tests: all five payment gateway initializePayment implementations
 * must persist top-level order_id and business_id on the payments row.
 *
 * These tests verify the INSERT object passed to supabase, not the provider API.
 * All gateways run in mock mode (no secret key) so no provider call is made.
 */

function createMockSupabase() {
  const insertedRows: Record<string, unknown>[] = [];
  const insertFn = vi.fn((row: Record<string, unknown>) => {
    insertedRows.push(row);
    return {
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'pay-1', ...row }, error: null }),
      }),
    };
  });

  return {
    client: {
      from: vi.fn(() => ({
        insert: insertFn,
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      })),
    },
    insertFn,
    insertedRows,
  };
}

function baseOpts(supabase: unknown): InitPaymentOpts {
  return {
    supabase: supabase as any,
    userId: 'user-1',
    amount: 5000,
    currency: 'NGN',
    referenceCode: 'REF-001',
    businessName: 'Test Shop',
    phone: '+2341234567890',
  };
}

// Import all gateways statically
import { PaystackGateway } from '../paystack';
import { StripeGateway } from '../stripe';
import { SquareGateway } from '../square';
import { FlutterwaveGateway } from '../flutterwave';
import { PayPalGateway } from '../paypal';

interface GatewayCase {
  name: string;
  create: () => { initializePayment: (opts: InitPaymentOpts) => Promise<any> };
  gatewayName: string;
}

const gateways: GatewayCase[] = [
  { name: 'Paystack', create: () => new PaystackGateway(), gatewayName: 'paystack' },
  { name: 'Stripe', create: () => new StripeGateway(), gatewayName: 'stripe' },
  { name: 'Square', create: () => new SquareGateway(), gatewayName: 'square' },
  { name: 'Flutterwave', create: () => new FlutterwaveGateway(), gatewayName: 'flutterwave' },
  { name: 'PayPal', create: () => new PayPalGateway(), gatewayName: 'paypal' },
];

beforeEach(() => {
  // Ensure mock mode (no secret keys)
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.SQUARE_ACCESS_TOKEN;
  delete process.env.FLW_SECRET_KEY;
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  (process.env as Record<string, string>).NODE_ENV = 'test';
  process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
});

describe.each(gateways)('$name payment linkage', ({ create, gatewayName }) => {
  it('stores top-level order_id and business_id with order payment', async () => {
    const gw = create();
    const { client, insertFn } = createMockSupabase();

    await gw.initializePayment({
      ...baseOpts(client),
      orderId: 'order-abc',
      businessId: 'biz-xyz',
    });

    expect(insertFn).toHaveBeenCalledTimes(1);
    const row = insertFn.mock.calls[0][0];
    expect(row.order_id).toBe('order-abc');
    expect(row.business_id).toBe('biz-xyz');
    expect(row.gateway).toBe(gatewayName);
  });

  it('preserves metadata.order_id for backward compatibility', async () => {
    const gw = create();
    const { client, insertFn } = createMockSupabase();

    await gw.initializePayment({
      ...baseOpts(client),
      orderId: 'order-abc',
      businessId: 'biz-xyz',
    });

    const row = insertFn.mock.calls[0][0];
    expect((row.metadata as Record<string, unknown>).order_id).toBe('order-abc');
  });

  it('stores null order_id and business_id when not provided', async () => {
    const gw = create();
    const { client, insertFn } = createMockSupabase();

    await gw.initializePayment(baseOpts(client));

    expect(insertFn).toHaveBeenCalledTimes(1);
    const row = insertFn.mock.calls[0][0];
    expect(row.order_id).toBeNull();
    expect(row.business_id).toBeNull();
  });

  it('does not change amount, currency, gateway, or status', async () => {
    const gw = create();
    const { client, insertFn } = createMockSupabase();

    await gw.initializePayment({
      ...baseOpts(client),
      orderId: 'order-1',
      businessId: 'biz-1',
    });

    const row = insertFn.mock.calls[0][0];
    expect(row.amount).toBe(5000);
    expect(row.currency).toBe('NGN');
    expect(row.gateway).toBe(gatewayName);
    expect(row.status).toBe('pending');
  });

  it('returns a valid result in mock mode', async () => {
    const gw = create();
    const { client } = createMockSupabase();

    const result = await gw.initializePayment(baseOpts(client));

    expect(result).not.toBeNull();
    expect(result!.reference).toBeTruthy();
    expect(result!.url).toBeTruthy();
  });
});

// --- Shared wrapper test ---

describe('Shared payment wrapper businessId forwarding', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards businessId to gateway.initializePayment', async () => {
    vi.resetModules();
    const mockGateway = {
      name: 'paystack',
      initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test', reference: 'REF-TEST' }),
      verifyPayment: vi.fn(),
      refundPayment: vi.fn(),
    };

    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn().mockReturnValue(mockGateway),
      getPaymentGatewayByName: vi.fn(),
    }));
    vi.doMock('@/lib/countries', () => ({
      getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }),
    }));
    vi.doMock('@/lib/constants', () => ({
      calculatePlatformFee: vi.fn().mockReturnValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 200 }),
      getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack'),
    }));

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      })),
    };

    await initializePayment(mockSupabase as any, {
      orderId: 'order-123',
      userId: 'user-1',
      amount: 5000,
      referenceCode: 'REF-001',
      businessName: 'Test',
      phone: '+2341234567890',
      businessId: 'biz-forwarded',
    });

    expect(mockGateway.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-forwarded',
        orderId: 'order-123',
      }),
    );
  });

  it('passes undefined businessId when not provided', async () => {
    vi.resetModules();
    const mockGateway = {
      name: 'paystack',
      initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test', reference: 'REF-TEST2' }),
      verifyPayment: vi.fn(),
      refundPayment: vi.fn(),
    };

    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn().mockReturnValue(mockGateway),
      getPaymentGatewayByName: vi.fn(),
    }));
    vi.doMock('@/lib/countries', () => ({
      getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }),
    }));
    vi.doMock('@/lib/constants', () => ({
      calculatePlatformFee: vi.fn().mockReturnValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 200 }),
      getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack'),
    }));

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');

    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      })),
    };

    await initializePayment(mockSupabase as any, {
      userId: 'user-1',
      amount: 3000,
      referenceCode: 'REF-002',
      businessName: 'Test',
      phone: '+2341234567890',
    });

    const callArgs = mockGateway.initializePayment.mock.calls[0][0];
    expect(callArgs.businessId).toBeUndefined();
  });
});
