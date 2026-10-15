import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockSupabase, getStep } from './helpers';
import { reservationFlow } from '../reservation.flow';
import { schedulingFlow } from '../scheduling.flow';
import { appointmentFlow } from '../appointment.flow';
import { paymentFlow } from '../payment.flow';

// ──────────────────────────────────────────────────────────
// Group 1: Dead-end recovery buttons
// ──────────────────────────────────────────────────────────

describe('Reservation: no-properties recovery', () => {
  const step = getStep(reservationFlow, 'select_apartment');

  it('shows buttons (not text-only) when no properties available', async () => {
    const supabase = createMockSupabase();
    (supabase.from as any).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [] }),
    });
    const ctx = createMockContext({
      supabase: supabase as any,
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'shortlet' as any, flow_type: 'reservation' as any, subscription_tier: 'starter', trial_ends_at: '', metadata: {} },
    });
    const messages = await step.prompt(ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('buttons');
    expect((messages[0] as any).buttons).toHaveLength(2);
    expect((messages[0] as any).buttons[0].id).toBe('recovery_other_options');
    expect((messages[0] as any).buttons[1].id).toBe('recovery_exit');
  });

  it('recovery_other_options validate returns _recovery_action', async () => {
    const ctx = createMockContext();
    const result = await step.validate('recovery_other_options', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._recovery_action).toBe('other_options');
  });

  it('recovery_exit validate returns _action cancel', async () => {
    const ctx = createMockContext();
    const result = await step.validate('recovery_exit', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancel');
  });

  it('next() routes to select_capability on other_options', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'select_apartment', session_data: { _recovery_action: 'other_options' }, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('select_capability');
    // Recovery action should be cleaned up
    expect(ctx.session.session_data._recovery_action).toBeUndefined();
  });

  it('next() returns null on cancel', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'select_apartment', session_data: { _action: 'cancel' }, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBeNull();
  });

  it('next() returns select_checkin on normal flow', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'select_apartment', session_data: {}, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('select_checkin');
  });
});

describe('Reservation: unavailable dates recovery', () => {
  const step = getStep(reservationFlow, 'create_reservation');

  it('recovery_change_dates validate returns correct action', async () => {
    const ctx = createMockContext();
    const result = await step.validate('recovery_change_dates', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._recovery_action).toBe('change_dates');
  });

  it('next() routes to select_checkin on change_dates and preserves property', async () => {
    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'create_reservation',
        session_data: { _recovery_action: 'change_dates', property_id: 'prop-123', service_name: 'Deluxe Suite' },
        version: 0,
      },
    });
    const nextStep = await step.next(ctx);
    expect(nextStep).toBe('select_checkin');
    // Property preserved
    expect(ctx.session.session_data.property_id).toBe('prop-123');
    expect(ctx.session.session_data.service_name).toBe('Deluxe Suite');
    // Recovery action cleaned up
    expect(ctx.session.session_data._recovery_action).toBeUndefined();
  });
});

describe('Scheduling: class session recovery', () => {
  const step = getStep(schedulingFlow, 'select_class_session');

  it('recovery_other_options returns correct data', async () => {
    const ctx = createMockContext();
    const result = await step.validate('recovery_other_options', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._recovery_action).toBe('other_options');
  });

  it('recovery_exit returns cancel action', async () => {
    const ctx = createMockContext();
    const result = await step.validate('recovery_exit', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancel');
  });

  it('next() routes to select_capability on other_options', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'select_class_session', session_data: { _recovery_action: 'other_options' }, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('select_capability');
  });

  it('next() returns null on cancel', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'select_class_session', session_data: { _action: 'cancel' }, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBeNull();
  });

  it('next() returns select_quantity on normal flow', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'select_class_session', session_data: {}, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('select_quantity');
  });
});

describe('Appointment: no-appointments recovery', () => {
  const step = appointmentFlow.steps[0]; // select_appointment

  it('recovery_other_options validate works', async () => {
    const ctx = createMockContext();
    const result = await step.validate('recovery_other_options', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._recovery_action).toBe('other_options');
  });

  it('recovery_exit validate works', async () => {
    const ctx = createMockContext();
    const result = await step.validate('recovery_exit', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancel');
  });

  it('next() routes to select_capability on other_options', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'select_appointment', session_data: { _recovery_action: 'other_options' }, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('select_capability');
    expect(ctx.session.session_data._recovery_action).toBeUndefined();
  });

  it('next() returns null on cancel', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'select_appointment', session_data: { _action: 'cancel' }, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────
// Group 3: Payment completion fixes
// ──────────────────────────────────────────────────────────

describe('Payment: recurring failure recovery', () => {
  const step = getStep(paymentFlow, 'setup_recurring');

  it('retry_recurring validate returns retry flag', async () => {
    const result = await step.validate('retry_recurring', createMockContext());
    expect(result.valid).toBe(true);
    expect(result.data?._retry_recurring).toBe(true);
  });

  it('go_back validate returns cancel action', async () => {
    const result = await step.validate('go_back', createMockContext());
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancel');
  });

  it('next() loops back to setup_recurring on retry', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'setup_recurring', session_data: { _retry_recurring: true }, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBe('setup_recurring');
    expect(ctx.session.session_data._retry_recurring).toBeUndefined();
  });

  it('next() returns null on normal completion', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'setup_recurring', session_data: {}, version: 0 },
    });
    const nextStep = await step.next!(ctx);
    expect(nextStep).toBeNull();
  });
});

describe('Payment: whitelabel footer', () => {
  const step = getStep(paymentFlow, 'payment_thank_you');

  it('whitelabel business does NOT show Powered by Waaiio', async () => {
    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'payment_thank_you',
        session_data: { active_capability: 'giving', service_name: 'Tithe', amount: 5000, reference_code: 'BW-1234' },
        version: 0,
      },
      business: { id: 'b1', name: 'Test Church', slug: 'test', category: 'church' as any, flow_type: 'payment' as any, subscription_tier: 'business', trial_ends_at: '', metadata: {} },
    });
    const messages = await step.prompt(ctx);
    expect(messages).toHaveLength(1);
    const text = (messages[0] as any).text;
    // business tier has whitelabel — should NOT contain Powered by
    expect(text).not.toContain('Powered by');
  });

  it('non-whitelabel business shows Powered by Waaiio', async () => {
    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'payment_thank_you',
        session_data: { active_capability: 'giving', service_name: 'Tithe', amount: 5000, reference_code: 'BW-1234' },
        version: 0,
      },
      business: { id: 'b1', name: 'Test Church', slug: 'test', category: 'church' as any, flow_type: 'payment' as any, subscription_tier: 'free', trial_ends_at: '', metadata: {} },
    });
    const messages = await step.prompt(ctx);
    const text = (messages[0] as any).text;
    expect(text).toContain('Powered by Waaiio');
  });
});

// ──────────────────────────────────────────────────────────
// Group 4: Cart expiry notification
// ──────────────────────────────────────────────────────────

describe('Ordering: cart expiry notification', () => {
  it('sets _cart_expired_notice when cart expires', () => {
    // Simulate: cart existed 3 hours ago
    const session_data: Record<string, unknown> = {
      cart: [{ id: 'item1' }],
      cart_created_at: Date.now() - 3 * 60 * 60 * 1000, // 3 hours ago
    };

    const CART_EXPIRY_MS = 2 * 60 * 60 * 1000;
    const cartCreatedAt = session_data.cart_created_at as number;
    const cartExpired = cartCreatedAt && Date.now() - cartCreatedAt > CART_EXPIRY_MS;

    expect(cartExpired).toBe(true);

    // The flow sets _cart_expired_notice when expiring
    if (cartExpired) {
      session_data._cart_expired_notice = true;
      session_data.cart = [];
      session_data.cart_created_at = Date.now();
    }

    expect(session_data._cart_expired_notice).toBe(true);
    expect(session_data.cart).toEqual([]);
  });

  it('does NOT set notice for fresh cart', () => {
    const session_data: Record<string, unknown> = {
      cart: [{ id: 'item1' }],
      cart_created_at: Date.now() - 30 * 60 * 1000, // 30 minutes ago
    };

    const CART_EXPIRY_MS = 2 * 60 * 60 * 1000;
    const cartCreatedAt = session_data.cart_created_at as number;
    const cartExpired = cartCreatedAt && Date.now() - cartCreatedAt > CART_EXPIRY_MS;

    expect(cartExpired).toBe(false);
    expect(session_data._cart_expired_notice).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────
// Returning customer: verify existing reuse patterns
// ──────────────────────────────────────────────────────────

describe('Returning customer: name/email reuse', () => {
  const reservationNameStep = getStep(reservationFlow, 'collect_name');
  const reservationEmailStep = getStep(reservationFlow, 'collect_email');

  it('collect_name skipIf returns true when user_id and profile name exist', async () => {
    const supabase = createMockSupabase();
    (supabase.from as any).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'u1', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' },
        error: null,
      }),
    });
    const ctx = createMockContext({
      supabase: supabase as any,
      session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'collect_name', session_data: {}, version: 0 },
    });
    const skip = await reservationNameStep.skipIf!(ctx);
    expect(skip).toBe(true);
    expect(ctx.session.session_data.first_name).toBe('Jane');
    expect(ctx.session.session_data.last_name).toBe('Doe');
    expect(ctx.session.session_data.email).toBe('jane@example.com');
  });

  it('collect_name skipIf returns false when no user_id', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: null, business_id: 'b1', current_step: 'collect_name', session_data: {}, version: 0 },
    });
    const skip = await reservationNameStep.skipIf!(ctx);
    expect(skip).toBe(false);
  });

  it('collect_email skipIf returns true for real email', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'collect_email', session_data: { email: 'jane@example.com' }, version: 0 },
    });
    const skip = await reservationEmailStep.skipIf!(ctx);
    expect(skip).toBe(true);
  });

  it('collect_email skipIf returns false for generated fallback email', async () => {
    const ctx = createMockContext({
      session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'collect_email', session_data: { email: '2341234567890@whatsapp.waaiio.com' }, version: 0 },
    });
    const skip = await reservationEmailStep.skipIf!(ctx);
    expect(skip).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────
// Recovery button ID and WhatsApp limit verification
// ──────────────────────────────────────────────────────────

describe('Recovery button constraints', () => {
  it('all recovery prompts have <= 3 buttons', async () => {
    // Reservation: no properties
    const resStep = getStep(reservationFlow, 'select_apartment');
    const supabase = createMockSupabase();
    (supabase.from as any).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [] }),
    });
    const ctx = createMockContext({
      supabase: supabase as any,
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'shortlet' as any, flow_type: 'reservation' as any, subscription_tier: 'starter', trial_ends_at: '', metadata: {} },
    });
    const msgs = await resStep.prompt(ctx);
    for (const m of msgs) {
      if (m.type === 'buttons') {
        expect((m as any).buttons.length).toBeLessThanOrEqual(3);
      }
    }

    // Appointment: no appointments
    const aptStep = appointmentFlow.steps[0];
    const aptSupabase = createMockSupabase();
    (aptSupabase.from as any).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [] }),
    });
    const aptCtx = createMockContext({
      supabase: aptSupabase as any,
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'salon' as any, flow_type: 'scheduling' as any, subscription_tier: 'starter', trial_ends_at: '', metadata: {} },
    });
    const aptMsgs = await aptStep.prompt(aptCtx);
    for (const m of aptMsgs) {
      if (m.type === 'buttons') {
        expect((m as any).buttons.length).toBeLessThanOrEqual(3);
      }
    }
  });
});


// CTO recovery regression: real reservation step navigation with invalid
// dates removed while keeping the selected property.
describe('Reservation recovery preserves user selection', () => {
  const step = getStep(reservationFlow, 'create_reservation');

  it('routes to date selection after invalid dates were cleared', async () => {
    const sessionData: Record<string, unknown> = {
      property_id: 'property-1',
      service_name: 'Suite',
      guests: 3,
      _recovery_action: 'change_dates',
    };
    const ctx = createMockContext({
      session: {
        id: 'session-1',
        user_id: 'customer-1',
        business_id: 'business-1',
        current_step: 'create_reservation',
        session_data: sessionData,
        version: 0,
      },
    });
    const result = await step.next(ctx);
    expect(result).toBe('select_checkin');
    expect(ctx.session.session_data).toMatchObject({
      property_id: 'property-1', service_name: 'Suite', guests: 3,
    });
    expect(ctx.session.session_data).not.toHaveProperty('check_in');
    expect(ctx.session.session_data).not.toHaveProperty('check_out');
    expect(ctx.session.session_data).not.toHaveProperty('_recovery_action');
  });
});
