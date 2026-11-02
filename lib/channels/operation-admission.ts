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
