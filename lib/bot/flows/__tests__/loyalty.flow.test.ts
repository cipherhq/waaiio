import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loyaltyFlow } from '../loyalty.flow';
import { createMockContext, getStep } from './helpers';
import type { FlowContext } from '../types';

// Mock external imports
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));

describe('Loyalty Flow', () => {
  let ctx: FlowContext;

  beforeEach(() => {
    ctx = createMockContext({
      business: {
        id: 'biz-1',
        name: 'Test Salon',
        slug: 'test-salon',
        category: 'salon' as any,
        flow_type: 'scheduling' as any,
        subscription_tier: 'starter',
        trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
        metadata: {
          loyalty_reward_threshold: 500,
          loyalty_reward_description: 'a free haircut',
        },
      },
    });
  });

  describe('loyalty_menu step', () => {
    const step = getStep(loyaltyFlow, 'loyalty_menu');

    it('shows no-points message when no loyalty record exists', async () => {
      const messages = await step.prompt(ctx);
      expect(messages[0].type).toBe('text');
      expect((messages[0] as any).text).toContain("don't have any loyalty points");
    });

    it('shows balance and buttons when loyalty record found', async () => {
      // Mock the supabase chain for loyalty_points
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: 'loy-1', points_balance: 450, total_earned: 500, total_redeemed: 50, visit_count: 12 },
          error: null,
        }),
      };
      const updateChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      (ctx.supabase.from as any)
        .mockReturnValueOnce(mockChain) // loyalty_points query
        .mockReturnValueOnce(updateChain); // bot_sessions update

      const messages = await step.prompt(ctx);
      // Should return 2 messages: text with balance + buttons
      expect(messages.length).toBe(2);
      expect((messages[0] as any).text).toContain('450');
      expect((messages[0] as any).text).toContain('12');
      expect((messages[1] as any).buttons).toHaveLength(2);
    });

    it('validates view_history selection', async () => {
      const result = await step.validate('view_history', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._loyalty_action).toBe('history');
    });

    it('validates redeem selection', async () => {
      const result = await step.validate('redeem', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._loyalty_action).toBe('redeem');
    });

    it('rejects invalid input', async () => {
      const result = await step.validate('something_else', ctx);
      expect(result.valid).toBe(false);
    });

    it('routes to loyalty_history on view_history', async () => {
      ctx.session.session_data._loyalty_action = 'history';
      const next = await step.next(ctx);
      expect(next).toBe('loyalty_history');
    });

    it('routes to loyalty_redeem on redeem', async () => {
      ctx.session.session_data._loyalty_action = 'redeem';
      const next = await step.next(ctx);
      expect(next).toBe('loyalty_redeem');
    });
  });

  describe('loyalty_history step', () => {
    const step = getStep(loyaltyFlow, 'loyalty_history');

    it('shows no-activity message when no transactions', async () => {
      ctx.session.session_data.loyalty_id = 'loy-1';
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
      (ctx.supabase.from as any).mockReturnValueOnce(mockChain);

      const messages = await step.prompt(ctx);
      expect((messages[0] as any).text).toContain('No points activity');
    });

    it('shows formatted transaction list', async () => {
      ctx.session.session_data.loyalty_id = 'loy-1';
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [
            { points_change: 10, reason: 'visit', created_at: '2026-01-15T10:00:00Z' },
            { points_change: -100, reason: 'redemption', created_at: '2026-01-05T10:00:00Z' },
          ],
          error: null,
        }),
      };
      (ctx.supabase.from as any).mockReturnValueOnce(mockChain);

      const messages = await step.prompt(ctx);
      expect((messages[0] as any).text).toContain('+10');
      expect((messages[0] as any).text).toContain('-100');
      expect((messages[0] as any).text).toContain('Visit');
      expect((messages[0] as any).text).toContain('Redemption');
    });

    it('always routes back to menu', async () => {
      const result = await step.validate('back_menu', ctx);
      expect(result.valid).toBe(true);
      const next = await step.next(ctx);
      expect(next).toBe('loyalty_menu');
    });
  });

  describe('loyalty_redeem step', () => {
    const step = getStep(loyaltyFlow, 'loyalty_redeem');

    it('shows insufficient points message when below threshold', async () => {
      ctx.session.session_data.loyalty_balance = 200;
      const messages = await step.prompt(ctx);
      expect((messages[0] as any).text).toContain('300'); // 500 - 200 = 300 needed
      expect((messages[0] as any).text).toContain('more points');
    });

    it('shows redemption confirmation when enough points', async () => {
      ctx.session.session_data.loyalty_balance = 600;
      const messages = await step.prompt(ctx);
      expect((messages[0] as any).body).toContain('free haircut');
      expect((messages[0] as any).buttons).toHaveLength(2);
    });

    it('validates confirm action', async () => {
      const result = await step.validate('confirm_redeem', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._redeem_action).toBe('confirm');
    });

    it('validates skip action', async () => {
      const result = await step.validate('skip_redeem', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._redeem_action).toBe('skip');
    });

    it('routes back to menu on skip', async () => {
      ctx.session.session_data._redeem_action = 'skip';
      const next = await step.next(ctx);
      expect(next).toBe('loyalty_menu');
    });
  });
});
