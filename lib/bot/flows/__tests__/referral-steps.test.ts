import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext, getStep } from './helpers';
import type { FlowContext } from '../types';

// Mock external imports used by scheduling.flow.ts
vi.mock('@/lib/constants', () => ({
  BOOKING_DEFAULTS: { maxPartySize: 20, maxDaysAhead: 90 },
  generateTimeSlots: vi.fn(() => []),
  formatCurrency: (amount: number) => `₦${amount}`,
  getLocale: vi.fn(() => ({ currency: 'NGN' })),
  getMaxQuantity: vi.fn(() => 20),
}));
vi.mock('@/lib/categoryConfig', () => ({ getCategoryLabels: vi.fn(() => ({ partyLabel: 'guests' })) }));
vi.mock('../shared/user', () => ({
  createWhatsAppUser: vi.fn(),
  findUserByPhone: vi.fn(),
}));
vi.mock('../shared/payment', () => ({
  initializePayment: vi.fn(),
  verifyPayment: vi.fn(),
  recordPlatformFee: vi.fn(),
}));
vi.mock('../shared/notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../shared/templates', () => ({ getConfirmationMessage: vi.fn() }));
vi.mock('../shared/post-completion', () => ({ handlePostCompletion: vi.fn() }));
vi.mock('../shared/terms', () => ({ getTermsPrompt: vi.fn() }));
vi.mock('../shared/notify-owner', () => ({ notifyOwnerNewBooking: vi.fn() }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn() }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn() }));
vi.mock('@/lib/capabilities/service', () => ({
  getEnabledCapabilities: vi.fn().mockResolvedValue(['scheduling', 'referral']),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));

// Import after mocks
const { schedulingFlow } = await import('../scheduling.flow');

describe('Referral Steps (scheduling)', () => {
  let ctx: FlowContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('ask_referral_code step', () => {
    const step = getStep(schedulingFlow, 'ask_referral_code');

    it('shows referral code prompt with buttons', async () => {
      const messages = await step.prompt(ctx);
      expect(messages[0].type).toBe('buttons');
      expect((messages[0] as any).buttons).toHaveLength(2);
      expect((messages[0] as any).buttons[0].id).toBe('enter_code');
      expect((messages[0] as any).buttons[1].id).toBe('skip');
    });

    it('validates enter_code selection', async () => {
      const result = await step.validate('enter_code', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._referral_action).toBe('enter');
    });

    it('validates skip selection', async () => {
      const result = await step.validate('skip', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._referral_action).toBe('skip');
    });

    it('rejects invalid input', async () => {
      const result = await step.validate('hello', ctx);
      expect(result.valid).toBe(false);
    });

    it('routes to enter_referral_code on enter', async () => {
      ctx.session.session_data._referral_action = 'enter';
      const next = await step.next(ctx);
      expect(next).toBe('enter_referral_code');
    });

    it('routes to collect_email on skip', async () => {
      ctx.session.session_data._referral_action = 'skip';
      const next = await step.next(ctx);
      expect(next).toBe('collect_email');
    });
  });

  describe('enter_referral_code step', () => {
    const step = getStep(schedulingFlow, 'enter_referral_code');

    it('shows prompt for code entry', async () => {
      const messages = await step.prompt(ctx);
      expect((messages[0] as any).text).toContain('referral code');
    });

    it('accepts skip as valid input', async () => {
      const result = await step.validate('skip', ctx);
      expect(result.valid).toBe(true);
    });

    it('accepts valid referral code', async () => {
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: 'ref-123', referrer_phone: '+2349000000000' },
          error: null,
        }),
      };
      (ctx.supabase.from as any).mockReturnValueOnce(mockChain);

      const result = await step.validate('FRIEND2026', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.referral_id).toBe('ref-123');
      expect(result.data?.referrer_phone).toBe('+2349000000000');
    });

    it('rejects invalid referral code', async () => {
      const mockChain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
      (ctx.supabase.from as any).mockReturnValueOnce(mockChain);

      const result = await step.validate('BADCODE', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('didn\u2019t work');
    });

    it('routes to collect_email', async () => {
      const next = await step.next(ctx);
      expect(next).toBe('collect_email');
    });
  });
});
