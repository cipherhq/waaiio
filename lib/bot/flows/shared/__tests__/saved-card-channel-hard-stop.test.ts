import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequiresPin = vi.fn();
const mockVerifyPin = vi.fn();
const mockChargeSavedMethod = vi.fn();
const mockGetSavedMethods = vi.fn();

vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    requiresPin: (...args: unknown[]) => mockRequiresPin(...args),
    verifyPin: (...args: unknown[]) => mockVerifyPin(...args),
    chargeSavedMethod: (...args: unknown[]) => mockChargeSavedMethod(...args),
    getSavedMethods: (...args: unknown[]) => mockGetSavedMethods(...args),
  },
}));

import { handleSavedCardInput } from '../saved-card-flow';
import { schedulingFlow } from '../../scheduling.flow';

function baseCtx(sessionData: Record<string, unknown>) {
  return {
    supabase: {
      from: vi.fn(() => {
        throw new Error('DB/provider preparation must not run without inbound channel');
      }),
    },
    sender: {
      sendText: vi.fn().mockResolvedValue({}),
      sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}),
    },
    standalone: {},
    intelligence: {},
    from: '+15712746425',
    session: {
      id: 'session-1',
      user_id: 'user-1',
      business_id: 'biz-1',
      current_step: 'saved_card_prompt',
      session_data: sessionData,
      version: 1,
    },
    business: {
      id: 'biz-1',
      name: 'Jshop',
      slug: 'jshop',
      category: 'shop',
      flow_type: 'scheduling',
      subscription_tier: 'business',
      trial_ends_at: '2027-01-01T00:00:00.000Z',
      metadata: {},
      country_code: 'US',
      payment_gateway: 'stripe',
    },
    t: vi.fn(async (text: string) => text),
  } as any;
}

describe('#382 saved-card inbound channel hard stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequiresPin.mockResolvedValue({ required: false, locked: false });
    mockVerifyPin.mockResolvedValue({ valid: true });
    mockGetSavedMethods.mockResolvedValue([]);
  });

  it('shared saved-card helper performs no charge when WhatsApp origin channel is missing', async () => {
    const ctx = baseCtx({
      _saved_method_id: 'spm-1',
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 50,
      reference: 'ORDER-1-saved',
      entityId: { orderId: 'order-1' },
      transactionCategory: 'ordering',
    });

    expect(result).toEqual({
      valid: false,
      errorMessage: 'We could not safely process this payment right now. Please try again.',
    });
    expect(mockRequiresPin).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(ctx.supabase.from).not.toHaveBeenCalled();
  });

  it('scheduling custom saved-card path performs no charge when inbound channel is missing', async () => {
    const step = schedulingFlow.steps.find(s => s.id === 'saved_card_prompt');
    expect(step).toBeDefined();

    const ctx = baseCtx({
      _saved_method_id: 'spm-1',
      _pending_deposit: 200,
      booking_id: 'booking-1',
      reference_code: 'WA-BK-1',
    });

    const result = await step!.validate('pay_saved', ctx);

    expect(result).toEqual({
      valid: false,
      errorMessage: 'We could not safely process this payment right now. Please try again.',
    });
    expect(mockRequiresPin).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(ctx.supabase.from).not.toHaveBeenCalled();
  });

  it('scheduling PIN-success path still performs no charge if channel provenance disappeared', async () => {
    const step = schedulingFlow.steps.find(s => s.id === 'saved_card_prompt');
    expect(step).toBeDefined();

    const ctx = baseCtx({
      _saved_method_id: 'spm-1',
      _awaiting_card_pin: true,
      _pending_deposit: 200,
      booking_id: 'booking-1',
      reference_code: 'WA-BK-1',
    });

    const result = await step!.validate('1234', ctx);

    expect(mockVerifyPin).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      valid: false,
      errorMessage: 'We could not safely process this payment right now. Please try again.',
    });
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(ctx.supabase.from).not.toHaveBeenCalled();
  });
});
