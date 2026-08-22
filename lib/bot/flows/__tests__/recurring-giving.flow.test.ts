/**
 * Recurring Giving lifecycle — executable flow step tests.
 *
 * Imports real flow objects and calls actual step methods (validate, next, prompt)
 * with mocked Supabase/context. Proves the giving-specific recurring integration
 * boundary works correctly.
 *
 * For generic recurring engine tests (Stripe activation, Paystack renewal, etc.)
 * see: p0-sub2-activation-lifecycle.test.ts, recurring-billing-db.test.ts,
 *       flutterwave-split-recurring.test.ts, paystack-split-recurring.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockSupabase, getStep } from './helpers';
import { paymentFlow } from '../payment.flow';
import { capabilitySelectionFlow } from '../capability-selection.flow';

// ── Helpers ──

function buildPaymentCtx(sessionDataOverrides: Record<string, unknown> = {}) {
  const supabase = createMockSupabase();
  return createMockContext({
    supabase: supabase as any,
    session: {
      id: 's1',
      user_id: 'u1',
      business_id: 'b1',
      current_step: 'select_category',
      version: 0,
      session_data: {
        active_capability: 'giving',
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

function buildCapCtx(capabilities: string[]) {
  return createMockContext({
    session: {
      id: 's1',
      user_id: 'u1',
      business_id: 'b1',
      current_step: 'my_account_menu',
      version: 0,
      session_data: { capabilities },
    },
  });
}

// ═══════════════════════════════════════════════════════════
// A. GIVING SERVICE METADATA
// ═══════════════════════════════════════════════════════════

describe('A. select_category — giving service with recurring metadata', () => {
  const step = getStep(paymentFlow, 'select_category');

  it('A1. validates recurring giving service and returns correct metadata', async () => {
    const ctx = buildPaymentCtx();

    // Mock supabase to return a recurring giving service
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [] }),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: 'giving-recurring-1',
          name: 'Tithe',
          billing_type: 'recurring',
          recurring_interval: 'monthly',
          price: 100,
        },
        error: null,
      }),
    }));

    const result = await step.validate('giving-recurring-1', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?.service_id).toBe('giving-recurring-1');
    expect(result.data?.service_name).toBe('Tithe');
    expect(result.data?.service_billing_type).toBe('recurring');
    expect(result.data?.service_recurring_interval).toBe('monthly');
    expect(result.data?.service_price).toBe(100);
  });

  it('A2. prompt filters by service_type=giving when active_capability=giving', async () => {
    const ctx = buildPaymentCtx();

    const fromMock = ctx.supabase.from as ReturnType<typeof vi.fn>;
    const eqCalls: Array<[string, unknown]> = [];
    // Build a fully chainable mock that records eq calls
    const makeChainable = (): Record<string, any> => {
      const chain: Record<string, any> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn((col: string, val: unknown) => { eqCalls.push([col, val]); return chain; });
      chain.neq = vi.fn(() => chain);
      chain.order = vi.fn().mockResolvedValue({ data: [] });
      return chain;
    };
    fromMock.mockImplementation(() => makeChainable());

    await step.prompt(ctx);

    // Must have filtered by service_type = 'giving'
    expect(eqCalls.some(([col, val]) => col === 'service_type' && val === 'giving')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// B. POST-PAYMENT ROUTING
// ═══════════════════════════════════════════════════════════

describe('B. await_payment.next — post-convergence routing (#163)', () => {
  const step = getStep(paymentFlow, 'await_payment');

  it('B1. already_confirmed ends flow (null) — recurring continuation removed (#165)', async () => {
    // After #163 convergence, canonical completed maps to already_confirmed → flow ends.
    // Recurring continuation from await_payment is tracked separately in #165.
    const ctx = buildPaymentCtx({
      _action: 'already_confirmed',
      service_billing_type: 'recurring',
      service_recurring_interval: 'monthly',
    });

    const next = await step.next(ctx);
    expect(next).toBeNull();
  });

  it('B2. payment_processing stays at await_payment for retry', async () => {
    const ctx = buildPaymentCtx({
      _action: 'payment_processing',
    });

    const next = await step.next(ctx);
    expect(next).toBe('await_payment');
  });

  it('B3. cancel ends flow', async () => {
    const ctx = buildPaymentCtx({
      _action: 'cancel',
    });

    const next = await step.next(ctx);
    expect(next).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// C. CONSENT — DECLINE AND ACCEPT
// ═══════════════════════════════════════════════════════════

describe('C. confirm_recurring — consent decline and accept', () => {
  const step = getStep(paymentFlow, 'confirm_recurring');

  it('C1. decline returns recurring_accepted=false and routes to payment_thank_you', async () => {
    const ctx = buildPaymentCtx({ recurring_frequency: 'monthly', amount: 100, service_name: 'Tithe' });

    const result = await step.validate('decline', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.recurring_accepted).toBe(false);

    // Apply returned data as the executor would
    ctx.session.session_data.recurring_accepted = false;
    const next = await step.next(ctx);
    expect(next).toBe('payment_thank_you');
  });

  it('C2. "no" also declines', async () => {
    const ctx = buildPaymentCtx({ recurring_frequency: 'monthly', amount: 100, service_name: 'Tithe' });

    const result = await step.validate('no', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.recurring_accepted).toBe(false);
  });

  it('C3. accept returns recurring_accepted=true and routes to setup_recurring', async () => {
    const ctx = buildPaymentCtx({ recurring_frequency: 'monthly', amount: 100, service_name: 'Tithe' });

    const result = await step.validate('i_accept', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.recurring_accepted).toBe(true);

    ctx.session.session_data.recurring_accepted = true;
    const next = await step.next(ctx);
    expect(next).toBe('setup_recurring');
  });

  it('C4. "yes" also accepts', async () => {
    const ctx = buildPaymentCtx({ recurring_frequency: 'monthly', amount: 100, service_name: 'Tithe' });

    const result = await step.validate('yes', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.recurring_accepted).toBe(true);
  });

  it('C5. invalid input is rejected', async () => {
    const ctx = buildPaymentCtx({ recurring_frequency: 'monthly', amount: 100, service_name: 'Tithe' });

    const result = await step.validate('maybe', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// D. MY ACCOUNT — SUBSCRIPTION MENU ACCESS
// ═══════════════════════════════════════════════════════════

describe('D. my_account_menu — subscription access with giving capability', () => {
  const step = getStep(capabilitySelectionFlow, 'my_account_menu');

  it('D1. giving-only capability shows Subscriptions option', async () => {
    const ctx = buildCapCtx(['giving']);
    const messages = await step.prompt(ctx);

    expect(messages[0].type).toBe('list');
    if (messages[0].type === 'list') {
      const postbacks = messages[0].items.map((i: { postbackText: string }) => i.postbackText);
      expect(postbacks).toContain('acct_subscriptions');
    }
  });

  it('D2. recurring-only capability shows Subscriptions option', async () => {
    const ctx = buildCapCtx(['recurring']);
    const messages = await step.prompt(ctx);

    expect(messages[0].type).toBe('list');
    if (messages[0].type === 'list') {
      const postbacks = messages[0].items.map((i: { postbackText: string }) => i.postbackText);
      expect(postbacks).toContain('acct_subscriptions');
    }
  });

  it('D3. neither giving nor recurring hides Subscriptions option', async () => {
    const ctx = buildCapCtx(['scheduling', 'payment']);
    const messages = await step.prompt(ctx);

    expect(messages[0].type).toBe('list');
    if (messages[0].type === 'list') {
      const postbacks = messages[0].items.map((i: { postbackText: string }) => i.postbackText);
      expect(postbacks).not.toContain('acct_subscriptions');
    }
  });

  it('D4. acct_subscriptions routes to list_subscriptions', async () => {
    const ctx = buildCapCtx(['giving']);
    const result = await step.validate('acct_subscriptions', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._my_account_route).toBe('list_subscriptions');

    ctx.session.session_data._my_account_route = 'list_subscriptions';
    const next = await step.next(ctx);
    expect(next).toBe('list_subscriptions');
  });
});
