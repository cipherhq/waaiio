/**
 * Phase 2D R13 — remaining Stage 2 / authority recovery executable proofs.
 * Uses production processSuccessfulPayment + Payment Authority functions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    withContext: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/redact', () => ({ isSafeIdentifier: () => true }));
vi.mock('@/lib/waitlist/auto-notify', () => ({ markWaitlistConverted: vi.fn() }));
vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2, feeFlat: 0, feeTotal: 100 }),
}));
vi.mock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/payments/session-terminalization', () => ({
  terminalizeOriginatingSession: vi.fn().mockResolvedValue({ status: 'no_origin' }),
}));

type FeeRow = {
  payment_id: string;
  order_id: string;
  business_id: string;
  transaction_amount: number;
  fee_percentage: number;
  fee_flat: number;
  fee_total: number;
  gateway_fee: number;
  is_direct_transfer: boolean;
};

function chain(data: any = null, error: any = null): any {
  const c: any = {};
  for (const method of ['select', 'eq', 'neq', 'not', 'is', 'in', 'order', 'limit', 'like', 'update', 'or', 'lt', 'gt']) {
    c[method] = vi.fn(() => c);
  }
  c.single = vi.fn().mockResolvedValue({ data, error });
  c.maybeSingle = vi.fn().mockResolvedValue({ data, error });
  c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  c.then = (resolve: any) => resolve({ data: Array.isArray(data) ? data : (data == null ? [] : [data]), error });
  return c;
}

function buildStage2Supabase(opts: {
  feeInsertError?: any;
  verifyRow?: FeeRow | null;
  verifyError?: any;
  paymentRow?: any;
  finalizationInitiallyComplete?: boolean;
} = {}) {
  const insertedFees: any[] = [];
  const rpcCalls: Array<{ name: string; params: any }> = [];
  let finalizationOwned = false;
  let finalizationComplete = opts.finalizationInitiallyComplete === true;

  const expectedFee: FeeRow = opts.verifyRow === undefined ? {
    payment_id: 'pay-direct',
    order_id: 'ord-1',
    business_id: 'biz-1',
    transaction_amount: 5000,
    fee_percentage: 0,
    fee_flat: 0,
    fee_total: 0,
    gateway_fee: 0,
    is_direct_transfer: true,
  } : opts.verifyRow as FeeRow;

  const paymentRow = opts.paymentRow ?? {
    id: 'pay-direct',
    amount: 5000,
    currency: 'NGN',
    gateway: 'direct',
    status: 'success',
    booking_id: null,
    invoice_id: null,
    campaign_id: null,
    reservation_id: null,
    order_id: 'ord-1',
    metadata: { _direct_transfer: true, pending_transfer_id: 'xf-1' },
    gateway_fee: 0,
    finalization_completed_at: finalizationComplete ? '2026-09-22T00:00:00Z' : null,
    payment_authority_version: 1,
  };

  const from = vi.fn((table: string) => {
    if (table === 'payments') return chain({ ...paymentRow, finalization_completed_at: finalizationComplete ? '2026-09-22T00:00:00Z' : null });
    if (table === 'orders') return chain({
      business_id: 'biz-1', referral_id: null, delivery_phone: '+234900',
      reference_code: 'ORD-1', total_amount: 5000,
    });
    if (table === 'businesses') return chain({
      subscription_tier: 'growth', trial_ends_at: null, payout_mode: 'platform_managed',
      custom_fee_percentage: null, custom_fee_flat: null, reseller_id: null,
    });
    if (table === 'platform_fees') {
      const c = chain(expectedFee, opts.verifyError ?? null);
      c.insert = vi.fn((payload: any) => {
        insertedFees.push(payload);
        return Promise.resolve({ data: null, error: opts.feeInsertError ?? null });
      });
      c.single = vi.fn().mockResolvedValue({ data: opts.verifyRow === null ? null : expectedFee, error: opts.verifyError ?? null });
      return c;
    }
    if (table === 'referrals') return chain();
    if (table === 'resellers') return chain(null);
    return chain(null);
  });

  const rpc = vi.fn(async (name: string, params?: any) => {
    rpcCalls.push({ name, params });
    if (name === 'claim_payment_finalization') {
      if (finalizationComplete) return { data: { claimed: false, already_completed: true, reason: 'already_completed' }, error: null };
      if (finalizationOwned) return { data: { claimed: false, reason: 'processing_in_progress' }, error: null };
      finalizationOwned = true;
      return {
        data: {
          claimed: true, claim_token: 'claim-1', payment_id: paymentRow.id, amount: paymentRow.amount,
          booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null,
          order_id: paymentRow.order_id, gateway_fee: 0,
        },
        error: null,
      };
    }
    if (name === 'complete_payment_finalization') {
      finalizationComplete = true;
      finalizationOwned = false;
      return { data: { completed: true }, error: null };
    }
    if (name === 'release_payment_finalization') {
      finalizationOwned = false;
      return { data: { released: true }, error: null };
    }
    if (name === 'apply_order_stock_once') return { data: { applied: true, already_applied: false }, error: null };
    if (name === 'finalize_promo_reservation') return { data: { reason: 'no_reservation' }, error: null };
    if (name === 'apply_customer_spend_once') return { data: { applied: true, already_applied: false }, error: null };
    return { data: null, error: null };
  });

  return { from, rpc, insertedFees, rpcCalls } as any;
}

const directPayment = {
  id: 'pay-direct', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null,
  reservation_id: null, order_id: 'ord-1',
  metadata: { _direct_transfer: true, pending_transfer_id: 'xf-1' },
  gateway_fee: 0, gateway: 'direct', payment_authority_version: 1,
};

describe('Phase 2D Stage 2 production edge cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fresh authoritative direct transfer verifies exact zero-fee row', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const sb = buildStage2Supabase();
    const result = await processSuccessfulPayment(sb, directPayment);
    expect(result.criticalSuccess).toBe(true);
    expect(sb.insertedFees).toContainEqual(expect.objectContaining({
      payment_id: 'pay-direct', order_id: 'ord-1', fee_total: 0, gateway_fee: 0, is_direct_transfer: true,
    }));
  });

  it('23505 replay + exact existing row succeeds', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const sb = buildStage2Supabase({ feeInsertError: { code: '23505', message: 'duplicate key' } });
    const result = await processSuccessfulPayment(sb, directPayment);
    expect(result.criticalSuccess).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('23505 replay + mismatched existing row fails closed', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const sb = buildStage2Supabase({
      feeInsertError: { code: '23505', message: 'duplicate key' },
      verifyRow: {
        payment_id: 'pay-direct', order_id: 'ord-1', business_id: 'biz-1',
        transaction_amount: 4999, fee_percentage: 0, fee_flat: 0, fee_total: 0,
        gateway_fee: 0, is_direct_transfer: true,
      },
    });
    const result = await processSuccessfulPayment(sb, directPayment);
    expect(result.criticalSuccess).toBe(false);
    expect(result.errors).toContain('direct_transfer_fee_mismatch');
  });

  it('23505 replay + missing verification row fails closed', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const sb = buildStage2Supabase({
      feeInsertError: { code: '23505', message: 'duplicate key' },
      verifyRow: null,
    });
    const result = await processSuccessfulPayment(sb, directPayment);
    expect(result.criticalSuccess).toBe(false);
    expect(result.errors).toContain('direct_transfer_fee_verify_failed');
  });

  it('verification query error fails closed', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const sb = buildStage2Supabase({
      feeInsertError: { code: '23505', message: 'duplicate key' },
      verifyError: { message: 'read timeout' },
    });
    const result = await processSuccessfulPayment(sb, directPayment);
    expect(result.criticalSuccess).toBe(false);
    expect(result.errors).toContain('direct_transfer_fee_verify_failed');
  });

  it('partial direct provenance without authority version uses normal fee path', async () => {
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const sb = buildStage2Supabase();
    const result = await processSuccessfulPayment(sb, {
      ...directPayment,
      payment_authority_version: null,
      metadata: { _direct_transfer: true, pending_transfer_id: 'xf-1' },
    });
    expect(result.criticalSuccess).toBe(true);
    const directRows = sb.insertedFees.filter((row: any) => row.is_direct_transfer === true);
    const normalRows = sb.insertedFees.filter((row: any) => row.is_direct_transfer !== true);
    expect(directRows).toHaveLength(0);
    expect(normalRows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Phase 2D direct-resume recovery authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it('in-flight contention grants exactly one Stage 2 owner and one Stage 3 send', async () => {
    const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');
    const sb = buildStage2Supabase();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });

    const processPayment = vi.fn(async () => {
      started();
      await gate;
      return { criticalSuccess: true };
    });
    const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' });

    const first = resumeSuccessfulPaymentFinalization(sb, 'pay-direct', processPayment, sendConfirmation);
    await startedPromise;
    const second = await resumeSuccessfulPaymentFinalization(sb, 'pay-direct', processPayment, sendConfirmation);

    expect(second.status).toBe('processing');
    expect(second.reason).toBe('processing_in_progress');
    release();
    const winner = await first;

    expect(winner.status).toBe('completed');
    expect(processPayment).toHaveBeenCalledTimes(1);
    expect(sendConfirmation).toHaveBeenCalledTimes(1);
    expect(sb.rpcCalls.filter((c: any) => c.name === 'complete_payment_finalization')).toHaveLength(1);
  });

  it('crash after M394 financial success recovers through real Stage 2 once', async () => {
    const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    const sb = buildStage2Supabase();
    const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' });

    const result = await resumeSuccessfulPaymentFinalization(
      sb,
      'pay-direct',
      (client, payment) => processSuccessfulPayment(client, payment),
      sendConfirmation,
    );

    expect(result.status).toBe('completed');
    expect(sb.rpcCalls.filter((c: any) => c.name === 'apply_order_stock_once')).toHaveLength(1);
    expect(sb.rpcCalls.filter((c: any) => c.name === 'apply_customer_spend_once')).toHaveLength(1);
    expect(sendConfirmation).toHaveBeenCalledTimes(1);
  });

  it('Stage 2 complete recovery skips processPayment and resumes Stage 3 only', async () => {
    const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');
    const sb = buildStage2Supabase({ finalizationInitiallyComplete: true });
    const processPayment = vi.fn().mockResolvedValue({ criticalSuccess: true });
    const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' });

    const result = await resumeSuccessfulPaymentFinalization(sb, 'pay-direct', processPayment, sendConfirmation);

    expect(result.status).toBe('completed');
    expect(processPayment).not.toHaveBeenCalled();
    expect(sendConfirmation).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 2D online provider regression: common Payment Authority remains canonical', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['paystack', 'stripe', 'flutterwave', 'square', 'paypal'] as const)(
    '%s success continues through authorizeAndFinalize, not direct-resume semantics',
    async provider => {
      const { authorizeAndFinalize } = await import('@/lib/payments/authority');
      const payment = {
        id: 'pay-online', amount: 5000, currency: 'NGN', gateway: provider, status: 'success',
        booking_id: null, invoice_id: null, campaign_id: null, reservation_id: null, order_id: null,
        metadata: {}, gateway_fee: 0, finalization_completed_at: '2026-09-22T00:00:00Z',
        payment_authority_version: 1,
      };
      const sb = {
        from: vi.fn(() => {
          const c = chain(payment);
          c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
          return c;
        }),
        rpc: vi.fn(),
      } as any;
      const processPayment = vi.fn();
      const sendConfirmation = vi.fn().mockResolvedValue({ status: 'completed' });

      const result = await authorizeAndFinalize(sb, {
        provider,
        waaiioReference: 'REF-ONLINE',
        amount: 5000,
        currency: 'NGN',
        verifiedAt: '2026-09-22T00:00:00Z',
      }, processPayment, sendConfirmation);

      expect(result.status).toBe('completed');
      expect(processPayment).not.toHaveBeenCalled();
      expect(sendConfirmation).toHaveBeenCalledTimes(1);
    },
  );
});
