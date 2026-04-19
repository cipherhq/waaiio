import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext, getStep } from './helpers';
import type { FlowContext } from '../types';

// Mock external imports used by ordering.flow.ts
vi.mock('@/lib/constants', () => ({
  formatCurrency: (amount: number) => `₦${amount}`,
}));
vi.mock('../shared/user', () => ({
  createWhatsAppUser: vi.fn(),
  findUserByPhone: vi.fn(),
}));
vi.mock('../shared/payment', () => ({
  initializePayment: vi.fn(),
  verifyPayment: vi.fn(),
  recordPlatformFee: vi.fn(),
}));
vi.mock('../shared/templates', () => ({ getOrderConfirmationMessage: vi.fn() }));
vi.mock('../shared/post-completion', () => ({ handlePostCompletion: vi.fn() }));
vi.mock('../shared/terms', () => ({ getTermsPrompt: vi.fn() }));
vi.mock('../shared/notify-owner', () => ({
  notifyOwnerNewOrder: vi.fn(),
  notifyOwnerNewQuoteRequest: vi.fn(),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn() }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));

// Import after mocks
const { orderingFlow } = await import('../ordering.flow');

describe('Logistics Steps (ordering)', () => {
  let ctx: FlowContext;

  beforeEach(() => {
    ctx = createMockContext({
      business: {
        id: 'biz-1',
        name: 'Fast Courier',
        slug: 'fast-courier',
        category: 'other' as any,
        flow_type: 'ordering' as any,
        subscription_tier: 'starter',
        trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
        metadata: { logistics_mode: true },
      },
    });
  });

  describe('collect_pickup_address step', () => {
    const step = getStep(orderingFlow, 'collect_pickup_address');

    it('shows pickup address prompt', async () => {
      const messages = await step.prompt(ctx);
      expect((messages[0] as any).text).toContain('Pickup Location');
      expect((messages[0] as any).text).toContain('pick up the package');
    });

    it('accepts valid address', async () => {
      const result = await step.validate('123 Main Street, Lagos', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.pickup_address).toBe('123 Main Street, Lagos');
    });

    it('rejects too-short address', async () => {
      const result = await step.validate('Hi', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('too short');
    });

    it('routes to collect_dropoff_address', async () => {
      const next = await step.next(ctx);
      expect(next).toBe('collect_dropoff_address');
    });
  });

  describe('collect_dropoff_address step', () => {
    const step = getStep(orderingFlow, 'collect_dropoff_address');

    it('shows dropoff address prompt', async () => {
      const messages = await step.prompt(ctx);
      expect((messages[0] as any).text).toContain('Drop-off Location');
    });

    it('accepts valid address and sets delivery_address', async () => {
      const result = await step.validate('456 Victoria Island, Lagos', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.dropoff_address).toBe('456 Victoria Island, Lagos');
      expect(result.data?.delivery_address).toBe('456 Victoria Island, Lagos');
    });

    it('rejects too-short address', async () => {
      const result = await step.validate('abc', ctx);
      expect(result.valid).toBe(false);
    });

    it('routes to collect_package_description', async () => {
      const next = await step.next(ctx);
      expect(next).toBe('collect_package_description');
    });
  });

  describe('collect_package_description step', () => {
    const step = getStep(orderingFlow, 'collect_package_description');

    it('shows package description prompt', async () => {
      const messages = await step.prompt(ctx);
      expect((messages[0] as any).text).toContain('What are you sending');
    });

    it('accepts valid description', async () => {
      const result = await step.validate('Two boxes of documents', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.package_description).toBe('Two boxes of documents');
    });

    it('rejects too-short description', async () => {
      const result = await step.validate('ab', ctx);
      expect(result.valid).toBe(false);
    });

    it('routes to collect_package_photo', async () => {
      const next = await step.next(ctx);
      expect(next).toBe('collect_package_photo');
    });
  });

  describe('collect_package_photo step', () => {
    const step = getStep(orderingFlow, 'collect_package_photo');

    it('shows photo prompt with skip button', async () => {
      const messages = await step.prompt(ctx);
      expect(messages[0].type).toBe('buttons');
      expect((messages[0] as any).buttons[0].id).toBe('skip');
    });

    it('accepts media URL from image', async () => {
      ctx.mediaUrl = 'https://cdn.whatsapp.net/photo123.jpg';
      const result = await step.validate('', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.package_photo_url).toBe('https://cdn.whatsapp.net/photo123.jpg');
    });

    it('accepts skip', async () => {
      const result = await step.validate('skip', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.package_photo_url).toBeUndefined();
    });

    it('routes to collect_name', async () => {
      const next = await step.next(ctx);
      expect(next).toBe('collect_name');
    });
  });
});
