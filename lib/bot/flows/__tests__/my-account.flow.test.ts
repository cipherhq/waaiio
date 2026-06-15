import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { capabilitySelectionFlow } from '../capability-selection.flow';

describe('My Account Menu', () => {
  describe('select_capability step', () => {
    const step = getStep(capabilitySelectionFlow, 'select_capability');

    it('routes to my_account_menu when user selects cap_my_account', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability',
          session_data: { capabilities: ['scheduling', 'payment'], _is_returning: true },
        },
      });

      const result = await step.validate('cap_my_account', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.active_capability).toBe('my_account');

      ctx.session.session_data.active_capability = 'my_account';
      const next = await step.next(ctx);
      expect(next).toBe('my_account_menu');
    });

    it('routes to my_account_menu for "my account" text input', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability',
          session_data: { capabilities: ['scheduling'], _is_returning: true },
        },
      });

      const result = await step.validate('my account', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.active_capability).toBe('my_account');
    });
  });

  describe('my_account_menu step', () => {
    const step = getStep(capabilitySelectionFlow, 'my_account_menu');

    it('shows menu items filtered by capabilities', async () => {
      // With all capabilities enabled, should show all items
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'my_account_menu',
          session_data: { capabilities: ['scheduling', 'ordering', 'giving', 'invoice', 'whatsapp_sign', 'loyalty', 'recurring', 'estimates'] },
        },
      });
      const messages = await step.prompt(ctx);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('list');
      if (messages[0].type === 'list') {
        expect(messages[0].items).toHaveLength(11);
      }
    });

    it('shows only relevant items when capabilities are limited', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'my_account_menu',
          session_data: { capabilities: ['scheduling'] },
        },
      });
      const messages = await step.prompt(ctx);
      expect(messages[0].type).toBe('list');
      if (messages[0].type === 'list') {
        // Only My Bookings, My Quotes, Get Receipt (always shown)
        expect(messages[0].items.length).toBeLessThan(9);
        expect(messages[0].items.map(i => i.postbackText)).toContain('acct_bookings');
        expect(messages[0].items.map(i => i.postbackText)).toContain('acct_receipt');
      }
    });

    it('routes acct_bookings to my_bookings step', async () => {
      const ctx = createMockContext();
      const result = await step.validate('acct_bookings', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._my_account_route).toBe('my_bookings');

      ctx.session.session_data._my_account_route = 'my_bookings';
      const next = await step.next(ctx);
      expect(next).toBe('my_bookings');
    });

    it('routes acct_orders to my_orders step', async () => {
      const ctx = createMockContext();
      const result = await step.validate('acct_orders', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._my_account_route).toBe('my_orders');

      ctx.session.session_data._my_account_route = 'my_orders';
      const next = await step.next(ctx);
      expect(next).toBe('my_orders');
    });

    it('handles acct_giving inline and returns to my account menu', async () => {
      const ctx = createMockContext();
      const result = await step.validate('acct_giving', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._my_account_route).toBe('my_account_menu');

      ctx.session.session_data._my_account_route = 'my_account_menu';
      const next = await step.next(ctx);
      expect(next).toBe('my_account_menu');
    });

    it('handles acct_receipt inline via direct call', async () => {
      const ctx = createMockContext();
      // Mock the profile lookup
      const mockFrom = ctx.supabase.from as ReturnType<typeof vi.fn>;
      mockFrom.mockImplementation(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'user-1' }, error: null }),
      }));

      const result = await step.validate('acct_receipt', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._my_account_route).toBe('my_account_menu');
    });

    it('routes flow steps correctly via routeMap', async () => {
      const routeTests = [
        { input: 'acct_subscriptions', expected: 'list_subscriptions' },
        { input: 'acct_loyalty', expected: 'loyalty_menu' },
        { input: 'acct_invoices', expected: 'invoice_list' },
      ];

      for (const { input, expected } of routeTests) {
        const ctx = createMockContext();
        const result = await step.validate(input, ctx);
        expect(result.valid).toBe(true);
        expect(result.data?._my_account_route).toBe(expected);

        ctx.session.session_data._my_account_route = expected;
        const next = await step.next(ctx);
        expect(next).toBe(expected);
      }
    });

    it('rejects invalid input', async () => {
      const ctx = createMockContext();
      const result = await step.validate('random garbage', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBeTruthy();
    });
  });

  describe('my_bookings stub step', () => {
    const step = getStep(capabilitySelectionFlow, 'my_bookings');

    it('exists as a flow step (prevents session deactivation)', () => {
      expect(step).toBeDefined();
      expect(step.id).toBe('my_bookings');
    });

    it('prompt returns a message (list or text)', async () => {
      const ctx = createMockContext({
        session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'my_bookings', session_data: {} },
      });
      // Mock supabase to return empty results (no bookings)
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [] }),
      };
      (ctx.supabase.from as ReturnType<typeof vi.fn>).mockReturnValue(mockChain);

      const messages = await step.prompt(ctx);
      expect(messages.length).toBeGreaterThan(0);
      // With no bookings, should return text message
      expect(messages[0].type).toBe('text');
    });
  });

  describe('my_orders stub step', () => {
    const step = getStep(capabilitySelectionFlow, 'my_orders');

    it('exists as a flow step (prevents session deactivation)', () => {
      expect(step).toBeDefined();
      expect(step.id).toBe('my_orders');
    });

    it('prompt returns list, buttons, or text message', async () => {
      const ctx = createMockContext({
        session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'my_orders', session_data: {} },
      });
      const messages = await step.prompt(ctx);
      expect(messages.length).toBeGreaterThan(0);
    });
  });
});
