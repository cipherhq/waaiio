/** Server-only admission for channel allocation and changes requiring certified schema.
 * Requests and public environment variables cannot enable this capability.
 * Existing channel resolution and messaging do not consult this switch.
 */
export const CHANNEL_OPERATIONS_UNAVAILABLE = {
  code: 'CHANNEL_OPERATIONS_UNAVAILABLE',
  error: 'WhatsApp channel setup and changes are temporarily unavailable. Existing connected messaging remains available.',
  message: 'WhatsApp channel setup and changes are temporarily unavailable. Existing connected messaging remains available.',
} as const;

export function channelOperationsEnabled(): boolean {
  return process.env.ENABLE_CHANNEL_ALLOCATION_OPERATIONS === 'true';
}

/** Narrow admission (M507): give a business that has no WhatsApp channel its
 * first shared number in its own country. This does NOT enable reassignment,
 * stale-channel repair, dedicated promotion, disconnect or admin changes; those
 * stay behind channelOperationsEnabled(). Server-only env var; default off.
 */
export function firstSharedAssignmentEnabled(): boolean {
  return process.env.ENABLE_FIRST_SHARED_ASSIGNMENT === 'true';
}

/** Returned when first assignment is enabled but no eligible number could be assigned. */
export const WHATSAPP_NUMBER_UNAVAILABLE = {
  code: 'WHATSAPP_NUMBER_UNAVAILABLE',
  error: "We couldn't give your business a WhatsApp number yet. Please try again in a few minutes or contact support.",
  message: "We couldn't give your business a WhatsApp number yet. Please try again in a few minutes or contact support.",
} as const;
