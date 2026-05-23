import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { orderingFlow } from '../ordering.flow';

describe('Ordering Flow', () => {
  it('flow has expected steps registered', () => {
    const stepIds = orderingFlow.steps.map(s => s.id);
    expect(stepIds).toContain('browse_catalog');
    expect(stepIds).toContain('browse_category_items');
    expect(stepIds).toContain('select_option_axis');
    expect(stepIds).toContain('select_variant_error');
    expect(stepIds).toContain('select_variant');
    expect(stepIds).toContain('collect_style_photo');
    expect(stepIds).toContain('collect_measurements');
    expect(stepIds).toContain('collect_design_notes');
    expect(stepIds).toContain('collect_deadline');
    expect(stepIds).toContain('select_quantity');
    expect(stepIds).toContain('select_addons');
    expect(stepIds).toContain('select_addon_quantity');
    expect(stepIds).toContain('addon_continue');
    expect(stepIds).toContain('add_to_cart');
    expect(stepIds).toContain('continue_or_checkout');
    expect(stepIds).toContain('apply_promo');
    expect(stepIds).toContain('enter_promo_code');
    expect(stepIds).toContain('select_delivery_zone');
    expect(stepIds).toContain('delivery_details');
    expect(stepIds).toContain('collect_pickup_address');
    expect(stepIds).toContain('collect_dropoff_address');
    expect(stepIds).toContain('collect_package_description');
    expect(stepIds).toContain('collect_package_photo');
    expect(stepIds).toContain('collect_address');
    expect(stepIds).toContain('confirm_address');
    expect(stepIds).toContain('collect_name');
    expect(stepIds).toContain('ask_referral_code');
    expect(stepIds).toContain('enter_referral_code');
    expect(stepIds).toContain('collect_email');
    expect(stepIds).toContain('review_order_summary');
    expect(stepIds).toContain('edit_order_menu');
    expect(stepIds).toContain('edit_name');
    expect(stepIds).toContain('edit_address');
    expect(stepIds).toContain('submit_quote_request');
    expect(stepIds).toContain('process_order');
    expect(stepIds).toContain('await_order_payment');
  });

  describe('process_order step', () => {
    const step = getStep(orderingFlow, 'process_order');

    it('T&C cancel check runs BEFORE gate — returns cancel message, not terms buttons (regression)', async () => {
      const ctx = createMockContext({
        session: {
          id: 'sess-1',
          user_id: 'u1',
          business_id: 'b1',
          current_step: 'process_order',
          session_data: {
            _terms_cancelled: true,
            cart: [{ product_id: 'p1', name: 'Widget', quantity: 1, price: 1000 }],
          },
        },
        business: {
          id: 'b1',
          name: 'Test Shop',
          slug: 'test-shop',
          category: 'other' as any,
          flow_type: 'ordering' as any,
          subscription_tier: 'starter',
          trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
          metadata: {},
        },
      });

      const messages = await step.prompt(ctx);

      // Should contain cancel confirmation
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

    it('next: returns process_order for re-entry when terms accepted', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'process_order',
          session_data: { _terms_accepted: true },
        },
      });
      const nextStep = await step.next!(ctx);
      expect(nextStep).toBe('process_order');
    });

    it('next: returns process_order for re-entry when terms cancelled', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'process_order',
          session_data: { _terms_cancelled: true },
        },
      });
      const nextStep = await step.next!(ctx);
      expect(nextStep).toBe('process_order');
    });

    it('next: returns null when _action is cancelled', async () => {
      const ctx = createMockContext({
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'process_order',
          session_data: { _action: 'cancelled' },
        },
      });
      const nextStep = await step.next!(ctx);
      expect(nextStep).toBeNull();
    });
  });

  describe('browse_catalog step', () => {
    const step = getStep(orderingFlow, 'browse_catalog');

    it('validate: rejects invalid product ID', async () => {
      const ctx = createMockContext();
      // The mock supabase .single() returns { data: null, error: null } by default
      const result = await step.validate('nonexistent-product-id', ctx);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toBeTruthy();
    });
  });

  describe('error messages use friendly tone', () => {
    const step = getStep(orderingFlow, 'process_order');

    it('process_order prompt uses "Something went wrong on our end" when user creation fails', async () => {
      const ctx = createMockContext({
        session: {
          id: 'sess-1',
          user_id: null as any,
          business_id: 'b1',
          current_step: 'process_order',
          session_data: {
            _terms_accepted: true,
            cart: [{ product_id: 'p1', name: 'Widget', quantity: 1, price: 1000 }],
          },
        },
        business: {
          id: 'b1',
          name: 'Test Shop',
          slug: 'test-shop',
          category: 'other' as any,
          flow_type: 'ordering' as any,
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
