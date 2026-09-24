/**
 * #353 Stripe Checkout Save Card integration — executable evidence
 *
 * Tests that Stripe Checkout sessions are configured correctly:
 * - payment_method_save=enabled when eligible
 * - allow_redisplay_filters=['always'] to prevent PIN bypass
 * - customer param when canonical Customer is provisioned
 * - customer_email fallback when not eligible
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StripeGateway } from '../stripe';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.STRIPE_SECRET_KEY = 'test_key_for_unit_tests';
  process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';

  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    json: () => Promise.resolve({
      id: 'cs_test_session_353',
      url: 'https://checkout.stripe.com/pay/cs_test_session_353',
    }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

// Mock Customer provisioning to return a Customer ID
vi.mock('../provision-stripe-customer', () => ({
  provisionStripeCustomer: vi.fn().mockResolvedValue({ customerId: 'cus_test_canonical' }),
}));

// Mock compatibility to return compatible
vi.mock('../saved-card-compat', async () => {
  const actual = await vi.importActual('../saved-card-compat');
  return {
    ...actual,
    isCompatibleForSavedCard: vi.fn().mockResolvedValue({ compatible: true }),
  };
});

describe('Stripe Checkout Save Card params', () => {
  it('passes customer and payment_method_save when eligible', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'pay_1' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase,
      orderId: 'ord_1', userId: 'u1',
      amount: 100, currency: 'USD', referenceCode: 'WA-OR-SAVE',
      businessName: 'TestShop', phone: '+12025551234', businessId: 'biz_1',
    });

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions');
    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    // Ordinary Checkout remains its own code path and keeps its existing card config.
    expect(body.get('payment_method_types[0]')).toBe('card');
    // Must have customer param (from provisioning)
    expect(body.get('customer')).toBe('cus_test_canonical');
    // Must NOT have customer_email when customer is set
    expect(body.get('customer_email')).toBeNull();
    // Must have Save Card checkbox enabled
    expect(body.get('saved_payment_method_options[payment_method_save]')).toBe('enabled');
    // Must filter redisplay to prevent PIN bypass
    expect(body.get('saved_payment_method_options[allow_redisplay_filters][0]')).toBe('always');
    // success_url still uses {CHECKOUT_SESSION_ID}
    expect(body.get('success_url')).toContain('{CHECKOUT_SESSION_ID}');
  });

  it('falls back to customer_email when provisioning fails', async () => {
    // Override provisioning to fail
    const { provisionStripeCustomer } = await import('../provision-stripe-customer');
    (provisionStripeCustomer as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'pay_2' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase,
      orderId: 'ord_2', userId: 'u1',
      amount: 50, currency: 'USD', referenceCode: 'WA-OR-FALLBACK',
      businessName: 'TestShop', phone: '+12025551234', businessId: 'biz_1',
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    // Should fall back to customer_email
    expect(body.get('customer_email')).toBeTruthy();
    expect(body.get('customer')).toBeNull();
    // Save Card params should NOT be set
    expect(body.get('saved_payment_method_options[payment_method_save]')).toBeNull();
  });

  it('uses customer_email for non-phone flows', async () => {
    const gateway = new StripeGateway();
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'pay_3' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient;

    await gateway.initializePayment({
      supabase: mockSupabase,
      orderId: 'ord_3', userId: 'u1',
      amount: 75, currency: 'USD', referenceCode: 'WA-OR-EMAIL',
      businessName: 'TestShop', phone: '', userEmail: 'test@example.com', businessId: 'biz_1',
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(body.get('customer_email')).toBe('test@example.com');
    expect(body.get('customer')).toBeNull();
  });
});
