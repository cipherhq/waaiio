/**
 * Recovery-Gated retry_payment — #168
 *
 * Executable behavioral tests at the real await_payment validate()/prompt()
 * boundary for Payment/Giving, Scheduling, and Ticketing flows.
 *
 * Proves: only definitive not_paid authorizes a replacement checkout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { paymentFlow } from '../payment.flow';
import { schedulingFlow } from '../scheduling.flow';
import { ticketingFlow } from '../ticketing.flow';

// ── Mock verifyAndReconcilePayment at module boundary ──
const mockRecovery = vi.fn();
vi.mock('@/lib/payments/bot-recovery', () => ({
  verifyAndReconcilePayment: (...args: unknown[]) => mockRecovery(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

// eslint-disable-next-line
function buildCtx(overrides: Record<string, unknown> = {}) {
  return createMockContext({
    session: {
      id: 's1', user_id: 'u1', business_id: 'b1',
      current_step: 'await_payment', version: 0,
      session_data: {
        payment_reference: 'ref-123',
        booking_id: 'bk-1',
        reference_code: 'PAY-001',
        service_name: 'Test Service',
        amount: 5000,
        active_capability: 'payment',
        ...overrides,
      },
    },
    business: {
      id: 'b1', name: 'Test Biz', slug: 'test',
      // eslint-disable-next-line
      category: 'other' as any, flow_type: 'scheduling' as any,
      subscription_tier: 'growth',
      trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {},
    },
  });
}

// ═══════════════════════════════════════════════════════════
// A. PAYMENT/GIVING retry_payment GATE
// ═══════════════════════════════════════════════════════════

describe('Payment/Giving: retry_payment recovery gate', () => {
  const step = getStep(paymentFlow, 'await_payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('not_paid: fresh checkout allowed', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid', paymentId: 'p1' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('retry_payment');
  });

  it('provider_error: blocked — cannot reach process_payment', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error', paymentId: 'p1' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    expect(r.data?._action).toBeUndefined();
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);
  });

  it('not_verified: blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_verified', paymentId: 'p1' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);
  });

  it('processing: blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'processing', paymentId: 'p1' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);
  });

  it('retryable: blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'retryable', paymentId: 'p1' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
  });

  it('completed: terminal ack, no fresh checkout', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed', paymentId: 'p1' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('already_confirmed');
    expect(r.data?._action).not.toBe('retry_payment');
  });

  it('not_deliverable: terminal ack', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_deliverable', paymentId: 'p1' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('already_confirmed');
  });

  it('no payment reference: fail closed', async () => {
    const ctx = buildCtx({ payment_reference: undefined });
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    expect(mockRecovery).not.toHaveBeenCalled();
  });

  it('stale retry_payment after block: recovery runs again', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error', paymentId: 'p1' });
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    // Recovery DID run (not short-circuited by flag)
    expect(mockRecovery).toHaveBeenCalledOnce();
  });

  it('transition: provider_error → not_paid clears block', async () => {
    // First: provider_error blocks
    mockRecovery.mockResolvedValue({ outcome: 'provider_error', paymentId: 'p1' });
    const ctx = buildCtx();
    await step.validate('i_paid', ctx);
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);

    // Second: not_paid clears
    mockRecovery.mockResolvedValue({ outcome: 'not_paid', paymentId: 'p1' });
    await step.validate('i_paid', ctx);
    expect(ctx.session.session_data._payment_retry_blocked).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// B. PROMPT GATING
// ═══════════════════════════════════════════════════════════

describe('Prompt gating: _payment_retry_blocked', () => {
  it('Payment: blocked → no retry_payment button', async () => {
    const step = getStep(paymentFlow, 'await_payment');
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const msgs = await step.prompt(ctx);
    const buttons = msgs[0].type === 'buttons' ? (msgs[0] as { buttons: Array<{ id: string }> }).buttons : [];
    expect(buttons.map(b => b.id)).not.toContain('retry_payment');
    expect(buttons.map(b => b.id)).toContain('i_paid');
  });

  it('Payment: not blocked → includes retry_payment button', async () => {
    const step = getStep(paymentFlow, 'await_payment');
    const ctx = buildCtx();
    const msgs = await step.prompt(ctx);
    const buttons = msgs[0].type === 'buttons' ? (msgs[0] as { buttons: Array<{ id: string }> }).buttons : [];
    expect(buttons.map(b => b.id)).toContain('retry_payment');
  });

  it('Scheduling: blocked → no retry_payment button', async () => {
    const step = getStep(schedulingFlow, 'payment');
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const msgs = await step.prompt(ctx);
    const buttons = msgs[0].type === 'buttons' ? (msgs[0] as { buttons: Array<{ id: string }> }).buttons : [];
    expect(buttons.map(b => b.id)).not.toContain('retry_payment');
  });

  it('Ticketing: blocked → no retry_payment button', async () => {
    const step = getStep(ticketingFlow, 'await_ticket_payment');
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const msgs = await step.prompt(ctx);
    const buttons = msgs[0].type === 'buttons' ? (msgs[0] as { buttons: Array<{ id: string }> }).buttons : [];
    expect(buttons.map(b => b.id)).not.toContain('retry_payment');
  });

  it('Bank transfer prompt unchanged (no retry_payment button)', async () => {
    const step = getStep(paymentFlow, 'await_payment');
    const ctx = buildCtx({ bank_transfer_offered: true });
    const msgs = await step.prompt(ctx);
    const buttons = msgs[0].type === 'buttons' ? (msgs[0] as { buttons: Array<{ id: string }> }).buttons : [];
    expect(buttons.map(b => b.id)).not.toContain('retry_payment');
  });
});

// ═══════════════════════════════════════════════════════════
// C. SCHEDULING retry_payment GATE
// ═══════════════════════════════════════════════════════════

describe('Scheduling: retry_payment recovery gate', () => {
  const step = getStep(schedulingFlow, 'payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('not_paid: fresh checkout allowed', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._retry_payment).toBe(true);
  });

  it('provider_error: blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);
  });

  it('completed: terminal ack', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed' });
    const ctx = buildCtx();
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('payment_confirmed');
    expect(r.data?._retry_payment).toBeUndefined();
  });

  it('no reference: fail closed', async () => {
    const ctx = buildCtx({ payment_reference: undefined });
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    expect(mockRecovery).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// D. TICKETING retry_payment GATE
// ═══════════════════════════════════════════════════════════

describe('Ticketing: retry_payment recovery gate', () => {
  const step = getStep(ticketingFlow, 'await_ticket_payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('not_paid: fresh checkout allowed', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._retry_payment).toBe(true);
  });

  it('provider_error: blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);
  });

  it('completed: terminal ack', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(true);
    expect(r.data?._action).toBe('payment_confirmed');
  });

  it('no reference: fail closed', async () => {
    const ctx = buildCtx({ payment_reference: undefined, event_name: 'Test Event' });
    const r = await step.validate('retry_payment', ctx);
    expect(r.valid).toBe(false);
    expect(mockRecovery).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// E. I'VE PAID OUTCOME FIDELITY (all flows)
// ═══════════════════════════════════════════════════════════

describe('Payment/Giving: I\'ve Paid outcome fidelity', () => {
  const step = getStep(paymentFlow, 'await_payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('not_paid: safe retry message, block cleared', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain('Get New Link');
    expect(ctx.session.session_data._payment_retry_blocked).toBeUndefined();
  });

  it('provider_error: neutral message, no new-link encouragement', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error' });
    const ctx = buildCtx();
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(false);
    expect(r.errorMessage).not.toContain('Get New Link');
    expect(r.errorMessage).toContain("I've Paid");
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);
  });

  it('not_verified: neutral error', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_verified' });
    const ctx = buildCtx();
    const r = await step.validate('i_paid', ctx);
    expect(r.valid).toBe(false);
    expect(r.errorMessage).not.toContain('Get New Link');
    expect(ctx.session.session_data._payment_retry_blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// F. VALIDATE → MERGE → NEXT() ROUTING PROOF
//    Proves only not_paid can reach the fresh-checkout step.
// ═══════════════════════════════════════════════════════════

/** Simulate executor: merge validate result.data into session, call next(). */
async function validateMergeNext(
  // eslint-disable-next-line
  step: any,
  input: string,
  // eslint-disable-next-line
  ctx: any,
): Promise<{ valid: boolean; nextStep: string | null }> {
  const result = await step.validate(input, ctx);
  if (result.valid && result.data) {
    Object.assign(ctx.session.session_data, result.data);
  }
  const nextStep = result.valid ? await step.next(ctx) : null;
  return { valid: result.valid, nextStep };
}

describe('Payment/Giving: validate→merge→next() routing proof', () => {
  const step = getStep(paymentFlow, 'await_payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('not_paid retry_payment → process_payment', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBe('process_payment');
  });

  it('provider_error retry_payment → blocked (no next())', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('not_verified retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_verified' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('processing retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'processing' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('retryable retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'retryable' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('no ref retry_payment → blocked', async () => {
    const ctx = buildCtx({ payment_reference: undefined });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('completed retry_payment → already_confirmed → null (terminal)', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(ctx.session.session_data._action).toBe('already_confirmed');
    expect(nextStep).toBeNull();
  });

  it('not_deliverable retry_payment → already_confirmed → null (terminal)', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_deliverable' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBeNull();
  });

  it('stale block → later not_paid → process_payment', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBe('process_payment');
    expect(ctx.session.session_data._payment_retry_blocked).toBeUndefined();
  });
});

describe('Scheduling: validate→merge→next() routing proof', () => {
  const step = getStep(schedulingFlow, 'payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('not_paid retry_payment → create_booking', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBe('create_booking');
  });

  it('provider_error retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('not_verified retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_verified' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('processing retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'processing' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('retryable retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'retryable' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('completed retry_payment → payment_confirmed → null', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBeNull();
  });

  it('not_deliverable retry_payment → payment_confirmed → null', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_deliverable' });
    const ctx = buildCtx();
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBeNull();
  });

  it('no ref retry_payment → blocked', async () => {
    const ctx = buildCtx({ payment_reference: undefined });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('stale block → not_paid → create_booking + block cleared', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx({ _payment_retry_blocked: true });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBe('create_booking');
    expect(ctx.session.session_data._payment_retry_blocked).toBeUndefined();
  });
});

describe('Ticketing: validate→merge→next() routing proof', () => {
  const step = getStep(ticketingFlow, 'await_ticket_payment');
  beforeEach(() => { vi.clearAllMocks(); });

  it('not_paid retry_payment → process_tickets', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBe('process_tickets');
  });

  it('provider_error retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'provider_error' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('not_verified retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_verified' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('processing retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'processing' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('retryable retry_payment → blocked', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'retryable' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('completed retry_payment → payment_confirmed → null', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBeNull();
  });

  it('not_deliverable retry_payment → payment_confirmed → null', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_deliverable' });
    const ctx = buildCtx({ event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBeNull();
  });

  it('no ref retry_payment → blocked', async () => {
    const ctx = buildCtx({ payment_reference: undefined, event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(false);
    expect(nextStep).toBeNull();
  });

  it('stale block → not_paid → process_tickets + block cleared', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_paid' });
    const ctx = buildCtx({ _payment_retry_blocked: true, event_name: 'Test Event' });
    const { valid, nextStep } = await validateMergeNext(step, 'retry_payment', ctx);
    expect(valid).toBe(true);
    expect(nextStep).toBe('process_tickets');
    expect(ctx.session.session_data._payment_retry_blocked).toBeUndefined();
  });
});
