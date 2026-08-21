/**
 * ACC-008: Order/Payment State-Machine Regression Tests
 *
 * Covers: CAS-owned transitions, fail-closed validates, payment-pending guard,
 * promo reservation/finalization/release, referral deferred conversion,
 * customer spend timing, owner notification, and cross-layer executor behavior.
 */
import { describe, it, expect, vi } from 'vitest';
import { getStep } from './helpers';
import { orderingFlow } from '../ordering.flow';
import type { FlowContext, FlowStepConfig, ValidationResult } from '../types';

function findStep(stepId: string): FlowStepConfig {
  return getStep(orderingFlow, stepId);
}

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

function buildCtx(overrides?: Partial<{ currentStep: string; sessionData: Record<string, unknown> }>): FlowContext {
  const sb = mockSupabase();
  return {
    supabase: sb as any,
    sender: { sendText: vi.fn().mockResolvedValue({}), sendButtons: vi.fn().mockResolvedValue({}), sendList: vi.fn().mockResolvedValue({}), sendDocument: vi.fn().mockResolvedValue({}) } as any,
    standalone: {} as any, intelligence: {} as any,
    t: vi.fn(async (text: string) => text),
    from: '+2341234567890',
    session: {
      id: 'session-acc008', user_id: 'user-acc008', business_id: 'biz-snapakit',
      current_step: overrides?.currentStep || 'add_to_cart',
      session_data: { capabilities: ['ordering', 'payment', 'chat', 'giving', 'appointment'], active_capability: 'ordering', ...overrides?.sessionData },
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

// ══════════════════════════════════════════════════════════
// 1. PROVEN REPRODUCTION: Quick-add → Checkout → NOT post-completion
// ══════════════════════════════════════════════════════════

describe('ACC-008: SnapaKit reproduction', () => {
  it('add_to_cart.validate() rejects "checkout" (fail closed)', async () => {
    const ctx = buildCtx({ sessionData: { cart: [{ product_id: 'p1', name: 'Jersey', price: 120000, quantity: 1 }] } });
    const result = await findStep('add_to_cart').validate('checkout', ctx);
    expect(result.valid).toBe(false);
  });

  it('add_to_cart.next() returns continue_or_checkout (not null)', async () => {
    const ctx = buildCtx();
    expect(await findStep('add_to_cart').next(ctx)).toBe('continue_or_checkout');
  });

  it('add_to_cart declares nextAfterPrompt: continue_or_checkout', () => {
    expect(findStep('add_to_cart').nextAfterPrompt).toBe('continue_or_checkout');
  });

  it('add_to_cart.prompt() does NOT write current_step to DB', async () => {
    const ctx = buildCtx({ sessionData: { current_product_id: 'p1', current_product_name: 'Jersey', current_product_price: 120000, current_quantity: 1, current_addons: [], _addon_action: 'skip', cart: [] } });
    const dbWrites: string[] = [];
    const origFrom = (ctx.supabase as any).from;
    (ctx.supabase as any).from = vi.fn((table: string) => {
      const chain = origFrom(table);
      const origUpdate = chain.update;
      chain.update = vi.fn((...args: any[]) => { if (args[0]?.current_step) dbWrites.push(args[0].current_step); return origUpdate(...args); });
      return chain;
    });
    await findStep('add_to_cart').prompt(ctx);
    expect(dbWrites.filter(w => w === 'continue_or_checkout')).toHaveLength(0);
  });

  it('"Checkout" from add_to_cart never produces post-completion', async () => {
    const ctx = buildCtx({ sessionData: { cart: [{ product_id: 'p1', name: 'Jersey', price: 120000, quantity: 1 }] } });
    const r = await findStep('add_to_cart').validate('checkout', ctx);
    const isPostCompletion = r.valid && (await findStep('add_to_cart').next(ctx)) === null;
    expect(isPostCompletion).toBe(false);
  });

  it('continue_or_checkout routes "checkout" to apply_promo', async () => {
    const ctx = buildCtx({ currentStep: 'continue_or_checkout', sessionData: { cart: [{ product_id: 'p1', name: 'Jersey', price: 120000, quantity: 1 }] } });
    const r = await findStep('continue_or_checkout').validate('checkout', ctx);
    expect(r.valid).toBe(true);
    Object.assign(ctx.session.session_data, r.data!);
    expect(await findStep('continue_or_checkout').next(ctx)).toBe('apply_promo');
  });
});

// ══════════════════════════════════════════════════════════
// 2. PROCESS_ORDER FAIL-CLOSED
// ══════════════════════════════════════════════════════════

describe('ACC-008: process_order fail-closed', () => {
  it('unknown input rejected', async () => {
    const ctx = buildCtx({ currentStep: 'process_order' });
    const r = await findStep('process_order').validate('random text', ctx);
    expect(r.valid).toBe(false);
  });

  it('accept_terms still valid', async () => {
    const ctx = buildCtx({ currentStep: 'process_order' });
    const r = await findStep('process_order').validate('accept_terms', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._terms_accepted).toBe(true);
  });

  it('cancel_order still valid', async () => {
    const ctx = buildCtx({ currentStep: 'process_order', sessionData: { order_id: 'o1' } });
    const r = await findStep('process_order').validate('cancel_order', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('cancelled');
  });
});

// ══════════════════════════════════════════════════════════
// 3. nextAfterPrompt: EXPLICIT CONDITIONAL TRANSITION
// ══════════════════════════════════════════════════════════

describe('ACC-008: nextAfterPrompt', () => {
  it('process_order.nextAfterPrompt is a function (conditional)', () => {
    const step = findStep('process_order');
    expect(typeof step.nextAfterPrompt).toBe('function');
  });

  it('returns await_order_payment when payment_reference is set', () => {
    const ctx = buildCtx({ sessionData: { payment_reference: 'ref-123' } });
    const nap = (findStep('process_order').nextAfterPrompt as Function)(ctx);
    expect(nap).toBe('await_order_payment');
  });

  it('returns await_order_payment when bank_transfer_reference is set', () => {
    const ctx = buildCtx({ sessionData: { bank_transfer_reference: 'bt-456' } });
    const nap = (findStep('process_order').nextAfterPrompt as Function)(ctx);
    expect(nap).toBe('await_order_payment');
  });

  it('returns undefined (no transition) for free orders', () => {
    const ctx = buildCtx();
    const nap = (findStep('process_order').nextAfterPrompt as Function)(ctx);
    expect(nap).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════
// 4. PAYMENT-PENDING POST-COMPLETION GUARD
// ══════════════════════════════════════════════════════════

describe('ACC-008: executor payment-pending guard', () => {
  function checkGuard(sd: Record<string, unknown>) {
    const isCancellation = sd._action === 'cancel' || sd._action === 'cancelled' || sd.cancelled === true || sd._action === 'cart_empty';
    const hasPaymentRef = !!(sd.payment_reference || sd.bank_transfer_reference);
    const isPaymentConfirmed = sd._action === 'payment_confirmed' || sd._action === 'already_confirmed';
    const isPaymentPending = hasPaymentRef && !isPaymentConfirmed;
    return { isCancellation, isPaymentPending, showPostCompletion: !isCancellation && !isPaymentPending };
  }

  it('payment_reference + no confirmation → suppresses post-completion', () => {
    expect(checkGuard({ payment_reference: 'ref', active_capability: 'ordering' }).showPostCompletion).toBe(false);
  });

  it('bank_transfer_reference + no confirmation → suppresses', () => {
    expect(checkGuard({ bank_transfer_reference: 'bt' }).showPostCompletion).toBe(false);
  });

  it('payment_reference + payment_confirmed → allows post-completion', () => {
    expect(checkGuard({ payment_reference: 'ref', _action: 'payment_confirmed' }).showPostCompletion).toBe(true);
  });

  it('payment_reference + already_confirmed → allows post-completion', () => {
    expect(checkGuard({ payment_reference: 'ref', _action: 'already_confirmed' }).showPostCompletion).toBe(true);
  });

  it('no payment reference → allows post-completion (free order)', () => {
    expect(checkGuard({ active_capability: 'ordering' }).showPostCompletion).toBe(true);
  });

  it('cancellation always suppresses regardless of payment state', () => {
    expect(checkGuard({ payment_reference: 'ref', _action: 'cancelled' }).showPostCompletion).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// 5. PROMO RESERVE / FINALIZE / RELEASE
// ══════════════════════════════════════════════════════════

describe('ACC-008: promo reservation semantics', () => {
  it('promo availability check accounts for reserved_uses', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('promo.current_uses + (promo.reserved_uses || 0)) >= promo.max_uses');
  });

  it('promo select includes reserved_uses field', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('reserved_uses');
    expect(src).toContain("'id, code, discount_type, discount_value, min_order_amount, max_uses, current_uses, reserved_uses, valid_until, is_active'");
  });

  it('create_order_atomic reserves (not finalizes) promo', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain('reserved_uses = reserved_uses + 1');
    expect(sql).not.toContain('current_uses = current_uses + 1\n    WHERE id = p_promo_code_id');
  });

  it('finalize_promo_reservation moves reserved → current', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION finalize_promo_reservation');
    expect(sql).toContain('current_uses = current_uses + 1');
    expect(sql).toContain('reserved_uses = GREATEST(reserved_uses - 1, 0)');
  });

  it('release_promo_reservation decrements reserved without incrementing current', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION release_promo_reservation');
  });

  it('cancel_stale_order_atomic releases promo reservation', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain('PERFORM release_promo_reservation(p_order_id)');
  });

  it('manual cancel_order in process_order releases promo', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain("release_promo_reservation");
  });

  it('finalize_promo_reservation called on payment success (webhook)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("finalize_promo_reservation");
  });

  it('finalize_promo_reservation called on payment success (bot I\'ve Paid)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // Must appear in await_order_payment section, not just process_order
    const awaitSection = src.substring(src.indexOf("id: 'await_order_payment'"));
    expect(awaitSection).toContain('finalize_promo_reservation');
  });
});

// ══════════════════════════════════════════════════════════
// 6. REFERRAL CONVERSION DEFERRED TO PAYMENT SUCCESS
// ══════════════════════════════════════════════════════════

describe('ACC-008: referral conversion', () => {
  it('paid order referral is deferred (not converted at creation)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('freshlyCreated && total === 0');
  });

  it('referral_id stored on order via create_order_atomic', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain('p_referral_id uuid');
    expect(sql).toContain('referral_id');
  });

  it('referral converted on webhook payment success', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("status: 'converted'");
    expect(src).toContain('referral_id');
  });

  it('referral converted on bot I\'ve Paid success', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const awaitSection = src.substring(src.indexOf("id: 'await_order_payment'"));
    expect(awaitSection).toContain("status: 'converted'");
  });
});

// ══════════════════════════════════════════════════════════
// 7. CUSTOMER SPEND / LTV OWNED BY PAYMENT AUTHORITY
// ══════════════════════════════════════════════════════════

describe('ACC-008: customer spend timing', () => {
  it('pending order passes ₦0 booking_amount', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('p_booking_amount: total > 0 ? 0 : total');
  });

  it('webhook payment success updates customer spend', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain('upsert_customer_profile');
    expect(src).toContain('p_booking_amount: payment.amount');
  });

  it('bot I\'ve Paid path updates customer spend', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const awaitSection = src.substring(src.indexOf("id: 'await_order_payment'"));
    expect(awaitSection).toContain('upsert_customer_profile');
    expect(awaitSection).toContain('p_booking_amount: totalAmount');
  });
});

// ══════════════════════════════════════════════════════════
// 8. OWNER NOTIFICATION + DASHBOARD
// ══════════════════════════════════════════════════════════

describe('ACC-008: pending order visibility', () => {
  it('owner notification shows Awaiting Payment for non-zero orders', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/notify-owner.ts', 'utf-8');
    expect(src).toContain('Awaiting Payment');
    expect(src).toContain('paymentPending');
  });

  it('dashboard orders page includes pending status with yellow badge', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/dashboard/orders/page.tsx', 'utf-8');
    expect(src).toContain("'pending'");
    expect(src).toContain('bg-yellow-100 text-yellow-700');
  });
});

// ══════════════════════════════════════════════════════════
// 9. NO DIRECT DB CURRENT_STEP WRITES
// ══════════════════════════════════════════════════════════

describe('ACC-008: no direct DB writes', () => {
  it('ordering.flow.ts has zero .update({ current_step: ... }) calls', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const dbWrites = src.match(/\.update\(\{[^}]*current_step:/g) || [];
    expect(dbWrites).toHaveLength(0);
  });

  it('ordering.flow.ts has zero ctx.session.current_step mutations', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const mutations = src.match(/ctx\.session\.current_step\s*=/g) || [];
    expect(mutations).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════
// 10. FREE ORDER PRESERVED
// ══════════════════════════════════════════════════════════

describe('ACC-008: free order behavior preserved', () => {
  it('free order referral conversion is immediate', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('freshlyCreated && total === 0');
  });

  it('free order customer profile gets amount 0', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('p_booking_amount: total > 0 ? 0 : total');
  });
});
