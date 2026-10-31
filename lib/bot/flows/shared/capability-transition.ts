/**
 * Shared capability-transition state cleanup.
 *
 * Called by EVERY code path that changes active_capability:
 * - capability-selection.flow.ts (interactive menu selection)
 * - executor.ts (confirmed semantic reroute)
 * - keyword-actions.ts (keyword-triggered capability switch)
 * - bot.service.ts (quick rebook after cancellation)
 *
 * Removes stale transactional state from the PREVIOUS capability
 * that could contaminate the NEW capability's booking/deposit/resource
 * selection. Preserves customer identity, history, valid prior
 * bookings, payment obligations, and unrelated session fields.
 *
 * Issue #730, CTO R5 P1-F6.
 */

/** Keys set by table-reservation.flow.ts that must be cleared on transition */
const TABLE_RESERVATION_KEYS = [
  '_is_table_reservation',
  'seating_resource_id',
  'seating_resource_name',
  '_seating_capacity',
  '_seating_min_party',
  '_seating_deposit',
  '_seating_duration',
  '_seating_available_days',
  '_seating_available_from',
  '_seating_available_to',
] as const;

/** Shared financial/selection keys that table reservations overwrite */
const SHARED_SELECTION_KEYS = [
  'service_id',
  'service_name',
  'service_price',
  'service_deposit',
  'service_duration',
  '_service_price_is_variable',
  '_service_max_capacity',
  '_service_available_days',
  '_service_available_from',
  '_service_available_to',
  '_service_requires_staff',
  '_service_staff_ids',
  '_service_allow_staff_selection',
  '_service_buffer_minutes',
  '_is_appointment',
  '_auto_approve',
  '_service_metadata',
  '_service_is_class',
  '_class_session_id',
  '_class_remaining_spots',
  'skip_service',
  'staff_id',
  'staff_name',
  'date',
  'time',
  'party_size',
] as const;

/**
 * Clear stale transactional state when switching capabilities.
 *
 * Call this BEFORE setting the new active_capability.
 * Does NOT clear: customer identity (first_name, last_name, email, phone),
 * account fields, capabilities list, business context, or conversation history.
 */
export function clearStaleCapabilityState(
  sessionData: Record<string, unknown>,
  fromCapability: string | undefined,
  toCapability: string,
): void {
  // No prior capability (fresh session) or same capability → no cleanup needed
  if (!fromCapability || fromCapability === toCapability) return;

  // Clear table-reservation-specific keys when leaving table_reservation
  if (fromCapability === 'table_reservation') {
    for (const key of TABLE_RESERVATION_KEYS) {
      delete sessionData[key];
    }
  }

  // Clear shared selection keys on ANY capability transition
  // (prevents service/staff/deposit from previous cap contaminating new one)
  for (const key of SHARED_SELECTION_KEYS) {
    delete sessionData[key];
  }
}
