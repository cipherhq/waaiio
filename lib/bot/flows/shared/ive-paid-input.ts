/**
 * #219: Shared parser for "I've Paid" input in active payment-waiting flows.
 *
 * Recognizes all valid I've Paid input forms:
 *   - Legacy: 'i_paid', 'i_paid_online', 'paid', 'done', 'check'
 *   - #219 payment-specific: 'i_paid_ref:<gateway-reference>'
 *
 * Used by active flow validators to support the new button ID format
 * without duplicating parsing logic across flows.
 */

export interface IvePaidInput {
  /** Whether this input is any recognized I've Paid form */
  recognized: boolean;
  /** #219: Gateway reference from i_paid_ref:<ref>, if present */
  paymentRef?: string;
}

const LEGACY_IDS = ['i_paid', 'i_paid_online', 'paid', 'done', 'check', "i've paid"];

export function parseIvePaidInput(text: string): IvePaidInput {
  if (LEGACY_IDS.includes(text)) {
    return { recognized: true };
  }
  if (text.startsWith('i_paid_ref:')) {
    const ref = text.slice('i_paid_ref:'.length);
    if (ref && ref.trim()) return { recognized: true, paymentRef: ref };
    // Malformed — fail closed
    return { recognized: false };
  }
  return { recognized: false };
}

/** Check if text is any I've Paid form (for exclusion lists like _awaiting_transfer_proof) */
export function isIvePaidInput(text: string): boolean {
  return parseIvePaidInput(text).recognized;
}
