/** Gateway-neutral copy for Waaiio-hosted payment links (before provider redirect).
 * Be specific: provider authorization tokens, masked details and transaction/contact
 * records can exist. Do not promise "no card data" or "no payment information".
 */
export const PAYMENT_LINK_PRIVACY = Object.freeze({
  heading: 'Your payment information is protected',
  description: 'Your card payment is processed securely by the payment provider. Waaiio does not store your full card number or CVV. The business cannot view your full card details. It can see the payment amount, status, and information you provide to complete your purchase.',
});
