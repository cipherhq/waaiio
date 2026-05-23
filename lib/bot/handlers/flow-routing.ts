import type { CapabilityId } from '@/lib/capabilities/types';
import type { FlowType } from '@/lib/constants';

/**
 * Get the first flow step based on flow type.
 */
export function getFirstStep(flowType: FlowType): string {
  switch (flowType) {
    case 'scheduling': return 'select_service';
    case 'payment': return 'select_category';
    case 'ordering': return 'browse_catalog';
    case 'ticketing': return 'select_event';
    case 'queue': return 'queue_start';
    case 'reservation': return 'select_service';
    default: return 'select_service';
  }
}

/**
 * Determine the first step based on capabilities.
 * - Single capability → go directly to that flow's first step
 * - Multiple capabilities → show capability selection menu
 * - Fallback to flow_type if no capabilities loaded
 */
export function getFirstStepFromCapabilities(capabilities: CapabilityId[], flowType: FlowType): string {
  if (capabilities.length === 0) {
    return getFirstStep(flowType);
  }

  // Filter to user-facing capabilities only (same filter as select_capability prompt)
  const nonUserFacing = new Set(['reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff', 'whatsapp_sign', 'survey', 'poll', 'broadcast', 'recurring', 'auto_reply', 'membership', 'estimates', 'packages', 'class_booking', 'multi_location']);
  // If scheduling is present, payment/invoice happen within the booking flow — don't show as separate options
  if (capabilities.includes('scheduling') || capabilities.includes('table_reservation')) {
    nonUserFacing.add('payment');
    nonUserFacing.add('invoice');
  }
  const userFacing = capabilities.filter(c => !nonUserFacing.has(c));

  if (userFacing.length <= 1) {
    return capabilityToFirstStep(userFacing[0] || capabilities[0]);
  }

  // Multiple user-facing capabilities — route to capability selection
  return 'select_capability';
}

/**
 * Map a capability ID to its first flow step.
 */
export function capabilityToFirstStep(cap: CapabilityId): string {
  switch (cap) {
    case 'appointment': return 'select_appointment';
    case 'scheduling': return 'select_service';
    case 'table_reservation': return 'select_service'; // Reuses scheduling flow
    case 'giving': return 'select_category';
    case 'payment': return 'select_category';
    case 'ordering': return 'browse_catalog';
    case 'ticketing': return 'select_event';
    case 'crowdfunding': return 'select_campaign';
    case 'reminders': return 'select_service'; // reminders piggyback on scheduling
    case 'queue': return 'queue_start';
    case 'reports': return 'select_service'; // reports are dashboard-only, no bot flow
    case 'chat': return 'chat_start';
    case 'waitlist': return 'waitlist_join';
    case 'feedback': return 'select_service'; // feedback is post-completion
    case 'loyalty': return 'loyalty_menu';
    case 'referral': return 'select_service'; // referral is post-completion
    case 'staff': return 'select_service'; // staff enhances scheduling
    case 'estimates': return 'select_service'; // quotes initiated from dashboard, falls through to scheduling
    case 'packages': return 'select_service'; // purchased at point of booking, falls through to scheduling
    case 'class_booking': return 'select_service'; // uses scheduling flow with is_class=true
    case 'multi_location': return 'select_service'; // location selection is a step within scheduling
    default: return 'select_service';
  }
}
