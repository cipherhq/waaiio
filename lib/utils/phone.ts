/**
 * Shared phone number utilities.
 * Use these instead of inline `phone.startsWith('+') ? ...` patterns.
 */

/** Strip leading '+' for WhatsApp API calls (e.g. '+12029226251' → '12029226251') */
export function stripPlus(phone: string): string {
  return phone.startsWith('+') ? phone.slice(1) : phone;
}

/** Ensure leading '+' for database storage (e.g. '12029226251' → '+12029226251') */
export function ensurePlus(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/** Get both '+' and non-'+' variants for dual-format queries */
export function phonePair(phone: string): { withPlus: string; withoutPlus: string } {
  return {
    withPlus: ensurePlus(phone),
    withoutPlus: stripPlus(phone),
  };
}
