/**
 * #197: Canonical strict parser for stale "I've Paid" machine postback IDs.
 *
 * Recognized shapes (messageType MUST be 'button'):
 *   i_paid                    → generic, no reference
 *   i_paid_online             → generic, no reference
 *   i_paid:<order-ref>        → reference-bearing (ref must be non-empty)
 *   i_paid_online:<order-ref> → reference-bearing (ref must be non-empty)
 *
 * Malformed/empty ref forms (e.g., "i_paid:", "i_paid_online:") fail closed.
 * Free text "paid"/"done" is NEVER matched by this parser.
 */

export interface StaleButtonParseResult {
  /** Whether this is a recognized stale payment machine postback */
  isStalePaymentButton: boolean;
  /** Whether the postback carries an order reference */
  hasReference: boolean;
  /** The extracted order reference (non-empty), or null */
  reference: string | null;
}

/**
 * Parse a potential stale "I've Paid" machine postback.
 *
 * @param text - The normalized button postback text (from Meta button_reply.id)
 * @param messageType - The message type ('button', 'text', 'list', etc.)
 * @param currentStep - The current session step
 */
export function parseStalePaymentButton(
  text: string,
  messageType: string,
  currentStep: string,
): StaleButtonParseResult {
  const NOT_MATCHED: StaleButtonParseResult = { isStalePaymentButton: false, hasReference: false, reference: null };

  // ONLY machine button postbacks — never free text
  if (messageType !== 'button') return NOT_MATCHED;

  // If session IS at a legitimate payment-waiting step, this is NOT stale
  const paymentWaitingSteps = [
    'payment', 'await_payment', 'await_ticket_payment', 'await_order_payment',
    'create_booking', 'reservation_payment', 'await_invoice_payment', 'await_donation_payment',
  ];
  if (paymentWaitingSteps.includes(currentStep)) return NOT_MATCHED;

  // Generic forms (exact match)
  if (text === 'i_paid' || text === 'i_paid_online') {
    return { isStalePaymentButton: true, hasReference: false, reference: null };
  }

  // Reference-bearing forms — strict parsing
  for (const prefix of ['i_paid:', 'i_paid_online:']) {
    if (text.startsWith(prefix)) {
      const ref = text.slice(prefix.length);
      // Malformed/empty ref → fail closed
      if (!ref || !ref.trim()) return NOT_MATCHED;
      return { isStalePaymentButton: true, hasReference: true, reference: ref };
    }
  }

  return NOT_MATCHED;
}
