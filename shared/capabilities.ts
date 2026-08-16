/**
 * Canonical Capability Catalog
 *
 * ONE authoritative source for capability IDs, labels, tiers, icons, and descriptions.
 * Consumed by both the root Next.js app and the Admin Vite app.
 *
 * Framework-neutral — no React, Next.js, or Vite imports.
 * Do NOT duplicate this data elsewhere.
 */

// ── Types ──

export type CapabilityId =
  | 'scheduling' | 'appointment' | 'payment' | 'ordering' | 'ticketing'
  | 'reservation' | 'table_reservation' | 'whatsapp_sign' | 'reminders'
  | 'crowdfunding' | 'reports' | 'queue' | 'feedback' | 'loyalty'
  | 'chat' | 'waitlist' | 'referral' | 'staff' | 'invoice' | 'survey'
  | 'poll' | 'giving' | 'broadcast' | 'recurring' | 'auto_reply'
  | 'membership' | 'estimates' | 'packages' | 'class_booking'
  | 'multi_location' | 'waiver' | 'promo_verification';

export type SubscriptionTier = 'free' | 'growth' | 'business';

export interface CapabilityDefinition {
  id: CapabilityId;
  label: string;
  description: string;
  icon: string;
}

// ── User-facing plan labels ──
// DB stores: free, growth, business
// Customers see: Free, Pro, Premium

export const PLAN_LABELS: Record<SubscriptionTier, string> = {
  free: 'Free',
  growth: 'Pro',
  business: 'Premium',
};

// ── Canonical capabilities ──

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
  { id: 'membership', label: 'Loyalty Tiers', description: 'Create Bronze/Silver/Gold tiers. Customers auto-upgrade based on spending and get discounts.', icon: '🏅' },
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
  { id: 'promo_verification', label: 'Promotions', description: 'Run WhatsApp-based consumer promotions with unique codes on products, packaging, or scratch cards. Instant verification and prize claiming.', icon: '🎰' },
];

// ── Tier requirements ──

export const CAPABILITY_TIER_REQUIREMENTS: Record<CapabilityId, SubscriptionTier> = {
  // FREE
  appointment: 'free',
  scheduling: 'free',
  payment: 'free',
  ordering: 'free',
  ticketing: 'free',
  giving: 'free',
  chat: 'free',
  feedback: 'free',
  poll: 'free',

  // PRO (Growth)
  reservation: 'growth',
  table_reservation: 'free',
  recurring: 'growth',
  broadcast: 'growth',
  membership: 'growth',
  survey: 'growth',
  invoice: 'growth',
  auto_reply: 'growth',
  loyalty: 'growth',
  referral: 'growth',
  reminders: 'growth',

  // PREMIUM (Business)
  staff: 'business',
  whatsapp_sign: 'business',
  reports: 'business',
  waitlist: 'business',
  queue: 'business',
  crowdfunding: 'business',

  // NEW
  estimates: 'free',
  packages: 'growth',
  class_booking: 'growth',
  multi_location: 'growth',
  waiver: 'growth',
  promo_verification: 'growth',
};

// ── Lookup helpers ──

export const CAPABILITY_MAP: Record<CapabilityId, CapabilityDefinition> = Object.fromEntries(
  CAPABILITIES.map(c => [c.id, c])
) as Record<CapabilityId, CapabilityDefinition>;

export const CAPABILITY_IDS: CapabilityId[] = CAPABILITIES.map(c => c.id);

const TIER_RANK: Record<SubscriptionTier, number> = { free: 0, growth: 1, business: 2 };

export function tierMeetsRequirement(businessTier: SubscriptionTier, requiredTier: SubscriptionTier): boolean {
  return TIER_RANK[businessTier] >= TIER_RANK[requiredTier];
}

// ── Dependencies ──

export const CAPABILITY_DEPENDENCIES: Partial<Record<CapabilityId, CapabilityId[]>> = {
  membership: ['loyalty'],
};
