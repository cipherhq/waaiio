/**
 * Payment-step prompt and "waiting for proof" state for direct bank transfer.
 * Shared by every flow that offers bank transfer.
 *
 * Kept apart from ./bank-transfer because many flow tests replace that whole
 * module with a mock.
 */
import { getFlowCopy } from '@/lib/bot/flows/flow-localization';
import type { PromptMessage, ValidationResult } from '../types';

/**
 * Keep the payment step waiting for the customer's transfer receipt.
 *
 * Returns an invalid result on purpose: the executor saves session_data and
 * re-sends the step's prompt, which then asks for the proof
 * (see bankTransferPaymentPrompt). Do not also send the request from validate():
 * the executor's re-prompt would follow it with a second, contradictory message.
 */
export function awaitTransferProof(sessionData: Record<string, unknown>): ValidationResult {
  sessionData._awaiting_transfer_proof = true;
  return { valid: false, persistSessionDataOnFailure: true };
}

/**
 * Payment-step prompt while a bank transfer is on offer.
 * "I've Paid Online" is offered only when the customer has an online payment link.
 * `translate` is ctx.t: the executor does not translate re-prompts, so the
 * proof request is translated here, as it was when validate() sent it.
 */
export async function bankTransferPaymentPrompt(
  sessionData: Record<string, unknown>,
  lang: string | undefined,
  translate: (text: string) => Promise<string>,
): Promise<PromptMessage> {
  const l = lang || 'en';
  const pRef = sessionData.payment_reference as string | undefined;
  const paidOnline = pRef
    ? [{ id: `i_paid_ref:${pRef}`, title: getFlowCopy(l, 'payment.ive_paid_online') }]
    : [];
  const sentTransfer = { id: 'sent_transfer', title: getFlowCopy(l, 'payment.ive_sent_transfer') };
  const cancel = { id: 'go_back', title: getFlowCopy(l, 'nav.cancel') };

  if (sessionData._awaiting_transfer_proof) {
    return {
      type: 'buttons',
      body: await translate(`Please send a *screenshot* of your transfer receipt, or type the bank *transaction reference* so we can verify your payment.\n\nRef: *${sessionData.bank_transfer_reference as string}*`),
      buttons: [...paidOnline, cancel],
    };
  }

  if (!pRef) {
    return {
      type: 'buttons',
      body: getFlowCopy(l, 'payment.transfer_hint'),
      buttons: [sentTransfer, cancel],
    };
  }

  return {
    type: 'buttons',
    body: getFlowCopy(l, 'payment.complete_payment'),
    buttons: [...paidOnline, sentTransfer, cancel],
  };
}
