-- Add admin-configurable content settings
INSERT INTO platform_settings (key, value, description) VALUES
(
  'hero_content',
  '{"badge":"Every message handled. Every opportunity captured.","headline":"Your WhatsApp. Now 10x Smarter.","subheadline":"Automate bookings, payments, orders, and engagement on WhatsApp — for any business, any industry, any country."}',
  'Landing page hero section content (badge, headline, subheadline)'
),
(
  'contact_emails',
  '{"general":"hello@waaiio.com","dpo":"dpo@waaiio.com","abuse":"abuse@waaiio.com","privacy":"privacy@waaiio.com"}',
  'Contact email addresses shown on contact and legal pages'
),
(
  'social_links',
  '{"twitter":"","linkedin":"","instagram":"","facebook":"","whatsapp":""}',
  'Social media profile URLs for website footer'
),
(
  'whatsapp_shared_numbers',
  '{"NG":"12029226251","US":"12029226251","GB":"12029226251","CA":"12029226251","GH":"12029226251"}',
  'Shared WhatsApp numbers per country for Starter tier businesses'
),
(
  'default_greetings',
  '{"barber":"Welcome to {name}! 💈 I can help you book an appointment.","restaurant":"Welcome to {name}! 🍽️ I can help you book a table.","church":"Welcome to {name}! 🙏 How can I help you today?","shop":"Welcome to {name}! 🛍️ Browse our products.","default":"Welcome to {name}! How can I help you today?"}',
  'Default bot greetings per business category. Use {name} for business name.'
),
(
  'directory_featured',
  '[]',
  'Array of business IDs to feature/pin at top of directory'
),
(
  'directory_hidden',
  '[]',
  'Array of business IDs to hide from the public directory'
)
ON CONFLICT (key) DO NOTHING;
