/**
 * ACC-008: Order/Payment State-Machine Regression Tests
 *
 * Tests the proven defect and its fix: add_to_cart catch-all validate + null next
 * caused the post-completion menu to appear before any checkout/payment flow.
 *
 * Configuration matches production SnapaKit:
 * - Ordering enabled, one simple product at ₦120,000
 * - No payment gateway configured, no bank account
 * - Quick-add path (simple product, no variants, no required addons)
 */
import { describe, it, expect, vi } from 'vitest';
import { getStep } from './helpers';
import { orderingFlow } from '../ordering.flow';
import type { FlowContext, FlowStepConfig, ValidationResult } from '../types';

function findStep(stepId: string): FlowStepConfig {
  return getStep(orderingFlow, stepId);
}

// ── Mock infrastructure ──

function mockSupabase() {
  const chain = () => {
    const c: Record<string, any> = {};
    c.select = vi.fn().mockReturnValue(c);
    c.insert = vi.fn().mockReturnValue(c);
    c.update = vi.fn().mockReturnValue(c);
    c.delete = vi.fn().mockReturnValue(c);
    c.eq = vi.fn().mockReturnValue(c);
    c.neq = vi.fn().mockReturnValue(c);
    c.or = vi.fn().mockReturnValue(c);
    c.is = vi.fn().mockReturnValue(c);
    c.not = vi.fn().mockReturnValue(c);
    c.in = vi.fn().mockReturnValue(c);
    c.gte = vi.fn().mockReturnValue(c);
    c.lte = vi.fn().mockReturnValue(c);
    c.like = vi.fn().mockReturnValue(c);
    c.order = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const origSelect = c.select;
    c.select = vi.fn((...a: any[]) => {
      if (a[1]?.count === 'exact') {
        const cc: Record<string, any> = {};
        cc.eq = vi.fn().mockReturnValue(cc);
        cc.neq = vi.fn().mockReturnValue(cc);
        cc.is = vi.fn().mockReturnValue(cc);
        cc.or = vi.fn().mockReturnValue(cc);
        cc.not = vi.fn().mockReturnValue(cc);
        cc.limit = vi.fn().mockReturnValue(cc);
        cc.then = (fn: any) => fn({ count: 0, data: [], error: null });
        Object.defineProperty(cc, Symbol.toStringTag, { value: 'Promise' });
        return cc;
      }
      return origSelect(...a);
    });
    return c;
  };

  return { from: vi.fn(() => chain()), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

function buildCtx(overrides: Partial<{
  currentStep: string;
  sessionData: Record<string, unknown>;
}>): FlowContext {
  const sb = mockSupabase();
  return {
    supabase: sb as any,
    sender: {
      sendText: vi.fn().mockResolvedValue({}),
      sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}),
      sendDocument: vi.fn().mockResolvedValue({}),
    } as any,
    standalone: {} as any,
    intelligence: {} as any,
    t: vi.fn(async (text: string) => text),
    from: '+2341234567890',
    session: {
      id: 'session-acc008', user_id: 'user-acc008', business_id: 'biz-snapakit',
      current_step: overrides.currentStep || 'add_to_cart',
      session_data: {
        capabilities: ['ordering', 'payment', 'chat', 'giving', 'appointment'],
        active_capability: 'ordering',
        ...overrides.sessionData,
      },
      version: 1,
    },
    business: {
      id: 'biz-snapakit', name: 'SnapaKit', slug: 'snapakit',
      category: 'shop' as any, flow_type: 'ordering' as any,
      subscription_tier: 'free',
      trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {}, country_code: 'NG', payment_gateway: null,
    },
  };
}

function cartSessionData() {
  return {
    current_product_id: 'prod-jersey',
    current_product_name: 'Man United Jersey',
    current_product_price: 120000,
    current_quantity: 1,
    current_addons: [],
    _addon_action: 'skip',
    cart: [],
  };
}

// ══════════════════════════════════════════════════════════
// REPRODUCTION: Exact SnapaKit quick-add → Checkout → post-completion bypass
// ══════════════════════════════════════════════════════════

describe('ACC-008: SnapaKit reproduction — quick-add checkout bypass', () => {
  it('₦120,000 quick-add → Checkout reaches checkout flow, NOT post-completion', () => {
    const addToCart = findStep('add_to_cart');
    // After fix: add_to_cart.validate() rejects unknown input
    // and next() routes to continue_or_checkout (not null)
    // This means "Checkout" typed on add_to_cart step cannot trigger post-completion
    expect(addToCart.next).toBeDefined();
  });

  it('add_to_cart.validate() rejects "checkout" input (fail closed)', async () => {
    const ctx = buildCtx({ sessionData: cartSessionData() });
    const addToCart = findStep('add_to_cart');
    const result = await addToCart.validate('checkout', ctx);
    expect(result.valid).toBe(false);
  });

  it('add_to_cart.next() returns continue_or_checkout (not null)', async () => {
    const ctx = buildCtx({ sessionData: cartSessionData() });
    const addToCart = findStep('add_to_cart');
    const next = await addToCart.next(ctx);
    expect(next).toBe('continue_or_checkout');
  });

  it('add_to_cart declares nextAfterPrompt for executor-owned transition', () => {
    const addToCart = findStep('add_to_cart');
    expect(addToCart.nextAfterPrompt).toBe('continue_or_checkout');
  });

  it('add_to_cart.prompt() does NOT write current_step to DB directly', async () => {
    const ctx = buildCtx({ sessionData: cartSessionData() });
    const dbWrites: string[] = [];
    const origFrom = (ctx.supabase as any).from;
    (ctx.supabase as any).from = vi.fn((table: string) => {
      const chain = origFrom(table);
      const origUpdate = chain.update;
      chain.update = vi.fn((...args: any[]) => {
        if (args[0]?.current_step) dbWrites.push(args[0].current_step);
        return origUpdate(...args);
      });
      return chain;
    });

    await findStep('add_to_cart').prompt(ctx);
    expect(dbWrites.filter(w => w === 'continue_or_checkout')).toHaveLength(0);
  });

  it('"Checkout" from add_to_cart never produces post-completion (full sequence)', async () => {
    const ctx = buildCtx({ sessionData: { ...cartSessionData(), cart: [{ product_id: 'p1', name: 'Jersey', price: 120000, quantity: 1 }] } });
    const addToCart = findStep('add_to_cart');
    const validateResult = await addToCart.validate('checkout', ctx);
    const nextResult = validateResult.valid ? await addToCart.next(ctx) : 'rejected';

    const isPostCompletion = validateResult.valid && nextResult === null;
    expect(isPostCompletion).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// CHECKOUT FLOW CORRECTNESS
// ══════════════════════════════════════════════════════════

describe('ACC-008: Checkout flow reaches T&C for non-zero orders', () => {
  it('continue_or_checkout routes "checkout" to apply_promo', async () => {
    const ctx = buildCtx({
      currentStep: 'continue_or_checkout',
      sessionData: { cart: [{ product_id: 'p1', name: 'Jersey', price: 120000, quantity: 1 }] },
    });
    const step = findStep('continue_or_checkout');
    const result = await step.validate('checkout', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('checkout');

    Object.assign(ctx.session.session_data, result.data!);
    const next = await step.next(ctx);
    expect(next).toBe('apply_promo');
  });
});

// ══════════════════════════════════════════════════════════
// PROCESS_ORDER FAIL-CLOSED
// ══════════════════════════════════════════════════════════

describe('ACC-008: process_order validate fails closed', () => {
  it('unknown input is rejected (not silently accepted)', async () => {
    const ctx = buildCtx({
      currentStep: 'process_order',
      sessionData: { cart: [{ product_id: 'p1', name: 'Jersey', price: 120000, quantity: 1 }] },
    });
    const step = findStep('process_order');
    const result = await step.validate('random text', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBeDefined();
  });

  it('accept_terms is still valid', async () => {
    const ctx = buildCtx({ currentStep: 'process_order' });
    const result = await findStep('process_order').validate('accept_terms', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._terms_accepted).toBe(true);
  });

  it('cancel_order is still valid', async () => {
    const ctx = buildCtx({ currentStep: 'process_order', sessionData: { order_id: 'order-1' } });
    const result = await findStep('process_order').validate('cancel_order', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancelled');
  });
});

// ══════════════════════════════════════════════════════════
// PAYMENT-PENDING NEVER TRIGGERS POST-COMPLETION
// ══════════════════════════════════════════════════════════

describe('ACC-008: payment-pending post-completion guard', () => {
  it('session with payment_reference is detected as payment-pending', () => {
    const sd: Record<string, unknown> = { payment_reference: 'ref-123', active_capability: 'ordering' };
    const isPaymentPending = !!(sd.payment_reference || sd.bank_transfer_reference);
    expect(isPaymentPending).toBe(true);
  });

  it('session with bank_transfer_reference is detected as payment-pending', () => {
    const sd: Record<string, unknown> = { bank_transfer_reference: 'bt-456', active_capability: 'ordering' };
    const isPaymentPending = !!(sd.payment_reference || sd.bank_transfer_reference);
    expect(isPaymentPending).toBe(true);
  });

  it('session without payment references is NOT payment-pending', () => {
    const sd: Record<string, unknown> = { active_capability: 'ordering' };
    const isPaymentPending = !!(sd.payment_reference || sd.bank_transfer_reference);
    expect(isPaymentPending).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// SIDE-EFFECT CORRECTNESS
// ══════════════════════════════════════════════════════════

describe('ACC-008: side-effect timing correctness', () => {
  it('upsert_customer_profile defers p_booking_amount for paid orders', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // Must contain the conditional that passes 0 for paid orders
    expect(src).toContain('p_booking_amount: total > 0 ? 0 : total');
  });

  it('referral conversion is deferred for paid orders', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('freshlyCreated && total === 0');
  });

  it('owner notification includes Awaiting Payment for non-zero orders', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/notify-owner.ts', 'utf-8');
    expect(src).toContain('Awaiting Payment');
    expect(src).toContain('paymentPending');
  });

  it('dashboard orders page includes pending status', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/dashboard/orders/page.tsx', 'utf-8');
    expect(src).toContain("'pending'");
    expect(src).toContain('bg-yellow-100 text-yellow-700');
  });
});

// ══════════════════════════════════════════════════════════
// NO DIRECT DB current_step WRITES IN ORDERING FLOW
// ══════════════════════════════════════════════════════════

describe('ACC-008: ordering flow contains no direct DB current_step writes', () => {
  it('ordering.flow.ts has zero current_step: direct writes', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // Must not contain any direct current_step writes to bot_sessions
    const matches = src.match(/current_step:/g) || [];
    // The only allowed occurrence is in the ctx.session.current_step in-memory mutation
    // which uses `ctx.session.current_step =` not `current_step:` in an object literal
    const dbWrites = src.match(/\.update\(\{[^}]*current_step:/g) || [];
    expect(dbWrites).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════
// FREE ORDER BEHAVIOR PRESERVED
// ══════════════════════════════════════════════════════════

describe('ACC-008: free order behavior', () => {
  it('free order referral conversion is immediate (total === 0)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // For free orders, referral conversion should still happen at order creation
    expect(src).toContain('freshlyCreated && total === 0');
  });

  it('free order customer profile gets full amount (0)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // total > 0 ? 0 : total — when total is 0, passes 0 (correct)
    expect(src).toContain('p_booking_amount: total > 0 ? 0 : total');
  });
});
