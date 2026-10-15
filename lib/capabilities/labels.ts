import type { CapabilityId } from './types';
import { getFlowCopy } from '@/lib/bot/flows/flow-localization';

const CAPABILITY_KEYS: Partial<Record<CapabilityId, string>> = {
  scheduling: 'cap.scheduling',
  appointment: 'cap.appointment',
  giving: 'cap.giving',
  payment: 'cap.payment',
  ordering: 'cap.ordering',
  ticketing: 'cap.ticketing',
  reservation: 'cap.reservation',
  table_reservation: 'cap.table_reservation',
  crowdfunding: 'cap.crowdfunding',
  reminders: 'cap.reminders',
  chat: 'cap.chat',
  waitlist: 'cap.waitlist',
  queue: 'cap.queue',
  loyalty: 'cap.loyalty',
  invoice: 'cap.invoice',
  waiver: 'cap.waiver',
  class_booking: 'cap.class_booking',
  promo_verification: 'cap.promo_verification',
};

const APPOINTMENT_CATEGORY_KEYS: Record<string, string> = {
  restaurant: 'cap.appointment.restaurant',
  event_services: 'cap.appointment.event_services',
  photographer: 'cap.appointment.photographer',
  gym: 'cap.appointment.gym',
  tutor: 'cap.appointment.tutor',
  coworking: 'cap.appointment.coworking',
  car_wash: 'cap.appointment.car_wash',
};

/** Generic labels for capability selection buttons.
 *  Used by both the bot (server) and dashboard (client).
 *  Custom label overrides the default if provided. */
export function getCapabilityLabel(cap: CapabilityId, category: string, customLabel?: string | null, lang?: string): string {
  if (customLabel) return customLabel;

  // Category-specific appointment labels
  if (cap === 'appointment' && APPOINTMENT_CATEGORY_KEYS[category]) {
    return getFlowCopy(lang, APPOINTMENT_CATEGORY_KEYS[category]);
  }

  const key = CAPABILITY_KEYS[cap];
  if (key) return getFlowCopy(lang, key);

  return cap; // fallback for unknown capabilities
}
