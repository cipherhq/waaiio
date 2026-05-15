import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoiceFlow } from '../invoice.flow';
import { createMockContext, getStep } from './helpers';
import type { FlowContext } from '../types';

// Mock external imports
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/constants', () => ({
  formatCurrency: (amount: number, _cc: string) => `₦${amount.toLocaleString()}`,
  getLocale: (_cc: string) => 'en-NG',
}));
vi.mock('../shared/payment', () => ({
  initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test/abc', reference: 'REF-123' }),
}));

describe('Invoice Flow', () => {
  let ctx: FlowContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('invoice_list step', () => {
    const step = getStep(invoiceFlow, 'invoice_list');

    it('sends no invoices message and returns empty when none found', async () => {
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
      (ctx.supabase.from as any).mockReturnValueOnce(mockChain);

      const messages = await step.prompt(ctx);
      expect(messages).toHaveLength(0);
      expect(ctx.session.session_data._invoice_empty).toBe(true);
      expect(ctx.sender.sendText).toHaveBeenCalled();
    });

    it('shows invoice list with correct formatting', async () => {
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'inv-1',
              invoice_number: 'BW-I0042',
              total_amount: 15000,
              due_date: '2026-01-30',
              status: 'overdue',
              businesses: { name: 'Test Biz', country_code: 'NG' },
            },
            {
              id: 'inv-2',
              invoice_number: 'BW-I0045',
              total_amount: 8500,
              due_date: '2026-02-15',
              status: 'sent',
              businesses: { name: 'Test Biz', country_code: 'NG' },
            },
          ],
          error: null,
        }),
      };
      const updateChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      (ctx.supabase.from as any)
        .mockReturnValueOnce(mockChain)
        .mockReturnValueOnce(updateChain);

      const messages = await step.prompt(ctx);
      const text = (messages[0] as any).text;
      expect(text).toContain('BW-I0042');
      expect(text).toContain('BW-I0045');
      expect(text).toContain('OVERDUE');
      expect(text).toContain('Reply with a number');
    });

    it('validates number selection within range', async () => {
      ctx.session.session_data._invoice_list = ['inv-1', 'inv-2'];
      const result = await step.validate('1', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._selected_invoice_id).toBe('inv-1');
    });

    it('validates second item selection', async () => {
      ctx.session.session_data._invoice_list = ['inv-1', 'inv-2'];
      const result = await step.validate('2', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._selected_invoice_id).toBe('inv-2');
    });

    it('rejects out-of-range number', async () => {
      ctx.session.session_data._invoice_list = ['inv-1', 'inv-2'];
      const result = await step.validate('5', ctx);
      expect(result.valid).toBe(false);
    });

    it('rejects non-numeric input', async () => {
      ctx.session.session_data._invoice_list = ['inv-1'];
      const result = await step.validate('abc', ctx);
      expect(result.valid).toBe(false);
    });

    it('routes to invoice_detail', async () => {
      const next = await step.next(ctx);
      expect(next).toBe('invoice_detail');
    });
  });

  describe('invoice_detail step', () => {
    const step = getStep(invoiceFlow, 'invoice_detail');

    it('validates pay action', async () => {
      const result = await step.validate('pay', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._invoice_action).toBe('pay');
    });

    it('validates back action', async () => {
      const result = await step.validate('back', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._invoice_action).toBe('back');
    });

    it('rejects invalid input', async () => {
      const result = await step.validate('random', ctx);
      expect(result.valid).toBe(false);
    });

    it('routes to invoice_list on back', async () => {
      ctx.session.session_data._invoice_action = 'back';
      const next = await step.next(ctx);
      expect(next).toBe('invoice_list');
    });

    it('routes to invoice_pay on pay', async () => {
      ctx.session.session_data._invoice_action = 'pay';
      const next = await step.next(ctx);
      expect(next).toBe('invoice_pay');
    });
  });

  describe('invoice_pay step', () => {
    const step = getStep(invoiceFlow, 'invoice_pay');

    it('ends session after payment (next returns null)', async () => {
      const next = await step.next(ctx);
      expect(next).toBeNull();
    });
  });
});
