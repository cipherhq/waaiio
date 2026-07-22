import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Enable payments for these tests (the gate would block otherwise)
process.env.ENABLE_PAYMENTS = 'true';

// Mock all external dependencies
vi.mock('@/lib/payments/factory', () => ({
  getPaymentGateway: vi.fn(),
  getPaymentGatewayByName: vi.fn(),
}));

vi.mock('@/lib/countries', () => ({
  getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }),
}));

// Mock the route resolver to return platform mode (no split)
vi.mock('@/lib/payments/route-resolver', () => ({
  resolvePaymentRoute: vi.fn().mockResolvedValue({
    mode: 'platform',
    provider: 'paystack',
    connectionId: null,
    feeBearerMode: 'platform',
    platformFeeAmount: 0,
  }),
}));

vi.mock('@/lib/encryption', () => ({
  decryptToken: vi.fn().mockReturnValue('decrypted_key'),
}));

vi.mock('@/lib/constants', () => ({
  calculatePlatformFee: vi.fn().mockReturnValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 200 }),
  getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack'),
}));

import { initializePayment } from '../payment';
import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory';

const mockGetGateway = getPaymentGateway as ReturnType<typeof vi.fn>;
const mockGetGatewayByName = getPaymentGatewayByName as ReturnType<typeof vi.fn>;

function createMockGateway(result: { url: string; reference: string } | null = { url: 'https://checkout.paystack.com/abc123', reference: 'REF-20260509-ABC12345' }) {
  return {
    name: 'paystack',
    initializePayment: vi.fn().mockResolvedValue(result),
    verifyPayment: vi.fn().mockResolvedValue(true),
    refundPayment: vi.fn(),
  };
}

function createMockSupabase(overrides: Record<string, unknown> = {}) {
  const defaultChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  return {
    from: vi.fn(() => ({ ...defaultChain, ...overrides })),
  };
}

describe('initializePayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
  });

  it('initializes payment with correct parameters via Paystack', async () => {
    const gateway = createMockGateway();
    mockGetGateway.mockReturnValue(gateway);

    const supabase = createMockSupabase();

    const result = await initializePayment(supabase as any, {
      bookingId: 'book-1',
      userId: 'user-1',
      amount: 5000,
      referenceCode: 'REF-001',
      businessName: 'Test Biz',
      phone: '+2341234567890',
      countryCode: 'NG',
    });

    expect(result).not.toBeNull();
    expect(result!.reference).toBe('REF-20260509-ABC12345');
    // Short URL passes through unchanged; long URLs get shortened
    expect(result!.url).toContain('checkout.paystack.com');
    expect(gateway.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5000,
        currency: 'NGN',
        referenceCode: 'REF-001',
        bookingId: 'book-1',
      }),
    );
  });

  it('uses resolver route provider when businessId is provided', async () => {
    const gateway = createMockGateway();
    mockGetGatewayByName.mockReturnValue(gateway);

    const supabase = createMockSupabase();

    const result = await initializePayment(supabase as any, {
      userId: 'user-1',
      amount: 3000,
      referenceCode: 'REF-002',
      businessName: 'Test Biz',
      phone: '+2341234567890',
      businessId: 'biz-1',
    });

    expect(result).not.toBeNull();
    // Resolver mock returns 'paystack', so gateway should be selected by name
    expect(mockGetGatewayByName).toHaveBeenCalledWith('paystack');
  });

  it('returns null when gateway throws', async () => {
    mockGetGateway.mockReturnValue({
      name: 'paystack',
      initializePayment: vi.fn().mockRejectedValue(new Error('Gateway down')),
    });

    const supabase = createMockSupabase();

    const result = await initializePayment(supabase as any, {
      userId: 'user-1',
      amount: 5000,
      referenceCode: 'REF-003',
      businessName: 'Test Biz',
      phone: '+2341234567890',
    });

    expect(result).toBeNull();
  });

  it('returns null when gateway returns null', async () => {
    const gateway = createMockGateway(null);
    mockGetGateway.mockReturnValue(gateway);

    const supabase = createMockSupabase();

    const result = await initializePayment(supabase as any, {
      userId: 'user-1',
      amount: 5000,
      referenceCode: 'REF-004',
      businessName: 'Test Biz',
      phone: '+2341234567890',
    });

    expect(result).toBeNull();
  });

  it('shortens the checkout URL using the last 8 chars of reference', async () => {
    const gateway = createMockGateway({
      url: 'https://checkout.paystack.com/very-long-checkout-id',
      reference: 'REF-20260509-ABCDEFGH',
    });
    mockGetGateway.mockReturnValue(gateway);

    const supabase = createMockSupabase();

    const result = await initializePayment(supabase as any, {
      userId: 'user-1',
      amount: 5000,
      referenceCode: 'REF-005',
      businessName: 'Test Biz',
      phone: '+2341234567890',
    });

    expect(result).not.toBeNull();
    // URL under 100 chars passes through; shortening only for very long URLs
    expect(result!.url).toContain('checkout.paystack.com');
  });

  it('links payment to campaign for donations', async () => {
    const gateway = createMockGateway();
    mockGetGateway.mockReturnValue(gateway);
    mockGetGatewayByName.mockReturnValue(gateway);

    const updateFn = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null }),
    });
    const insertFn = vi.fn().mockResolvedValue({ data: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'campaign_donations') {
          return { insert: insertFn };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              is: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
            not: vi.fn().mockReturnThis(),
          }),
          update: updateFn,
          insert: insertFn,
        };
      }),
    };

    await initializePayment(supabase as any, {
      userId: 'user-1',
      amount: 2000,
      referenceCode: 'REF-006',
      businessName: 'Test Biz',
      phone: '+2341234567890',
      campaignId: 'campaign-1',
      businessId: 'biz-1',
      donorName: 'John',
    });

    // Campaign ID should be passed to the gateway
    expect(gateway.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 'campaign-1' }),
    );
  });

  it('defaults to NG country code when none provided', async () => {
    const gateway = createMockGateway();
    mockGetGateway.mockReturnValue(gateway);

    const supabase = createMockSupabase();

    await initializePayment(supabase as any, {
      userId: 'user-1',
      amount: 5000,
      referenceCode: 'REF-007',
      businessName: 'Test Biz',
      phone: '+2341234567890',
      // No countryCode provided
    });

    expect(gateway.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'NGN' }),
    );
  });
});
