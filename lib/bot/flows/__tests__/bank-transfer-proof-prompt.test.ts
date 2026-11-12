/**
 * Bank-transfer proof prompt — staging TestBiz trace 2026-11-12 (booking WA-BK-8012).
 *
 * Runs the real payment-step prompt()/validate() of every flow that offers
 * direct bank transfer, and proves:
 *   1. "I've Sent Transfer" leaves the step waiting for proof without sending
 *      anything itself. The executor re-prompts after an invalid result, and the
 *      re-prompt is the proof request, so the customer gets one message, not a
 *      proof request followed by "pay with the link above".
 *   2. With no online payment link, the step never offers "I've Paid Online".
 *   3. "I've Paid" on a transfer-only payment asks for the receipt instead of
 *      silently cancelling the session.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import type { FlowDefinition, PromptMessage } from '../types';
import { paymentFlow } from '../payment.flow';
import { schedulingFlow } from '../scheduling.flow';
import { ticketingFlow } from '../ticketing.flow';
import { orderingFlow } from '../ordering.flow';
import { reservationFlow } from '../reservation.flow';
import { invoiceFlow } from '../invoice.flow';
import { crowdfundingFlow } from '../crowdfunding.flow';

vi.mock('@/lib/payments/bot-recovery', () => ({
  verifyAndReconcilePayment: vi.fn(async () => ({ outcome: 'not_paid' })),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

const FLOWS: Array<[string, FlowDefinition, string]> = [
  ['payment', paymentFlow, 'await_payment'],
  ['scheduling', schedulingFlow, 'payment'],
  ['ticketing', ticketingFlow, 'await_ticket_payment'],
  ['ordering', orderingFlow, 'await_order_payment'],
  ['reservation', reservationFlow, 'reservation_payment'],
  ['invoice', invoiceFlow, 'await_invoice_payment'],
  ['crowdfunding', crowdfundingFlow, 'await_donation_payment'],
];

function transferCtx(extra: Record<string, unknown> = {}) {
  return createMockContext({
    session: {
      id: 's1', user_id: 'u1', business_id: 'test-business-id',
      current_step: '', version: 0,
      session_data: {
        bank_transfer_offered: true,
        bank_transfer_reference: 'WA-53A0',
        bank_transfer_amount: 5000,
        reference_code: 'WA-BK-8012',
        booking_id: 'bk-1',
        service_name: 'Lashes Refil',
        ...extra,
      },
    },
  });
}

function buttonIds(msgs: PromptMessage[]): string[] {
  expect(msgs).toHaveLength(1);
  const m = msgs[0] as { type: string; buttons?: Array<{ id: string }> };
  expect(m.type).toBe('buttons');
  return (m.buttons || []).map(b => b.id);
}

function body(msgs: PromptMessage[]): string {
  return (msgs[0] as { body: string }).body;
}

describe.each(FLOWS)('%s flow — bank transfer payment step', (_name, flow, stepId) => {
  const step = getStep(flow, stepId);

  it('transfer-only prompt offers "I\'ve Sent Transfer" and Cancel, not "I\'ve Paid Online"', async () => {
    const ids = buttonIds(await step.prompt(transferCtx()));
    expect(ids).toEqual(['sent_transfer', 'go_back']);
  });

  it('prompt with an online link keeps both options', async () => {
    const ids = buttonIds(await step.prompt(transferCtx({ payment_reference: 'PSK-REF-1' })));
    expect(ids).toEqual(['i_paid_ref:PSK-REF-1', 'sent_transfer', 'go_back']);
  });

  it('"I\'ve Sent Transfer" waits for proof and sends nothing itself', async () => {
    const ctx = transferCtx();
    const result = await step.validate('sent_transfer', ctx);

    expect(result.valid).toBe(false);
    expect(result.persistSessionDataOnFailure).toBe(true);
    expect(result.errorMessage).toBeFalsy();
    expect(ctx.session.session_data._awaiting_transfer_proof).toBe(true);
    expect(ctx.sender.sendText).not.toHaveBeenCalled();
    expect(ctx.supabase.from).not.toHaveBeenCalledWith('bot_sessions');

    // The executor's re-prompt is the proof request — one message, no payment link talk.
    const reprompt = await step.prompt(ctx);
    expect(buttonIds(reprompt)).toEqual(['go_back']);
    expect(body(reprompt)).toContain('screenshot');
    expect(body(reprompt)).toContain('WA-53A0');
    expect(body(reprompt)).not.toMatch(/link/i);
    // The executor does not translate re-prompts, so the step must (as validate() did before).
    expect(ctx.t).toHaveBeenCalledWith(expect.stringContaining('screenshot'));
  });

  it('proof request keeps "I\'ve Paid Online" when an online link exists', async () => {
    const ctx = transferCtx({ payment_reference: 'PSK-REF-1', _awaiting_transfer_proof: true });
    expect(buttonIds(await step.prompt(ctx))).toEqual(['i_paid_ref:PSK-REF-1', 'go_back']);
  });

  it('"I\'ve Paid" on a transfer-only payment asks for proof instead of cancelling', async () => {
    const ctx = transferCtx();
    const result = await step.validate('i_paid_online', ctx);

    expect(result.valid).toBe(false);
    expect(result.persistSessionDataOnFailure).toBe(true);
    expect(result.data?._action).toBeUndefined();
    expect(ctx.session.session_data._awaiting_transfer_proof).toBe(true);
    expect(ctx.sender.sendText).not.toHaveBeenCalled();
  });
});
