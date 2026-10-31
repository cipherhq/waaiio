/** Allowlisted customer-facing diagnostics; never expose arbitrary provider payloads. */
export const PHONE_ALREADY_REGISTERED_REASON = 'meta_phone_already_registered';
export const PHONE_ALREADY_REGISTERED_MESSAGE = 'This number is already connected to another WhatsApp account. This connection method cannot move it. Use a different dedicated number, continue with the shared number, or contact support to review your options.';

export function safeFailureMessage(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === PHONE_ALREADY_REGISTERED_REASON) return PHONE_ALREADY_REGISTERED_MESSAGE;
  if (reason.includes('registration')) return 'Phone registration failed. Please try again.';
  if (reason.includes('subscription') || reason.includes('webhook')) return 'Webhook setup failed. Please try again.';
  if (reason.includes('Promotion')) return 'Channel activation failed. Please try again.';
  return 'Connection failed. Please try again.';
}
