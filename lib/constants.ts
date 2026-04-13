// ═══════════════════════════════════════════════════════
// Waaiio Shared Constants — Multi-Industry Platform
// ═══════════════════════════════════════════════════════

export const APP_NAME = 'Waaiio';
export const APP_TAGLINE = 'WhatsApp Automation for Every Business';
export const BOOKING_REF_PREFIX = 'BW';
export const TRIAL_DAYS = 7;

// ── Flow Types ──
export type FlowType = 'scheduling' | 'payment' | 'ordering' | 'ticketing' | 'reservation';
export type BusinessCategoryKey =
  | 'restaurant' | 'barber' | 'spa' | 'salon' | 'gym' | 'clinic'
  | 'consultant' | 'church' | 'mosque' | 'school' | 'ngo'
  | 'shop' | 'food_delivery' | 'events' | 'transport' | 'cinema'
  | 'car_park' | 'tattoo' | 'real_estate' | 'travel_agency'
  | 'logistics' | 'taxi' | 'government' | 'instagram_vendor'
  | 'crowdfunding_org' | 'laundry' | 'veterinary' | 'dental'
  | 'coworking' | 'tutor' | 'photographer' | 'mall_vendor'
  | 'pharmacy' | 'hotel' | 'car_wash' | 'catering'
  | 'funeral' | 'tailor' | 'shortlet' | 'other';
export type SubscriptionTier = 'free' | 'growth' | 'business';

/** Maps internal tier names to customer-facing marketing names */
export const TIER_MARKETING_NAMES: Record<SubscriptionTier, string> = {
  free: 'Starter',
  growth: 'Pro',
  business: 'Premium',
};

export type CountryCode = string;
export type PaymentGatewayName = 'paystack' | 'stripe' | 'flutterwave' | 'square';

// Re-export capability types for convenience
export type { CapabilityId } from '@/lib/capabilities/types';

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
    paymentGateway: 'square',
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
  NG: { free: { price: 0, feeFlat: 200 }, growth: { price: 15_000, feeFlat: 50 }, business: { price: 50_000, feeFlat: 50 } },
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
  // ── New Categories ──
  { key: 'car_park', label: 'Parking', icon: '🅿️', flow: 'payment' },
  { key: 'tattoo', label: 'Tattoo Shop', icon: '🎨', flow: 'scheduling' },
  { key: 'real_estate', label: 'Real Estate', icon: '🏠', flow: 'scheduling' },
  { key: 'travel_agency', label: 'Travel Agency', icon: '✈️', flow: 'scheduling' },
  { key: 'logistics', label: 'Logistics & Shipping', icon: '🚚', flow: 'ordering' },
  { key: 'taxi', label: 'Taxi & Ride-Hailing', icon: '🚕', flow: 'payment' },
  { key: 'government', label: 'Government & Utilities', icon: '🏛️', flow: 'payment' },
  { key: 'instagram_vendor', label: 'Online Vendor', icon: '🛒', flow: 'ordering' },
  { key: 'crowdfunding_org', label: 'Crowdfunding', icon: '❤️', flow: 'payment' },
  { key: 'laundry', label: 'Laundry & Dry Cleaning', icon: '👔', flow: 'scheduling' },
  { key: 'veterinary', label: 'Veterinary', icon: '🐾', flow: 'scheduling' },
  { key: 'dental', label: 'Dental Clinic', icon: '🦷', flow: 'scheduling' },
  { key: 'coworking', label: 'Coworking Space', icon: '🏢', flow: 'scheduling' },
  { key: 'tutor', label: 'Tutor & Coaching', icon: '📚', flow: 'scheduling' },
  { key: 'photographer', label: 'Photographer', icon: '📷', flow: 'scheduling' },
  { key: 'mall_vendor', label: 'Mall Vendor', icon: '🏪', flow: 'ordering' },
  { key: 'pharmacy', label: 'Pharmacy', icon: '💊', flow: 'ordering' },
  { key: 'hotel', label: 'Hotel & Lodge', icon: '🛏️', flow: 'scheduling' },
  { key: 'shortlet', label: 'Shortlet / Apartment', icon: '🏘️', flow: 'reservation' },
  { key: 'car_wash', label: 'Car Wash', icon: '🚿', flow: 'scheduling' },
  { key: 'catering', label: 'Catering', icon: '🍳', flow: 'ordering' },
  { key: 'funeral', label: 'Funeral Services', icon: '🌺', flow: 'payment' },
  { key: 'tailor', label: 'Tailor & Fashion', icon: '✂️', flow: 'ordering' },
  { key: 'other', label: 'Other (Custom)', icon: '🔧', flow: 'scheduling' },
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
  personLabel: string;
  personLabelPlural: string;
  hiddenStatuses: string[];
  serviceName: string;
  serviceNamePlural: string;
  namePlaceholder: string;
  defaultHasPrice: boolean;
}> = {
  restaurant: { entityName: 'reservation', entityNamePlural: 'reservations', actionVerb: 'Book', confirmationEmoji: '🍽️', receiptTitle: 'Booking Confirmed', quantityLabel: 'guests', personLabel: 'Guest', personLabelPlural: 'Guests', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Table Reservation, Private Dining', defaultHasPrice: true },
  barber: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '💈', receiptTitle: 'Appointment Confirmed', quantityLabel: 'people', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Haircut, Beard Trim', defaultHasPrice: true },
  spa: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '🧖', receiptTitle: 'Appointment Confirmed', quantityLabel: 'people', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Full Body Massage, Facial', defaultHasPrice: true },
  salon: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '💇', receiptTitle: 'Appointment Confirmed', quantityLabel: 'people', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Haircut & Styling, Braiding', defaultHasPrice: true },
  gym: { entityName: 'session', entityNamePlural: 'sessions', actionVerb: 'Book', confirmationEmoji: '🏋️', receiptTitle: 'Session Confirmed', quantityLabel: 'people', personLabel: 'Member', personLabelPlural: 'Members', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Personal Training, Group Class', defaultHasPrice: true },
  clinic: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '🏥', receiptTitle: 'Appointment Confirmed', quantityLabel: 'patients', personLabel: 'Patient', personLabelPlural: 'Patients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Consultation, Check-up', defaultHasPrice: true },
  consultant: { entityName: 'consultation', entityNamePlural: 'consultations', actionVerb: 'Book', confirmationEmoji: '💼', receiptTitle: 'Consultation Confirmed', quantityLabel: 'attendees', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Strategy Session, Advisory', defaultHasPrice: true },
  church: { entityName: 'giving', entityNamePlural: 'giving', actionVerb: 'Give', confirmationEmoji: '⛪', receiptTitle: 'Giving Received', quantityLabel: 'amount', personLabel: 'Member', personLabelPlural: 'Members', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Giving Category', serviceNamePlural: 'Giving Categories', namePlaceholder: 'e.g. Tithe, Offering, Building Fund', defaultHasPrice: false },
  mosque: { entityName: 'giving', entityNamePlural: 'giving', actionVerb: 'Give', confirmationEmoji: '🕌', receiptTitle: 'Giving Received', quantityLabel: 'amount', personLabel: 'Member', personLabelPlural: 'Members', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Offering', serviceNamePlural: 'Offerings', namePlaceholder: 'e.g. Zakat, Sadaqah, Fitrah', defaultHasPrice: false },
  school: { entityName: 'payment', entityNamePlural: 'payments', actionVerb: 'Pay', confirmationEmoji: '🎓', receiptTitle: 'Payment Received', quantityLabel: 'amount', personLabel: 'Student', personLabelPlural: 'Students', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Fee Category', serviceNamePlural: 'Fee Categories', namePlaceholder: 'e.g. School Fees, PTA Dues, Exam Fees', defaultHasPrice: false },
  ngo: { entityName: 'donation', entityNamePlural: 'donations', actionVerb: 'Donate', confirmationEmoji: '🤝', receiptTitle: 'Donation Received', quantityLabel: 'amount', personLabel: 'Donor', personLabelPlural: 'Donors', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Program', serviceNamePlural: 'Programs', namePlaceholder: 'e.g. Education Fund, Community Outreach', defaultHasPrice: false },
  shop: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '🛍️', receiptTitle: 'Order Confirmed', quantityLabel: 'items', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Product', serviceNamePlural: 'Products', namePlaceholder: 'e.g. T-Shirt, Gift Box', defaultHasPrice: true },
  food_delivery: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '🛵', receiptTitle: 'Order Confirmed', quantityLabel: 'items', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Menu Item', serviceNamePlural: 'Menu Items', namePlaceholder: 'e.g. Jollof Rice, Shawarma', defaultHasPrice: true },
  events: { entityName: 'ticket', entityNamePlural: 'tickets', actionVerb: 'Buy', confirmationEmoji: '🎪', receiptTitle: 'Tickets Confirmed', quantityLabel: 'tickets', personLabel: 'Attendee', personLabelPlural: 'Attendees', hiddenStatuses: ['no_show', 'in_progress'], serviceName: 'Event', serviceNamePlural: 'Events', namePlaceholder: 'e.g. Concert, Workshop', defaultHasPrice: true },
  transport: { entityName: 'ticket', entityNamePlural: 'tickets', actionVerb: 'Buy', confirmationEmoji: '🚌', receiptTitle: 'Ticket Confirmed', quantityLabel: 'seats', personLabel: 'Attendee', personLabelPlural: 'Attendees', hiddenStatuses: ['no_show', 'in_progress'], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Lagos–Abuja, Express Route', defaultHasPrice: true },
  cinema: { entityName: 'ticket', entityNamePlural: 'tickets', actionVerb: 'Buy', confirmationEmoji: '🎬', receiptTitle: 'Ticket Confirmed', quantityLabel: 'seats', personLabel: 'Attendee', personLabelPlural: 'Attendees', hiddenStatuses: ['no_show', 'in_progress'], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Regular, VIP, IMAX', defaultHasPrice: true },
  // ── New Categories ──
  car_park: { entityName: 'parking', entityNamePlural: 'parking passes', actionVerb: 'Pay', confirmationEmoji: '🅿️', receiptTitle: 'Parking Paid', quantityLabel: 'vehicles', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Hourly Parking, Monthly Pass', defaultHasPrice: true },
  tattoo: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '🎨', receiptTitle: 'Appointment Confirmed', quantityLabel: 'sessions', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Small Tattoo, Cover-up', defaultHasPrice: true },
  real_estate: { entityName: 'viewing', entityNamePlural: 'viewings', actionVerb: 'Book', confirmationEmoji: '🏠', receiptTitle: 'Viewing Confirmed', quantityLabel: 'viewings', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Property Viewing, Consultation', defaultHasPrice: true },
  travel_agency: { entityName: 'booking', entityNamePlural: 'bookings', actionVerb: 'Book', confirmationEmoji: '✈️', receiptTitle: 'Booking Confirmed', quantityLabel: 'travelers', personLabel: 'Traveler', personLabelPlural: 'Travelers', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Travel Consultation, Visa Assist', defaultHasPrice: true },
  logistics: { entityName: 'shipment', entityNamePlural: 'shipments', actionVerb: 'Order', confirmationEmoji: '🚚', receiptTitle: 'Shipment Confirmed', quantityLabel: 'packages', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Same-day Delivery, Interstate', defaultHasPrice: true },
  taxi: { entityName: 'ride', entityNamePlural: 'rides', actionVerb: 'Pay', confirmationEmoji: '🚕', receiptTitle: 'Ride Payment', quantityLabel: 'rides', personLabel: 'Rider', personLabelPlural: 'Riders', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. City Ride, Airport Transfer', defaultHasPrice: false },
  government: { entityName: 'payment', entityNamePlural: 'payments', actionVerb: 'Pay', confirmationEmoji: '🏛️', receiptTitle: 'Payment Received', quantityLabel: 'amount', personLabel: 'Citizen', personLabelPlural: 'Citizens', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Utility Bill, Application Fee', defaultHasPrice: false },
  instagram_vendor: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '🛒', receiptTitle: 'Order Confirmed', quantityLabel: 'items', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Product', serviceNamePlural: 'Products', namePlaceholder: 'e.g. Custom Order, Bundle Deal', defaultHasPrice: true },
  crowdfunding_org: { entityName: 'donation', entityNamePlural: 'donations', actionVerb: 'Donate', confirmationEmoji: '❤️', receiptTitle: 'Donation Received', quantityLabel: 'amount', personLabel: 'Donor', personLabelPlural: 'Donors', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Campaign', serviceNamePlural: 'Campaigns', namePlaceholder: 'e.g. Medical Fund, Community Project', defaultHasPrice: false },
  laundry: { entityName: 'pickup', entityNamePlural: 'pickups', actionVerb: 'Book', confirmationEmoji: '👔', receiptTitle: 'Pickup Confirmed', quantityLabel: 'items', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Wash & Fold, Dry Cleaning', defaultHasPrice: true },
  veterinary: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '🐾', receiptTitle: 'Appointment Confirmed', quantityLabel: 'pets', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Consultation, Vaccination', defaultHasPrice: true },
  dental: { entityName: 'appointment', entityNamePlural: 'appointments', actionVerb: 'Book', confirmationEmoji: '🦷', receiptTitle: 'Appointment Confirmed', quantityLabel: 'patients', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Check-up, Cleaning, Filling', defaultHasPrice: true },
  coworking: { entityName: 'booking', entityNamePlural: 'bookings', actionVerb: 'Book', confirmationEmoji: '🏢', receiptTitle: 'Space Booked', quantityLabel: 'desks', personLabel: 'Member', personLabelPlural: 'Members', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Hot Desk, Private Office', defaultHasPrice: true },
  tutor: { entityName: 'session', entityNamePlural: 'sessions', actionVerb: 'Book', confirmationEmoji: '📚', receiptTitle: 'Session Confirmed', quantityLabel: 'students', personLabel: 'Student', personLabelPlural: 'Students', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Private Lesson, Group Session', defaultHasPrice: true },
  photographer: { entityName: 'session', entityNamePlural: 'sessions', actionVerb: 'Book', confirmationEmoji: '📷', receiptTitle: 'Session Confirmed', quantityLabel: 'sessions', personLabel: 'Client', personLabelPlural: 'Clients', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Portrait Session, Event Coverage', defaultHasPrice: true },
  mall_vendor: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '🏪', receiptTitle: 'Order Confirmed', quantityLabel: 'items', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Product', serviceNamePlural: 'Products', namePlaceholder: 'e.g. Perfume, Accessories', defaultHasPrice: true },
  pharmacy: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '💊', receiptTitle: 'Order Confirmed', quantityLabel: 'items', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Product', serviceNamePlural: 'Products', namePlaceholder: 'e.g. Prescription, OTC Medicine', defaultHasPrice: true },
  hotel: { entityName: 'reservation', entityNamePlural: 'reservations', actionVerb: 'Book', confirmationEmoji: '🛏️', receiptTitle: 'Reservation Confirmed', quantityLabel: 'nights', personLabel: 'Guest', personLabelPlural: 'Guests', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Standard Room, Deluxe Suite', defaultHasPrice: true },
  car_wash: { entityName: 'booking', entityNamePlural: 'bookings', actionVerb: 'Book', confirmationEmoji: '🚿', receiptTitle: 'Booking Confirmed', quantityLabel: 'vehicles', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Basic Wash, Full Detail', defaultHasPrice: true },
  catering: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '🍳', receiptTitle: 'Order Confirmed', quantityLabel: 'servings', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Party Package, Corporate Lunch', defaultHasPrice: true },
  funeral: { entityName: 'service', entityNamePlural: 'services', actionVerb: 'Pay', confirmationEmoji: '🌺', receiptTitle: 'Payment Received', quantityLabel: 'amount', personLabel: 'Family', personLabelPlural: 'Families', hiddenStatuses: ['no_show', 'in_progress', 'confirmed'], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Service Fee, Memorial Contribution', defaultHasPrice: false },
  tailor: { entityName: 'order', entityNamePlural: 'orders', actionVerb: 'Order', confirmationEmoji: '✂️', receiptTitle: 'Order Confirmed', quantityLabel: 'items', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. Custom Suit, Alteration', defaultHasPrice: true },
  shortlet: { entityName: 'stay', entityNamePlural: 'stays', actionVerb: 'Book a Stay', confirmationEmoji: '🏘️', receiptTitle: 'Reservation Confirmed', quantityLabel: 'guests', personLabel: 'Guest', personLabelPlural: 'Guests', hiddenStatuses: [], serviceName: 'Apartment', serviceNamePlural: 'Apartments', namePlaceholder: 'e.g. Studio Apartment, 2-Bed Flat', defaultHasPrice: true },
  other: { entityName: 'booking', entityNamePlural: 'bookings', actionVerb: 'Book', confirmationEmoji: '✅', receiptTitle: 'Booking Confirmed', quantityLabel: 'slots', personLabel: 'Customer', personLabelPlural: 'Customers', hiddenStatuses: [], serviceName: 'Service', serviceNamePlural: 'Services', namePlaceholder: 'e.g. General Booking', defaultHasPrice: true },
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
      'Dashboard & analytics',
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
      'WhatsApp reminders',
      'Recurring payments',
      'Broadcast messages',
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
      'Custom bot persona & greeting',
      'Loyalty & referral programs',
      'Queue & waitlist management',
      'Customer feedback & reviews',
      '1% + ₦50 per transaction',
    ],
  },
};

// ── Broadcast Limits per Tier ──
export const BROADCAST_LIMITS: Record<SubscriptionTier, {
  maxBroadcasts: number;
  maxRecipients: number;
}> = {
  free: { maxBroadcasts: 0, maxRecipients: 0 },
  growth: { maxBroadcasts: 10, maxRecipients: 500 },
  business: { maxBroadcasts: Infinity, maxRecipients: Infinity },
};

// ── Tier Feature Sets (single source of truth) ──

export interface TierFeatureSet {
  marketingName: string;
  description: string;
  feePercentage: number;
  maxBookings: number;
  whitelabel: boolean;
  capabilities: string[];
  broadcastLimits: { maxBroadcasts: number; maxRecipients: number };
  highlights: string[];
}

export const TIER_FEATURES: Record<SubscriptionTier, TierFeatureSet> = {
  free: {
    marketingName: 'Starter',
    description: 'Perfect for trying out Waaiio with zero risk.',
    feePercentage: 2.5,
    maxBookings: 50,
    whitelabel: false,
    capabilities: ['scheduling', 'payment', 'ordering', 'ticketing', 'feedback', 'chat'],
    broadcastLimits: { maxBroadcasts: 0, maxRecipients: 0 },
    highlights: [
      '7-day free trial (no fees)',
      'Up to 50 bookings/month',
      'WhatsApp automation',
      'Dashboard & analytics',
    ],
  },
  growth: {
    marketingName: 'Pro',
    description: 'For growing businesses that need more volume and features.',
    feePercentage: 1.5,
    maxBookings: 500,
    whitelabel: false,
    capabilities: ['scheduling', 'payment', 'ordering', 'ticketing', 'feedback', 'chat', 'reservation', 'reminders', 'loyalty', 'referral'],
    broadcastLimits: { maxBroadcasts: 10, maxRecipients: 500 },
    highlights: [
      'Everything in Starter, plus:',
      'Up to 500 bookings/month',
      'WhatsApp reminders',
      'Recurring payments',
      'Broadcast messages (10/mo, 500 recipients)',
    ],
  },
  business: {
    marketingName: 'Premium',
    description: 'For established businesses that want full control and branding.',
    feePercentage: 1.0,
    maxBookings: Infinity,
    whitelabel: true,
    capabilities: ['scheduling', 'payment', 'ordering', 'ticketing', 'feedback', 'chat', 'reservation', 'reminders', 'loyalty', 'referral', 'whatsapp_sign', 'queue', 'waitlist', 'reports', 'staff', 'crowdfunding'],
    broadcastLimits: { maxBroadcasts: Infinity, maxRecipients: Infinity },
    highlights: [
      'Everything in Pro, plus:',
      'Unlimited bookings',
      'Custom bot persona & greeting',
      'Loyalty & referral programs',
      'Queue & waitlist management',
      'Customer feedback & reviews',
      'Whitelabel branding',
      'Unlimited broadcasts',
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
  // ── New Categories ──
  car_park: [
    { name: 'Hourly Parking', price: 500, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
    { name: 'Daily Parking', price: 3000, price_is_variable: false, duration_minutes: null, deposit_amount: 0 },
    { name: 'Monthly Pass', price: 30000, price_is_variable: false, duration_minutes: null, deposit_amount: 0 },
  ],
  tattoo: [
    { name: 'Small Tattoo', price: 15000, price_is_variable: false, duration_minutes: 60, deposit_amount: 5000 },
    { name: 'Medium Tattoo', price: 35000, price_is_variable: false, duration_minutes: 120, deposit_amount: 10000 },
    { name: 'Consultation', price: 0, price_is_variable: false, duration_minutes: 30, deposit_amount: 0 },
  ],
  real_estate: [
    { name: 'Property Viewing', price: 0, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
    { name: 'Consultation', price: 10000, price_is_variable: false, duration_minutes: 45, deposit_amount: 0 },
  ],
  travel_agency: [
    { name: 'Travel Consultation', price: 5000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
  ],
  logistics: [],
  taxi: [
    { name: 'Ride Payment', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  government: [
    { name: 'Utility Bill', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Application Fee', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  instagram_vendor: [],
  crowdfunding_org: [],
  laundry: [
    { name: 'Wash & Fold', price: 3000, price_is_variable: false, duration_minutes: null, deposit_amount: 0 },
    { name: 'Dry Cleaning', price: 5000, price_is_variable: false, duration_minutes: null, deposit_amount: 0 },
    { name: 'Ironing Only', price: 1500, price_is_variable: false, duration_minutes: null, deposit_amount: 0 },
  ],
  veterinary: [
    { name: 'Consultation', price: 10000, price_is_variable: false, duration_minutes: 30, deposit_amount: 3000 },
    { name: 'Vaccination', price: 8000, price_is_variable: false, duration_minutes: 15, deposit_amount: 0 },
    { name: 'Grooming', price: 5000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
  ],
  dental: [
    { name: 'Check-up', price: 10000, price_is_variable: false, duration_minutes: 30, deposit_amount: 5000 },
    { name: 'Cleaning', price: 15000, price_is_variable: false, duration_minutes: 45, deposit_amount: 5000 },
    { name: 'Filling', price: 25000, price_is_variable: false, duration_minutes: 60, deposit_amount: 10000 },
  ],
  coworking: [
    { name: 'Hot Desk (Day)', price: 3000, price_is_variable: false, duration_minutes: 480, deposit_amount: 0 },
    { name: 'Private Office (Day)', price: 10000, price_is_variable: false, duration_minutes: 480, deposit_amount: 0 },
    { name: 'Meeting Room (Hour)', price: 5000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
  ],
  tutor: [
    { name: 'Private Lesson', price: 10000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
    { name: 'Group Session', price: 5000, price_is_variable: false, duration_minutes: 90, deposit_amount: 0 },
  ],
  photographer: [
    { name: 'Portrait Session', price: 30000, price_is_variable: false, duration_minutes: 60, deposit_amount: 10000 },
    { name: 'Event Coverage', price: 100000, price_is_variable: false, duration_minutes: 240, deposit_amount: 30000 },
  ],
  mall_vendor: [],
  pharmacy: [],
  hotel: [
    { name: 'Standard Room', price: 25000, price_is_variable: false, duration_minutes: null, deposit_amount: 10000 },
    { name: 'Deluxe Room', price: 45000, price_is_variable: false, duration_minutes: null, deposit_amount: 15000 },
  ],
  car_wash: [
    { name: 'Basic Wash', price: 2000, price_is_variable: false, duration_minutes: 30, deposit_amount: 0 },
    { name: 'Full Wash & Polish', price: 5000, price_is_variable: false, duration_minutes: 60, deposit_amount: 0 },
    { name: 'Interior Detail', price: 8000, price_is_variable: false, duration_minutes: 90, deposit_amount: 0 },
  ],
  catering: [],
  funeral: [
    { name: 'Service Fee', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
    { name: 'Memorial Contribution', price: 0, price_is_variable: true, duration_minutes: null, deposit_amount: 0 },
  ],
  tailor: [],
  shortlet: [
    { name: 'Studio Apartment', price: 25000, price_is_variable: false, duration_minutes: null, deposit_amount: 10000 },
    { name: '1-Bedroom Apartment', price: 45000, price_is_variable: false, duration_minutes: null, deposit_amount: 15000 },
    { name: '2-Bedroom Apartment', price: 75000, price_is_variable: false, duration_minutes: null, deposit_amount: 25000 },
  ],
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

/** Category-specific max party/quantity size */
export function getMaxQuantity(category: BusinessCategoryKey): number {
  switch (category) {
    case 'barber':
    case 'salon':
    case 'tattoo':
    case 'photographer':
      return 5;
    case 'clinic':
    case 'dental':
    case 'veterinary':
    case 'consultant':
      return 3;
    case 'spa':
    case 'tutor':
      return 6;
    case 'gym':
    case 'coworking':
      return 10;
    case 'hotel':
    case 'shortlet':
      return 10;
    case 'restaurant':
    case 'catering':
      return 20;
    case 'events':
    case 'cinema':
    case 'transport':
      return 50;
    default:
      return BOOKING_DEFAULTS.maxPartySize;
  }
}

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

// ── DB-backed Country Helpers ──
// Registration pattern to avoid circular deps — lib/countries.ts calls registerCountryResolver() after import.

type CountryResolverFn = (code: string) => {
  name: string; flag: string; dialing_code: string; currency_code: string;
  currency_symbol: string; currency_locale: string; payment_gateway: string;
  phone_digits: number; phone_pattern: string; phone_placeholder: string;
  cities: Record<string, { name: string; neighborhoods: string[] }>;
  pricing?: Record<string, { price: number; feeFlat: number }>;
  verification_tiers?: Record<string, { label: string; limit: number; requirements: string }>;
  doc_types?: { key: string; label: string; desc: string }[];
} | null;

let _countryResolver: CountryResolverFn | null = null;

/** Called by lib/countries.ts to register its getCountry function */
export function registerCountryResolver(fn: CountryResolverFn): void {
  _countryResolver = fn;
}

/** Get CountryRow from DB cache, or null if not loaded */
function _getCountryFromDb(code: string) {
  return _countryResolver?.(code) ?? null;
}

/** Get country config: DB cache first, then hardcoded COUNTRIES fallback */
function _getCountryConfig(code: string): CountryConfig {
  const db = _getCountryFromDb(code);
  if (db) {
    return {
      name: db.name,
      flag: db.flag,
      dialingCode: db.dialing_code,
      currencyCode: db.currency_code,
      currencySymbol: db.currency_symbol,
      currencyLocale: db.currency_locale,
      paymentGateway: db.payment_gateway as PaymentGatewayName,
      phoneDigits: db.phone_digits,
      phonePattern: db.phone_pattern ? new RegExp(db.phone_pattern) : /./,
      phonePlaceholder: db.phone_placeholder,
      cities: db.cities,
    };
  }
  return COUNTRIES[code as keyof typeof COUNTRIES] ?? COUNTRIES.NG;
}

// ── Multi-Country Helpers ──

/** Format currency for a given country */
export function formatCurrency(amount: number, countryCode: CountryCode = 'NG'): string {
  const c = _getCountryConfig(countryCode);
  const fractionDigits = ['NGN', 'GHS'].includes(c.currencyCode) ? 0 : 2;
  return new Intl.NumberFormat(c.currencyLocale, {
    style: 'currency',
    currency: c.currencyCode,
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
  const dbCountry = _getCountryFromDb(countryCode);
  const cp = dbCountry?.pricing && Object.keys(dbCountry.pricing).length > 0
    ? dbCountry.pricing as Record<string, { price: number; feeFlat: number }>
    : COUNTRY_PRICING[countryCode as keyof typeof COUNTRY_PRICING] ?? COUNTRY_PRICING.NG;
  const fmt = (amt: number) => formatCurrency(amt, countryCode);

  return {
    free: {
      ...PRICING_TIERS.free,
      price: 0,
      feeFlat: cp.free.feeFlat,
      features: [
        ...TIER_FEATURES.free.highlights,
        `${TIER_FEATURES.free.feePercentage}% + ${fmt(cp.free.feeFlat)} per transaction after trial`,
      ],
    },
    growth: {
      ...PRICING_TIERS.growth,
      price: cp.growth.price,
      feeFlat: cp.growth.feeFlat,
      features: [
        ...TIER_FEATURES.growth.highlights,
        `${TIER_FEATURES.growth.feePercentage}% + ${fmt(cp.growth.feeFlat)} per transaction`,
      ],
    },
    business: {
      ...PRICING_TIERS.business,
      price: cp.business.price,
      feeFlat: cp.business.feeFlat,
      features: [
        ...TIER_FEATURES.business.highlights,
        `${TIER_FEATURES.business.feePercentage}% + ${fmt(cp.business.feeFlat)} per transaction`,
      ],
    },
  };
}

/** Get locale string for date formatting */
export function getLocale(countryCode: CountryCode = 'NG'): string {
  return _getCountryConfig(countryCode).currencyLocale;
}

/** Get cities for a country */
export function getCitiesForCountry(countryCode: CountryCode = 'NG') {
  const dbCountry = _getCountryFromDb(countryCode);
  if (dbCountry?.cities && Object.keys(dbCountry.cities).length > 0) return dbCountry.cities;
  return _getCountryConfig(countryCode).cities;
}

/** Get the payment gateway for a country */
export function getPaymentGatewayForCountry(countryCode: CountryCode = 'NG'): PaymentGatewayName {
  const dbCountry = _getCountryFromDb(countryCode);
  if (dbCountry) return dbCountry.payment_gateway as PaymentGatewayName;
  return _getCountryConfig(countryCode).paymentGateway;
}

// ── Verification / KYC Configuration ──

export type VerificationLevel = 'unverified' | 'basic' | 'standard' | 'full';

interface VerificationTier {
  label: string;
  limit: number; // monthly payout limit in local currency; 999999999 = unlimited
  requirements: string;
}

const VERIFICATION_TIERS: Record<CountryCode, Record<VerificationLevel, VerificationTier>> = {
  NG: {
    unverified: { label: 'Unverified', limit: 0, requirements: 'Just signed up' },
    basic: { label: 'Basic', limit: 500_000, requirements: 'Email + Phone + Bank verified' },
    standard: { label: 'Standard', limit: 5_000_000, requirements: '+ Business document (CAC/license)' },
    full: { label: 'Full', limit: 999_999_999, requirements: '+ Government ID + Address proof' },
  },
  US: {
    unverified: { label: 'Unverified', limit: 0, requirements: 'Just signed up' },
    basic: { label: 'Basic', limit: 5_000, requirements: 'Email + Phone + Bank verified' },
    standard: { label: 'Standard', limit: 50_000, requirements: '+ Business document (EIN/license)' },
    full: { label: 'Full', limit: 999_999_999, requirements: '+ Government ID + Address proof' },
  },
  GB: {
    unverified: { label: 'Unverified', limit: 0, requirements: 'Just signed up' },
    basic: { label: 'Basic', limit: 4_000, requirements: 'Email + Phone + Bank verified' },
    standard: { label: 'Standard', limit: 40_000, requirements: '+ Business document (Companies House/license)' },
    full: { label: 'Full', limit: 999_999_999, requirements: '+ Government ID + Address proof' },
  },
  CA: {
    unverified: { label: 'Unverified', limit: 0, requirements: 'Just signed up' },
    basic: { label: 'Basic', limit: 7_000, requirements: 'Email + Phone + Bank verified' },
    standard: { label: 'Standard', limit: 70_000, requirements: '+ Business document (BN/license)' },
    full: { label: 'Full', limit: 999_999_999, requirements: '+ Government ID + Address proof' },
  },
  GH: {
    unverified: { label: 'Unverified', limit: 0, requirements: 'Just signed up' },
    basic: { label: 'Basic', limit: 50_000, requirements: 'Email + Phone + Bank verified' },
    standard: { label: 'Standard', limit: 500_000, requirements: '+ Business document (RGD certificate/license)' },
    full: { label: 'Full', limit: 999_999_999, requirements: '+ Government ID + Address proof' },
  },
};

export function getVerificationTiers(countryCode: CountryCode = 'NG') {
  const dbCountry = _getCountryFromDb(countryCode);
  if (dbCountry?.verification_tiers && Object.keys(dbCountry.verification_tiers).length > 0) {
    return dbCountry.verification_tiers as Record<VerificationLevel, VerificationTier>;
  }
  return VERIFICATION_TIERS[countryCode as keyof typeof VERIFICATION_TIERS] ?? VERIFICATION_TIERS.NG;
}

export function getPayoutLimit(countryCode: CountryCode = 'NG', level: VerificationLevel = 'unverified'): number {
  const tiers = getVerificationTiers(countryCode);
  return tiers[level]?.limit ?? 0;
}

export function formatPayoutLimit(countryCode: CountryCode = 'NG', level: VerificationLevel = 'unverified'): string {
  const limit = getPayoutLimit(countryCode, level);
  if (limit === 0) return 'No payouts';
  if (limit >= 999_999_999) return 'Unlimited';
  return formatCurrency(limit, countryCode);
}

// Per-country document types for KYC verification
export interface DocTypeConfig {
  key: string;
  label: string;
  desc: string;
}

const COUNTRY_DOC_TYPES: Record<CountryCode, DocTypeConfig[]> = {
  NG: [
    { key: 'cac_certificate', label: 'CAC Certificate', desc: 'Certificate of incorporation from CAC' },
    { key: 'business_license', label: 'Business License', desc: 'State or local business license' },
    { key: 'government_id', label: 'Government ID', desc: 'National ID, voter\'s card, or driver\'s license' },
    { key: 'utility_bill', label: 'Utility Bill', desc: 'Recent utility bill showing business address' },
    { key: 'tin_certificate', label: 'TIN Certificate', desc: 'Tax Identification Number certificate' },
  ],
  US: [
    { key: 'ein_letter', label: 'EIN Letter', desc: 'IRS EIN confirmation letter (CP 575)' },
    { key: 'business_license', label: 'Business License', desc: 'State or local business license' },
    { key: 'government_id', label: 'Government ID', desc: 'Driver\'s license, passport, or state ID' },
    { key: 'utility_bill', label: 'Utility Bill', desc: 'Recent utility bill showing business address' },
    { key: 'articles_of_incorporation', label: 'Articles of Incorporation', desc: 'State-filed articles of incorporation' },
  ],
  GB: [
    { key: 'companies_house', label: 'Companies House Certificate', desc: 'Certificate of incorporation from Companies House' },
    { key: 'business_license', label: 'Business License', desc: 'Local authority business license' },
    { key: 'government_id', label: 'Government ID', desc: 'Passport or UK driving licence' },
    { key: 'utility_bill', label: 'Utility Bill', desc: 'Recent utility bill showing business address' },
    { key: 'hmrc_registration', label: 'HMRC Registration', desc: 'HMRC tax registration document' },
  ],
  CA: [
    { key: 'bn_certificate', label: 'Business Number Certificate', desc: 'CRA Business Number registration' },
    { key: 'business_license', label: 'Business License', desc: 'Provincial or municipal business license' },
    { key: 'government_id', label: 'Government ID', desc: 'Driver\'s licence, passport, or provincial ID' },
    { key: 'utility_bill', label: 'Utility Bill', desc: 'Recent utility bill showing business address' },
    { key: 'articles_of_incorporation', label: 'Articles of Incorporation', desc: 'Federal or provincial incorporation docs' },
  ],
  GH: [
    { key: 'rgd_certificate', label: 'RGD Certificate', desc: 'Registrar General\'s Department certificate' },
    { key: 'business_license', label: 'Business License', desc: 'District assembly business license' },
    { key: 'government_id', label: 'Government ID', desc: 'Ghana Card, passport, or voter\'s ID' },
    { key: 'utility_bill', label: 'Utility Bill', desc: 'Recent utility bill showing business address' },
    { key: 'tin_certificate', label: 'TIN Certificate', desc: 'GRA Tax Identification Number certificate' },
  ],
};

export function getDocTypesForCountry(countryCode: CountryCode = 'NG'): DocTypeConfig[] {
  const dbCountry = _getCountryFromDb(countryCode);
  if (dbCountry?.doc_types && dbCountry.doc_types.length > 0) return dbCountry.doc_types;
  return COUNTRY_DOC_TYPES[countryCode as keyof typeof COUNTRY_DOC_TYPES] ?? COUNTRY_DOC_TYPES.NG;
}

export function getDocTypeLabel(countryCode: CountryCode, key: string): string {
  const docs = getDocTypesForCountry(countryCode);
  const dt = docs.find(d => d.key === key);
  return dt?.label || key.replace(/_/g, ' ');
}
