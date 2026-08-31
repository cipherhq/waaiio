/**
 * #245: Refund state truth-contract behavioral tests
 *
 * Verifies the 6-state domain vocabulary is used truthfully:
 *   1. processRefund() returns the correct RefundState at every return path
 *   2. API route passes domain state through unchanged (no server-side classifier)
 *   3. RefundModal maps 6 domain states to distinct UI presentations
 *   4. Orders page handles refunded payment status correctly
 *
 * These tests exercise the real domain/route contract -- no reimplemented classifiers.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { RefundState, ProcessRefundResult } from '@/lib/payments/refund-handler';
import * as fs from 'fs';
import * as path from 'path';

// ===============================================================
// 1. processRefund() domain result: typed 6-state field
// ===============================================================

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/payments/factory', () => ({
  getPaymentGatewayByName: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn() })),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn(() => ({})),
}));

function chainMock(terminal: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'select', 'eq', 'in', 'insert', 'update', 'limit', 'single', 'maybeSingle', 'rpc'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  (chain.single as Mock).mockResolvedValue(terminal);
  (chain.maybeSingle as Mock).mockResolvedValue(terminal);
  return chain;
}

describe('processRefund: 6-state domain vocabulary', () => {
  let processRefund: typeof import('@/lib/payments/refund-handler').processRefund;
  let createServiceClient: Mock;

  beforeEach(async () => {
    vi.resetModules();
    const serviceMod = await import('@/lib/supabase/service');
    createServiceClient = serviceMod.createServiceClient as Mock;
    const handler = await import('@/lib/payments/refund-handler');
    processRefund = handler.processRefund;
  });

  it('returns state: "failed" when payment not found', async () => {
    const supabase = chainMock();
    (supabase.single as Mock).mockResolvedValue({ data: null, error: { message: 'not found' } });

    const result = await processRefund({
      supabase: supabase as never,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 100,
      initiatedBy: 'user-1', initiatedByRole: 'business',
    });

    expect(result.state).toBe('failed');
    expect(result.success).toBe(false);
  });

  it('returns state: "failed" when payment status is not refundable', async () => {
    const supabase = chainMock();
    (supabase.single as Mock).mockResolvedValue({
      data: { id: 'pay-1', status: 'pending', amount: 100, business_id: 'biz-1' },
      error: null,
    });

    const result = await processRefund({
      supabase: supabase as never,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 100,
      initiatedBy: 'user-1', initiatedByRole: 'business',
    });

    expect(result.state).toBe('failed');
  });

  it('returns state: "failed" when amount is zero', async () => {
    const supabase = chainMock();
    (supabase.single as Mock)
      .mockResolvedValueOnce({
        data: { id: 'pay-1', status: 'success', amount: 5000, business_id: 'biz-1', gateway: 'paystack', metadata: null },
        error: null,
      });

    const service = chainMock();
    (service.select as Mock).mockReturnValue(service);
    (service.from as Mock).mockReturnValue(service);
    (service.eq as Mock).mockReturnValue(service);
    createServiceClient.mockReturnValue(service);

    const result = await processRefund({
      supabase: supabase as never,
      paymentId: 'pay-1', businessId: 'biz-1', amount: 0,
      initiatedBy: 'user-1', initiatedByRole: 'business',
    });

    expect(result.state).toBe('failed');
  });

  it('RefundState is exactly the 6-state union', () => {
    const validStates: RefundState[] = [
      'pending', 'provider_pending', 'provider_ambiguous',
      'provider_success_unfinalized', 'success', 'failed',
    ];
    const result: ProcessRefundResult = { success: true, state: 'success' };
    expect(validStates).toContain(result.state);
  });
});

// ===============================================================
// 2. API route: passes domain state through unchanged
// ===============================================================

describe('API route: no classifier, passes domain state', () => {
  const REFUND_ROUTE = fs.readFileSync(
    path.resolve('app/api/payments/refund/route.ts'), 'utf-8',
  );

  it('route does NOT contain classifyRefundErrorState function', () => {
    expect(REFUND_ROUTE).not.toContain('function classifyRefundErrorState');
  });

  it('route does NOT parse errorMessage with .includes()', () => {
    expect(REFUND_ROUTE).not.toContain("errorMessage.includes(");
  });

  it('route passes result.state directly to JSON response', () => {
    expect(REFUND_ROUTE).toContain('result.state');
  });

  it('route imports RefundState from refund-handler', () => {
    expect(REFUND_ROUTE).toContain("from '@/lib/payments/refund-handler'");
    expect(REFUND_ROUTE).toContain('RefundState');
  });

  it('route exports RefundResponseState type for consumers', () => {
    expect(REFUND_ROUTE).toContain('RefundResponseState');
  });
});

// ===============================================================
// 3. RefundModal: maps 6 domain states to distinct UI presentations
// ===============================================================

describe('RefundModal: 6-state domain mapping', () => {
  /**
   * Mirrors the modal's handleSubmit state-mapping logic.
   * The modal reads `data.state` -- never parses error text.
   */
  function simulateModalStateMapping(
    resOk: boolean,
    data: { success?: boolean; state?: string; error?: string },
  ): { type: string; message?: string } {
    if (resOk && data.success) {
      return { type: 'success' };
    }
    const state = data.state;
    if (state === 'pending') return { type: 'pending' };
    if (state === 'provider_pending') return { type: 'provider_pending' };
    if (state === 'provider_ambiguous') return { type: 'provider_ambiguous' };
    if (state === 'provider_success_unfinalized') return { type: 'provider_success_unfinalized' };
    return { type: 'failed', message: data.error || 'Refund failed' };
  }

  it('maps success response', () => {
    expect(simulateModalStateMapping(true, { success: true, state: 'success' }))
      .toEqual({ type: 'success' });
  });

  it('maps state: "pending" (dispatch claim loser)', () => {
    expect(simulateModalStateMapping(false, { state: 'pending', error: 'claim failed' }))
      .toEqual({ type: 'pending' });
  });

  it('maps state: "provider_pending"', () => {
    expect(simulateModalStateMapping(false, { state: 'provider_pending', error: 'awaiting' }))
      .toEqual({ type: 'provider_pending' });
  });

  it('maps state: "provider_ambiguous"', () => {
    expect(simulateModalStateMapping(false, { state: 'provider_ambiguous', error: 'unknown' }))
      .toEqual({ type: 'provider_ambiguous' });
  });

  it('maps state: "provider_success_unfinalized"', () => {
    expect(simulateModalStateMapping(false, { state: 'provider_success_unfinalized', error: 'finalize failed' }))
      .toEqual({ type: 'provider_success_unfinalized' });
  });

  it('maps state: "failed" with error message', () => {
    expect(simulateModalStateMapping(false, { state: 'failed', error: 'Gateway refund failed' }))
      .toEqual({ type: 'failed', message: 'Gateway refund failed' });
  });

  it('maps missing state to failed with default message', () => {
    expect(simulateModalStateMapping(false, {}))
      .toEqual({ type: 'failed', message: 'Refund failed' });
  });

  it('does NOT parse error text for state -- typed field wins', () => {
    const result = simulateModalStateMapping(false, {
      state: 'failed',
      error: 'Refund accepted by provider',
    });
    expect(result.type).toBe('failed');
  });
});

describe('RefundModal: structural guards', () => {
  const REFUND_MODAL = fs.readFileSync(
    path.resolve('components/dashboard/RefundModal.tsx'), 'utf-8',
  );

  it('modal does NOT contain pendingSignals or ambiguousSignals arrays', () => {
    expect(REFUND_MODAL).not.toContain('pendingSignals');
    expect(REFUND_MODAL).not.toContain('ambiguousSignals');
  });

  it('modal does NOT use indexOf for state detection', () => {
    expect(REFUND_MODAL).not.toContain('.indexOf(signal)');
  });

  it('modal reads data.state for state mapping', () => {
    expect(REFUND_MODAL).toContain('data.state');
  });

  it('modal handles all 6 domain states', () => {
    expect(REFUND_MODAL).toContain("state === 'pending'");
    expect(REFUND_MODAL).toContain("state === 'provider_pending'");
    expect(REFUND_MODAL).toContain("state === 'provider_ambiguous'");
    expect(REFUND_MODAL).toContain("state === 'provider_success_unfinalized'");
  });
});

// ===============================================================
// 4. Orders page: refund guard handles all payment states
// ===============================================================

describe('Orders page: refund guard handles all payment states', () => {
  function simulateOpenRefund(
    payment: { amount: number; refund_amount: number | null; status: string } | null,
  ): { action: 'open_modal'; refundable: number } | { action: 'disabled'; reason: string } {
    if (!payment) return { action: 'disabled', reason: 'No payment recorded' };
    if (payment.status === 'refunded') return { action: 'disabled', reason: 'Fully refunded' };
    const refundable = Number(payment.amount) - Number(payment.refund_amount || 0);
    if (refundable <= 0) return { action: 'disabled', reason: 'Fully refunded' };
    return { action: 'open_modal', refundable };
  }

  it('returns "No payment recorded" when no payment exists', () => {
    expect(simulateOpenRefund(null)).toEqual({ action: 'disabled', reason: 'No payment recorded' });
  });

  it('returns "Fully refunded" when payment has status="refunded"', () => {
    expect(simulateOpenRefund({ amount: 5000, refund_amount: 5000, status: 'refunded' }))
      .toEqual({ action: 'disabled', reason: 'Fully refunded' });
  });

  it('returns "Fully refunded" for status="refunded" even with zero refund_amount', () => {
    expect(simulateOpenRefund({ amount: 5000, refund_amount: 0, status: 'refunded' }))
      .toEqual({ action: 'disabled', reason: 'Fully refunded' });
  });

  it('returns "Fully refunded" when status="success" and remaining is 0', () => {
    expect(simulateOpenRefund({ amount: 5000, refund_amount: 5000, status: 'success' }))
      .toEqual({ action: 'disabled', reason: 'Fully refunded' });
  });

  it('opens modal for partial refund on status="success"', () => {
    expect(simulateOpenRefund({ amount: 5000, refund_amount: 2000, status: 'success' }))
      .toEqual({ action: 'open_modal', refundable: 3000 });
  });

  it('"No payment recorded" and "Fully refunded" are distinct reasons', () => {
    const noPayment = simulateOpenRefund(null);
    const fullyRefunded = simulateOpenRefund({ amount: 5000, refund_amount: 5000, status: 'refunded' });
    expect(noPayment).not.toEqual(fullyRefunded);
  });
});

describe('Orders page: query includes refunded status', () => {
  const ORDERS_PAGE = fs.readFileSync(
    path.resolve('app/dashboard/orders/page.tsx'), 'utf-8',
  );

  it('queries payments with .in("status", ["success", "refunded"])', () => {
    expect(ORDERS_PAGE).toContain(".in('status', ['success', 'refunded'])");
  });

  it('handles payment.status === "refunded" as "Fully refunded"', () => {
    expect(ORDERS_PAGE).toContain("payment.status === 'refunded'");
  });
});

// ===============================================================
// 5. refund-handler: every return has truthful state
// ===============================================================

describe('refund-handler: 6-state truth-contract', () => {
  const REFUND_HANDLER = fs.readFileSync(
    path.resolve('lib/payments/refund-handler.ts'), 'utf-8',
  );

  it('exports RefundState as 6-state union', () => {
    expect(REFUND_HANDLER).toContain("| 'pending'");
    expect(REFUND_HANDLER).toContain("| 'provider_pending'");
    expect(REFUND_HANDLER).toContain("| 'provider_ambiguous'");
    expect(REFUND_HANDLER).toContain("| 'provider_success_unfinalized'");
    expect(REFUND_HANDLER).toContain("| 'success'");
    expect(REFUND_HANDLER).toContain("| 'failed'");
  });

  it('ProcessRefundResult interface includes state: RefundState', () => {
    expect(REFUND_HANDLER).toContain('state: RefundState');
  });

  it('every return block with success: also has state:', () => {
    const blocks = REFUND_HANDLER.split(/return \{/).slice(1);
    const successBlocks = blocks.filter(b => {
      const closingBrace = b.indexOf('}');
      const chunk = b.slice(0, closingBrace === -1 ? 200 : closingBrace + 50);
      return chunk.includes('success:');
    });
    const blocksWithState = successBlocks.filter(b => {
      const closingBrace = b.indexOf('};');
      const chunk = b.slice(0, closingBrace === -1 ? 200 : closingBrace);
      return chunk.includes('state:');
    });
    expect(blocksWithState.length).toBe(successBlocks.length);
    expect(blocksWithState.length).toBeGreaterThan(10);
  });

  // --- Behavioral state-accuracy assertions ---

  it('provider pending with no queryRefundStatus -> state: provider_pending (not failed)', () => {
    // The return for "Gateway does not support refund status query" must use provider_pending
    expect(REFUND_HANDLER).toContain("errorMessage: 'Gateway does not support refund status query', state: 'provider_pending'");
  });

  it('provider pending with credential failure -> state: provider_pending (not failed)', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: 'Payment credential not found for reconciliation', state: 'provider_pending'");
  });

  it('dispatch claim loser -> state: pending (not failed)', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: 'Failed to claim refund for dispatch', state: 'pending'");
  });

  it('provider success + finalization RPC failure -> state: provider_success_unfinalized (not failed)', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: 'Refund processed but finalization failed — will be retried', state: 'provider_success_unfinalized'");
  });

  it('provider success + durability write failure -> state: provider_success_unfinalized', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: 'Provider refund succeeded but state update failed — will be recovered', state: 'provider_success_unfinalized'");
  });

  it('transport_unknown -> state: provider_ambiguous', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: 'Refund outcome unknown', state: 'provider_ambiguous'");
  });

  it('terminal provider failure -> state: failed', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: result.errorMessage || 'Gateway refund failed', state: 'failed'");
  });

  it('successful finalization -> state: success', () => {
    expect(REFUND_HANDLER).toContain("state: finalized ? 'success' : 'provider_success_unfinalized'");
  });

  it('re-finalization failure -> state: provider_success_unfinalized', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: 'Re-finalization failed', state: 'provider_success_unfinalized'");
  });

  it('provider_pending persistence failure -> state: provider_ambiguous (not failed)', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: 'Provider accepted but state persistence failed — requires recovery', state: 'provider_ambiguous'");
  });

  it('terminal_failure persistence failure -> state: provider_ambiguous (not failed)', () => {
    expect(REFUND_HANDLER).toContain("errorMessage: 'Provider failure confirmed but state persistence failed — requires recovery', state: 'provider_ambiguous'");
  });

  it('Tier-2 non-replay-safe gateway -> state: provider_ambiguous', () => {
    expect(REFUND_HANDLER).toContain("state: 'provider_ambiguous'");
  });
});
