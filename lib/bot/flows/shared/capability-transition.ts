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
  // M557 minimum spend and packages
  '_seating_minimum_spend',
  '_seating_payment_mode',
  '_seating_packages',
  '_seating_package_id',
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
  '_staff_any',
  'date',
  'time',
  'party_size',
  // Time taken at the final claim (#919): back-to-time-list markers
  '_slot_taken_return',
  '_slot_taken_count',
] as const;

/**
 * Add-on choices (written only by scheduling's select_addons). Never pre-filled,
 * so they are cleared even when the previous capability is unknown (#859).
 */
const ADDON_KEYS = ['_available_addons', '_selected_addons'] as const;

/**
 * Pre-booking question answers and position (scheduling's pre_booking_questions).
 * They belong to one booking: a kept position skips the questions and the kept
 * answers are saved on the next booking.
 */
const PRE_BOOKING_QUESTION_KEYS = ['_pbq_answers', '_pbq_index'] as const;

/** Clear pre-booking question state. Call whenever a new booking starts. */
export function clearPreBookingQuestionState(sessionData: Record<string, unknown>): void {
  for (const key of PRE_BOOKING_QUESTION_KEYS) {
    delete sessionData[key];
  }
}

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
  // Every caller starts a new interaction, even for the same capability.
  clearPreBookingQuestionState(sessionData);

  if (fromCapability === toCapability) return;

  // Add-ons belong to the earlier booking. Clear them even with no known prior
  // capability (e.g. the saved-card "Menu" button clears active_capability).
  for (const key of ADDON_KEYS) {
    delete sessionData[key];
  }

  // No prior capability (fresh session): keep smart-prefilled booking data
  if (!fromCapability) return;

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
