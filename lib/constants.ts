// ═══════════════════════════════════════════════════════
// Blowded Shared Constants — Multi-Industry Platform
// ═══════════════════════════════════════════════════════

export const APP_NAME = 'Blowded';
export const APP_TAGLINE = 'WhatsApp Automation for Every Business';
export const BOOKING_REF_PREFIX = 'BW';
export const TRIAL_DAYS = 7;

// ── Flow Types ──
export type FlowType = 'scheduling' | 'payment' | 'ordering' | 'ticketing';
export type BusinessCategoryKey =
  | 'restaurant' | 'barber' | 'spa' | 'salon' | 'gym' | 'clinic'
  | 'consultant' | 'church' | 'mosque' | 'school' | 'ngo'
  | 'shop' | 'food_delivery' | 'events' | 'transport' | 'cinema' | 'other';
export type SubscriptionTier = 'free' | 'growth' | 'business';
export type CountryCode = 'NG' | 'US' | 'GB' | 'CA' | 'GH';
export type PaymentGatewayName = 'paystack' | 'stripe';

// ── Country Configuration ──

interface CountryConfig {
  name: string;
  flag: string;
  dialingCode: string;
  currencyCode: string;
  currencySymbol: string;
  currencyLocale: string;
  paymentGateway: PaymentGatewayName;
  phoneDigits: number;
  phonePattern: RegExp;
  phonePlaceholder: string;
  cities: Record<string, { name: string; neighborhoods: string[] }>;
}

export const COUNTRIES: Record<CountryCode, CountryConfig> = {
  NG: {
    name: 'Nigeria',
    flag: '\ud83c\uddf3\ud83c\uddec',
    dialingCode: '+234',
    currencyCode: 'NGN',
    currencySymbol: '\u20a6',
    currencyLocale: 'en-NG',
    paymentGateway: 'paystack',
    phoneDigits: 10,
    phonePattern: /^[789]\d{9}$/,
    phonePlaceholder: '8012345678',
    cities: {
      lagos: {
        name: 'Lagos',
        neighborhoods: ['Victoria Island', 'Ikoyi', 'Lekki Phase 1', 'Lekki Phase 2', 'Ikeja GRA', 'Yaba', 'Surulere', 'Ajah', 'Maryland', 'Magodo'],
      },
      abuja: {
        name: 'Abuja',
        neighborhoods: ['Wuse', 'Wuse 2', 'Maitama', 'Garki', 'Asokoro', 'Jabi', 'Gwarinpa', 'Utako', 'Central Area', 'Katampe'],
      },
      port_harcourt: {
        name: 'Port Harcourt',
        neighborhoods: ['GRA Phase 1', 'GRA Phase 2', 'Trans-Amadi', 'Old GRA', 'Rumuola', 'Elekahia', 'Rumuokwurusi', 'Peter Odili Road'],
      },
    },
  },
  US: {
    name: 'United States',
    flag: '\ud83c\uddfa\ud83c\uddf8',
    dialingCode: '+1',
    currencyCode: 'USD',
    currencySymbol: '$',
    currencyLocale: 'en-US',
    paymentGateway: 'stripe',
    phoneDigits: 10,
    phonePattern: /^[2-9]\d{9}$/,
    phonePlaceholder: '2025551234',
    cities: {
      new_york: {
        name: 'New York',
        neighborhoods: ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Harlem', 'SoHo', 'Williamsburg', 'Astoria'],
      },
      los_angeles: {
        name: 'Los Angeles',
        neighborhoods: ['Hollywood', 'Beverly Hills', 'Santa Monica', 'Venice', 'Downtown', 'Silver Lake', 'Koreatown', 'Culver City'],
      },
      houston: {
        name: 'Houston',
        neighborhoods: ['Downtown', 'Midtown', 'Heights', 'Montrose', 'River Oaks', 'Galleria', 'Third Ward', 'Sugar Land'],
      },
      atlanta: {
        name: 'Atlanta',
        neighborhoods: ['Buckhead', 'Midtown', 'Downtown', 'Decatur', 'East Atlanta', 'West End', 'Sandy Springs', 'Marietta'],
      },
    },
  },
  GB: {
    name: 'United Kingdom',
    flag: '\ud83c\uddec\ud83c\udde7',
    dialingCode: '+44',
    currencyCode: 'GBP',
    currencySymbol: '\u00a3',
    currencyLocale: 'en-GB',
    paymentGateway: 'stripe',
    phoneDigits: 10,
    phonePattern: /^7\d{9}$/,
    phonePlaceholder: '7911123456',
    cities: {
      london: {
        name: 'London',
        neighborhoods: ['Shoreditch', 'Brixton', 'Peckham', 'Camden', 'Hackney', 'Dalston', 'Tottenham', 'Lewisham'],
      },
      manchester: {
        name: 'Manchester',
        neighborhoods: ['Northern Quarter', 'Chorlton', 'Didsbury', 'Ancoats', 'Rusholme', 'Moss Side', 'Salford', 'Withington'],
      },
      birmingham: {
        name: 'Birmingham',
        neighborhoods: ['City Centre', 'Edgbaston', 'Moseley', 'Handsworth', 'Erdington', 'Selly Oak', 'Aston', 'Digbeth'],
      },
    },
  },
  CA: {
    name: 'Canada',
    flag: '\ud83c\udde8\ud83c\udde6',
    dialingCode: '+1',
    currencyCode: 'CAD',
    currencySymbol: 'CA$',
    currencyLocale: 'en-CA',
    paymentGateway: 'stripe',
    phoneDigits: 10,
    phonePattern: /^[2-9]\d{9}$/,
    phonePlaceholder: '4165551234',
    cities: {
      toronto: {
        name: 'Toronto',
        neighborhoods: ['Downtown', 'Scarborough', 'North York', 'Etobicoke', 'Brampton', 'Mississauga', 'Yorkville', 'Liberty Village'],
      },
      calgary: {
        name: 'Calgary',
        neighborhoods: ['Downtown', 'Beltline', 'Kensington', 'Inglewood', 'Bridgeland', 'Mission', 'Bowness', 'NE Calgary'],
      },
      vancouver: {
        name: 'Vancouver',
        neighborhoods: ['Downtown', 'Kitsilano', 'Gastown', 'Mount Pleasant', 'Commercial Drive', 'Burnaby', 'Richmond', 'Surrey'],
      },
    },
  },
  GH: {
    name: 'Ghana',
    flag: '\ud83c\uddec\ud83c\udded',
    dialingCode: '+233',
    currencyCode: 'GHS',
    currencySymbol: 'GH\u20b5',
    currencyLocale: 'en-GH',
    paymentGateway: 'paystack',
    phoneDigits: 9,
    phonePattern: /^[2-9]\d{8}$/,
    phonePlaceholder: '241234567',
    cities: {
      accra: {
        name: 'Accra',
        neighborhoods: ['East Legon', 'Osu', 'Labone', 'Airport Residential', 'Cantonments', 'Dzorwulu', 'Spintex', 'Madina'],
      },
      kumasi: {
        name: 'Kumasi',
        neighborhoods: ['Adum', 'Bantama', 'Ashtown', 'Ahodwo', 'Danyame', 'Nhyiaeso', 'Suame', 'Tafo'],
      },
      tema: {
        name: 'Tema',
        neighborhoods: ['Community 1', 'Community 5', 'Community 25', 'Sakumono', 'Nungua', 'Kpone', 'Ashaiman', 'Baatsona'],
      },
    },
  },
};

// ── Per-Country Pricing ──

const COUNTRY_PRICING: Record<CountryCode, Record<SubscriptionTier, { price: number; feeFlat: number }>> = {
  NG: { free: { price: 0, feeFlat: 100 }, growth: { price: 15_000, feeFlat: 50 }, business: { price: 50_000, feeFlat: 50 } },
  US: { free: { price: 0, feeFlat: 0.50 }, growth: { price: 15, feeFlat: 0.25 }, business: { price: 50, feeFlat: 0.25 } },
  GB: { free: { price: 0, feeFlat: 0.40 }, growth: { price: 12, feeFlat: 0.20 }, business: { price: 40, feeFlat: 0.20 } },
  CA: { free: { price: 0, feeFlat: 0.50 }, growth: { price: 20, feeFlat: 0.25 }, business: { price: 65, feeFlat: 0.25 } },
  GH: { free: { price: 0, feeFlat: 5 }, growth: { price: 150, feeFlat: 2 }, business: { price: 500, feeFlat: 2 } },
};

// ── Business Categories ──
export const BUSINESS_CATEGORIES: Array<{
  key: BusinessCategoryKey;
  label: string;
  icon: string;
  flow: FlowType;
}> = [
  { key: 'restaurant', label: 'Restaurant', icon: '🍽️', flow: 'scheduling' },
  { key: 'barber', label: 'Barbershop', icon: '💈', flow: 'scheduling' },
  { key: 'spa', label: 'Spa', icon: '🧖', flow: 'scheduling' },
  { key: 'salon', label: 'Hair Salon', icon: '💇', flow: 'scheduling' },
  { key: 'gym', label: 'Gym / Fitness', icon: '🏋️', flow: 'scheduling' },
  { key: 'clinic', label: 'Clinic / Hospital', icon: '🏥', flow: 'scheduling' },
  { key: 'consultant', label: 'Consultant', icon: '💼', flow: 'scheduling' },
  { key: 'church', label: 'Church', icon: '⛪', flow: 'payment' },
  { key: 'mosque', label: 'Mosque', icon: '🕌', flow: 'payment' },
  { key: 'school', label: 'School', icon: '🎓', flow: 'payment' },
  { key: 'ngo', label: 'NGO / Charity', icon: '🤝', flow: 'payment' },
  { key: 'shop', label: 'Shop / Retail', icon: '🛍️', flow: 'ordering' },
  { key: 'food_delivery', label: 'Food Delivery', icon: '🛵', flow: 'ordering' },
  { key: 'events', label: 'Events', icon: '🎪', flow: 'ticketing' },
  { key: 'transport', label: 'Transport', icon: '🚌', flow: 'ticketing' },
  { key: 'cinema', label: 'Cinema', icon: '🎬', flow: 'ticketing' },
  { key: 'other', label: 'Other', icon: '🔧', flow: 'scheduling' },
];

// ── Category → Flow Map ──
export const CATEGORY_FLOW_MAP: Record<BusinessCategoryKey, FlowType> = Object.fromEntries(
  BUSINESS_CATEGORIES.map(c => [c.key, c.flow])
) as Record<BusinessCategoryKey, FlowType>;

// ── Per-Category Labels ──
export const CATEGORY_LABELS: Record<BusinessCategoryKey, {
  entityName: string;
  entityNamePlural: string;
  actionVerb: string;
  confirmationEmoji: string;
  receiptTitle: string;
  quantityLabel: string;
}> = {
  restaurant: { entityName: 'reservation', entityNamePlural: 'reservations', actionVerb: 'Book', confirmationEmoji: '🍽️', receiptTitle: 'Booking Confirmed', quantityLabel: 'guests' },
  barber: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '💈', receiptTitle: 'Appointment Confirmed', quantityLabel: 'people' },
  spa: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '🧖', receiptTitle: 'Appointment Confirmed', quantityLabel: 'people' },
  salon: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '💇', receiptTitle: 'Appointment Confirmed', quantityLabel: 'people' },
  gym: { entityName: 'session', entityNamePlural: 'sessions', actionVerb: 'Book', confirmationEmoji: '🏋️', receiptTitle: 'Session Confirmed', quantityLabel: 'people' },
  clinic: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '🏥', receiptTitle: 'Appointment Confirmed', quantityLabel: 'patients' },
  consultant: { entityName: 'consultation', entityNamePlural: 'consultations', actionVerb: 'Book', confirmationEmoji: '💼', receiptTitle: 'Consultation Confirmed', quantityLabel: 'attendees' },
  church: { entityName: 'payment', entityNamePlural: 'payments', actionVerb: 'Pay', confirmationEmoji: '⛪', receiptTitle: 'Payment Received', quantityLabel: 'amount' },
  mosque: { entityName: 'payment', entityNamePlural: 'payments', actionVerb: 'Pay', confirmationEmoji: '🕌', receiptTitle: 'Payment Received', quantityLabel: 'amount' },
  school: { entityName: 'payment', entityNamePlural: 'payments', actionVerb: 'Pay', confirmationEmoji: '🎓', receiptTitle: 'Payment Received', quantityLabel: 'amount' },
  ngo: { entityName: 'donation', entityNamePlural: 'donations', actionVerb: 'Donate', confirmationEmoji: '🤝', receiptTitle: 'Donation Received', quantityLabel: 'amount' },
  shop: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '🛍️', receiptTitle: 'Order Confirmed', quantityLabel: 'items' },
  food_delivery: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '🛵', receiptTitle: 'Order Confirmed', quantityLabel: 'items' },
  events: { entityName: 'ticket', entityNamePlural: 'tickets', actionVerb: 'Buy', confirmationEmoji: '🎪', receiptTitle: 'Tickets Confirmed', quantityLabel: 'tickets' },
  transport: { entityName: 'ticket', entityNamePlural: 'tickets', actionVerb: 'Buy', confirmationEmoji: '🚌', receiptTitle: 'Ticket Confirmed', quantityLabel: 'seats' },
  cinema: { entityName: 'ticket', entityNamePlural: 'tickets', actionVerb: 'Buy', confirmationEmoji: '🎬', receiptTitle: 'Ticket Confirmed', quantityLabel: 'seats' },
  other: { entityName: 'booking', entityNamePlural: 'bookings', actionVerb: 'Book', confirmationEmoji: '✅', receiptTitle: 'Booking Confirmed', quantityLabel: 'slots' },
};

// ── Pricing Tiers ──
export const PRICING_TIERS: Record<SubscriptionTier, {
  name: string;
  price: number | null;
  feePercentage: number;
  feeFlat: number;
  maxBookings: number;
  whitelabel: boolean;
  features: string[];
}> = {
  free: {
    name: 'Free',
    price: 0,
    feePercentage: 2.5,
    feeFlat: 100,
    maxBookings: 50,
    whitelabel: false,
    features: [
      '7-day free trial (no fees)',
      'Up to 50 bookings/month',
      'WhatsApp automation',
      'Basic dashboard',
      '2.5% + ₦100 per transaction after trial',
    ],
  },
  growth: {
    name: 'Growth',
    price: 15_000,
    feePercentage: 1.5,
    feeFlat: 50,
    maxBookings: 500,
    whitelabel: false,
    features: [
      'Up to 500 bookings/month',
      'WhatsApp automation',
      'Full dashboard & analytics',
      'SMS & email reminders',
      '1.5% + ₦50 per transaction',
    ],
  },
  business: {
    name: 'Business',
    price: 50_000,
    feePercentage: 1.0,
    feeFlat: 50,
    maxBookings: Infinity,
    whitelabel: true,
    features: [
      'Unlimited bookings',
      'White-label (your brand)',
      'Custom persona',
      'Priority support',
      'Advanced analytics',
      '1% + ₦50 per transaction',
    ],
  },
};

// ── Legacy pricing (kept for backward compatibility) ──
export const PRICING = {
  whatsapp_standalone: {
    starter: { name: 'Starter', price: 15_000, maxBookings: 100, whitelabel: false },
    professional: { name: 'Professional', price: 35_000, maxBookings: Infinity, whitelabel: true },
    enterprise: { name: 'Enterprise', price: null, maxBookings: Infinity, whitelabel: true },
  },
} as const;

// ── Default Services per Category ──
export const DEFAULT_SERVICES: Record<BusinessCategoryKey, Array<{
  name: string;
  price: number;
  price_is_variable: boolean;
  duration_minutes: number | null;
  deposit_amount: number;
}>> = {
  restaurant: [
    { name: 'Table Reservation', price: 0, price_is_variable: false, duration_minutes: 120, deposit_amount: 0 },
  ],
  barber: [
    { name: 'Haircut', price: 3000, price_is_variable: false, duration_minutes: 30, deposit_amount: 0 },
    { name: 'Beard Trim', price: 1500, price_is_variable: false, duration_minutes: 15, deposit_amount: 0 },
    { name: 'Full Grooming', price: 5000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
  ],
  spa: [
    { name: 'Full Body Massage', price: 15000, price_is_variable: false, duration_minutes: 60, deposit_amount: 5000 },
    { name: 'Facial Treatment', price: 10000, price_is_variable: false, duration_minutes: 45, deposit_amount: 3000 },
  ],
  salon: [
    { name: 'Haircut & Styling', price: 5000, price_is_variable: false, duration_minutes: 45, deposit_amount: 0 },
    { name: 'Braiding', price: 10000, price_is_variable: false, duration_minutes: 120, deposit_amount: 3000 },
    { name: 'Manicure & Pedicure', price: 5000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
  ],
  gym: [
    { name: 'Personal Training', price: 10000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
    { name: 'Group Class', price: 3000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
  ],
  clinic: [
    { name: 'Consultation', price: 10000, price_is_variable: false, duration_minutes: 30, deposit_amount: 5000 },
    { name: 'Check-up', price: 20000, price_is_variable: false, duration_minutes: 60, deposit_amount: 10000 },
  ],
  consultant: [
    { name: 'Consultation Session', price: 25000, price_is_variable: false, duration_minutes: 60, deposit_amount: 10000 },
  ],
  church: [
    { name: 'Tithe', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Offering', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Building Fund', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Welfare', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  mosque: [
    { name: 'Zakat', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Sadaqah', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Fitrah', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  school: [
    { name: 'School Fees', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'PTA Dues', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Exam Fees', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  ngo: [
    { name: 'Donation', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Membership', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  shop: [],
  food_delivery: [],
  events: [],
  transport: [],
  cinema: [],
  other: [
    { name: 'General Booking', price: 0, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
  ],
};

// ── Cities & Neighborhoods (backward-compat alias for NG) ──
export const CITIES = COUNTRIES.NG.cities;

// ── Booking Defaults ──
export const BOOKING_DEFAULTS = {
  maxPartySize: 20,
  maxAdvanceDays: 30,
  defaultCancellationHours: 4,
  defaultWalkInRatio: 60,
  defaultSlotDurationMinutes: 120,
  reminderHours: [24, 2],
} as const;

// ── Time Slots ──
export function generateTimeSlots(
  openTime: string = '12:00',
  closeTime: string = '22:00',
  intervalMinutes: number = 30,
): string[] {
  const slots: string[] = [];
  const [openH, openM] = openTime.split(':').map(Number);
  const [closeH, closeM] = closeTime.split(':').map(Number);
  let current = openH * 60 + openM;
  const end = closeH * 60 + closeM;

  while (current < end) {
    const h = Math.floor(current / 60);
    const m = current % 60;
    slots.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
    current += intervalMinutes;
  }
  return slots;
}

// ── Slug Generator ──
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// ── Format Naira ──
export function formatNaira(amount: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

// ── Bot Code Generator ──
export function generateBotCode(name: string): string {
  const stopWords = new Set(['the', 'and', 'restaurant', 'kitchen', 'bar', 'lounge', 'cafe', 'eatery', 'by']);
  return name
    .toUpperCase()
    .replace(/&/g, '')
    .replace(/[^A-Z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0 && !stopWords.has(w.toLowerCase()))
    .join('-')
    .replace(/-+/g, '-')
    .slice(0, 30);
}

// ── Platform Fee Calculator ──
export function calculatePlatformFee(
  amount: number,
  tier: SubscriptionTier,
  isInTrial: boolean,
): { feePercentage: number; feeFlat: number; feeTotal: number } {
  if (isInTrial) {
    return { feePercentage: 0, feeFlat: 0, feeTotal: 0 };
  }
  const tierConfig = PRICING_TIERS[tier];
  const percentageFee = Math.round(amount * tierConfig.feePercentage / 100);
  const feeTotal = percentageFee + tierConfig.feeFlat;
  return {
    feePercentage: tierConfig.feePercentage,
    feeFlat: tierConfig.feeFlat,
    feeTotal,
  };
}

// ── Multi-Country Helpers ──

/** Format currency for a given country */
export function formatCurrency(amount: number, countryCode: CountryCode = 'NG'): string {
  const country = COUNTRIES[countryCode];
  const fractionDigits = ['NGN', 'GHS'].includes(country.currencyCode) ? 0 : 2;
  return new Intl.NumberFormat(country.currencyLocale, {
    style: 'currency',
    currency: country.currencyCode,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

/** Get pricing tiers localized for a country */
export function getPricingTiers(countryCode: CountryCode = 'NG'): Record<SubscriptionTier, {
  name: string;
  price: number;
  feePercentage: number;
  feeFlat: number;
  maxBookings: number;
  whitelabel: boolean;
  features: string[];
}> {
  const cp = COUNTRY_PRICING[countryCode];
  const country = COUNTRIES[countryCode];
  const fmt = (amt: number) => formatCurrency(amt, countryCode);

  return {
    free: {
      ...PRICING_TIERS.free,
      price: 0,
      feeFlat: cp.free.feeFlat,
      features: [
        '7-day free trial (no fees)',
        'Up to 50 bookings/month',
        'WhatsApp automation',
        'Basic dashboard',
        `2.5% + ${fmt(cp.free.feeFlat)} per transaction after trial`,
      ],
    },
    growth: {
      ...PRICING_TIERS.growth,
      price: cp.growth.price,
      feeFlat: cp.growth.feeFlat,
      features: [
        'Up to 500 bookings/month',
        'WhatsApp automation',
        'Full dashboard & analytics',
        'SMS & email reminders',
        `1.5% + ${fmt(cp.growth.feeFlat)} per transaction`,
      ],
    },
    business: {
      ...PRICING_TIERS.business,
      price: cp.business.price,
      feeFlat: cp.business.feeFlat,
      features: [
        'Unlimited bookings',
        'White-label (your brand)',
        'Custom persona',
        'Priority support',
        'Advanced analytics',
        `1% + ${fmt(cp.business.feeFlat)} per transaction`,
      ],
    },
  };
}

/** Get locale string for date formatting */
export function getLocale(countryCode: CountryCode = 'NG'): string {
  return COUNTRIES[countryCode].currencyLocale;
}

/** Get cities for a country */
export function getCitiesForCountry(countryCode: CountryCode = 'NG') {
  return COUNTRIES[countryCode].cities;
}

/** Get the payment gateway for a country */
export function getPaymentGatewayForCountry(countryCode: CountryCode = 'NG'): PaymentGatewayName {
  return COUNTRIES[countryCode].paymentGateway;
}
