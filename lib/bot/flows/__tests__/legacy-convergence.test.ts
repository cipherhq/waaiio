/**
 * Legacy Payment Convergence — #173
 *
 * Executable behavioral tests for Reservation, Invoice, and Crowdfunding
 * convergence through canonical verifyAndReconcilePayment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { reservationFlow } from '../reservation.flow';
import { crowdfundingFlow } from '../crowdfunding.flow';

const mockRecovery = vi.fn();
vi.mock('@/lib/payments/bot-recovery', () => ({
  verifyAndReconcilePayment: (...args: unknown[]) => mockRecovery(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/redact', () => ({ isSafeIdentifier: () => true }));
vi.mock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2, feeFlat: 0, feeTotal: 100 }) }));
vi.mock('@/lib/waitlist/auto-notify', () => ({ markWaitlistConverted: vi.fn() }));

function buildCtx(overrides: Record<string, unknown> = {}) {
  return createMockContext({
    session: {
      id: 's1', user_id: 'u1', business_id: 'b1',
      current_step: 'reservation_payment', version: 0,
      session_data: {
        payment_reference: 'ref-123', reservation_id: 'res-1',
        reference_code: 'RES-001', active_capability: 'reservation',
        ...overrides,
      },
    },
    business: {
      id: 'b1', name: 'Test Hotel', slug: 'test',
      // eslint-disable-next-line
      category: 'other' as any, flow_type: 'reservation' as any,
      subscription_tier: 'growth',
      trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {},
    },
  });
}

async function validateMergeNext(
  // eslint-disable-next-line
  step: any, input: string, ctx: any,
): Promise<{ valid: boolean; nextStep: string | null }> {
  const result = await step.validate(input, ctx);
  if (result.valid && result.data) Object.assign(ctx.session.session_data, result.data);
  const nextStep = result.valid ? await step.next(ctx) : null;
  return { valid: result.valid, nextStep };
}

// ═══════════════════════════════════════════════════════════
// RESERVATION I'VE PAID CONVERGENCE
// ═══════════════════════════════════════════════════════════

describe('Reservation: I\'ve Paid convergence', () => {
  const step = getStep(reservationFlow, 'reservation_payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('completed → brief ack, flow ends', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed' });
    const ctx = buildCtx();
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('already_confirmed');
  });

  it('not_paid → retry message, block cleared', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain('Get New Link');
    expect(ctx.session.session_data._payment_retry_blocked).toBeUndefined();
  });

  it('provider_error → blocked, no new-link', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error' });
    const ctx = buildCtx();
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(false);
    expect(r.errorMessage).not.toContain('Get New Link');
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);
  });

  it('processing → stays at step', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'processing' });
    const ctx = buildCtx();
    const { nextStep } = await validateMergeNext(step, 'i_paid', ctx);
    expect(nextStep).toBe('reservation_payment');
  });

  it('missing payment_reference → fail closed (not cancel)', async () => {
    const ctx = buildCtx({ payment_reference: undefined });
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(false);
    expect(r.data?._action).toBeUndefined();
    expect(mockRecovery).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// RESERVATION RETRY GATE
// ═══════════════════════════════════════════════════════════

describe('Reservation: retry_payment recovery gate', () => {
  const step = getStep(reservationFlow, 'reservation_payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('not_paid → create_reservation', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx();
    const { nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(nextStep).toBe('create_reservation');
  });

  it('provider_error → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('no ref → fail closed', async () => {
    const ctx = buildCtx({ payment_reference: undefined });
    const { valid } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(mockRecovery).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// RESERVATION CANCEL CAS
// ═══════════════════════════════════════════════════════════

describe('Reservation: cancel CAS guard', () => {
  const step = getStep(reservationFlow, 'reservation_payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('pending cancel succeeds', async () => {
    const ctx = buildCtx();
    const cancelChain = {
      update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 'res-1' }], error: null }),
    };
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
      if (t === 'reservations') return cancelChain;
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const r = await step.validate('cancel', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('cancel');
  });

  it('payment-won → already_confirmed', async () => {
    const ctx = buildCtx();
    const cancelChain = {
      update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const rereadChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { status: 'confirmed', deposit_status: 'paid' }, error: null }),
        }),
      }),
    };
    let callCount = 0;
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
      if (t === 'reservations') { callCount++; return callCount === 1 ? cancelChain : rereadChain; }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const r = await step.validate('cancel', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('already_confirmed');
  });
});

// ═══════════════════════════════════════════════════════════
// RESERVATION PROMPT GATING
// ═══════════════════════════════════════════════════════════

describe('Reservation: prompt gating', () => {
  const step = getStep(reservationFlow, 'reservation_payment');

  it('blocked → no retry_payment button', async () => {
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const msgs = await step.prompt(ctx);
    const buttons = msgs[0].type === 'buttons' ? (msgs[0] as { buttons: Array<{ id: string }> }).buttons : [];
    expect(buttons.map((b: { id: string }) => b.id)).not.toContain('retry_payment');
  });

  it('not blocked → includes retry_payment', async () => {
    const ctx = buildCtx();
    const msgs = await step.prompt(ctx);
    const buttons = msgs[0].type === 'buttons' ? (msgs[0] as { buttons: Array<{ id: string }> }).buttons : [];
    expect(buttons.map((b: { id: string }) => b.id)).toContain('retry_payment');
  });
});

// ═══════════════════════════════════════════════════════════
// INVOICE I'VE PAID CONVERGENCE
// ═══════════════════════════════════════════════════════════

describe('Invoice: I\'ve Paid convergence', () => {
  // Invoice flow uses a non-standard step export, import the step directly
  let step: ReturnType<typeof getStep>;
  beforeEach(async () => {
    vi.clearAllMocks();
    const { invoiceFlow } = await import('../invoice.flow');
    step = getStep(invoiceFlow, 'await_invoice_payment');
  });

  it('completed → brief ack', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed' });
    const ctx = buildCtx({ _invoice_ref: 'INV-001', payment_reference: 'ref-inv' });
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('already_confirmed');
  });

  it('processing → stays at step', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'processing' });
    const ctx = buildCtx({ payment_reference: 'ref-inv' });
    const { nextStep } = await validateMergeNext(step, 'i_paid', ctx);
    expect(nextStep).toBe('await_invoice_payment');
  });

  it('missing ref → fail closed', async () => {
    const ctx = buildCtx({ payment_reference: undefined });
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(false);
    expect(mockRecovery).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// CROWDFUNDING I'VE PAID CONVERGENCE
// ═══════════════════════════════════════════════════════════

describe('Crowdfunding: I\'ve Paid convergence', () => {
  const awaitStep = crowdfundingFlow.steps.find(s => s.id === 'await_donation_payment')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('completed → brief ack', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed' });
    const ctx = buildCtx({ payment_reference: 'ref-don', campaign_title: 'Feed the Children', donation_ref_code: 'DON-001' });
    const r = await awaitStep.validate('i_paid', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('already_confirmed');
  });

  it('processing → stays at step', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'processing' });
    const ctx = buildCtx({ payment_reference: 'ref-don', campaign_title: 'Test' });
    const { nextStep } = await validateMergeNext(awaitStep, 'i_paid', ctx);
    expect(nextStep).toBe('await_donation_payment');
  });

  it('missing ref → fail closed', async () => {
    const ctx = buildCtx({ payment_reference: undefined });
    const r = await awaitStep.validate('i_paid', ctx);
    expect(r.valid).toBe(false);
    expect(mockRecovery).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// CROWDFUNDING CANCEL CAS
// ═══════════════════════════════════════════════════════════

describe('Crowdfunding: cancel CAS guard', () => {
  const awaitStep = crowdfundingFlow.steps.find(s => s.id === 'await_donation_payment')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('donation-success → already_confirmed (no overwrite)', async () => {
    const ctx = buildCtx({ donation_ref_code: 'DON-001', payment_reference: 'ref-don' });
    const cancelChain = {
      update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const rereadChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { status: 'success' }, error: null }),
        }),
      }),
    };
    let callCount = 0;
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((t: string) => {
      if (t === 'campaign_donations') { callCount++; return callCount === 1 ? cancelChain : rereadChain; }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const r = await awaitStep.validate('cancel', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('already_confirmed');
  });
});

// ═══════════════════════════════════════════════════════════
// CAMPAIGN SEMANTIC FAILURE
// ═══════════════════════════════════════════════════════════

describe('Campaign donation semantic failure propagation', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('null RPC result → throws (fail closed)', async () => {
    const { processCampaignDonation } = await import('@/lib/payments/process-success');
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };

    // eslint-disable-next-line
    await expect(processCampaignDonation(supabase as any, 'p1', 'c1', 5000)).rejects.toThrow();
  });

  it('applied:false + reason → throws', async () => {
    const { processCampaignDonation } = await import('@/lib/payments/process-success');
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: { applied: false, reason: 'donation_not_found' }, error: null }) };

    // eslint-disable-next-line
    await expect(processCampaignDonation(supabase as any, 'p1', 'c1', 5000)).rejects.toThrow('donation_not_found');
  });

  it('applied:true → no throw', async () => {
    const { processCampaignDonation } = await import('@/lib/payments/process-success');
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: { applied: true, amount: 5000 }, error: null }),
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { business_id: 'b1', subscription_tier: 'free', trial_ends_at: '2020-01-01', payout_mode: 'platform' }, error: null }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    };
    // eslint-disable-next-line
    await expect(processCampaignDonation(supabase as any, 'p1', 'c1', 5000)).resolves.not.toThrow();
  });

  it('already_applied → no throw', async () => {
    const { processCampaignDonation } = await import('@/lib/payments/process-success');
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: { applied: false, already_applied: true, is_legacy: false, amount: 5000 }, error: null }),
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { business_id: 'b1', subscription_tier: 'free', trial_ends_at: '2020-01-01', payout_mode: 'platform' }, error: null }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    };

    // eslint-disable-next-line
    await expect(processCampaignDonation(supabase as any, 'p1', 'c1', 5000)).resolves.not.toThrow();
  });
});
