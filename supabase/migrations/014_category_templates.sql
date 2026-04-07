-- ═══════════════════════════════════════════════════════
-- 014: Category Templates — Admin-managed business templates
-- ═══════════════════════════════════════════════════════

CREATE TABLE public.category_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  icon VARCHAR(10) NOT NULL DEFAULT '🔧',
  flow_type flow_type NOT NULL DEFAULT 'scheduling',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Default services (JSONB array)
  default_services JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Bot greeting template (uses {{name}} placeholder)
  default_greeting TEXT NOT NULL DEFAULT 'Welcome to {{name}}! How can I help you today?',

  -- UI labels
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE public.category_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_category_templates" ON public.category_templates
  FOR ALL USING (public.is_admin());

CREATE POLICY "anyone_can_read_active_templates" ON public.category_templates
  FOR SELECT USING (is_active = true);

-- ── Seed all 41 categories ──
INSERT INTO public.category_templates (key, label, icon, flow_type, sort_order, default_services, default_greeting, labels)
VALUES
  ('restaurant', 'Restaurant', '🍽️', 'scheduling', 0,
   '[{"name":"Table Reservation","price":0,"price_is_variable":false,"duration_minutes":120,"deposit_amount":0}]',
   'Welcome to {{name}}! I can help you book a table. When would you like to dine?',
   '{"entityName":"reservation","entityNamePlural":"reservations","actionVerb":"Book","confirmationEmoji":"🍽️","receiptTitle":"Booking Confirmed","quantityLabel":"guests","personLabel":"Guest","personLabelPlural":"Guests","hiddenStatuses":[]}'),

  ('barber', 'Barbershop', '💈', 'scheduling', 1,
   '[{"name":"Haircut","price":3000,"price_is_variable":false,"duration_minutes":30,"deposit_amount":0},{"name":"Beard Trim","price":1500,"price_is_variable":false,"duration_minutes":15,"deposit_amount":0},{"name":"Full Grooming","price":5000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0}]',
   'Welcome to {{name}}! 💈 I can help you book an appointment. What service would you like?',
   '{"entityName":"appointment","entityNamePlural":"appointments","actionVerb":"Book","confirmationEmoji":"💈","receiptTitle":"Appointment Confirmed","quantityLabel":"people","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('spa', 'Spa', '🧖', 'scheduling', 2,
   '[{"name":"Full Body Massage","price":15000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":5000},{"name":"Facial Treatment","price":10000,"price_is_variable":false,"duration_minutes":45,"deposit_amount":3000}]',
   'Welcome to {{name}}! ✨ I can help you book a session. What would you like?',
   '{"entityName":"appointment","entityNamePlural":"appointments","actionVerb":"Book","confirmationEmoji":"🧖","receiptTitle":"Appointment Confirmed","quantityLabel":"people","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('salon', 'Hair Salon', '💇', 'scheduling', 3,
   '[{"name":"Haircut & Styling","price":5000,"price_is_variable":false,"duration_minutes":45,"deposit_amount":0},{"name":"Braiding","price":10000,"price_is_variable":false,"duration_minutes":120,"deposit_amount":3000},{"name":"Manicure & Pedicure","price":5000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0}]',
   'Welcome to {{name}}! ✨ I can help you book a session. What would you like?',
   '{"entityName":"appointment","entityNamePlural":"appointments","actionVerb":"Book","confirmationEmoji":"💇","receiptTitle":"Appointment Confirmed","quantityLabel":"people","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('gym', 'Gym / Fitness', '🏋️', 'scheduling', 4,
   '[{"name":"Personal Training","price":10000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0},{"name":"Group Class","price":3000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0}]',
   'Welcome to {{name}}! 🏋️ I can help you book a session. What would you like?',
   '{"entityName":"session","entityNamePlural":"sessions","actionVerb":"Book","confirmationEmoji":"🏋️","receiptTitle":"Session Confirmed","quantityLabel":"people","personLabel":"Member","personLabelPlural":"Members","hiddenStatuses":[]}'),

  ('clinic', 'Clinic / Hospital', '🏥', 'scheduling', 5,
   '[{"name":"Consultation","price":10000,"price_is_variable":false,"duration_minutes":30,"deposit_amount":5000},{"name":"Check-up","price":20000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":10000}]',
   'Welcome to {{name}}! 🏥 I can help you book an appointment. What service do you need?',
   '{"entityName":"appointment","entityNamePlural":"appointments","actionVerb":"Book","confirmationEmoji":"🏥","receiptTitle":"Appointment Confirmed","quantityLabel":"patients","personLabel":"Patient","personLabelPlural":"Patients","hiddenStatuses":[]}'),

  ('consultant', 'Consultant', '💼', 'scheduling', 6,
   '[{"name":"Consultation Session","price":25000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":10000}]',
   'Welcome to {{name}}! 💼 I can help you schedule a consultation. When works for you?',
   '{"entityName":"consultation","entityNamePlural":"consultations","actionVerb":"Book","confirmationEmoji":"💼","receiptTitle":"Consultation Confirmed","quantityLabel":"attendees","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('church', 'Church', '⛪', 'payment', 7,
   '[{"name":"Tithe","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Offering","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Building Fund","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Welfare","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 🙏 I can help you make payments. What would you like to pay for?',
   '{"entityName":"payment","entityNamePlural":"payments","actionVerb":"Pay","confirmationEmoji":"⛪","receiptTitle":"Payment Received","quantityLabel":"amount","personLabel":"Member","personLabelPlural":"Members","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('mosque', 'Mosque', '🕌', 'payment', 8,
   '[{"name":"Zakat","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Sadaqah","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Fitrah","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 🙏 I can help you make payments. What would you like to pay for?',
   '{"entityName":"payment","entityNamePlural":"payments","actionVerb":"Pay","confirmationEmoji":"🕌","receiptTitle":"Payment Received","quantityLabel":"amount","personLabel":"Member","personLabelPlural":"Members","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('school', 'School', '🎓', 'payment', 9,
   '[{"name":"School Fees","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"PTA Dues","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Exam Fees","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 🎓 I can help you make payments. Select a category to proceed.',
   '{"entityName":"payment","entityNamePlural":"payments","actionVerb":"Pay","confirmationEmoji":"🎓","receiptTitle":"Payment Received","quantityLabel":"amount","personLabel":"Student","personLabelPlural":"Students","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('ngo', 'NGO / Charity', '🤝', 'payment', 10,
   '[{"name":"Donation","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Membership","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 🤝 Thank you for your generosity. How would you like to contribute?',
   '{"entityName":"donation","entityNamePlural":"donations","actionVerb":"Donate","confirmationEmoji":"🤝","receiptTitle":"Donation Received","quantityLabel":"amount","personLabel":"Donor","personLabelPlural":"Donors","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('shop', 'Shop / Retail', '🛍️', 'ordering', 11,
   '[]',
   'Welcome to {{name}}! 🛍️ Browse our products and place an order.',
   '{"entityName":"order","entityNamePlural":"orders","actionVerb":"Order","confirmationEmoji":"🛍️","receiptTitle":"Order Confirmed","quantityLabel":"items","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('food_delivery', 'Food Delivery', '🛵', 'ordering', 12,
   '[]',
   'Welcome to {{name}}! 🛍️ Browse our products and place an order.',
   '{"entityName":"order","entityNamePlural":"orders","actionVerb":"Order","confirmationEmoji":"🛵","receiptTitle":"Order Confirmed","quantityLabel":"items","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('events', 'Events', '🎪', 'ticketing', 13,
   '[]',
   'Welcome to {{name}}! 🎪 Check out our upcoming events and get your tickets!',
   '{"entityName":"ticket","entityNamePlural":"tickets","actionVerb":"Buy","confirmationEmoji":"🎪","receiptTitle":"Tickets Confirmed","quantityLabel":"tickets","personLabel":"Attendee","personLabelPlural":"Attendees","hiddenStatuses":["no_show","in_progress"]}'),

  ('transport', 'Transport', '🚌', 'ticketing', 14,
   '[]',
   'Welcome to {{name}}! 🚌 I can help you book transport tickets. Where are you headed?',
   '{"entityName":"ticket","entityNamePlural":"tickets","actionVerb":"Buy","confirmationEmoji":"🚌","receiptTitle":"Ticket Confirmed","quantityLabel":"seats","personLabel":"Attendee","personLabelPlural":"Attendees","hiddenStatuses":["no_show","in_progress"]}'),

  ('cinema', 'Cinema', '🎬', 'ticketing', 15,
   '[]',
   'Welcome to {{name}}! 🎬 I can help you get movie tickets. What would you like to see?',
   '{"entityName":"ticket","entityNamePlural":"tickets","actionVerb":"Buy","confirmationEmoji":"🎬","receiptTitle":"Ticket Confirmed","quantityLabel":"seats","personLabel":"Attendee","personLabelPlural":"Attendees","hiddenStatuses":["no_show","in_progress"]}'),

  ('car_park', 'Parking', '🅿️', 'payment', 16,
   '[{"name":"Hourly Parking","price":500,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0},{"name":"Daily Parking","price":3000,"price_is_variable":false,"duration_minutes":null,"deposit_amount":0},{"name":"Monthly Pass","price":30000,"price_is_variable":false,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 🅿️ I can help you with parking. What do you need?',
   '{"entityName":"parking","entityNamePlural":"parking passes","actionVerb":"Pay","confirmationEmoji":"🅿️","receiptTitle":"Parking Paid","quantityLabel":"vehicles","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('tattoo', 'Tattoo Shop', '🎨', 'scheduling', 17,
   '[{"name":"Small Tattoo","price":15000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":5000},{"name":"Medium Tattoo","price":35000,"price_is_variable":false,"duration_minutes":120,"deposit_amount":10000},{"name":"Consultation","price":0,"price_is_variable":false,"duration_minutes":30,"deposit_amount":0}]',
   'Welcome to {{name}}! 🎨 I can help you book an appointment. What are you looking for?',
   '{"entityName":"appointment","entityNamePlural":"appointments","actionVerb":"Book","confirmationEmoji":"🎨","receiptTitle":"Appointment Confirmed","quantityLabel":"sessions","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('real_estate', 'Real Estate', '🏠', 'scheduling', 18,
   '[{"name":"Property Viewing","price":0,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0},{"name":"Consultation","price":10000,"price_is_variable":false,"duration_minutes":45,"deposit_amount":0}]',
   'Welcome to {{name}}! 🏠 I can help you schedule a property viewing. What are you interested in?',
   '{"entityName":"viewing","entityNamePlural":"viewings","actionVerb":"Book","confirmationEmoji":"🏠","receiptTitle":"Viewing Confirmed","quantityLabel":"viewings","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('travel_agency', 'Travel Agency', '✈️', 'scheduling', 19,
   '[{"name":"Travel Consultation","price":5000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0}]',
   'Welcome to {{name}}! ✈️ I can help you plan your trip. Where would you like to go?',
   '{"entityName":"booking","entityNamePlural":"bookings","actionVerb":"Book","confirmationEmoji":"✈️","receiptTitle":"Booking Confirmed","quantityLabel":"travelers","personLabel":"Traveler","personLabelPlural":"Travelers","hiddenStatuses":[]}'),

  ('logistics', 'Logistics & Shipping', '🚚', 'ordering', 20,
   '[]',
   'Welcome to {{name}}! 🚚 I can help you with shipping. What do you need to send?',
   '{"entityName":"shipment","entityNamePlural":"shipments","actionVerb":"Order","confirmationEmoji":"🚚","receiptTitle":"Shipment Confirmed","quantityLabel":"packages","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('taxi', 'Taxi & Ride-Hailing', '🚕', 'payment', 21,
   '[{"name":"Ride Payment","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 🚕 I can help you with ride payments.',
   '{"entityName":"ride","entityNamePlural":"rides","actionVerb":"Pay","confirmationEmoji":"🚕","receiptTitle":"Ride Payment","quantityLabel":"rides","personLabel":"Rider","personLabelPlural":"Riders","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('government', 'Government & Utilities', '🏛️', 'payment', 22,
   '[{"name":"Utility Bill","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Application Fee","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 🏛️ I can help you make payments. What would you like to pay for?',
   '{"entityName":"payment","entityNamePlural":"payments","actionVerb":"Pay","confirmationEmoji":"🏛️","receiptTitle":"Payment Received","quantityLabel":"amount","personLabel":"Citizen","personLabelPlural":"Citizens","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('instagram_vendor', 'Online Vendor', '🛒', 'ordering', 23,
   '[]',
   'Welcome to {{name}}! 🛒 Browse our products and place an order.',
   '{"entityName":"order","entityNamePlural":"orders","actionVerb":"Order","confirmationEmoji":"🛒","receiptTitle":"Order Confirmed","quantityLabel":"items","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('crowdfunding_org', 'Crowdfunding', '❤️', 'payment', 24,
   '[]',
   'Welcome to {{name}}! ❤️ Thank you for your support. How would you like to contribute?',
   '{"entityName":"donation","entityNamePlural":"donations","actionVerb":"Donate","confirmationEmoji":"❤️","receiptTitle":"Donation Received","quantityLabel":"amount","personLabel":"Donor","personLabelPlural":"Donors","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('laundry', 'Laundry & Dry Cleaning', '👔', 'scheduling', 25,
   '[{"name":"Wash & Fold","price":3000,"price_is_variable":false,"duration_minutes":null,"deposit_amount":0},{"name":"Dry Cleaning","price":5000,"price_is_variable":false,"duration_minutes":null,"deposit_amount":0},{"name":"Ironing Only","price":1500,"price_is_variable":false,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}! 👔 I can help you schedule a pickup. What service do you need?',
   '{"entityName":"pickup","entityNamePlural":"pickups","actionVerb":"Book","confirmationEmoji":"👔","receiptTitle":"Pickup Confirmed","quantityLabel":"items","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('veterinary', 'Veterinary', '🐾', 'scheduling', 26,
   '[{"name":"Consultation","price":10000,"price_is_variable":false,"duration_minutes":30,"deposit_amount":3000},{"name":"Vaccination","price":8000,"price_is_variable":false,"duration_minutes":15,"deposit_amount":0},{"name":"Grooming","price":5000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0}]',
   'Welcome to {{name}}! 🐾 I can help you book an appointment for your pet. What do you need?',
   '{"entityName":"appointment","entityNamePlural":"appointments","actionVerb":"Book","confirmationEmoji":"🐾","receiptTitle":"Appointment Confirmed","quantityLabel":"pets","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('dental', 'Dental Clinic', '🦷', 'scheduling', 27,
   '[{"name":"Check-up","price":10000,"price_is_variable":false,"duration_minutes":30,"deposit_amount":5000},{"name":"Cleaning","price":15000,"price_is_variable":false,"duration_minutes":45,"deposit_amount":5000},{"name":"Filling","price":25000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":10000}]',
   'Welcome to {{name}}! 🦷 I can help you book a dental appointment. What do you need?',
   '{"entityName":"appointment","entityNamePlural":"appointments","actionVerb":"Book","confirmationEmoji":"🦷","receiptTitle":"Appointment Confirmed","quantityLabel":"patients","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('coworking', 'Coworking Space', '🏢', 'scheduling', 28,
   '[{"name":"Hot Desk (Day)","price":3000,"price_is_variable":false,"duration_minutes":480,"deposit_amount":0},{"name":"Private Office (Day)","price":10000,"price_is_variable":false,"duration_minutes":480,"deposit_amount":0},{"name":"Meeting Room (Hour)","price":5000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0}]',
   'Welcome to {{name}}! 🏢 I can help you book a workspace. What do you need?',
   '{"entityName":"booking","entityNamePlural":"bookings","actionVerb":"Book","confirmationEmoji":"🏢","receiptTitle":"Space Booked","quantityLabel":"desks","personLabel":"Member","personLabelPlural":"Members","hiddenStatuses":[]}'),

  ('tutor', 'Tutor & Coaching', '📚', 'scheduling', 29,
   '[{"name":"Private Lesson","price":10000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0},{"name":"Group Session","price":5000,"price_is_variable":false,"duration_minutes":90,"deposit_amount":0}]',
   'Welcome to {{name}}! 📚 I can help you book a lesson. What subject are you interested in?',
   '{"entityName":"session","entityNamePlural":"sessions","actionVerb":"Book","confirmationEmoji":"📚","receiptTitle":"Session Confirmed","quantityLabel":"students","personLabel":"Student","personLabelPlural":"Students","hiddenStatuses":[]}'),

  ('photographer', 'Photographer', '📷', 'scheduling', 30,
   '[{"name":"Portrait Session","price":30000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":10000},{"name":"Event Coverage","price":100000,"price_is_variable":false,"duration_minutes":240,"deposit_amount":30000}]',
   'Welcome to {{name}}! 📷 I can help you book a session. What type of photography do you need?',
   '{"entityName":"session","entityNamePlural":"sessions","actionVerb":"Book","confirmationEmoji":"📷","receiptTitle":"Session Confirmed","quantityLabel":"sessions","personLabel":"Client","personLabelPlural":"Clients","hiddenStatuses":[]}'),

  ('mall_vendor', 'Mall Vendor', '🏪', 'ordering', 31,
   '[]',
   'Welcome to {{name}}! 🏪 Browse our products and place an order.',
   '{"entityName":"order","entityNamePlural":"orders","actionVerb":"Order","confirmationEmoji":"🏪","receiptTitle":"Order Confirmed","quantityLabel":"items","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('pharmacy', 'Pharmacy', '💊', 'ordering', 32,
   '[]',
   'Welcome to {{name}}! 💊 I can help you order medications. What do you need?',
   '{"entityName":"order","entityNamePlural":"orders","actionVerb":"Order","confirmationEmoji":"💊","receiptTitle":"Order Confirmed","quantityLabel":"items","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('hotel', 'Hotel & Lodge', '🛏️', 'scheduling', 33,
   '[{"name":"Standard Room","price":25000,"price_is_variable":false,"duration_minutes":null,"deposit_amount":10000},{"name":"Deluxe Room","price":45000,"price_is_variable":false,"duration_minutes":null,"deposit_amount":15000}]',
   'Welcome to {{name}}! 🛏️ I can help you book a room. When are you checking in?',
   '{"entityName":"reservation","entityNamePlural":"reservations","actionVerb":"Book","confirmationEmoji":"🛏️","receiptTitle":"Reservation Confirmed","quantityLabel":"nights","personLabel":"Guest","personLabelPlural":"Guests","hiddenStatuses":[]}'),

  ('car_wash', 'Car Wash', '🚿', 'scheduling', 34,
   '[{"name":"Basic Wash","price":2000,"price_is_variable":false,"duration_minutes":30,"deposit_amount":0},{"name":"Full Wash & Polish","price":5000,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0},{"name":"Interior Detail","price":8000,"price_is_variable":false,"duration_minutes":90,"deposit_amount":0}]',
   'Welcome to {{name}}! 🚿 I can help you book a car wash. What service do you need?',
   '{"entityName":"booking","entityNamePlural":"bookings","actionVerb":"Book","confirmationEmoji":"🚿","receiptTitle":"Booking Confirmed","quantityLabel":"vehicles","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('catering', 'Catering', '🍳', 'ordering', 35,
   '[]',
   'Welcome to {{name}}! 🍳 I can help you place a catering order. What do you need?',
   '{"entityName":"order","entityNamePlural":"orders","actionVerb":"Order","confirmationEmoji":"🍳","receiptTitle":"Order Confirmed","quantityLabel":"servings","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('funeral', 'Funeral Services', '🌺', 'payment', 36,
   '[{"name":"Service Fee","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0},{"name":"Memorial Contribution","price":0,"price_is_variable":true,"duration_minutes":null,"deposit_amount":0}]',
   'Welcome to {{name}}. 🌺 I can help you with service arrangements and payments.',
   '{"entityName":"service","entityNamePlural":"services","actionVerb":"Pay","confirmationEmoji":"🌺","receiptTitle":"Payment Received","quantityLabel":"amount","personLabel":"Family","personLabelPlural":"Families","hiddenStatuses":["no_show","in_progress","confirmed"]}'),

  ('tailor', 'Tailor & Fashion', '✂️', 'ordering', 37,
   '[]',
   'Welcome to {{name}}! ✂️ I can help you place an order. What are you looking for?',
   '{"entityName":"order","entityNamePlural":"orders","actionVerb":"Order","confirmationEmoji":"✂️","receiptTitle":"Order Confirmed","quantityLabel":"items","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}'),

  ('other', 'Other (Custom)', '🔧', 'scheduling', 38,
   '[{"name":"General Booking","price":0,"price_is_variable":false,"duration_minutes":60,"deposit_amount":0}]',
   'Welcome to {{name}}! How can I help you today?',
   '{"entityName":"booking","entityNamePlural":"bookings","actionVerb":"Book","confirmationEmoji":"✅","receiptTitle":"Booking Confirmed","quantityLabel":"slots","personLabel":"Customer","personLabelPlural":"Customers","hiddenStatuses":[]}');
