/**
 * P0-INVOICE-1 — Behavioral tests for invoice bot flow
 *
 * Tests execute real flow step prompts with mocked Supabase.
 * Proves: canonical schema fields, outstanding balance, status safety.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoiceFlow } from '../bot/flows/invoice.flow';
import type { FlowContext } from '../bot/flows/types';
import * as fs from 'fs';
import * as path from 'path';

// ── Hoisted mocks ──
const { mockInitializePayment } = vi.hoisted(() => ({
  mockInitializePayment: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/constants', () => ({
  formatCurrency: (amount: number) => `₦${amount}`,
  getLocale: () => 'en-NG',
}));
vi.mock('../bot/flows/shared/payment', () => ({
  initializePayment: (...args: unknown[]) => mockInitializePayment(...args),
}));
vi.mock('../bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn().mockResolvedValue({ qualifies: false, bankAccount: null, platformSettings: {} }),
  createPendingTransfer: vi.fn().mockResolvedValue('TRF-001'),
  formatBankTransferBlock: vi.fn().mockReturnValue('Bank: Test Bank\nAcct: 1234'),
  DUAL_OPTION_BUTTONS: [{ id: 'test', title: 'Test' }],
  BANK_ONLY_BUTTONS: [{ id: 'test', title: 'Test' }],
}));
vi.mock('../bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewInvoicePayment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../bot/flows/shared/notifications', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../bot/flows/shared/powered-by', () => ({
  getPoweredByFooter: () => '',
}));
vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: (v: string) => v,
}));

function getStep(flow: typeof invoiceFlow, id: string) {
  const step = flow.steps.find(s => s.id === id);
  if (!step) throw new Error(`Step ${id} not found`);
  return step;
}

function mockChain(resolvedData: unknown = null) {
  const c: Record<string, any> = {};
  ['select', 'eq', 'or', 'in', 'order', 'limit', 'update', 'neq'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: resolvedData, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: resolvedData, error: null });
  return c;
}

function buildCtx(overrides: Partial<FlowContext> = {}): FlowContext {
  const sessionData: Record<string, unknown> = {};
  const fromMock = vi.fn();
  return {
    supabase: { from: fromMock, rpc: vi.fn() } as any,
    session: {
      id: 'sess-1', business_id: 'biz-1', user_id: 'usr-1',
      whatsapp_number: '+234123', is_active: true, current_step: 'invoice_pay',
      session_data: sessionData,
    } as any,
    from: '+234123',
    business: { id: 'biz-1', country_code: 'NG' } as any,
    sender: { sendText: vi.fn() } as any,
    t: async (s: string) => s,
    ...overrides,
  } as FlowContext;
}

const INVOICE_BASE = {
  id: 'inv-1',
  reference_code: 'BW-I0042',
  total_amount: 100,
  amount_paid: 0,
  status: 'sent',
  business_id: 'biz-1',
  created_at: '2026-01-15',
  due_date: '2026-02-15',
  businesses: { name: 'Test Biz', country_code: 'NG', payment_gateway: null, subscription_tier: 'free' },
};

describe('P0-INVOICE-1: Behavioral invoice flow tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitializePayment.mockResolvedValue({ url: 'https://pay.test/inv', reference: 'REF-001' });
  });

  // ── 1. Invoice detail: canonical items ──
  it('1. invoice_detail renders items using amount field', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE });
      if (table === 'invoice_items') return mockChain(null); // items query — return value from order().limit() chain
      return mockChain();
    });
    // Override invoice_items to return via the chain's final method
    let capturedItemSelect = '';
    fromMock.mockImplementation((table: string) => {
      const c = mockChain(table === 'invoices' ? { ...INVOICE_BASE } : null);
      if (table === 'invoice_items') {
        c.select = vi.fn().mockImplementation((cols: string) => { capturedItemSelect = cols; return c; });
        c.order = vi.fn().mockResolvedValue({
          data: [{ description: 'Service', quantity: 2, unit_price: 25, amount: 50 }],
          error: null,
        });
      }
      return c;
    });

    const step = getStep(invoiceFlow, 'invoice_detail');
    const msgs = await step.prompt!(ctx);
    const text = (msgs[0] as any).text || (msgs[0] as any).body || '';

    // Item rendered with amount, not total
    expect(text).toContain('Service');
    expect(text).toContain('₦50');
    // Query selected amount, not total
    expect(capturedItemSelect).toContain('amount');
    expect(capturedItemSelect).not.toContain('total');
  });

  // ── 2. Strict item query contract ──
  it('2. invoice_items SELECT requests amount, not total', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/invoice.flow.ts'), 'utf-8');
    const itemSelects = src.match(/from\('invoice_items'\)[\s\S]*?\.select\('([^']+)'\)/);
    expect(itemSelects).not.toBeNull();
    expect(itemSelects![1]).toContain('amount');
    expect(itemSelects![1]).not.toContain('total');
  });

  // ── 3. reference_code propagation ──
  it('3. payment init receives referenceCode from reference_code', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, total_amount: 100, amount_paid: 0 });
      if (table === 'profiles') {
        const c = mockChain({ id: 'usr-1' });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'usr-1', first_name: 'J', last_name: 'D' }, error: null });
        return c;
      }
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    await step.prompt!(ctx);

    expect(mockInitializePayment).toHaveBeenCalledTimes(1);
    expect(mockInitializePayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      referenceCode: 'BW-I0042',
      invoiceId: 'inv-1',
    }));
  });

  // ── 4. Partial payment ──
  it('4. partial payment: initializePayment uses remaining balance (60), not total (100)', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, total_amount: 100, amount_paid: 40 });
      if (table === 'profiles') { const c = mockChain({ id: 'usr-1' }); c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'usr-1' }, error: null }); return c; }
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    await step.prompt!(ctx);

    expect(mockInitializePayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 60 }));
  });

  // ── 6. Fully paid ──
  it('6. fully paid invoice: no payment initialized', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, total_amount: 100, amount_paid: 100, status: 'paid' });
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    const text = (msgs[0] as any).body || (msgs[0] as any).text || '';
    expect(text).toContain('paid');
  });

  // ── 7. Zero balance with payable-looking status ──
  it('7. zero balance + status=sent: no payment', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, total_amount: 100, amount_paid: 100, status: 'sent' });
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect((msgs[0] as any).body).toContain('fully paid');
  });

  // ── 8. Overpaid safety ──
  it('8. overpaid invoice: no payment, no negative amount', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, total_amount: 100, amount_paid: 120 });
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect(mockInitializePayment).not.toHaveBeenCalled();
  });

  // ── 9. Cancelled invoice ──
  it('9. cancelled invoice: no payment', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, status: 'cancelled' });
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect((msgs[0] as any).body).toContain('cancelled');
  });

  // ── 10. Draft invoice ──
  it('10. draft invoice: no payment', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, status: 'draft' });
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect(mockInitializePayment).not.toHaveBeenCalled();
  });

  // ── 11. Payable overdue ──
  it('11. overdue invoice with partial payment: pays remaining', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, total_amount: 100, amount_paid: 25, status: 'overdue' });
      if (table === 'profiles') { const c = mockChain({ id: 'usr-1' }); c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'usr-1' }, error: null }); return c; }
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    await step.prompt!(ctx);
    expect(mockInitializePayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: 75 }));
  });

  // ── 12. State changed after list ──
  it('12. invoice paid between list and pay: blocks payment', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE, status: 'paid', amount_paid: 100 });
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect(mockInitializePayment).not.toHaveBeenCalled();
  });

  // ── 13. Invoice not found ──
  it('13. invoice not found: no payment, safe message', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-missing';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation(() => mockChain(null));

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect((msgs[0] as any).text).toContain('not found');
  });

  // ── 14. DB error ──
  it('14. database error: no payment, safe handling', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation(() => {
      const c = mockChain();
      c.single = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection failed' } });
      return c;
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect((msgs[0] as any).text).not.toContain('connection failed'); // no raw DB error
  });

  // ── 15. Payment initializer failure ──
  it('15. payment init failure: safe fallback', async () => {
    mockInitializePayment.mockResolvedValue(null);
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE });
      if (table === 'profiles') { const c = mockChain({ id: 'usr-1' }); c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'usr-1' }, error: null }); return c; }
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    const msgs = await step.prompt!(ctx);
    expect((msgs[0] as any).body || (msgs[0] as any).text).toContain('couldn\'t generate');
  });

  // ── 16. Invoice ID association ──
  it('16. payment init receives invoiceId', async () => {
    const ctx = buildCtx();
    ctx.session.session_data._selected_invoice_id = 'inv-1';
    const fromMock = ctx.supabase.from as any;
    fromMock.mockImplementation((table: string) => {
      if (table === 'invoices') return mockChain({ ...INVOICE_BASE });
      if (table === 'profiles') { const c = mockChain({ id: 'usr-1' }); c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'usr-1' }, error: null }); return c; }
      return mockChain();
    });

    const step = getStep(invoiceFlow, 'invoice_pay');
    await step.prompt!(ctx);
    expect(mockInitializePayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ invoiceId: 'inv-1' }));
  });

  // ── 18. Schema regression guards ──
  it('18a. regression: invoice_number reintroduction detected', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/invoice.flow.ts'), 'utf-8');
    expect(src).not.toContain('invoice_number');
  });

  it('18b. regression: invoice_items.total reintroduction detected', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/flows/invoice.flow.ts'), 'utf-8');
    // item query must use amount, not total
    const itemSelect = src.match(/from\('invoice_items'\)[\s\S]*?select\('([^']+)'\)/);
    expect(itemSelect).not.toBeNull();
    expect(itemSelect![1]).not.toContain('total');
    expect(itemSelect![1]).toContain('amount');
  });
});
