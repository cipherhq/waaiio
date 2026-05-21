// ═══════════════════════════════════════════════════════
// Capability Type Definitions
// ═══════════════════════════════════════════════════════

export type CapabilityId = 'scheduling' | 'appointment' | 'payment' | 'ordering' | 'ticketing' | 'reservation' | 'table_reservation' | 'whatsapp_sign' | 'reminders' | 'crowdfunding' | 'reports' | 'queue' | 'feedback' | 'loyalty' | 'chat' | 'waitlist' | 'referral' | 'staff' | 'invoice' | 'survey' | 'poll' | 'giving' | 'broadcast' | 'recurring' | 'auto_reply' | 'membership';

export interface CapabilityDefinition {
  id: CapabilityId;
  label: string;
  description: string;
  icon: string;
}

export const CAPABILITIES: CapabilityDefinition[] = [
  // ── FREE ──
  { id: 'appointment', label: 'Appointments', description: 'Customers pick a date, time, and staff member to book with you. You get notified instantly.', icon: '📅' },
  { id: 'scheduling', label: 'Services', description: 'Customers request services without choosing a specific time. You handle the scheduling.', icon: '🛎️' },
  { id: 'payment', label: 'Payments', description: 'Send payment links via WhatsApp. Customers tap and pay instantly. Works with Paystack, Stripe, and Flutterwave.', icon: '💳' },
  { id: 'ordering', label: 'Online Store', description: 'Customers browse your menu or catalog, add items to cart, and place orders — all on WhatsApp.', icon: '🛒' },
  { id: 'ticketing', label: 'Ticketing', description: 'Sell tickets to events with QR code check-in. Supports multiple ticket types (Regular, VIP, etc.).', icon: '🎟️' },
  { id: 'giving', label: 'Giving', description: 'Accept tithes, offerings, and donations via WhatsApp. Track donors and amounts automatically.', icon: '🙏' },
  { id: 'chat', label: 'Chat', description: 'Live two-way messaging. When the bot can\'t help, customers chat with your team directly.', icon: '💬' },
  { id: 'feedback', label: 'Reviews', description: 'Automatically ask customers for ratings after every booking or order. Track your star rating.', icon: '⭐' },
  { id: 'poll', label: 'Polls', description: 'Create quick polls and let customers vote via WhatsApp. See live results with visual charts.', icon: '🗳️' },

  // ── PRO (Growth) ──
  { id: 'reservation', label: 'Reservations', description: 'Property bookings with check-in/out dates. For hotels, Airbnb, shortlets, and car rentals.', icon: '🏘️' },
  { id: 'table_reservation', label: 'Table Reservations', description: 'Let customers reserve tables for dining with date, time, and party size.', icon: '🍽️' },
  { id: 'recurring', label: 'Subscriptions', description: 'Auto-charge customers weekly or monthly. They can manage their own subscriptions via WhatsApp.', icon: '🔄' },
  { id: 'broadcast', label: 'Broadcasts', description: 'Send promotions, updates, and announcements to all your customers at once via WhatsApp.', icon: '📢' },
  { id: 'membership', label: 'Membership', description: 'Create Bronze/Silver/Gold tiers. Customers auto-upgrade based on spending and get discounts.', icon: '🏅' },
  { id: 'survey', label: 'Surveys', description: 'Build custom surveys with multiple question types. Send via WhatsApp and track all responses.', icon: '📊' },
  { id: 'invoice', label: 'Invoices', description: 'Create professional invoices with line items. Send via WhatsApp with a one-click payment link.', icon: '🧾' },
  { id: 'auto_reply', label: 'Auto-Reply', description: 'Set business hours and an away message. Customers who message after hours get an instant reply.', icon: '🤖' },
  { id: 'loyalty', label: 'Loyalty', description: 'Points program for repeat customers. Earn points per visit, redeem for rewards or discounts.', icon: '🏆' },
  { id: 'referral', label: 'Referral', description: 'Customers share a link, new customer books, both get rewarded. Word-of-mouth on autopilot.', icon: '🤝' },
  { id: 'reminders', label: 'Reminders', description: 'Automatic booking and payment reminders sent via WhatsApp. Reduce no-shows by up to 60%.', icon: '🔔' },

  // ── PREMIUM (Business) ──
  { id: 'staff', label: 'Staff', description: 'Assign team members to services, set work schedules, auto-balance bookings. Staff get WhatsApp notifications.', icon: '👥' },
  { id: 'whatsapp_sign', label: 'E-Signatures', description: 'Send contracts for digital signature via WhatsApp. Customers review and sign from their phone.', icon: '✍️' },
  { id: 'reports', label: 'Documents', description: 'Upload and share documents with specific customers via WhatsApp. Phone verification for security.', icon: '📄' },
  { id: 'waitlist', label: 'Waitlist', description: 'When you\'re fully booked, customers join a waitlist. Auto-notified when a slot opens up.', icon: '📝' },
  { id: 'queue', label: 'Queue', description: 'Walk-in customers check in via WhatsApp, see their position, and get notified when it\'s their turn.', icon: '📋' },
  { id: 'crowdfunding', label: 'Campaigns', description: 'Run fundraising campaigns with goals and progress tracking. Track every donor and amount.', icon: '❤️' },
];

export const CAPABILITY_MAP: Record<CapabilityId, CapabilityDefinition> = Object.fromEntries(
  CAPABILITIES.map(c => [c.id, c])
) as Record<CapabilityId, CapabilityDefinition>;

// ── Tier Gating ──
// Minimum tier required to enable each capability.
// Admin-granted overrides can bypass tier requirements for individual businesses.

type SubscriptionTier = 'free' | 'growth' | 'business';

export const CAPABILITY_TIER_REQUIREMENTS: Record<CapabilityId, SubscriptionTier> = {
  // ── FREE: Basics to get started ──
  appointment: 'free',    // Book appointments with date/time/staff
  scheduling: 'free',     // On-demand services (laundry, repairs, etc.)
  payment: 'free',        // Collect payments via WhatsApp
  ordering: 'free',       // Product catalog + cart + checkout
  ticketing: 'free',      // Event tickets with QR check-in
  giving: 'free',         // Tithes, offerings, donations
  chat: 'free',           // Live two-way messaging with customers
  feedback: 'free',       // Auto-collect ratings after service
  poll: 'free',           // Quick polls and voting (no revenue value)

  // ── PRO (Growth): Tools to grow and engage ──
  reservation: 'growth',  // Property/room bookings with check-in/out
  table_reservation: 'free',  // Restaurant table reservations
  recurring: 'growth',    // Auto-charge subscriptions (gym, church, etc.)
  broadcast: 'growth',    // Send promos to all customers at once
  membership: 'growth',   // VIP tiers based on spending
  survey: 'growth',       // Custom surveys with response tracking
  invoice: 'growth',      // Professional invoices with payment links
  auto_reply: 'growth',   // Business hours + away message
  loyalty: 'growth',      // Points program for repeat customers
  referral: 'growth',     // Referral rewards for word-of-mouth
  reminders: 'growth',    // Auto booking/payment reminders

  // ── PREMIUM (Business): Scale and operations ──
  staff: 'business',      // Multi-staff scheduling + notifications
  whatsapp_sign: 'business', // Digital contract signatures via WhatsApp
  reports: 'business',    // Upload and share documents securely
  waitlist: 'business',   // Auto-manage waitlists when fully booked
  queue: 'business',      // Walk-in queue with turn notifications
  crowdfunding: 'business', // Campaigns with goals + donor tracking (cash cow)
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
  growth: 'Pro',
  business: 'Premium',
};

/** Default capabilities for each business category.
 * loyalty and referral are OPT-IN — businesses enable them manually from dashboard.
 * They are NOT included in category defaults. */
export const CATEGORY_DEFAULT_CAPABILITIES: Record<string, CapabilityId[]> = {
  restaurant: ['table_reservation', 'ordering', 'feedback', 'chat', 'waitlist', 'staff', 'broadcast', 'auto_reply'],
  barber: ['appointment', 'feedback', 'chat', 'staff', 'broadcast', 'auto_reply'],
  spa: ['appointment', 'feedback', 'chat', 'waitlist', 'staff', 'broadcast', 'auto_reply', 'membership'],
  salon: ['appointment', 'feedback', 'chat', 'staff', 'broadcast', 'auto_reply'],
  gym: ['appointment', 'feedback', 'chat', 'recurring', 'membership', 'auto_reply'],
  clinic: ['appointment', 'reports', 'queue', 'feedback', 'chat', 'waitlist', 'staff', 'survey', 'auto_reply'],
  consultant: ['appointment', 'feedback', 'chat', 'survey', 'recurring', 'auto_reply'],
  church: ['giving', 'appointment', 'ticketing', 'feedback', 'chat', 'broadcast', 'recurring', 'poll'],
  mosque: ['giving', 'appointment', 'ticketing', 'feedback', 'chat', 'broadcast', 'recurring', 'poll'],
  school: ['payment', 'feedback', 'chat', 'survey', 'broadcast', 'recurring'],
  ngo: ['payment', 'feedback', 'chat', 'survey'],
  shop: ['ordering', 'feedback', 'chat'],
  food_delivery: ['ordering', 'feedback'],
  events: ['ticketing', 'feedback', 'waitlist'],
  event_services: ['appointment', 'payment', 'invoice', 'chat', 'feedback'],
  transport: ['ticketing', 'feedback'],
  cinema: ['ticketing', 'feedback', 'waitlist'],
  car_park: ['payment', 'feedback'],
  tattoo: ['appointment', 'payment', 'feedback', 'chat', 'staff'],
  real_estate: ['appointment', 'payment', 'whatsapp_sign', 'feedback', 'chat'],
  travel_agency: ['appointment', 'payment', 'ticketing', 'feedback', 'chat'],
  logistics: ['ordering', 'payment', 'feedback', 'chat'],
  taxi: ['payment', 'feedback'],
  government: ['payment', 'feedback'],
  instagram_vendor: ['ordering', 'feedback', 'chat'],
  crowdfunding_org: ['crowdfunding', 'payment'],
  laundry: ['scheduling', 'ordering', 'feedback', 'chat'],
  veterinary: ['appointment', 'payment', 'reports', 'feedback', 'chat', 'waitlist', 'staff'],
  dental: ['appointment', 'payment', 'reminders', 'reports', 'queue', 'feedback', 'chat', 'waitlist', 'staff'],
  coworking: ['appointment', 'payment', 'feedback', 'chat'],
  tutor: ['appointment', 'payment', 'feedback', 'chat'],
  photographer: ['appointment', 'payment', 'feedback', 'chat', 'staff'],
  mall_vendor: ['payment', 'ordering', 'feedback', 'chat'],
  pharmacy: ['ordering', 'payment', 'feedback', 'chat'],
  hotel: ['reservation', 'payment', 'feedback', 'chat', 'waitlist', 'staff', 'survey'],
  car_wash: ['appointment', 'payment', 'feedback', 'chat'],
  catering: ['ordering', 'payment', 'feedback', 'chat'],
  funeral: ['payment', 'feedback', 'chat'],
  tailor: ['ordering', 'payment', 'feedback', 'chat'],
  shortlet: ['reservation', 'payment', 'feedback', 'chat'],
  nail_tech: ['appointment', 'payment', 'feedback', 'chat', 'staff'],
  mua: ['appointment', 'payment', 'feedback', 'chat', 'invoice'],
  pet_grooming: ['appointment', 'payment', 'feedback', 'chat'],
  therapy: ['appointment', 'payment', 'chat', 'reminders'],
  bakery: ['ordering', 'payment', 'feedback', 'chat'],
  mechanic: ['appointment', 'payment', 'invoice', 'chat'],
  cleaning: ['appointment', 'payment', 'invoice', 'chat'],
  plumber: ['appointment', 'payment', 'invoice', 'chat'],
  pest_control: ['appointment', 'payment', 'invoice', 'chat'],
  driving_school: ['appointment', 'payment', 'feedback', 'chat'],
  music_studio: ['appointment', 'payment', 'feedback', 'chat', 'staff'],
  legal: ['appointment', 'payment', 'invoice', 'chat'],
  daycare: ['payment', 'reminders', 'chat'],
  printing: ['ordering', 'payment', 'invoice', 'chat'],
  car_rental: ['reservation', 'payment', 'invoice', 'chat'],
  supermarket: ['ordering', 'payment', 'chat'],
  security: ['appointment', 'scheduling', 'payment', 'invoice', 'chat'],
  accounting: ['appointment', 'scheduling', 'payment', 'invoice', 'chat'],
  other: ['appointment', 'feedback', 'chat'],
};
