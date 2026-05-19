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
  membership: 'Automatic membership tiers based on customer spending. Reward your best customers with discounts and bonus points.',
  referral: 'Referral program — customers share a link, and both referrer and new customer get rewards.',
  feedback: 'Customer ratings and reviews collected after service. Track your star rating and respond to feedback.',
  chat: 'Live two-way messaging with customers. The bot handles routine questions; you handle the rest.',

  // Waaiio Sign
  contracts: 'Send documents for e-signature via WhatsApp. Customers review and sign directly in chat.',

  // Finance
  payouts: 'Connect your bank account or Stripe to receive payments. See your balance and payout history.',
  financials: 'Revenue analytics — track income, platform fees, and trends over time.',

  // Grow (Marketing)
  broadcasts: 'Send WhatsApp messages to all or selected customers. Great for promotions, updates, and announcements.',
  sequences: 'Automated follow-up messages — send a series of messages after a booking, purchase, or sign-up. Set delays between each message.',
  keywords: 'Auto-responses for your bot. When a customer types a specific word, your bot replies with a custom message automatically.',
  rules: 'Set up automations — when something happens (new booking, payment, etc.), automatically trigger an action (send message, tag customer, notify staff).',
  referrals: 'Referral program — your customers share a link, and both the referrer and new customer earn rewards when the new person books.',
  analytics: 'See how your business is performing — daily bookings, revenue trends, top services, peak hours, and customer insights.',
  insights: 'Smart business insights — customer retention, revenue forecasts, peak hours, and actionable recommendations.',
  'whatsapp-usage': 'Track your WhatsApp messaging usage — conversations, messages sent/received, and delivery rates.',
  surveys: 'Create custom surveys and send them to customers via WhatsApp. Track responses and analyze results.',
  polls: 'Create quick polls and let customers vote via WhatsApp. See live results with visual charts.',
  'qr-code': 'Your unique WhatsApp link and QR code. Share on social media, print for your shop, or add to your website.',

  // Settings
  whatsapp: 'Customize your WhatsApp bot — greeting message, assistant name, welcome buttons, and response templates.',
  'whatsapp/templates': 'WhatsApp message templates for proactive outreach — reminders, confirmations, and marketing messages.',
  'flow-editor': 'Customize your bot\'s conversation steps — change what it says, add conditions, and personalize the experience.',
  faq: 'Add frequently asked questions and answers. Your bot will automatically respond when customers ask matching questions.',
  integrations: 'Connect Waaiio to your existing tools via webhooks. Receive real-time events when bookings, payments, or orders happen.',
  settings: 'Business settings — name, address, operating hours, payment gateway, auto-reply, notifications, and account.',
  capabilities: 'Turn features on or off for your business. Each feature adds new options to your bot and dashboard.',
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
  giving: 'Collect tithes, offerings, and donations via WhatsApp. Members choose their giving category and enter an amount.',
  'setup-assistant': 'Step-by-step guide to set up your business. Add your services, connect WhatsApp, and test your bot.',
  verification: 'Verify your business to unlock higher payout limits and build customer trust.',
  activity: 'Recent activity across your business — new bookings, payments, orders, and customer interactions.',
  'appointments-management': 'Manage your bookable appointments — set duration, price, staff, and availability. Customers see these when booking on WhatsApp.',
  properties: 'Manage your rooms, apartments, or vehicles for rent. Set pricing, photos, amenities, and blocked dates.',
  'orders/quotes': 'Customer price requests. Review what they want, send your quoted price, and they can accept or reject.',
  'events/scan': 'Scan ticket QR codes with your phone camera to check in guests at events.',
  'events/invites': 'Send party invitations via WhatsApp and track RSVPs — who\'s coming, maybe, or declined.',
  parties: 'Create standalone party invites. Send via WhatsApp, track RSVPs, manage your guest list.',
  'payment-request': 'Send a payment link to any customer via WhatsApp. They click and pay instantly — no invoice needed.',
  reports: 'Upload and share documents with customers via WhatsApp. Customers access with phone verification.',
  forms: 'Build custom forms and send them to customers via WhatsApp. Collect information, applications, or feedback.',
  members: 'Invite team members with specific roles to access your dashboard.',
};

/**
 * Field-level tooltips for form inputs.
 * Used alongside form labels to explain what a field does.
 */
export const FIELD_TOOLTIPS: Record<string, string> = {
  // Services
  'service.duration': 'How long the appointment takes. Used to calculate available time slots and prevent overlapping bookings.',
  'service.buffer': 'Cleanup or prep time between appointments. A 30-min service with 10-min buffer blocks 40 minutes total.',
  'service.deposit': 'Amount collected upfront when a customer books. Can be the full price or a partial deposit.',
  'service.deposit_percentage': 'Percentage of the service price to collect as a deposit. For example, 50% of a $100 service = $50 deposit.',
  'service.max_capacity': 'How many customers can book the same time slot. Set to 1 for one-on-one services, higher for classes or group sessions.',
  'service.auto_approve': 'When on, bookings are confirmed instantly. When off, you must manually approve each booking from the calendar.',
  'service.available_days': 'Which days this service is available. Customers can only book on these days.',
  'service.staff_selection': 'When on, customers can choose which staff member they want. When off, the system assigns the least busy staff.',
  'service.quote_enabled': 'When on, customers can request a price quote instead of booking directly. You review and send your price.',
  'service.variable_price': 'When on, you set a starting price but the final amount can vary. Useful for "starting from" pricing.',

  // Products
  'product.variants': 'Different options for the same product — like sizes (S, M, L) or colors. Each variant can have its own price and stock.',
  'product.track_inventory': 'When on, stock decreases with each order. Products auto-hide when stock reaches zero.',
  'product.min_order_qty': 'Minimum quantity a customer must order. Useful for wholesale or bulk items.',

  // Business settings
  'settings.operating_hours': 'When your business is open. The bot only shows time slots within these hours.',
  'settings.payment_gateway': 'Which payment provider handles your transactions. Choose based on your country and preference.',
  'settings.payout_mode': 'Direct Split: payment is split automatically at checkout. Platform Managed: we collect 100% and pay you weekly.',
  'settings.bot_persona': 'Give your bot a name and personality. Customers see this name instead of "Waaiio" when chatting.',
  'settings.auto_reply': 'Automatic response when a customer messages outside your operating hours or when the bot doesn\'t understand.',

  // Events
  'event.ticket_types': 'Different ticket categories — like Regular, VIP, or Early Bird. Each can have its own price and quantity limit.',
  'event.venue': 'Where the event takes place. This is shown on the ticket and in the booking confirmation.',

  // Invoices
  'invoice.partial_payment': 'When enabled, customers can pay part of the invoice now and the rest later.',
  'invoice.due_date': 'Deadline for payment. The bot sends reminders as the due date approaches.',

  // Payouts
  'payout.subaccount': 'Your bank account linked to the payment gateway. Earnings are deposited here.',
  'payout.platform_fee': 'The percentage Waaiio takes per transaction. Depends on your subscription tier: Starter 2%, Pro 1.5%, Premium 1%.',

  // Loyalty
  'loyalty.points_per_visit': 'How many points a customer earns per booking or purchase. More points = faster rewards.',
  'loyalty.redemption_value': 'What points are worth in your currency. For example, 100 points = $1 off.',

  // Broadcasts
  'broadcast.segment': 'Who receives the message. "All" sends to everyone. "VIP" sends to your top spenders. "Dormant" targets customers who haven\'t visited recently.',
};
