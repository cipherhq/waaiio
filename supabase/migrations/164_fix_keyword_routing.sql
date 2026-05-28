-- Fix keyword routing bugs found in comprehensive audit

-- BUG 2: Shortlet keywords route to scheduling instead of reservation
UPDATE bot_keywords
SET payload = '{"capability":"reservation"}'
WHERE keyword IN ('apartment', 'flat', 'accommodation', 'room')
  AND scope = 'category'
  AND category IN ('shortlet', 'hotel', 'airbnb', 'car_rental')
  AND action_type = 'start_capability'
  AND payload = '{"capability":"scheduling"}';

-- BUG 3: Restaurant table/dine-in keywords route to scheduling instead of table_reservation
UPDATE bot_keywords
SET payload = '{"capability":"table_reservation"}'
WHERE keyword IN ('table', 'dine-in', 'dine in', 'reservation')
  AND scope = 'category'
  AND category IN ('restaurant', 'cafe', 'bar', 'lounge')
  AND action_type = 'start_capability'
  AND payload = '{"capability":"scheduling"}';

-- BUG 5: Add "menu" as ordering keyword for food businesses (overrides system show_menu)
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('menu', 'exact', 'start_capability', '{"capability":"ordering"}', true, 95, 'category', 'restaurant', 'Menu - starts ordering flow for restaurants'),
  ('menu', 'exact', 'start_capability', '{"capability":"ordering"}', true, 95, 'category', 'cafe', 'Menu - starts ordering flow for cafes'),
  ('menu', 'exact', 'start_capability', '{"capability":"ordering"}', true, 95, 'category', 'food_delivery', 'Menu - starts ordering flow for food delivery'),
  ('menu', 'exact', 'start_capability', '{"capability":"ordering"}', true, 95, 'category', 'bakery', 'Menu - starts ordering flow for bakeries'),
  ('menu', 'exact', 'start_capability', '{"capability":"ordering"}', true, 95, 'category', 'catering', 'Menu - starts ordering flow for catering')
ON CONFLICT DO NOTHING;

-- BUG 7: Add crowdfunding keywords for NGO/crowdfunding categories
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('campaign', 'contains', 'start_capability', '{"capability":"crowdfunding"}', true, 60, 'category', 'ngo', 'Campaign - starts crowdfunding flow'),
  ('campaign', 'contains', 'start_capability', '{"capability":"crowdfunding"}', true, 60, 'category', 'crowdfunding_org', 'Campaign - starts crowdfunding flow'),
  ('fundraise', 'contains', 'start_capability', '{"capability":"crowdfunding"}', true, 60, 'category', 'ngo', 'Fundraise - starts crowdfunding flow'),
  ('fundraise', 'contains', 'start_capability', '{"capability":"crowdfunding"}', true, 60, 'category', 'crowdfunding_org', 'Fundraise - starts crowdfunding flow'),
  ('support', 'exact', 'start_capability', '{"capability":"crowdfunding"}', true, 55, 'category', 'ngo', 'Support - starts crowdfunding flow'),
  ('support', 'exact', 'start_capability', '{"capability":"crowdfunding"}', true, 55, 'category', 'crowdfunding_org', 'Support - starts crowdfunding flow')
ON CONFLICT DO NOTHING;
