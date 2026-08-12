// ═══════════════════════════════════════════════════════
// Capability Type Definitions
//
// Re-exports from shared/capabilities.ts (canonical source).
// App-specific logic (category defaults, tier helpers) lives here.
// ═══════════════════════════════════════════════════════

export {
  type CapabilityId,
  type SubscriptionTier,
  type CapabilityDefinition,
  CAPABILITIES,
  CAPABILITY_MAP,
  CAPABILITY_IDS,
  CAPABILITY_TIER_REQUIREMENTS,
  CAPABILITY_DEPENDENCIES,
  PLAN_LABELS,
  tierMeetsRequirement,
} from '@/shared/capabilities';

// Re-export for backward compatibility
import type { CapabilityId, SubscriptionTier } from '@/shared/capabilities';
import { CAPABILITY_TIER_REQUIREMENTS, tierMeetsRequirement } from '@/shared/capabilities';

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
  return tierMeetsRequirement(currentTier, CAPABILITY_TIER_REQUIREMENTS[capId]);
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
