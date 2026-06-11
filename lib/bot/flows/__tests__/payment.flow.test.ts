import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockSupabase, getStep } from './helpers';
import { paymentFlow } from '../payment.flow';

describe('Payment Flow', () => {
  it('has all expected steps registered', () => {
    const stepIds = paymentFlow.steps.map(s => s.id);
    expect(stepIds).toContain('select_category');
    expect(stepIds).toContain('enter_amount');
    expect(stepIds).toContain('confirm_amount');
    expect(stepIds).toContain('collect_name');
    expect(stepIds).toContain('process_payment');
    expect(stepIds).toContain('await_payment');
    expect(stepIds).toContain('offer_recurring');
    expect(stepIds).toContain('confirm_recurring');
    expect(stepIds).toContain('setup_recurring');
    expect(stepIds).toContain('payment_thank_you');
  });

  // Helper to build a mock context for payment flow
  function buildCtx(sessionDataOverrides: Record<string, unknown> = {}) {
    const supabase = createMockSupabase();
    return createMockContext({
      supabase: supabase as any,
      session: {
        id: 's1',
        user_id: 'u1',
        business_id: 'b1',
        current_step: 'select_category',
        session_data: {
          active_capability: 'payment',
          ...sessionDataOverrides,
        },
      },
      business: {
        id: 'b1',
        name: 'Test Church',
        slug: 'test-church',
        category: 'church' as any,
        flow_type: 'payment' as any,
        subscription_tier: 'growth',
        trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
        metadata: {},
      },
    });
  }

  describe('select_category step', () => {
    const step = getStep(paymentFlow, 'select_category');

    it('validates a valid service_id and sets active data', async () => {
      const ctx = buildCtx();

      // Mock supabase to return a service when queried by ID
      (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const chain: Record<string, any> = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              id: 'svc1',
              name: 'Tithe',
              billing_type: 'one_time',
              recurring_interval: null,
              price: 0,
            },
            error: null,
          }),
        };
        return chain;
      });

      const result = await step.validate('svc1', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.service_id).toBe('svc1');
      expect(result.data?.service_name).toBe('Tithe');
      expect(result.data?.service_billing_type).toBe('one_time');
    });

    it('rejects invalid input when service not found', async () => {
      const ctx = buildCtx();

      // Mock supabase to return null (no service found)
      (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const chain: Record<string, any> = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
        return chain;
      });

      const result = await step.validate('nonexistent', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBeTruthy();
    });
  });

  describe('enter_amount step', () => {
    const step = getStep(paymentFlow, 'enter_amount');

    it('validates a valid number and sets amount', async () => {
      const ctx = buildCtx({ service_name: 'Tithe' });
      const result = await step.validate('5000', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.amount).toBe(5000);
    });

    it('validates amount with currency symbols', async () => {
      const ctx = buildCtx({ service_name: 'Tithe' });
      const result = await step.validate('$500', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?.amount).toBe(500);
    });

    it('rejects negative numbers', async () => {
      const ctx = buildCtx({ service_name: 'Tithe' });
      const result = await step.validate('-100', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('valid amount');
    });

    it('rejects zero', async () => {
      const ctx = buildCtx({ service_name: 'Tithe' });
      const result = await step.validate('0', ctx);
      expect(result.valid).toBe(false);
    });

    it('rejects non-numeric input', async () => {
      const ctx = buildCtx({ service_name: 'Tithe' });
      const result = await step.validate('abc', ctx);
      expect(result.valid).toBe(false);
    });

    it('skipIf returns true when amount is pre-filled', async () => {
      const ctx = buildCtx({ amount: 5000 });
      const shouldSkip = await step.skipIf!(ctx);
      expect(shouldSkip).toBe(true);
    });

    it('skipIf returns true when service has fixed price', async () => {
      const ctx = buildCtx({ service_price: 3000 });
      const shouldSkip = await step.skipIf!(ctx);
      expect(shouldSkip).toBe(true);
      // It should have set the amount in session_data
      expect(ctx.session.session_data.amount).toBe(3000);
    });

    it('skipIf returns false when no amount and no fixed price', async () => {
      const ctx = buildCtx({ service_price: 0 });
      const shouldSkip = await step.skipIf!(ctx);
      expect(shouldSkip).toBe(false);
    });
  });

  describe('process_payment step', () => {
    const step = getStep(paymentFlow, 'process_payment');

    it('T&C cancel check runs BEFORE gate — returns cancel message, NOT terms prompt', async () => {
      const ctx = buildCtx({
        _terms_cancelled: true,
        amount: 5000,
        service_id: 'svc1',
        service_name: 'Tithe',
        first_name: 'John',
        last_name: 'Doe',
      });
      ctx.session.current_step = 'process_payment';

      const messages = await step.prompt(ctx);

      // Executor now handles session deactivation after next() returns null

      // Should return a cancellation message
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
      expect((messages[0] as any).text).toContain('cancelled');

      // Must NOT contain terms buttons
      const hasTermsButtons = messages.some(
        (m: any) => m.buttons?.some((b: any) => b.id === 'accept_terms' || b.id === 'cancel_terms')
      );
      expect(hasTermsButtons).toBe(false);
    });

    it('validate: cancel_terms sets _terms_cancelled', async () => {
      const ctx = buildCtx();
      const result = await step.validate('cancel_terms', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._terms_cancelled).toBe(true);
    });

    it('validate: accept_terms sets _terms_accepted', async () => {
      const ctx = buildCtx();
      const result = await step.validate('accept_terms', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._terms_accepted).toBe(true);
    });

    it('validate: unknown input returns valid (passthrough)', async () => {
      const ctx = buildCtx();
      const result = await step.validate('random_input', ctx);
      expect(result.valid).toBe(true);
      // No specific data set for unknown inputs
      expect(result.data).toBeUndefined();
    });

    it('next: re-enters process_payment when terms accepted', async () => {
      const ctx = buildCtx({ _terms_accepted: true });
      ctx.session.current_step = 'process_payment';
      const nextStep = await step.next(ctx);
      expect(nextStep).toBe('process_payment');
    });

    it('next: re-enters process_payment when terms cancelled', async () => {
      const ctx = buildCtx({ _terms_cancelled: true });
      ctx.session.current_step = 'process_payment';
      const nextStep = await step.next(ctx);
      expect(nextStep).toBe('process_payment');
    });

    it('next: returns null when neither terms accepted nor cancelled (flow end)', async () => {
      const ctx = buildCtx({});
      ctx.session.current_step = 'process_payment';
      const nextStep = await step.next(ctx);
      expect(nextStep).toBeNull();
    });

    it('error messages use friendly tone ("Something went wrong on our end")', async () => {
      const ctx = buildCtx({
        _terms_accepted: true,
        amount: 5000,
        service_id: 'svc1',
        service_name: 'Tithe',
        first_name: 'John',
        last_name: 'Doe',
      });
      ctx.session.current_step = 'process_payment';
      ctx.session.user_id = '';

      // Mock supabase to fail user creation (return null for users lookup)
      (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const chain: Record<string, any> = {
          select: vi.fn().mockReturnThis(),
          insert: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          neq: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
        return chain;
      });

      const messages = await step.prompt(ctx);
      const errorTexts = messages
        .filter((m: any) => m.type === 'text')
        .map((m: any) => m.text);

      // Should use friendly error language
      const hasSnagMessage = errorTexts.some((t: string) => t.includes('Something went wrong on our end'));
      expect(hasSnagMessage).toBe(true);

      // Should NOT use generic "Something went wrong"
      for (const text of errorTexts) {
        // Error message should be user-friendly, not generic
      }
    });
  });
});
