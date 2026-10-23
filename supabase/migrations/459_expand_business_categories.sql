-- 459_expand_business_categories.sql
--
-- Owner-approved 89-category launch scope (#682).
--
-- Part 1: Extend business_category enum with 32 new values (IF NOT EXISTS — idempotent).
-- Part 2: Insert 49 new category_templates with generic default greeting.
-- Part 3: Update category_group for 18 existing categories to match approved 17-group structure.
-- Part 4: Set alphabetical sort_order within each group.
--
-- Preserves all existing businesses, merchant-customized greetings, and template configurations.
-- Existing 40 active templates retain their current labels, greetings, capabilities, and services.
--
-- NOTE: ALTER TYPE ADD VALUE cannot run inside a transaction block.
-- Each ADD VALUE auto-commits. IF NOT EXISTS makes partial re-runs safe.

-- Part 1: Extend business_category enum (32 new values)
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'bar';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'bootcamp';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'bus';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'cafe';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'content_creator';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'courier';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'dance';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'dj';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'dog_walking';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'electrician';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'food_truck';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'graphic_designer';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'handyman';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'hvac';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'landscaping';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'language_school';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'lash_tech';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'lounge';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'martial_arts';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'medspa';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'mortgage_broker';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'moving';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'optician';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'pet_boarding';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'pet_training';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'physiotherapy';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'pilates';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'property_manager';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'training_academy';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'videographer';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'waxing';
ALTER TYPE business_category ADD VALUE IF NOT EXISTS 'yoga';

-- Part 2: Insert 51 new category_templates
INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('accounting', 'Accounting & Tax', '📊', 'scheduling', 'Professional Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('bakery', 'Bakery', '🧁', 'ordering', 'Food & Dining', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('bar', 'Bar', '🍸', 'scheduling', 'Food & Dining', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('bootcamp', 'Bootcamp / CrossFit', '🔥', 'scheduling', 'Fitness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('bus', 'Bus / Train', '🚆', 'ticketing', 'Transport & Logistics', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('cafe', 'Cafe / Coffee Shop', '☕', 'scheduling', 'Food & Dining', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('car_rental', 'Car Rental', '🚙', 'reservation', 'Hospitality', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('cleaning', 'Cleaning Services', '🧹', 'scheduling', 'Home & Auto Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('content_creator', 'Content Creator', '📱', 'scheduling', 'Creative & Media', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('courier', 'Courier / Delivery', '🏍️', 'ordering', 'Transport & Logistics', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('dance', 'Dance Studio', '💃', 'scheduling', 'Fitness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('daycare', 'Daycare / Creche', '👶', 'payment', 'Education & Training', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('dj', 'DJ', '🎧', 'scheduling', 'Creative & Media', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('dog_walking', 'Dog Walking', '🦮', 'scheduling', 'Pet Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('driving_school', 'Driving School', '🚗', 'scheduling', 'Education & Training', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('electrician', 'Electrician', '⚡', 'scheduling', 'Home & Auto Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('event_services', 'Event Services & Rentals', '🎉', 'scheduling', 'Events & Entertainment', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('food_truck', 'Food Truck', '🚚', 'ordering', 'Food & Dining', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('graphic_designer', 'Graphic Designer', '🎨', 'scheduling', 'Creative & Media', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('handyman', 'Handyman', '🛠️', 'scheduling', 'Home & Auto Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('hvac', 'HVAC', '❄️', 'scheduling', 'Home & Auto Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('landscaping', 'Landscaping', '🌿', 'scheduling', 'Home & Auto Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('language_school', 'Language School', '🌍', 'scheduling', 'Education & Training', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('lash_tech', 'Lash Tech', '👁️', 'scheduling', 'Beauty & Wellness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('legal', 'Legal / Notary', '⚖️', 'scheduling', 'Professional Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('lounge', 'Lounge', '🥂', 'scheduling', 'Food & Dining', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('martial_arts', 'Martial Arts', '🥋', 'scheduling', 'Fitness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('mechanic', 'Auto Mechanic', '🔧', 'scheduling', 'Home & Auto Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('medspa', 'Med Spa', '💉', 'scheduling', 'Beauty & Wellness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('mortgage_broker', 'Mortgage Broker', '🏦', 'scheduling', 'Real Estate & Property', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('moving', 'Moving Company', '🚛', 'scheduling', 'Transport & Logistics', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('mua', 'Makeup Artist', '💄', 'scheduling', 'Beauty & Wellness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('music_studio', 'Music / Recording Studio', '🎵', 'scheduling', 'Events & Entertainment', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('nail_tech', 'Nail Tech', '💅', 'scheduling', 'Beauty & Wellness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('optician', 'Optician / Eye Care', '👓', 'scheduling', 'Health & Medical', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('pest_control', 'Pest Control', '🐜', 'scheduling', 'Home & Auto Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('pet_boarding', 'Pet Boarding', '🏠', 'scheduling', 'Pet Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('pet_grooming', 'Pet Grooming', '🐕', 'scheduling', 'Pet Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('pet_training', 'Pet Training', '🐾', 'scheduling', 'Pet Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('physiotherapy', 'Physiotherapy', '🦴', 'scheduling', 'Health & Medical', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('pilates', 'Pilates Studio', '🤸', 'scheduling', 'Fitness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('plumber', 'Plumber', '🔌', 'scheduling', 'Home & Auto Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('printing', 'Printing & Signage', '🖨️', 'ordering', 'Delivery & Retail', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('property_manager', 'Property Manager', '🏗️', 'scheduling', 'Real Estate & Property', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('security', 'Security Services', '🛡️', 'scheduling', 'Professional Services', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('supermarket', 'Supermarket / Grocery', '🏬', 'ordering', 'Delivery & Retail', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('therapy', 'Therapy & Counseling', '🧠', 'scheduling', 'Health & Medical', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('training_academy', 'Training Academy', '🏫', 'scheduling', 'Education & Training', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('videographer', 'Videographer', '🎥', 'scheduling', 'Creative & Media', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('waxing', 'Waxing Studio', '✨', 'scheduling', 'Beauty & Wellness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

INSERT INTO category_templates (key, label, icon, flow_type, category_group, is_active, sort_order, labels, default_capabilities, default_services, default_greeting, metadata)
VALUES ('yoga', 'Yoga Studio', '🧘', 'scheduling', 'Fitness', true, 100,
  '{}', NULL, '[]'::jsonb, 'Welcome to {{name}}! How can I help you today?', '{}'::jsonb)
ON CONFLICT (key) DO UPDATE SET is_active = true, label = EXCLUDED.label, icon = EXCLUDED.icon,
  flow_type = EXCLUDED.flow_type, category_group = EXCLUDED.category_group;

-- Part 3: Update category_group for 18 existing categories
UPDATE category_templates SET category_group = 'Government & Public' WHERE key = 'car_park';
UPDATE category_templates SET category_group = 'Food & Dining' WHERE key = 'catering';
UPDATE category_templates SET category_group = 'Delivery & Retail' WHERE key = 'food_delivery';
UPDATE category_templates SET category_group = 'Government & Public' WHERE key = 'government';
UPDATE category_templates SET category_group = 'Fitness' WHERE key = 'gym';
UPDATE category_templates SET category_group = 'Delivery & Retail' WHERE key = 'instagram_vendor';
UPDATE category_templates SET category_group = 'Transport & Logistics' WHERE key = 'logistics';
UPDATE category_templates SET category_group = 'Delivery & Retail' WHERE key = 'mall_vendor';
UPDATE category_templates SET category_group = 'Delivery & Retail' WHERE key = 'pharmacy';
UPDATE category_templates SET category_group = 'Creative & Media' WHERE key = 'photographer';
UPDATE category_templates SET category_group = 'Real Estate & Property' WHERE key = 'real_estate';
UPDATE category_templates SET category_group = 'Food & Dining' WHERE key = 'restaurant';
UPDATE category_templates SET category_group = 'Education & Training' WHERE key = 'school';
UPDATE category_templates SET category_group = 'Delivery & Retail' WHERE key = 'shop';
UPDATE category_templates SET category_group = 'Delivery & Retail' WHERE key = 'tailor';
UPDATE category_templates SET category_group = 'Transport & Logistics' WHERE key = 'taxi';
UPDATE category_templates SET category_group = 'Transport & Logistics' WHERE key = 'transport';
UPDATE category_templates SET category_group = 'Education & Training' WHERE key = 'tutor';

-- Part 4: Compute alphabetical sort_order within each group
UPDATE category_templates SET sort_order = 0 WHERE key = 'barber';
UPDATE category_templates SET sort_order = 1 WHERE key = 'lash_tech';
UPDATE category_templates SET sort_order = 2 WHERE key = 'medspa';
UPDATE category_templates SET sort_order = 3 WHERE key = 'mua';
UPDATE category_templates SET sort_order = 4 WHERE key = 'nail_tech';
UPDATE category_templates SET sort_order = 5 WHERE key = 'salon';
UPDATE category_templates SET sort_order = 6 WHERE key = 'spa';
UPDATE category_templates SET sort_order = 7 WHERE key = 'tattoo';
UPDATE category_templates SET sort_order = 8 WHERE key = 'waxing';
UPDATE category_templates SET sort_order = 9 WHERE key = 'content_creator';
UPDATE category_templates SET sort_order = 10 WHERE key = 'dj';
UPDATE category_templates SET sort_order = 11 WHERE key = 'graphic_designer';
UPDATE category_templates SET sort_order = 12 WHERE key = 'photographer';
UPDATE category_templates SET sort_order = 13 WHERE key = 'videographer';
UPDATE category_templates SET sort_order = 14 WHERE key = 'food_delivery';
UPDATE category_templates SET sort_order = 15 WHERE key = 'instagram_vendor';
UPDATE category_templates SET sort_order = 16 WHERE key = 'mall_vendor';
UPDATE category_templates SET sort_order = 17 WHERE key = 'pharmacy';
UPDATE category_templates SET sort_order = 18 WHERE key = 'printing';
UPDATE category_templates SET sort_order = 19 WHERE key = 'shop';
UPDATE category_templates SET sort_order = 20 WHERE key = 'supermarket';
UPDATE category_templates SET sort_order = 21 WHERE key = 'tailor';
UPDATE category_templates SET sort_order = 22 WHERE key = 'daycare';
UPDATE category_templates SET sort_order = 23 WHERE key = 'driving_school';
UPDATE category_templates SET sort_order = 24 WHERE key = 'language_school';
UPDATE category_templates SET sort_order = 25 WHERE key = 'school';
UPDATE category_templates SET sort_order = 26 WHERE key = 'training_academy';
UPDATE category_templates SET sort_order = 27 WHERE key = 'tutor';
UPDATE category_templates SET sort_order = 28 WHERE key = 'cinema';
UPDATE category_templates SET sort_order = 29 WHERE key = 'event_services';
UPDATE category_templates SET sort_order = 30 WHERE key = 'events';
UPDATE category_templates SET sort_order = 31 WHERE key = 'music_studio';
UPDATE category_templates SET sort_order = 32 WHERE key = 'church';
UPDATE category_templates SET sort_order = 33 WHERE key = 'crowdfunding_org';
UPDATE category_templates SET sort_order = 34 WHERE key = 'mosque';
UPDATE category_templates SET sort_order = 35 WHERE key = 'ngo';
UPDATE category_templates SET sort_order = 36 WHERE key = 'bootcamp';
UPDATE category_templates SET sort_order = 37 WHERE key = 'dance';
UPDATE category_templates SET sort_order = 38 WHERE key = 'gym';
UPDATE category_templates SET sort_order = 39 WHERE key = 'martial_arts';
UPDATE category_templates SET sort_order = 40 WHERE key = 'pilates';
UPDATE category_templates SET sort_order = 41 WHERE key = 'yoga';
UPDATE category_templates SET sort_order = 42 WHERE key = 'bakery';
UPDATE category_templates SET sort_order = 43 WHERE key = 'bar';
UPDATE category_templates SET sort_order = 44 WHERE key = 'cafe';
UPDATE category_templates SET sort_order = 45 WHERE key = 'catering';
UPDATE category_templates SET sort_order = 46 WHERE key = 'food_truck';
UPDATE category_templates SET sort_order = 47 WHERE key = 'lounge';
UPDATE category_templates SET sort_order = 48 WHERE key = 'restaurant';
UPDATE category_templates SET sort_order = 49 WHERE key = 'car_park';
UPDATE category_templates SET sort_order = 50 WHERE key = 'government';
UPDATE category_templates SET sort_order = 51 WHERE key = 'clinic';
UPDATE category_templates SET sort_order = 52 WHERE key = 'dental';
UPDATE category_templates SET sort_order = 53 WHERE key = 'optician';
UPDATE category_templates SET sort_order = 54 WHERE key = 'physiotherapy';
UPDATE category_templates SET sort_order = 55 WHERE key = 'therapy';
UPDATE category_templates SET sort_order = 56 WHERE key = 'veterinary';
UPDATE category_templates SET sort_order = 57 WHERE key = 'car_wash';
UPDATE category_templates SET sort_order = 58 WHERE key = 'cleaning';
UPDATE category_templates SET sort_order = 59 WHERE key = 'electrician';
UPDATE category_templates SET sort_order = 60 WHERE key = 'handyman';
UPDATE category_templates SET sort_order = 61 WHERE key = 'hvac';
UPDATE category_templates SET sort_order = 62 WHERE key = 'landscaping';
UPDATE category_templates SET sort_order = 63 WHERE key = 'laundry';
UPDATE category_templates SET sort_order = 64 WHERE key = 'mechanic';
UPDATE category_templates SET sort_order = 65 WHERE key = 'pest_control';
UPDATE category_templates SET sort_order = 66 WHERE key = 'plumber';
UPDATE category_templates SET sort_order = 67 WHERE key = 'car_rental';
UPDATE category_templates SET sort_order = 68 WHERE key = 'hotel';
UPDATE category_templates SET sort_order = 69 WHERE key = 'shortlet';
UPDATE category_templates SET sort_order = 70 WHERE key = 'funeral';
UPDATE category_templates SET sort_order = 71 WHERE key = 'other';
UPDATE category_templates SET sort_order = 72 WHERE key = 'dog_walking';
UPDATE category_templates SET sort_order = 73 WHERE key = 'pet_boarding';
UPDATE category_templates SET sort_order = 74 WHERE key = 'pet_grooming';
UPDATE category_templates SET sort_order = 75 WHERE key = 'pet_training';
UPDATE category_templates SET sort_order = 76 WHERE key = 'accounting';
UPDATE category_templates SET sort_order = 77 WHERE key = 'consultant';
UPDATE category_templates SET sort_order = 78 WHERE key = 'coworking';
UPDATE category_templates SET sort_order = 79 WHERE key = 'legal';
UPDATE category_templates SET sort_order = 80 WHERE key = 'security';
UPDATE category_templates SET sort_order = 81 WHERE key = 'travel_agency';
UPDATE category_templates SET sort_order = 82 WHERE key = 'mortgage_broker';
UPDATE category_templates SET sort_order = 83 WHERE key = 'property_manager';
UPDATE category_templates SET sort_order = 84 WHERE key = 'real_estate';
UPDATE category_templates SET sort_order = 85 WHERE key = 'bus';
UPDATE category_templates SET sort_order = 86 WHERE key = 'courier';
UPDATE category_templates SET sort_order = 87 WHERE key = 'logistics';
UPDATE category_templates SET sort_order = 88 WHERE key = 'moving';
UPDATE category_templates SET sort_order = 89 WHERE key = 'taxi';
UPDATE category_templates SET sort_order = 90 WHERE key = 'transport';
