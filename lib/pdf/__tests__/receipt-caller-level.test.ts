/**
 * R3 Blocker 1: Real receipt caller-level test.
 *
 * Mocks generateReceiptPdf, executes the real handlePostCompletion() path,
 * and asserts the generator receives the correct presentation fields.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock generateReceiptPdf to intercept the call
const mockGenerateReceiptPdf = vi.fn().mockResolvedValue(Buffer.from('%PDF-receipt'));
vi.mock('@/lib/pdf/receipt-generator', () => ({
  generateReceiptPdf: (...args: unknown[]) => mockGenerateReceiptPdf(...args),
}));

// Mock dependencies that handlePostCompletion uses
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn(() => ({})),
}));
vi.mock('@/lib/capabilities/service', () => ({
  getEnabledCapabilities: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/bot/automation/sequence-service', () => ({
  triggerSequences: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({
  evaluateRules: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/customer-intelligence', () => ({
  calculateLtvTier: vi.fn().mockReturnValue('new'),
}));

const BIZ_ID = 'biz-receipt-test';
const BIZ_LOGO = 'https://storage.example.com/logos/citadel.png';

function createReceiptSupabase() {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      ['select', 'eq', 'in', 'or', 'not', 'order', 'limit', 'update', 'upsert', 'insert', 'delete'].forEach(m => {
        chain[m] = vi.fn().mockReturnValue(chain);
      });
      chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });

      if (table === 'businesses') {
        chain.single = vi.fn().mockResolvedValue({
          data: {
            name: 'Citadel of Grace',
            country_code: 'NG',
            subscription_tier: 'growth',
            metadata: {},
            logo_url: BIZ_LOGO,
          },
          error: null,
        });
      }
      if (table === 'customer_profiles') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      if (table === 'payment_receipt_applications') {
        chain.upsert = vi.fn().mockResolvedValue({ error: null });
      }
      return chain;
    }),
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ error: null }),
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: 'https://signed.url/receipt.pdf' },
          error: null,
        }),
      }),
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

describe('R3 Blocker 1: Real handlePostCompletion receipt caller', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('passes logoUrl, countryCode, currencyCode; does NOT fabricate subtotal/fees/paymentMethod', async () => {
    const supabase = createReceiptSupabase();

    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    await handlePostCompletion({
      supabase: supabase as any,
      businessId: BIZ_ID,
      customerPhone: '+2348012345678',
      customerName: 'Adebayo Olumide',
      amountPaid: 15000,
      serviceName: 'Praise Night VIP x2',
      referenceCode: 'WAA-PAY-7742',
      paymentId: 'pay-receipt-test',
      currencyCode: 'NGN',
    });

    // generateReceiptPdf must have been called
    expect(mockGenerateReceiptPdf).toHaveBeenCalledTimes(1);
    const receiptData = mockGenerateReceiptPdf.mock.calls[0][0];

    // logoUrl = business logo_url
    expect(receiptData.logoUrl).toBe(BIZ_LOGO);

    // countryCode = business country
    expect(receiptData.countryCode).toBe('NG');

    // currencyCode = supplied authoritative payment currency
    expect(receiptData.currencyCode).toBe('NGN');

    // subtotal, fees, paymentMethod NOT fabricated
    expect(receiptData.subtotal).toBeUndefined();
    expect(receiptData.fees).toBeUndefined();
    expect(receiptData.paymentMethod).toBeUndefined();

    // Basic sanity: amount and business name passed correctly
    expect(receiptData.amount).toBe(15000);
    expect(receiptData.businessName).toBe('Citadel of Grace');
  });
});
