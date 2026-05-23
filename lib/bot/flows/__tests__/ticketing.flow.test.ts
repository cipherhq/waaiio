import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { ticketingFlow } from '../ticketing.flow';

describe('Ticketing Flow', () => {
  it('flow has expected steps registered', () => {
    const stepIds = ticketingFlow.steps.map(s => s.id);
    expect(stepIds).toContain('select_event');
    expect(stepIds).toContain('select_ticket_type');
    expect(stepIds).toContain('select_quantity');
    expect(stepIds).toContain('ticket_confirmation');
    expect(stepIds).toContain('collect_name');
    expect(stepIds).toContain('process_tickets');
    expect(stepIds).toContain('await_ticket_payment');
  });

  describe('process_tickets step', () => {
    const step = getStep(ticketingFlow, 'process_tickets');

    it('T&C cancel check runs BEFORE gate — returns cancel message, not terms buttons (regression)', async () => {
      const ctx = createMockContext({
        session: {
          id: 'sess-1',
          user_id: 'u1',
          business_id: 'b1',
          current_step: 'process_tickets',
          session_data: {
            _terms_cancelled: true,
            ticket_quantity: 2,
            total_amount: 5000,
            event_name: 'Test Concert',
            event_date: '2026-06-15',
            event_venue: 'Test Arena',
          },
        },
        business: {
          id: 'b1',
          name: 'Test Events',
          slug: 'test-events',
          category: 'other' as any,
          flow_type: 'ticketing' as any,
          subscription_tier: 'starter',
          trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
          metadata: {},
        },
      });

      const messages = await step.prompt(ctx);

      // Should contain cancel confirmation text
      const text = messages.map(m => ('text' in m ? m.text : ('body' in m ? m.body : ''))).join(' ');
      expect(text).toContain('cancelled');

      // Should NOT contain the T&C "Continue" button (that would mean the gate fired instead)
      expect(text).not.toContain('Continue');
    });

    it('validate: cancel_terms sets _terms_cancelled flag', async () => {
      const ctx = createMockContext();
      const result = await step.validate('cancel_terms', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._terms_cancelled).toBe(true);
    });

    it('validate: accept_terms sets _terms_accepted flag', async () => {
      const ctx = createMockContext();
      const result = await step.validate('accept_terms', ctx);
      expect(result.valid).toBe(true);
      expect(result.data?._terms_accepted).toBe(true);
    });

    it('next: returns process_tickets for re-entry when terms accepted', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'process_tickets',
          session_data: { _terms_accepted: true },
        },
      });
      const nextStep = await step.next!(ctx);
      expect(nextStep).toBe('process_tickets');
    });

    it('next: returns process_tickets for re-entry when terms cancelled', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'process_tickets',
          session_data: { _terms_cancelled: true },
        },
      });
      const nextStep = await step.next!(ctx);
      expect(nextStep).toBe('process_tickets');
    });

    it('next: returns null when neither terms flag is set (normal completion)', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'process_tickets',
          session_data: {},
        },
      });
      const nextStep = await step.next!(ctx);
      expect(nextStep).toBeNull();
    });
  });

  describe('select_event step', () => {
    const step = getStep(ticketingFlow, 'select_event');

    it('validate: rejects invalid event ID', async () => {
      const ctx = createMockContext();
      // The mock supabase .single() returns { data: null, error: null } by default
      const result = await step.validate('nonexistent-event-id', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBeTruthy();
    });
  });

  describe('error messages use friendly tone', () => {
    const step = getStep(ticketingFlow, 'process_tickets');

    it('process_tickets prompt uses "Something went wrong on our end" when user creation fails', async () => {
      const ctx = createMockContext({
        session: {
          id: 'sess-1',
          user_id: null as any,
          business_id: 'b1',
          current_step: 'process_tickets',
          session_data: {
            _terms_accepted: true,
            ticket_quantity: 2,
            total_amount: 5000,
            event_name: 'Test Concert',
            event_date: '2026-06-15',
            event_venue: 'Test Arena',
            first_name: 'Test',
            last_name: 'User',
          },
        },
        business: {
          id: 'b1',
          name: 'Test Events',
          slug: 'test-events',
          category: 'other' as any,
          flow_type: 'ticketing' as any,
          subscription_tier: 'starter',
          trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
          metadata: {},
        },
      });

      const messages = await step.prompt(ctx);
      const text = messages.map(m => ('text' in m ? m.text : '')).join(' ');
      // createWhatsAppUser returns undefined from mock → userId is falsy
      expect(text).toContain('Something went wrong on our end');
      // Error message should be user-friendly, not generic
    });
  });
});
