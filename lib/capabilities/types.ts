// ═══════════════════════════════════════════════════════
// Capability Type Definitions
// ═══════════════════════════════════════════════════════

export type CapabilityId = 'scheduling' | 'appointment' | 'payment' | 'ordering' | 'ticketing' | 'reservation' | 'table_reservation' | 'whatsapp_sign' | 'reminders' | 'crowdfunding' | 'reports' | 'queue' | 'feedback' | 'loyalty' | 'chat' | 'waitlist' | 'referral' | 'staff' | 'invoice' | 'survey' | 'poll' | 'giving' | 'broadcast' | 'recurring' | 'auto_reply' | 'membership' | 'estimates' | 'packages' | 'class_booking' | 'multi_location' | 'waiver';

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

  // ── NEW ──
  { id: 'estimates', label: 'Estimates & Quotes', description: 'Send price quotes to customers. They approve and it becomes a booking.', icon: '📋' },
  { id: 'packages', label: 'Session Packages', description: 'Sell multi-session bundles. Customers buy once, redeem over time.', icon: '🎫' },
  { id: 'class_booking', label: 'Class Booking', description: 'Group classes with capacity limits. Customers sign up for available slots.', icon: '👥' },
  { id: 'multi_location', label: 'Multi-Location', description: 'Manage multiple branches. Customers choose their preferred location.', icon: '📍' },
  { id: 'waiver', label: 'Waivers', description: 'Collect liability waivers and release forms before services. Customers sign digitally from their phone.', icon: '📋' },
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

  // ── NEW ──
  estimates: 'free',        // Send price quotes (free to encourage adoption)
  packages: 'growth',       // Session bundles (growth feature)
  class_booking: 'growth',  // Group classes with capacity
  multi_location: 'growth', // Multi-branch management
  waiver: 'growth',         // Liability waivers and release forms
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
// ── Group-based capability defaults ──
// Each category maps to its industry group's default capabilities.
// loyalty and referral are OPT-IN only — never in defaults.

// Group capability sets (DRY helper)
const _BEAUTY: CapabilityId[] = ['appointment', 'payment', 'feedback', 'chat', 'staff', 'broadcast', 'reminders', 'auto_reply', 'packages'];
const _HEALTH: CapabilityId[] = ['appointment', 'payment', 'feedback', 'chat', 'staff', 'queue', 'waitlist', 'reminders', 'reports', 'auto_reply'];
const _FOOD_DINING: CapabilityId[] = ['table_reservation', 'ordering', 'payment', 'feedback', 'chat', 'waitlist', 'broadcast', 'auto_reply'];
const _DELIVERY_RETAIL: CapabilityId[] = ['ordering', 'payment', 'feedback', 'chat', 'broadcast'];
const _HOME_AUTO: CapabilityId[] = ['scheduling', 'payment', 'invoice', 'feedback', 'chat', 'reminders', 'estimates'];
const _PROFESSIONAL: CapabilityId[] = ['appointment', 'scheduling', 'payment', 'invoice', 'feedback', 'chat', 'reminders', 'recurring', 'whatsapp_sign', 'estimates', 'packages'];
const _HOSPITALITY: CapabilityId[] = ['reservation', 'payment', 'feedback', 'chat', 'waitlist', 'staff', 'broadcast', 'survey', 'multi_location'];
const _EVENTS: CapabilityId[] = ['ticketing', 'appointment', 'payment', 'invoice', 'feedback', 'chat', 'broadcast', 'waitlist'];
const _FAITH: CapabilityId[] = ['giving', 'appointment', 'ticketing', 'payment', 'feedback', 'chat', 'broadcast', 'recurring', 'poll', 'crowdfunding'];
const _FITNESS: CapabilityId[] = ['appointment', 'scheduling', 'payment', 'feedback', 'chat', 'recurring', 'membership', 'auto_reply', 'class_booking', 'packages'];
const _TRANSPORT: CapabilityId[] = ['ticketing', 'payment', 'feedback', 'chat'];
const _EDUCATION: CapabilityId[] = ['appointment', 'scheduling', 'payment', 'feedback', 'chat', 'recurring', 'broadcast', 'survey', 'class_booking'];
const _PET: CapabilityId[] = ['appointment', 'scheduling', 'payment', 'feedback', 'chat', 'reminders'];
const _CREATIVE: CapabilityId[] = ['appointment', 'payment', 'invoice', 'whatsapp_sign', 'feedback', 'chat', 'estimates'];
const _REAL_ESTATE: CapabilityId[] = ['appointment', 'payment', 'invoice', 'whatsapp_sign', 'feedback', 'chat', 'broadcast'];
const _GOVERNMENT: CapabilityId[] = ['payment', 'queue', 'feedback', 'chat'];
const _OTHER: CapabilityId[] = ['appointment', 'payment', 'feedback', 'chat'];

export const CATEGORY_DEFAULT_CAPABILITIES: Record<string, CapabilityId[]> = {
  // ── Beauty & Wellness ──
  salon: _BEAUTY,
  barber: _BEAUTY,
  spa: _BEAUTY,
  tattoo: _BEAUTY,
  nail_tech: _BEAUTY,
  mua: _BEAUTY,
  lash_tech: _BEAUTY,
  medspa: _BEAUTY,
  waxing: _BEAUTY,

  // ── Health & Medical ──
  clinic: _HEALTH,
  dental: _HEALTH,
  veterinary: _HEALTH,
  therapy: _HEALTH,
  optician: _HEALTH,
  physiotherapy: _HEALTH,

  // ── Food & Dining ──
  restaurant: _FOOD_DINING,
  cafe: _FOOD_DINING,
  bar: _FOOD_DINING,
  lounge: _FOOD_DINING,
  bakery: _FOOD_DINING,
  catering: _FOOD_DINING,
  food_truck: _FOOD_DINING,

  // ── Delivery & Retail ──
  shop: _DELIVERY_RETAIL,
  food_delivery: _DELIVERY_RETAIL,
  pharmacy: _DELIVERY_RETAIL,
  supermarket: _DELIVERY_RETAIL,
  tailor: _DELIVERY_RETAIL,
  printing: _DELIVERY_RETAIL,

  // ── Home & Auto Services ──
  laundry: _HOME_AUTO,
  car_wash: _HOME_AUTO,
  mechanic: _HOME_AUTO,
  cleaning: _HOME_AUTO,
  plumber: _HOME_AUTO,
  pest_control: _HOME_AUTO,
  handyman: _HOME_AUTO,
  hvac: _HOME_AUTO,
  landscaping: _HOME_AUTO,
  electrician: _HOME_AUTO,

  // ── Professional Services ──
  consultant: _PROFESSIONAL,
  legal: _PROFESSIONAL,
  accounting: _PROFESSIONAL,
  travel_agency: _PROFESSIONAL,
  coworking: _PROFESSIONAL,
  security: _PROFESSIONAL,

  // ── Hospitality ──
  hotel: _HOSPITALITY,
  shortlet: _HOSPITALITY,
  car_rental: _HOSPITALITY,

  // ── Events & Entertainment ──
  events: _EVENTS,
  event_services: _EVENTS,
  cinema: _EVENTS,
  music_studio: _EVENTS,

  // ── Faith & Community ──
  church: _FAITH,
  mosque: _FAITH,
  ngo: _FAITH,
  crowdfunding_org: _FAITH,

  // ── Fitness ──
  gym: _FITNESS,
  yoga: _FITNESS,
  pilates: _FITNESS,
  dance: _FITNESS,
  martial_arts: _FITNESS,
  bootcamp: _FITNESS,

  // ── Transport & Logistics ──
  taxi: _TRANSPORT,
  transport: _TRANSPORT,
  logistics: _TRANSPORT,
  courier: _TRANSPORT,
  moving: _TRANSPORT,
  bus: _TRANSPORT,

  // ── Education & Training ──
  school: _EDUCATION,
  tutor: _EDUCATION,
  driving_school: _EDUCATION,
  language_school: _EDUCATION,
  training_academy: _EDUCATION,
  daycare: _EDUCATION,

  // ── Pet Services ──
  pet_grooming: _PET,
  dog_walking: _PET,
  pet_boarding: _PET,
  pet_training: _PET,

  // ── Creative & Media ──
  photographer: _CREATIVE,
  videographer: _CREATIVE,
  dj: _CREATIVE,
  graphic_designer: _CREATIVE,
  content_creator: _CREATIVE,

  // ── Real Estate & Property ──
  real_estate: _REAL_ESTATE,
  property_manager: _REAL_ESTATE,
  mortgage_broker: _REAL_ESTATE,

  // ── Government & Public ──
  government: _GOVERNMENT,
  car_park: _GOVERNMENT,

  // ── Other ──
  funeral: _OTHER,
  other: _OTHER,
};
