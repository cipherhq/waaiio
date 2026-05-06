-- Add category_group column for grouped onboarding
ALTER TABLE category_templates ADD COLUMN IF NOT EXISTS category_group VARCHAR(50) DEFAULT 'Other';

-- Assign groups to existing categories
UPDATE category_templates SET category_group = 'Beauty & Wellness' WHERE key IN ('barber', 'salon', 'spa', 'tattoo');
UPDATE category_templates SET category_group = 'Health & Medical' WHERE key IN ('clinic', 'dental', 'veterinary');
UPDATE category_templates SET category_group = 'Food & Drink' WHERE key IN ('restaurant', 'food_delivery', 'catering');
UPDATE category_templates SET category_group = 'Events & Entertainment' WHERE key IN ('events', 'event_services', 'photographer', 'cinema');
UPDATE category_templates SET category_group = 'Professional Services' WHERE key IN ('consultant', 'tutor', 'coworking', 'real_estate', 'travel_agency');
UPDATE category_templates SET category_group = 'Home & Auto Services' WHERE key IN ('laundry', 'car_wash', 'logistics', 'car_park');
UPDATE category_templates SET category_group = 'Shops & Commerce' WHERE key IN ('shop', 'instagram_vendor', 'mall_vendor', 'pharmacy', 'tailor');
UPDATE category_templates SET category_group = 'Hospitality' WHERE key IN ('hotel', 'shortlet');
UPDATE category_templates SET category_group = 'Faith & Community' WHERE key IN ('church', 'mosque', 'school', 'ngo', 'crowdfunding_org');
UPDATE category_templates SET category_group = 'Fitness & Wellness' WHERE key IN ('gym');
UPDATE category_templates SET category_group = 'Transport' WHERE key IN ('taxi', 'transport');
UPDATE category_templates SET category_group = 'Other' WHERE key IN ('government', 'funeral', 'other');
