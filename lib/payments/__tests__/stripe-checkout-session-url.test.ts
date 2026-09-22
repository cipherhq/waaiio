/**
 * Stripe Checkout Session URL — #358 executable evidence
 *
 * Verifies that Stripe's success_url uses the literal {CHECKOUT_SESSION_ID}
 * placeholder, which Stripe replaces with the real cs_... session ID on redirect.
 *
 * This eliminates the need for entity-type dispatch on the payment-success page,
 * since the existing gateway_reference lookup resolves the payment directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StripeGateway } from '../stripe';

// Mock fetch to capture the Stripe API call
const mockFetch = vi.fn();

describe('Stripe success_url contains {CHECKOUT_SESSION_ID}', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Set Stripe key so we don't hit mock mode
    process.env.STRIPE_SECRET_KEY = 'test_key_for_unit_tests';
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';

    // Mock global fetch to capture the Stripe API call
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({
        id: 'cs_test_session_123',
        url: 'https://checkout.stripe.com/pay/cs_test_session_123',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  it('builds success_url with literal {CHECKOUT_SESSION_ID} placeholder', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'pay_001' },
              error: null,
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase,
      bookingId: undefined,
      orderId: 'ord_test',
      invoiceId: undefined,
      reservationId: undefined,
      userId: 'user_001',
      amount: 50,
      currency: 'USD',
      referenceCode: 'WA-OR-1234',
      businessName: 'Test Shop',
      phone: '',
      businessId: 'biz_001',
    });

    // Verify fetch was called with the Stripe API
    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');

    // Parse the URL-encoded body to check success_url
    const body = new URLSearchParams(options.body);
    const successUrl = body.get('success_url');
    expect(successUrl).toBe('https://www.waaiio.com/payment-success?ref={CHECKOUT_SESSION_ID}');

    // Verify it does NOT contain the entity referenceCode
    expect(successUrl).not.toContain('WA-OR-1234');
  });

  it('success_url works for order entity type', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase, orderId: 'ord_1', userId: 'u1',
      amount: 100, currency: 'USD', referenceCode: 'WA-OR-9138',
      businessName: 'JShop', phone: '', businessId: 'biz_1',
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(body.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
  });

  it('success_url works for booking/appointment entity type', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'p2' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase, bookingId: 'bk_1', userId: 'u1',
      amount: 75, currency: 'USD', referenceCode: 'WA-BK-5555',
      businessName: 'Salon', phone: '', businessId: 'biz_2',
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(body.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
    expect(body.get('success_url')).not.toContain('WA-BK-5555');
  });

  it('success_url works for ticketing entity type', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'p3' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase, bookingId: 'bk_tk_1', userId: 'u1',
      amount: 25, currency: 'GBP', referenceCode: 'WA-TK-8888',
      businessName: 'Events', phone: '', businessId: 'biz_3',
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(body.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
  });

  it('success_url works for invoice entity type', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'p4' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase, invoiceId: 'inv_1', userId: 'u1',
      amount: 200, currency: 'CAD', referenceCode: 'WA-IN-3333',
      businessName: 'Consulting', phone: '', businessId: 'biz_4',
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(body.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
  });

  it('success_url works for reservation entity type', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'p5' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase, reservationId: 'res_1', userId: 'u1',
      amount: 150, currency: 'USD', referenceCode: 'WA-RS-7777',
      businessName: 'Restaurant', phone: '', businessId: 'biz_5',
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(body.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
  });

  it('success_url works for campaign/giving entity type', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'p6' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase, campaignId: 'camp_1', userId: 'u1',
      amount: 50, currency: 'USD', referenceCode: 'DON-XYZ789',
      businessName: 'Charity', phone: '', businessId: 'biz_6',
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(body.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
    expect(body.get('success_url')).not.toContain('DON-XYZ789');
  });

  it('still stores referenceCode in metadata for legacy compatibility', async () => {
    const gateway = new StripeGateway();
    const insertCalls: unknown[] = [];
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockImplementation((data: unknown) => {
          insertCalls.push(data);
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'p7' }, error: null }),
            }),
          };
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase, orderId: 'ord_2', userId: 'u1',
      amount: 100, currency: 'USD', referenceCode: 'WA-OR-META',
      businessName: 'Shop', phone: '', businessId: 'biz_7',
    });

    // The payment row insert should still contain metadata.reference_code
    const insertData = insertCalls[0] as Record<string, unknown>;
    const meta = insertData.metadata as Record<string, unknown>;
    expect(meta.reference_code).toBe('WA-OR-META');
  });

  it('still uses referenceCode for idempotency key', async () => {
    // Clear mock calls from prior tests
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({
        id: 'cs_test_idem_key',
        url: 'https://checkout.stripe.com/pay/cs_test_idem_key',
      }),
    });

    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'p8' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase, orderId: 'ord_3', userId: 'u1',
      amount: 100, currency: 'USD', referenceCode: 'WA-OR-IDEM',
      businessName: 'Shop', phone: '', businessId: 'biz_8',
    });

    // Verify the Idempotency-Key header uses the referenceCode
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['Idempotency-Key']).toBe('checkout_WA-OR-IDEM');
  });
});
