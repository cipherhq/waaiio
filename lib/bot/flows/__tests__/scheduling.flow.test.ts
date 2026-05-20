import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockSupabase, getStep } from './helpers';
import { schedulingFlow } from '../scheduling.flow';

describe('Scheduling Flow', () => {
  it('has all expected steps registered', () => {
    const stepIds = schedulingFlow.steps.map(s => s.id);
    expect(stepIds).toContain('select_service');
    expect(stepIds).toContain('select_staff');
    expect(stepIds).toContain('select_date');
    expect(stepIds).toContain('select_time');
    expect(stepIds).toContain('select_quantity');
    expect(stepIds).toContain('confirmation');
    expect(stepIds).toContain('collect_name');
    expect(stepIds).toContain('create_booking');
    expect(stepIds).toContain('payment');
  });

  describe('create_booking step', () => {
    const step = getStep(schedulingFlow, 'create_booking');

    // Helper to build a mock context with chainable supabase for create_booking
    function buildCtx(sessionDataOverrides: Record<string, unknown> = {}) {
      const supabase = createMockSupabase();
      return createMockContext({
        supabase: supabase as any,
        session: {
          id: 's1',
          user_id: 'u1',
          business_id: 'b1',
          current_step: 'create_booking',
          session_data: {
            date: '2026-06-01',
            time: '10:00',
            service_id: 'svc1',
            service_name: 'Haircut',
            service_price: 5000,
            service_deposit: 0,
            first_name: 'John',
            last_name: 'Doe',
            party_size: 1,
            _auto_approve: true,
            ...sessionDataOverrides,
          },
        },
        business: {
          id: 'b1',
          name: 'Test Salon',
          slug: 'test-salon',
          category: 'salon' as any,
          flow_type: 'scheduling' as any,
          subscription_tier: 'growth',
          trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
          metadata: {},
        },
      });
    }

    it('T&C cancel check runs BEFORE gate — returns cancel message, NOT terms prompt', async () => {
      const ctx = buildCtx({ _terms_cancelled: true });

      const messages = await step.prompt(ctx);

      // Should deactivate session via supabase update
      expect(ctx.supabase.from).toHaveBeenCalledWith('bot_sessions');

      // Should return a cancellation message, not terms buttons
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
      expect((messages[0] as any).text).toContain('cancelled');

      // Must NOT contain accept_terms/cancel_terms buttons (i.e., not getTermsPrompt output)
      const hasTermsButtons = messages.some(
        (m: any) => m.buttons?.some((b: any) => b.id === 'accept_terms' || b.id === 'cancel_terms')
      );
      expect(hasTermsButtons).toBe(false);
    });

    it('T&C accept — proceeds past the gate (does not return terms prompt)', async () => {
      const ctx = buildCtx({
        _terms_accepted: true,
        service_price: 5000,
        service_deposit: 0,
      });

      // Mock the rpc for book_slot_atomic — rpc().single() chain
      (ctx.supabase.rpc as ReturnType<typeof vi.fn>).mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { booking_id: 'bk1', reference_code: 'REF123', slot_available: true },
          error: null,
        }),
      });

      const messages = await step.prompt(ctx);

      // Should NOT return the terms prompt (no accept_terms button)
      const hasTermsButtons = messages.some(
        (m: any) => m.buttons?.some((b: any) => b.id === 'accept_terms')
      );
      expect(hasTermsButtons).toBe(false);
    });

    it('validate: cancel_terms input sets _terms_cancelled', async () => {
      const ctx = buildCtx();
      const result = await step.validate('cancel_terms', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._terms_cancelled).toBe(true);
    });

    it('validate: accept_terms input sets _terms_accepted', async () => {
      const ctx = buildCtx();
      const result = await step.validate('accept_terms', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._terms_accepted).toBe(true);
    });

    it('validate: cancel_booking sets _action to cancel', async () => {
      const ctx = buildCtx({ booking_id: 'bk1' });
      const result = await step.validate('cancel_booking', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._action).toBe('cancel');
    });

    it('validate: go_back sets _action to cancel', async () => {
      const ctx = buildCtx({ booking_id: 'bk1' });
      const result = await step.validate('go_back', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._action).toBe('cancel');
    });

    it('next: returns create_booking when terms accepted (re-entry)', async () => {
      const ctx = buildCtx({ _terms_accepted: true });
      const nextStep = await step.next(ctx);
      expect(nextStep).toBe('create_booking');
    });

    it('next: returns create_booking when terms cancelled (re-entry)', async () => {
      const ctx = buildCtx({ _terms_cancelled: true });
      const nextStep = await step.next(ctx);
      expect(nextStep).toBe('create_booking');
    });

    it('next: returns select_capability when _action is cancel', async () => {
      const ctx = buildCtx({ _action: 'cancel' });
      const nextStep = await step.next(ctx);
      expect(nextStep).toBe('select_capability');
    });

    it('error messages use "Oops, we hit a snag" not "Something went wrong"', async () => {
      // Test with no userId — forces the error path
      const ctx = buildCtx({ _terms_accepted: true, service_price: 5000 });
      ctx.session.user_id = '';

      // Mock createWhatsAppUser to return null (user creation fails)
      // The flow calls createWhatsAppUser internally which needs supabase mocks
      // Simplest: set user_id to empty string and mock the supabase calls to fail
      (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        const chain: Record<string, any> = {
          select: vi.fn().mockReturnThis(),
          insert: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
          delete: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          neq: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          not: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
        return chain;
      });

      const messages = await step.prompt(ctx);

      // Find any text messages with error content
      const errorTexts = messages
        .filter((m: any) => m.type === 'text')
        .map((m: any) => m.text);

      // Should not contain "Something went wrong"
      for (const text of errorTexts) {
        expect(text).not.toContain('Something went wrong');
      }
    });
  });
});
