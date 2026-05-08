// ═══════════════════════════════════════════════════════
// Capability Type Definitions
// ═══════════════════════════════════════════════════════

export type CapabilityId = 'scheduling' | 'appointment' | 'payment' | 'ordering' | 'ticketing' | 'reservation' | 'whatsapp_sign' | 'reminders' | 'crowdfunding' | 'reports' | 'queue' | 'feedback' | 'loyalty' | 'chat' | 'waitlist' | 'referral' | 'staff' | 'invoice' | 'survey' | 'poll' | 'giving';

export interface CapabilityDefinition {
  id: CapabilityId;
  label: string;
  description: string;
  icon: string;
}

export const CAPABILITIES: CapabilityDefinition[] = [
  { id: 'appointment', label: 'Appointments', description: 'Calendar-based bookings with date, time, and staff assignment', icon: '📅' },
  { id: 'scheduling', label: 'Services', description: 'On-demand services like laundry, printing, and repairs', icon: '🛎️' },
  { id: 'payment', label: 'Payments', description: 'Collect payments, tithes, fees, and donations', icon: '💳' },
  { id: 'ordering', label: 'Online Store', description: 'Product catalog, cart, and order management', icon: '🛒' },
  { id: 'ticketing', label: 'Ticketing', description: 'Sell event tickets and manage attendance', icon: '🎟️' },
  { id: 'reservation', label: 'Reservations', description: 'Duration-based stay bookings with check-in/out dates', icon: '🏘️' },
  { id: 'whatsapp_sign', label: 'WhatsApp Sign', description: 'Send documents for e-signature via WhatsApp', icon: '✍️' },
  { id: 'reminders', label: 'Reminders', description: 'Automated appointment and payment reminders', icon: '🔔' },
  { id: 'crowdfunding', label: 'Crowdfunding', description: 'Run campaigns with goals and donor tracking', icon: '❤️' },
  { id: 'reports', label: 'Document Share', description: 'Upload and share documents with customers via WhatsApp', icon: '📄' },
  { id: 'queue', label: 'Queue', description: 'Customer check-in, queue management, and turn notifications', icon: '📋' },
  { id: 'feedback', label: 'Feedback', description: 'Collect customer ratings and reviews after service', icon: '⭐' },
  { id: 'loyalty', label: 'Loyalty', description: 'Points-based loyalty program for repeat customers', icon: '🏆' },
  { id: 'chat', label: 'Chat', description: 'Two-way messaging between staff and customers', icon: '💬' },
  { id: 'waitlist', label: 'Waitlist', description: 'Waitlist management for fully-booked services or events', icon: '📝' },
  { id: 'referral', label: 'Referral', description: 'Customer referral program with reward tracking', icon: '🤝' },
  { id: 'staff', label: 'Staff', description: 'Staff management with service assignments and scheduling', icon: '👥' },
  { id: 'invoice', label: 'Invoices', description: 'Create and send invoices with online payment links', icon: '🧾' },
  { id: 'survey', label: 'Surveys', description: 'Create and send customer surveys via WhatsApp', icon: '📊' },
  { id: 'poll', label: 'Polls', description: 'Quick polls and voting via WhatsApp', icon: '🗳️' },
  { id: 'giving', label: 'Giving', description: 'Collect tithes, offerings, and donations via WhatsApp', icon: '🙏' },
];

export const CAPABILITY_MAP: Record<CapabilityId, CapabilityDefinition> = Object.fromEntries(
  CAPABILITIES.map(c => [c.id, c])
) as Record<CapabilityId, CapabilityDefinition>;

// ── Tier Gating ──
// Minimum tier required to enable each capability.
// Admin-granted overrides can bypass tier requirements for individual businesses.

type SubscriptionTier = 'free' | 'growth' | 'business';

export const CAPABILITY_TIER_REQUIREMENTS: Record<CapabilityId, SubscriptionTier> = {
  appointment: 'free',
  scheduling: 'free',
  payment: 'free',
  ordering: 'free',
  ticketing: 'free',
  feedback: 'free',
  chat: 'free',
  reservation: 'growth',
  reminders: 'growth',
  loyalty: 'growth',
  referral: 'growth',
  whatsapp_sign: 'business',
  queue: 'business',
  waitlist: 'business',
  reports: 'business',
  staff: 'business',
  crowdfunding: 'free',
  invoice: 'business',
  survey: 'growth',
  poll: 'growth',
  giving: 'free',
};

const TIER_RANK: Record<SubscriptionTier, number> = { free: 0, growth: 1, business: 2 };

/**
 * Get the minimum tier required for a capability.
 */
export function getRequiredTier(capId: CapabilityId): SubscriptionTier {
  return CAPABILITY_TIER_REQUIREMENTS[capId];
}

/**
 * Check if a business's current tier (or admin overrides) allow enabling a capability.
 */
export function canEnableCapability(
  capId: CapabilityId,
  currentTier: SubscriptionTier,
  overrides?: CapabilityId[],
): boolean {
  if (overrides?.includes(capId)) return true;
  return TIER_RANK[currentTier] >= TIER_RANK[CAPABILITY_TIER_REQUIREMENTS[capId]];
}

/** Human-readable tier label */
export const TIER_LABELS: Record<SubscriptionTier, string> = {
  free: 'Free',
  growth: 'Growth',
  business: 'Business',
};

/** Default capabilities for each business category */
export const CATEGORY_DEFAULT_CAPABILITIES: Record<string, CapabilityId[]> = {
  restaurant: ['appointment', 'reservation', 'ordering', 'feedback', 'loyalty', 'chat', 'waitlist', 'referral', 'staff'],
  barber: ['appointment', 'feedback', 'loyalty', 'chat', 'referral', 'staff'],
  spa: ['appointment', 'feedback', 'loyalty', 'chat', 'waitlist', 'referral', 'staff'],
  salon: ['appointment', 'feedback', 'loyalty', 'chat', 'referral', 'staff'],
  gym: ['appointment', 'feedback', 'loyalty', 'chat', 'referral'],
  clinic: ['appointment', 'reports', 'queue', 'feedback', 'chat', 'waitlist', 'staff', 'survey'],
  consultant: ['appointment', 'feedback', 'chat', 'referral', 'survey'],
  church: ['giving', 'appointment', 'ticketing', 'feedback', 'chat'],
  mosque: ['giving', 'appointment', 'ticketing', 'feedback', 'chat'],
  school: ['payment', 'feedback', 'chat', 'survey'],
  ngo: ['payment', 'feedback', 'chat', 'referral', 'survey'],
  shop: ['ordering', 'feedback', 'loyalty', 'chat', 'referral'],
  food_delivery: ['ordering', 'feedback', 'loyalty', 'referral'],
  events: ['ticketing', 'feedback', 'waitlist', 'referral'],
  event_services: ['appointment', 'payment', 'invoice', 'chat', 'feedback', 'referral'],
  transport: ['ticketing', 'feedback'],
  cinema: ['ticketing', 'feedback', 'waitlist', 'loyalty'],
  car_park: ['payment', 'feedback'],
  tattoo: ['appointment', 'payment', 'feedback', 'loyalty', 'chat', 'staff'],
  real_estate: ['appointment', 'payment', 'whatsapp_sign', 'feedback', 'chat', 'referral'],
  travel_agency: ['appointment', 'payment', 'ticketing', 'feedback', 'chat', 'referral'],
  logistics: ['ordering', 'payment', 'feedback', 'chat'],
  taxi: ['payment', 'feedback', 'referral'],
  government: ['payment', 'feedback'],
  instagram_vendor: ['ordering', 'feedback', 'loyalty', 'chat', 'referral'],
  crowdfunding_org: ['crowdfunding', 'payment', 'referral'],
  laundry: ['scheduling', 'ordering', 'feedback', 'loyalty', 'chat', 'referral'],
  veterinary: ['appointment', 'payment', 'reports', 'feedback', 'chat', 'waitlist', 'staff'],
  dental: ['appointment', 'payment', 'reminders', 'reports', 'queue', 'feedback', 'chat', 'waitlist', 'staff'],
  coworking: ['appointment', 'payment', 'feedback', 'loyalty', 'chat', 'referral'],
  tutor: ['appointment', 'payment', 'feedback', 'chat', 'referral'],
  photographer: ['appointment', 'payment', 'feedback', 'chat', 'referral', 'staff'],
  mall_vendor: ['payment', 'ordering', 'feedback', 'loyalty', 'chat'],
  pharmacy: ['ordering', 'payment', 'feedback', 'loyalty', 'chat'],
  hotel: ['reservation', 'payment', 'feedback', 'loyalty', 'chat', 'waitlist', 'referral', 'staff', 'survey'],
  car_wash: ['appointment', 'payment', 'feedback', 'loyalty', 'chat', 'referral'],
  catering: ['ordering', 'payment', 'feedback', 'chat', 'referral'],
  funeral: ['payment', 'feedback', 'chat'],
  tailor: ['ordering', 'payment', 'feedback', 'loyalty', 'chat'],
  shortlet: ['reservation', 'payment', 'feedback', 'chat'],
  nail_tech: ['appointment', 'payment', 'feedback', 'loyalty', 'chat', 'referral', 'staff'],
  mua: ['appointment', 'payment', 'feedback', 'chat', 'referral', 'invoice'],
  pet_grooming: ['appointment', 'payment', 'feedback', 'loyalty', 'chat', 'referral'],
  therapy: ['appointment', 'payment', 'chat', 'reminders'],
  bakery: ['ordering', 'payment', 'feedback', 'chat', 'referral'],
  mechanic: ['appointment', 'payment', 'invoice', 'chat'],
  cleaning: ['appointment', 'payment', 'invoice', 'chat', 'referral'],
  plumber: ['appointment', 'payment', 'invoice', 'chat'],
  pest_control: ['appointment', 'payment', 'invoice', 'chat'],
  driving_school: ['appointment', 'payment', 'feedback', 'chat'],
  music_studio: ['appointment', 'payment', 'feedback', 'loyalty', 'chat', 'staff'],
  legal: ['appointment', 'payment', 'invoice', 'chat'],
  daycare: ['payment', 'reminders', 'chat'],
  printing: ['ordering', 'payment', 'invoice', 'chat'],
  car_rental: ['reservation', 'payment', 'invoice', 'chat'],
  supermarket: ['ordering', 'payment', 'chat'],
  security: ['appointment', 'scheduling', 'payment', 'invoice', 'chat'],
  accounting: ['appointment', 'scheduling', 'payment', 'invoice', 'chat'],
  other: ['appointment', 'feedback', 'chat'],
};
