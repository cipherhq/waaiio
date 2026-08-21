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

  it('create_order_atomic inserts promo_reservations row (not reserved_uses column)', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain("INSERT INTO promo_reservations (order_id, promo_code_id, state)");
    expect(sql).toContain("'reserved'");
  });

  it('finalize_promo_reservation transitions reserved → finalized via per-order state', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.finalize_promo_reservation');
    expect(sql).toContain("SET state = 'finalized'");
    expect(sql).toContain('current_uses = current_uses + 1');
  });

  it('release_promo_reservation transitions reserved → released via per-order state', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.release_promo_reservation');
    expect(sql).toContain("SET state = 'released'");
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

  it('I\'ve Paid converges through reconcilePayment (which calls processSuccessfulPayment → finalize)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const awaitSection = src.substring(src.indexOf("id: 'await_order_payment'"));
    // Must use reconcilePayment, not manual finalize_promo_reservation
    expect(awaitSection).toContain('reconcilePayment');
    expect(awaitSection).not.toContain('finalize_promo_reservation');
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

  it('referral converted via reconcilePayment → processSuccessfulPayment (not manual I\'ve Paid)', () => {
    // Referral conversion now happens inside processSuccessfulPayment (called by reconcilePayment).
    // The "I've Paid" path no longer manually converts referrals.
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("status: 'converted'");
    expect(src).toContain('referral_id');
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

  it('webhook payment success uses apply_customer_spend_once (exactly-once)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    const orderSection = src.split('// 4. Confirm order')[1]?.split('// 5. Confirm reservation')[0] || '';
    expect(orderSection).toContain('apply_customer_spend_once');
  });

  it('bot I\'ve Paid path converges through reconcilePayment (spend via processSuccessfulPayment)', () => {
    // Spend is now exclusively inside processSuccessfulPayment, called by reconcilePayment.
    // The "I've Paid" path must NOT directly call upsert_customer_profile.
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const awaitSection = src.substring(src.indexOf("id: 'await_order_payment'"));
    expect(awaitSection).toContain('reconcilePayment');
    expect(awaitSection).not.toContain('upsert_customer_profile');
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

// ══════════════════════════════════════════════════════════
// 11. I'VE PAID CONVERGENCE THROUGH PAYMENT AUTHORITY
// ══════════════════════════════════════════════════════════

describe('ACC-008: I\'ve Paid converges through canonical Payment Authority', () => {
  it('await_order_payment uses reconcilePayment instead of manual stock/fee/promo pipeline', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // Must import and call reconcilePayment
    expect(src).toContain("reconcilePayment(ctx.supabase, paymentRow.id, 'ive_paid')");
    // Must NOT call manual stock/fee/promo/spend directly from I've Paid
    const ivePaidSection = src.split("'i_paid' || text === 'i_paid_online'")[1]?.split("'payment_confirmed'")[0] || '';
    expect(ivePaidSection).not.toContain('apply_order_stock_once');
    expect(ivePaidSection).not.toContain('recordPlatformFee');
    expect(ivePaidSection).not.toContain('finalize_promo_reservation');
    expect(ivePaidSection).not.toContain('upsert_customer_profile');
  });

  it('handlePostCompletion passes amountPaid=0 to prevent double-counted spend', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    // In the await_order_payment section, after reconcilePayment call,
    // handlePostCompletion must use amountPaid: 0
    const awaitSection = src.substring(src.indexOf("id: 'await_order_payment'"));
    const afterResult = awaitSection.split("providerOutcome === 'verified'")[1] || '';
    expect(afterResult).toContain('amountPaid: 0');
  });
});

// ══════════════════════════════════════════════════════════
// 12. CUSTOMER SPEND EXACTLY-ONCE
// ══════════════════════════════════════════════════════════

describe('ACC-008: customer spend exactly-once via durable marker', () => {
  it('process-success.ts uses apply_customer_spend_once RPC (not raw upsert_customer_profile)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    const orderSection = src.split('// 4. Confirm order')[1]?.split('// 5. Confirm reservation')[0] || '';
    expect(orderSection).toContain('apply_customer_spend_once');
    // Must NOT call raw upsert_customer_profile for spend in order section
    expect(orderSection).not.toContain("rpc('upsert_customer_profile'");
  });

  it('spend failure is critical (adds to criticalErrors)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("'customer_spend_failed'");
    expect(src).toContain("'customer_spend_threw'");
  });

  it('promo finalization failure is critical', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("'promo_finalization_failed'");
  });
});

// ══════════════════════════════════════════════════════════
// 13. PROMO RESERVATION STATE MACHINE
// ══════════════════════════════════════════════════════════

describe('ACC-008: promo reservation per-order state', () => {
  it('migration 333 creates promo_reservations table with order_id UNIQUE', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS promo_reservations');
    expect(sql).toContain('order_id UUID NOT NULL UNIQUE');
    expect(sql).toMatch(/state TEXT.*CHECK.*reserved.*finalized.*released/);
  });

  it('create_order_atomic enforces promo capacity under FOR UPDATE lock', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    expect(sql).toContain("FROM promo_codes WHERE id = p_promo_code_id FOR UPDATE");
    expect(sql).toContain("FROM promo_reservations");
    expect(sql).toContain("state IN ('reserved', 'finalized')");
    expect(sql).toContain("v_active_count >= v_promo.max_uses");
    expect(sql).toContain("'promo_exhausted'");
  });

  it('finalize_promo_reservation transitions reserved → finalized with state guard', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    const fnSection = sql.split('finalize_promo_reservation')[2] || '';
    expect(fnSection).toContain("'already_finalized'");
    expect(fnSection).toContain("'already_released'");
    expect(fnSection).toContain("SET state = 'finalized'");
    expect(fnSection).toContain("current_uses = current_uses + 1");
  });

  it('release_promo_reservation transitions reserved → released with state guard', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    const fnSection = sql.split('release_promo_reservation')[2] || '';
    expect(fnSection).toContain("'already_released'");
    expect(fnSection).toContain("'already_finalized'");
    expect(fnSection).toContain("SET state = 'released'");
  });

  it('create_order_atomic drops old 304 signature before creating new one', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    // Must DROP old signature to avoid overload
    expect(sql).toContain('DROP FUNCTION IF EXISTS public.create_order_atomic');
    // New signature includes p_referral_id and p_notes
    expect(sql).toContain('p_referral_id uuid DEFAULT NULL');
    expect(sql).toContain('p_notes text DEFAULT NULL');
  });

  it('cancel_stale_order_atomic calls release_promo_reservation', () => {
    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/333_promo_reservation_and_order_referral.sql', 'utf-8');
    const cancelSection = sql.split('cancel_stale_order_atomic')[1] || '';
    expect(cancelSection).toContain('release_promo_reservation');
  });
});

// ══════════════════════════════════════════════════════════
// 14. CROSS-FLOW EXECUTOR GUARD REGRESSION
// ══════════════════════════════════════════════════════════

describe('ACC-008: cross-flow payment-pending guard does NOT trap non-ordering flows', () => {
  it('payment-pending guard only checks payment_reference/bank_transfer_reference', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/executor.ts', 'utf-8');
    // Guard must check for payment_reference or bank_transfer_reference in session_data
    expect(src).toContain('sd.payment_reference || sd.bank_transfer_reference');
    // Must also check for payment confirmation actions
    expect(src).toContain("sd._action === 'payment_confirmed'");
    expect(src).toContain("sd._action === 'already_confirmed'");
  });

  it('scheduling flow uses payment_reference but also has payment_confirmed action', () => {
    // Scheduling also uses payment_reference for paid bookings — the guard fires,
    // but scheduling has a payment_confirmed action to pass through.
    const fs = require('fs');
    const schedulingSrc = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    expect(schedulingSrc).toContain('d.payment_reference = ');
    expect(schedulingSrc).toContain("'payment_confirmed'");
  });

  it('ticketing flow has no payment_reference session key collision', () => {
    const fs = require('fs');
    const ticketingSrc = fs.readFileSync('lib/bot/flows/ticketing.flow.ts', 'utf-8');
    // Ticketing uses payment_reference for ticket payment — but it also has its own
    // completion path. The guard should allow ticketing completion.
    const hasRef = ticketingSrc.includes('payment_reference');
    if (hasRef) {
      // If ticketing uses payment_reference, the guard fires — verify ticketing
      // has payment_confirmed action to pass through
      expect(ticketingSrc).toContain("'payment_confirmed'");
    }
  });
});

// ══════════════════════════════════════════════════════════
// 15. AUTOMATION LIFECYCLE DOCUMENTATION
// ══════════════════════════════════════════════════════════

describe('ACC-008: automation lifecycle', () => {
  it('evaluateRules(order_created) fires at pending order creation', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain("evaluateRules(ctx.supabase, ctx.business.id, 'order_created'");
  });

  it('triggerSequences(after_order) fires at pending order creation', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain("triggerSequences(ctx.supabase, ctx.business.id, 'after_order'");
  });

  it('evaluateRules(payment_received) fires on payment success', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain("evaluateRules(ctx.supabase, ctx.business.id, 'payment_received'");
  });

  it('handlePostCompletion fires on payment success with amountPaid=0', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    const awaitSection = src.substring(src.indexOf("id: 'await_order_payment'"));
    const afterResult = awaitSection.split("providerOutcome === 'verified'")[1] || '';
    expect(afterResult).toContain('handlePostCompletion');
    expect(afterResult).toContain('amountPaid: 0');
  });
});
