/**
 * CAS-004 — Canonical semantic types for free-text routing.
 * Language-independent. One canonical model across all supported languages.
 */

export type SemanticFamily =
  | 'service_time_booking'
  | 'class_booking'
  | 'property_reservation'
  | 'table_reservation'
  | 'ordering'
  | 'ticketing'
  | 'giving'
  | 'payment'
  | 'queue'
  | 'waitlist'
  | null;

export type RequestedAction =
  | 'create_new'
  | 'manage_existing'
  | 'read_history'
  | 'informational'
  | 'navigation'
  | null;

/** Map a semantic family to the capability IDs that can fulfill it */
export const FAMILY_TO_CAPABILITIES: Record<string, string[]> = {
  service_time_booking: ['scheduling', 'appointment'],
  class_booking: ['class_booking'],
  property_reservation: ['reservation'],
  table_reservation: ['table_reservation'],
  ordering: ['ordering'],
  ticketing: ['ticketing'],
  giving: ['giving'],
  payment: ['payment'],
  queue: ['queue'],
  waitlist: ['waitlist'],
};

/** Valid SemanticFamily values for validation */
export const VALID_SEMANTIC_FAMILIES: readonly string[] = [
  'service_time_booking', 'class_booking', 'property_reservation', 'table_reservation',
  'ordering', 'ticketing', 'giving', 'payment', 'queue', 'waitlist',
];

/** Valid RequestedAction values for validation */
export const VALID_REQUESTED_ACTIONS: readonly string[] = [
  'create_new', 'manage_existing', 'read_history', 'informational', 'navigation',
];

/** Validate LLM output against allowed enums */
export function validateSemanticFamily(value: unknown): SemanticFamily {
  if (typeof value === 'string' && VALID_SEMANTIC_FAMILIES.includes(value)) {
    return value as SemanticFamily;
  }
  return null;
}

export function validateRequestedAction(value: unknown): RequestedAction {
  if (typeof value === 'string' && VALID_REQUESTED_ACTIONS.includes(value)) {
    return value as RequestedAction;
  }
  return null;
}

/** Valid language codes */
const VALID_LANGUAGE_CODES = ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es'];

/** Validate LLM language output against canonical supported codes */
export function validateLanguage(value: unknown): string | null {
  if (typeof value === 'string' && VALID_LANGUAGE_CODES.includes(value)) {
    return value;
  }
  return null; // invalid/unknown — do not silently treat as English
}
