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
];

/** Get manifest entries for a specific flow type */
export function getManifestForFlow(flowType: string): StepManifestEntry[] {
  return STEP_MANIFEST.filter(e => e.flowType === flowType);
}

/** Get all unique flow types from the manifest */
export function getManifestFlowTypes(): string[] {
  return [...new Set(STEP_MANIFEST.map(e => e.flowType))];
}
