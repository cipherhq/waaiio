import type { CapabilityId } from './types';

/** Generic labels for capability selection buttons.
 *  Used by both the bot (server) and dashboard (client).
 *  Custom label overrides the default if provided. */
export function getCapabilityLabel(cap: CapabilityId, category: string, customLabel?: string | null): string {
  if (customLabel) return customLabel;
  switch (cap) {
    case 'scheduling':
      return 'Our Services';
    case 'appointment': {
      const bookingLabels: Record<string, string> = {
        restaurant: 'Book a Table',
        event_services: 'Book a Service',
        photographer: 'Book a Session',
        gym: 'Book a Session',
        tutor: 'Book a Session',
        coworking: 'Book a Space',
        car_wash: 'Book a Wash',
      };
      return bookingLabels[category] || 'Book Appointment';
    }
    case 'giving':
      return 'Give';
    case 'payment':
      return 'Make Payment';
    case 'ordering':
      return 'Place an Order';
    case 'ticketing':
      return 'Buy Tickets';
    case 'reservation':
      return 'Book a Stay';
    case 'table_reservation':
      return 'Make a Reservation';
    case 'crowdfunding':
      return 'Support a Campaign';
    case 'reminders':
      return 'My Reminders';
    case 'chat':
      return 'Chat with Us';
    case 'waitlist':
      return 'Join Waitlist';
    case 'queue':
      return 'Join Queue';
    case 'loyalty':
      return 'My Rewards';
    case 'invoice':
      return 'My Invoices';
    default:
      return cap;
  }
}
