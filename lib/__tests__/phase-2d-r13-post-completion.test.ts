/**
 * Phase 2D R13 — runtime suppression proof inside the real post-completion path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateReceiptPdf = vi.fn();
const mockSender = { sendText: vi.fn(), sendDocument: vi.fn() };
const mockDriveInternalEffect = vi.fn(async (_sb: any, _pid: string, _key: string, _token: string, fn: () => Promise<void>) => {
  await fn();
  return { ok: true };
});
const mockDriveExternalEffect = vi.fn(async () => ({ ok: true }));
const mockSkipOptionalEffect = vi.fn(async () => ({ ok: true }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/pdf/receipt-generator', () => ({ generateReceiptPdf: (...args: any[]) => mockGenerateReceiptPdf(...args) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn() }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn() }));
vi.mock('@/lib/bot/customer-intelligence', () => ({ calculateLtvTier: vi.fn(() => 'new') }));
vi.mock('@/lib/payments/terminal-effects', () => ({
  driveInternalEffect: (...args: any[]) => mockDriveInternalEffect(...args),
  driveExternalEffect: (...args: any[]) => mockDriveExternalEffect(...args),
  skipOptionalEffect: (...args: any[]) => mockSkipOptionalEffect(...args),
}));
vi.mock('@/lib/constants', () => ({
  PRICING_TIERS: { free: { whitelabel: false }, growth: { whitelabel: false } },
}));

function chain(data: any = null): any {
  const c: any = {};
  for (const method of ['select','eq','neq','not','is','in','order','limit','update','insert','upsert','or']) {
    c[method] = vi.fn(() => c);
  }
  c.single = vi.fn().mockResolvedValue({ data, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  c.then = (resolve: any) => resolve({ data: Array.isArray(data) ? data : (data == null ? [] : [data]), error: null });
  return c;
}

describe('Phase 2D direct-order post-completion suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateReceiptPdf.mockResolvedValue(Buffer.from('pdf'));
    mockSender.sendText.mockResolvedValue({ success: true });
    mockSender.sendDocument.mockResolvedValue({ success: true });
  });

  it('amountPaid=0 + no loyalty capability causes zero receipt generation/delivery and zero loyalty WhatsApp', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'businesses') return chain({
          name: 'Biz', country_code: 'NG', subscription_tier: 'growth', metadata: {}, logo_url: null,
        });
        if (table === 'customer_profiles') return chain(null);
        return chain(null);
      }),
      rpc: vi.fn(async (name: string) => {
        if (name === 'apply_payment_customer_visit_once') return { data: { applied: false }, error: null };
        return { data: { applied: false }, error: null };
      }),
      storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn() })) },
    } as any;

    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    await handlePostCompletion({
      supabase,
      businessId: 'biz-1',
      customerPhone: '+234900',
      customerName: 'Cust',
      serviceType: 'order',
      referenceId: undefined,
      sender: mockSender as any,
      paymentId: 'pay-direct',
      claimToken: 'claim-1',
      amountPaid: 0,
      serviceName: 'Order',
      referenceCode: 'ORD-1',
      skipAutomation: true,
      skipCustomerSpend: false,
    });

    expect(mockGenerateReceiptPdf).not.toHaveBeenCalled();
    expect(mockSender.sendDocument).not.toHaveBeenCalled();
    expect(mockSender.sendText).not.toHaveBeenCalled();

    const externalKeys = mockDriveExternalEffect.mock.calls.map((call: any[]) => call[2]);
    expect(externalKeys).not.toContain('receipt_pdf_delivery');
    expect(externalKeys).not.toContain('customer_loyalty_whatsapp');

    const internalKeys = mockDriveInternalEffect.mock.calls.map((call: any[]) => call[2]);
    expect(internalKeys).not.toContain('receipt_pdf_generation');
    expect(internalKeys).not.toContain('loyalty_award');
  });
});
