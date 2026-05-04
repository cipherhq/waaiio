/**
 * Tooltip text for dashboard pages and features.
 * Used by PageHeader and other components to help users understand features.
 */

export const PAGE_TOOLTIPS: Record<string, string> = {
  // Main
  overview: 'Your business at a glance — bookings, revenue, and quick actions.',

  // Commerce
  services: 'Add the services or products you offer. These appear in your WhatsApp bot when customers want to book or order.',
  bookings: 'All appointments and bookings made through WhatsApp. You can confirm, cancel, or reschedule from here.',
  calendar: 'Visual calendar view of all your bookings. Drag to reschedule.',
  orders: 'Customer orders placed through your WhatsApp bot. Track status and manage fulfillment.',
  invoices: 'Create and send invoices via WhatsApp. Customers receive a payment link in chat. Supports recurring invoices.',
  products: 'Your product catalog for ordering businesses. Add items with prices, images, and variants.',
  queue: 'Walk-in queue management. Customers check in via WhatsApp, see their position, and get notified when it\'s their turn.',
  waitlist: 'When you\'re fully booked, customers can join a waitlist and get notified when a slot opens.',
  loyalty: 'Points-based loyalty program. Customers earn points per booking/purchase and redeem for rewards.',
  referral: 'Referral program — customers share a link, and both referrer and new customer get rewards.',
  feedback: 'Customer ratings and reviews collected after service. Track your star rating and respond to feedback.',
  chat: 'Live two-way messaging with customers. The bot handles routine questions; you handle the rest.',

  // Waaiio Sign
  contracts: 'Send documents for e-signature via WhatsApp. Customers review and sign directly in chat.',

  // Finance
  payouts: 'Connect your bank account or Stripe to receive payments. See your balance and payout history.',
  financials: 'Revenue analytics — track income, platform fees, and trends over time.',

  // Marketing
  broadcasts: 'Send WhatsApp messages to all or selected customers. Great for promotions, updates, and announcements.',
  sequences: 'Automated message sequences — follow up with customers after booking, purchase, or sign-up.',
  keywords: 'Custom keyword triggers for your bot. When a customer types a keyword, the bot responds with your custom message.',
  analytics: 'Detailed analytics — daily bookings, revenue trends, top services, peak hours, and customer insights.',

  // Settings
  whatsapp: 'Customize your WhatsApp bot — greeting message, assistant name, welcome buttons, and response templates.',
  'whatsapp-usage': 'Track your WhatsApp messaging usage — conversations, messages sent/received, and delivery rates.',
  'whatsapp/templates': 'WhatsApp message templates for proactive outreach — reminders, confirmations, and marketing messages.',
  integrations: 'Connect Waaiio to your existing tools via webhooks. Receive real-time events when bookings, payments, or orders happen.',
  'bot-flows': 'Visual flow editor — customize your bot\'s conversation paths without code.',
  'qr-code': 'Your unique WhatsApp link and QR code. Share on social media, print for your shop, or add to your website.',
  pages: 'Manage your business\'s public pages — terms of service, privacy policy, and custom landing pages.',
  settings: 'Business settings — name, address, operating hours, capabilities, and subscription plan.',
  capabilities: 'Enable or disable features for your business. Each capability adds new functionality to your bot and dashboard.',
  help: 'Find answers to common questions about using Waaiio.',
  support: 'Submit support tickets or chat with us on WhatsApp for help.',
  reservations: 'Manage guest reservations with check-in/out dates, nightly rates, and payment tracking.',
  guests: 'View all guests who have booked with your business.',
  staff: 'Manage your team — assign services, set schedules, and track performance.',
  'promo-codes': 'Create discount codes for promotions.',
  recurring: 'Manage recurring payments and subscriptions from your customers.',
  campaigns: 'Run crowdfunding campaigns with goals and donor tracking.',
  events: 'Create and manage events with ticket sales and QR code check-in.',
  tickets: 'View and manage event ticket sales.',
  notifications: 'View system notifications and alerts for your business.',
  locations: 'Manage multiple business locations.',
  surveys: 'Create custom surveys and send them to customers via WhatsApp. Track responses and analyze results.',
  polls: 'Create quick polls and let customers vote via WhatsApp. See live results with visual charts.',
  'setup-assistant': 'Ace is your AI assistant. Describe your business or upload a menu photo — Ace creates your services, products, hours, and bot greeting automatically.',
  verification: 'Verify your business to unlock higher payout limits.',
};
