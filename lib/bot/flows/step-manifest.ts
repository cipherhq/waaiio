export interface StepManifestEntry {
  flowType: string;
  stepId: string;
  label: string;
  description: string;
  isOptional: boolean;
  promptType: 'text' | 'buttons' | 'list';
}

export const STEP_MANIFEST: StepManifestEntry[] = [
  // Scheduling
  { flowType: 'scheduling', stepId: 'select_service', label: 'Select Service', description: 'Customer picks which service they want', isOptional: false, promptType: 'list' },
  { flowType: 'scheduling', stepId: 'select_staff', label: 'Select Staff', description: 'Customer picks a specific staff member', isOptional: true, promptType: 'buttons' },
  { flowType: 'scheduling', stepId: 'select_date', label: 'Select Date', description: 'Customer picks a date for the booking', isOptional: false, promptType: 'buttons' },
  { flowType: 'scheduling', stepId: 'select_time', label: 'Select Time', description: 'Customer picks a time slot', isOptional: false, promptType: 'list' },
  { flowType: 'scheduling', stepId: 'select_quantity', label: 'Select Quantity', description: 'Number of guests / party size', isOptional: true, promptType: 'buttons' },
  { flowType: 'scheduling', stepId: 'special_requests', label: 'Special Requests', description: 'Optional notes or special requirements', isOptional: true, promptType: 'buttons' },
  { flowType: 'scheduling', stepId: 'book_for_other', label: 'Book for Someone Else', description: 'Option to book on behalf of another person', isOptional: true, promptType: 'buttons' },
  { flowType: 'scheduling', stepId: 'collect_other_name', label: 'Other Person Name', description: 'Name of the person being booked for', isOptional: true, promptType: 'text' },
  { flowType: 'scheduling', stepId: 'confirmation', label: 'Confirmation', description: 'Review and confirm booking details', isOptional: false, promptType: 'buttons' },
  { flowType: 'scheduling', stepId: 'collect_name', label: 'Collect Name', description: 'Ask for customer full name', isOptional: false, promptType: 'text' },
  { flowType: 'scheduling', stepId: 'collect_email', label: 'Collect Email', description: 'Ask for customer email address', isOptional: true, promptType: 'text' },
  // Ordering
  { flowType: 'ordering', stepId: 'browse_catalog', label: 'Browse Catalog', description: 'Customer browses available products', isOptional: false, promptType: 'list' },
  { flowType: 'ordering', stepId: 'select_product', label: 'Select Product', description: 'Customer selects a specific product', isOptional: false, promptType: 'buttons' },
  { flowType: 'ordering', stepId: 'select_quantity', label: 'Select Quantity', description: 'Choose how many to order', isOptional: false, promptType: 'buttons' },
  { flowType: 'ordering', stepId: 'collect_address', label: 'Delivery Address', description: 'Collect delivery address for the order', isOptional: true, promptType: 'text' },
  { flowType: 'ordering', stepId: 'order_confirmation', label: 'Order Confirmation', description: 'Review and confirm order', isOptional: false, promptType: 'buttons' },
  // Payment
  { flowType: 'payment', stepId: 'select_category', label: 'Select Category', description: 'Choose payment category', isOptional: false, promptType: 'list' },
  { flowType: 'payment', stepId: 'enter_amount', label: 'Enter Amount', description: 'Customer enters payment amount', isOptional: false, promptType: 'text' },
  { flowType: 'payment', stepId: 'payment_confirmation', label: 'Payment Confirmation', description: 'Review and confirm payment', isOptional: false, promptType: 'buttons' },
  // Ticketing
  { flowType: 'ticketing', stepId: 'select_event', label: 'Select Event', description: 'Choose which event to attend', isOptional: false, promptType: 'list' },
  { flowType: 'ticketing', stepId: 'select_ticket_type', label: 'Ticket Type', description: 'Choose ticket tier (VIP, Regular, etc.)', isOptional: false, promptType: 'buttons' },
  { flowType: 'ticketing', stepId: 'select_quantity', label: 'Number of Tickets', description: 'How many tickets to purchase', isOptional: false, promptType: 'buttons' },
  // Reservation
  { flowType: 'reservation', stepId: 'select_apartment', label: 'Select Apartment', description: 'Customer picks which apartment or unit', isOptional: false, promptType: 'list' },
  { flowType: 'reservation', stepId: 'select_checkin', label: 'Check-in Date', description: 'Customer picks a check-in date', isOptional: false, promptType: 'buttons' },
  { flowType: 'reservation', stepId: 'select_checkout', label: 'Check-out Date', description: 'Customer picks a check-out date', isOptional: false, promptType: 'buttons' },
  { flowType: 'reservation', stepId: 'select_guests', label: 'Number of Guests', description: 'How many guests will be staying', isOptional: false, promptType: 'buttons' },
  { flowType: 'reservation', stepId: 'special_requests', label: 'Special Requests', description: 'Optional notes or special requirements', isOptional: true, promptType: 'text' },
  { flowType: 'reservation', stepId: 'reservation_confirmation', label: 'Reservation Confirmation', description: 'Review and confirm reservation details', isOptional: false, promptType: 'buttons' },
  { flowType: 'reservation', stepId: 'collect_name', label: 'Collect Name', description: 'Ask for guest full name', isOptional: false, promptType: 'text' },
  { flowType: 'reservation', stepId: 'collect_email', label: 'Collect Email', description: 'Ask for guest email address', isOptional: true, promptType: 'text' },
  { flowType: 'reservation', stepId: 'create_reservation', label: 'Create Reservation', description: 'System creates the reservation record', isOptional: false, promptType: 'buttons' },
  { flowType: 'reservation', stepId: 'reservation_payment', label: 'Reservation Payment', description: 'Collect payment for the reservation', isOptional: true, promptType: 'buttons' },
  // Queue
  { flowType: 'queue', stepId: 'queue_start', label: 'Join Queue', description: 'Customer initiates queue check-in', isOptional: false, promptType: 'buttons' },
  { flowType: 'queue', stepId: 'queue_collect_name', label: 'Collect Name', description: 'Ask for customer name for the queue', isOptional: false, promptType: 'text' },
  { flowType: 'queue', stepId: 'queue_confirm_checkin', label: 'Confirm Check-in', description: 'Confirm the customer has been added to the queue', isOptional: false, promptType: 'buttons' },
  { flowType: 'queue', stepId: 'queue_check_status', label: 'Check Status', description: 'Customer checks their queue position', isOptional: true, promptType: 'buttons' },
  // Crowdfunding
  { flowType: 'crowdfunding', stepId: 'select_campaign', label: 'Select Campaign', description: 'Customer picks a campaign to support', isOptional: false, promptType: 'list' },
  { flowType: 'crowdfunding', stepId: 'campaign_view', label: 'Campaign Details', description: 'View campaign description, goal, and progress', isOptional: false, promptType: 'buttons' },
  { flowType: 'crowdfunding', stepId: 'enter_donation_amount', label: 'Donation Amount', description: 'Customer enters how much to donate', isOptional: false, promptType: 'text' },
  { flowType: 'crowdfunding', stepId: 'confirm_donation', label: 'Confirm Donation', description: 'Review and confirm donation details', isOptional: false, promptType: 'buttons' },
  { flowType: 'crowdfunding', stepId: 'donation_payment', label: 'Donation Payment', description: 'Process the donation payment', isOptional: false, promptType: 'buttons' },
  // Feedback
  { flowType: 'feedback', stepId: 'feedback_rating', label: 'Rating', description: 'Customer rates the service', isOptional: false, promptType: 'buttons' },
  { flowType: 'feedback', stepId: 'feedback_comment', label: 'Comment', description: 'Customer leaves an optional comment', isOptional: true, promptType: 'text' },
  { flowType: 'feedback', stepId: 'feedback_thanks', label: 'Thank You', description: 'Thank the customer for their feedback', isOptional: false, promptType: 'buttons' },
  // Waitlist
  { flowType: 'waitlist', stepId: 'waitlist_join', label: 'Join Waitlist', description: 'Customer requests to join the waitlist', isOptional: false, promptType: 'buttons' },
  { flowType: 'waitlist', stepId: 'waitlist_collect_name', label: 'Collect Name', description: 'Ask for customer name for the waitlist', isOptional: false, promptType: 'text' },
  { flowType: 'waitlist', stepId: 'waitlist_confirm', label: 'Waitlist Confirmation', description: 'Confirm the customer has been added to the waitlist', isOptional: false, promptType: 'buttons' },
  // Chat
  { flowType: 'chat', stepId: 'chat_start', label: 'Start Chat', description: 'Initiate a two-way chat session with staff', isOptional: false, promptType: 'buttons' },
  // Loyalty
  { flowType: 'loyalty', stepId: 'loyalty_menu', label: 'Loyalty Menu', description: 'Customer views loyalty program options', isOptional: false, promptType: 'buttons' },
  { flowType: 'loyalty', stepId: 'loyalty_history', label: 'Points History', description: 'View earned and redeemed points', isOptional: true, promptType: 'list' },
  { flowType: 'loyalty', stepId: 'loyalty_redeem', label: 'Redeem Points', description: 'Customer redeems loyalty points for a reward', isOptional: true, promptType: 'buttons' },
  // Invoice
  { flowType: 'invoice', stepId: 'invoice_list', label: 'Invoice List', description: 'Customer views outstanding invoices', isOptional: false, promptType: 'list' },
  { flowType: 'invoice', stepId: 'invoice_detail', label: 'Invoice Detail', description: 'View full invoice breakdown', isOptional: false, promptType: 'buttons' },
  { flowType: 'invoice', stepId: 'invoice_pay', label: 'Pay Invoice', description: 'Process payment for the invoice', isOptional: false, promptType: 'buttons' },
];

/** Get manifest entries for a specific flow type */
export function getManifestForFlow(flowType: string): StepManifestEntry[] {
  return STEP_MANIFEST.filter(e => e.flowType === flowType);
}

/** Get all unique flow types from the manifest */
export function getManifestFlowTypes(): string[] {
  return [...new Set(STEP_MANIFEST.map(e => e.flowType))];
}
