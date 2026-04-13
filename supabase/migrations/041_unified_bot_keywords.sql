-- ============================================================
-- 041: Unified Bot Keywords System
-- Merges hardcoded intents, business keywords, and quick replies
-- into a single bot_keywords table with scope-based priority.
-- ============================================================

-- ── 1. Schema Changes ─────────────────────────────────────

-- Make business_id nullable (system/category keywords have no business)
ALTER TABLE bot_keywords ALTER COLUMN business_id DROP NOT NULL;

-- Add scope column
ALTER TABLE bot_keywords ADD COLUMN IF NOT EXISTS scope VARCHAR(10) NOT NULL DEFAULT 'business'
  CHECK (scope IN ('system', 'category', 'business'));

-- Add category column (links to category_templates.key)
ALTER TABLE bot_keywords ADD COLUMN IF NOT EXISTS category VARCHAR(40);

-- Add description column (admin-facing explanation)
ALTER TABLE bot_keywords ADD COLUMN IF NOT EXISTS description TEXT;

-- Expand match_type to include regex
ALTER TABLE bot_keywords DROP CONSTRAINT IF EXISTS bot_keywords_match_type_check;
ALTER TABLE bot_keywords ADD CONSTRAINT bot_keywords_match_type_check
  CHECK (match_type IN ('exact', 'contains', 'starts_with', 'regex'));

-- Expand action_type with new actions
ALTER TABLE bot_keywords DROP CONSTRAINT IF EXISTS bot_keywords_action_type_check;
ALTER TABLE bot_keywords ADD CONSTRAINT bot_keywords_action_type_check
  CHECK (action_type IN ('reply', 'start_flow', 'start_capability', 'url', 'navigate_step', 'acknowledge', 'show_menu'));

-- ── 2. Integrity Constraints ──────────────────────────────

-- System keywords must NOT have a business_id
ALTER TABLE bot_keywords ADD CONSTRAINT system_no_business
  CHECK ((scope = 'system' AND business_id IS NULL) OR scope != 'system');

-- Category keywords must have a category
ALTER TABLE bot_keywords ADD CONSTRAINT category_has_category
  CHECK ((scope = 'category' AND category IS NOT NULL) OR scope != 'category');

-- Business keywords must have a business_id
ALTER TABLE bot_keywords ADD CONSTRAINT business_has_business
  CHECK ((scope = 'business' AND business_id IS NOT NULL) OR scope != 'business');

-- ── 3. RLS Policies ──────────────────────────────────────

-- Drop old policy
DROP POLICY IF EXISTS "owner_crud" ON bot_keywords;

-- Admins (service_role) manage system & category keywords
CREATE POLICY "admins_manage_system_category" ON bot_keywords FOR ALL
  USING (scope IN ('system', 'category') AND auth.role() = 'service_role');

-- Business owners manage their own keywords
CREATE POLICY "owners_manage_business_keywords" ON bot_keywords FOR ALL
  USING (scope = 'business' AND business_id IN (
    SELECT id FROM businesses WHERE owner_id = auth.uid()
  ));

-- Everyone can read system & category keywords
CREATE POLICY "anyone_read_system_category" ON bot_keywords FOR SELECT
  USING (scope IN ('system', 'category'));

-- ── 4. Indexes ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_bot_keywords_system
  ON bot_keywords(scope, is_active) WHERE scope = 'system';

CREATE INDEX IF NOT EXISTS idx_bot_keywords_category
  ON bot_keywords(category, is_active) WHERE scope = 'category';

-- ── 5. Seed System Keywords (from INTENT_RULES) ──────────

INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, description)
VALUES
  -- Greeting
  ('^(hi|hello|hey|good morning|good afternoon|good evening|yo|howdy|hiya|sup)$', 'regex', 'show_menu',
   '{"message":"greeting"}', true, 100, 'system',
   'Greeting detection - triggers welcome menu'),

  -- Help
  ('^(help|support|assist|what can you do|how does this work|options)$', 'regex', 'reply',
   '{"message":"Need help? Here are your options:\n\u2022 Type *menu* to see available services\n\u2022 Type *status* to check your booking\n\u2022 Type *cancel* to cancel current action"}',
   true, 100, 'system',
   'Help menu - shows available commands'),

  -- Booking / Scheduling
  ('^(book|appointment|schedule|reserve)$', 'regex', 'start_capability',
   '{"capability":"scheduling"}', true, 90, 'system',
   'Booking intent - starts scheduling flow'),

  -- Status
  ('^(status|track|where|check|my order|my booking)$', 'regex', 'navigate_step',
   '{"action":"show_status"}', true, 90, 'system',
   'Status check - shows current booking/order status'),

  -- History
  ('^(history|previous|past|orders|bookings)$', 'regex', 'navigate_step',
   '{"action":"show_history"}', true, 80, 'system',
   'History lookup - shows past transactions'),

  -- Receipt
  ('^(receipt|invoice|proof)$', 'regex', 'navigate_step',
   '{"action":"show_receipt"}', true, 80, 'system',
   'Receipt request - sends last transaction receipt'),

  -- Menu / Options
  ('^(menu|options|services|what can|what do)$', 'regex', 'show_menu',
   '{"message":"menu"}', true, 90, 'system',
   'Menu request - shows available services/options'),

  -- Pricing
  ('^(price|cost|how much|fee|charge)$', 'regex', 'navigate_step',
   '{"action":"show_pricing"}', true, 70, 'system',
   'Pricing inquiry - shows pricing information'),

  -- Hours
  ('^(hours|open|close|when|time|available)$', 'regex', 'reply',
   '{"message":"Please check our business page for current hours, or ask about a specific service."}',
   true, 70, 'system',
   'Business hours inquiry'),

  -- Location
  ('^(location|address|where are|directions|find you)$', 'regex', 'reply',
   '{"message":"Please check our business page for our location details."}',
   true, 70, 'system',
   'Location inquiry'),

  -- Thanks
  ('^(thank|thanks|thx|cheers|appreciate)$', 'regex', 'acknowledge',
   '{"message":"You''re welcome! Is there anything else I can help with?"}',
   true, 60, 'system',
   'Gratitude acknowledgment'),

  -- Check-in
  ('^(checkin|check.in|check in|i.m here|arrived|im here)$', 'regex', 'navigate_step',
   '{"action":"checkin"}', true, 90, 'system',
   'Queue check-in trigger'),

  -- Escalate to human
  ('^(escalate|human|agent|speak to|talk to|real person|manager|live chat|customer service)$', 'regex', 'navigate_step',
   '{"action":"escalate"}', true, 95, 'system',
   'Human escalation - routes to live agent'),

  -- Ordering
  ('^(order|buy|purchase|add to cart)$', 'regex', 'start_capability',
   '{"capability":"ordering"}', true, 90, 'system',
   'Order intent - starts ordering flow');

-- ── 6. Seed Category Keywords ─────────────────────────────

-- Church / Religious
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('pastor', 'contains', 'reply', '{"message":"To speak with a pastor, please type *talk to human* or visit during service hours."}', true, 50, 'category', 'church', 'Pastor inquiry'),
  ('sermon', 'contains', 'reply', '{"message":"Check our events page for upcoming sermons and service times."}', true, 50, 'category', 'church', 'Sermon inquiry'),
  ('tithe', 'contains', 'start_capability', '{"capability":"payment"}', true, 60, 'category', 'church', 'Tithe - starts payment flow'),
  ('offering', 'contains', 'start_capability', '{"capability":"payment"}', true, 60, 'category', 'church', 'Offering - starts payment flow'),
  ('prayer', 'contains', 'reply', '{"message":"We''d love to pray with you. Type *talk to human* to connect with a prayer partner."}', true, 50, 'category', 'church', 'Prayer request');

-- Restaurant
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('delivery', 'contains', 'start_capability', '{"capability":"ordering"}', true, 60, 'category', 'restaurant', 'Delivery - starts ordering flow'),
  ('takeout', 'contains', 'start_capability', '{"capability":"ordering"}', true, 60, 'category', 'restaurant', 'Takeout - starts ordering flow'),
  ('dine-in', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 60, 'category', 'restaurant', 'Dine-in - starts reservation flow'),
  ('table', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 55, 'category', 'restaurant', 'Table reservation');

-- Salon / Beauty
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('haircut', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 60, 'category', 'salon', 'Haircut - starts scheduling flow'),
  ('nails', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 60, 'category', 'salon', 'Nails - starts scheduling flow'),
  ('facial', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 60, 'category', 'salon', 'Facial - starts scheduling flow'),
  ('massage', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 60, 'category', 'salon', 'Massage - starts scheduling flow');

-- Shortlet / Accommodation
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('apartment', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 60, 'category', 'shortlet', 'Apartment - starts reservation flow'),
  ('flat', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 55, 'category', 'shortlet', 'Flat inquiry'),
  ('accommodation', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 60, 'category', 'shortlet', 'Accommodation - starts reservation flow'),
  ('room', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 55, 'category', 'shortlet', 'Room - starts reservation flow');

-- Healthcare
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('doctor', 'contains', 'start_capability', '{"capability":"scheduling"}', true, 60, 'category', 'healthcare', 'Doctor appointment'),
  ('prescription', 'contains', 'reply', '{"message":"For prescriptions, please visit during clinic hours or type *talk to human*."}', true, 50, 'category', 'healthcare', 'Prescription inquiry'),
  ('emergency', 'contains', 'reply', '{"message":"For emergencies, please call your local emergency number immediately."}', true, 70, 'category', 'healthcare', 'Emergency notice');

-- ── 7. Migrate Quick Replies to Business Keywords ─────────

INSERT INTO bot_keywords (business_id, keyword, match_type, action_type, payload, is_active, priority, scope)
SELECT
  wc.business_id,
  qr->>'trigger',
  'contains',
  'reply',
  qr->>'response',
  true,
  10,
  'business'
FROM whatsapp_config wc,
     jsonb_array_elements(wc.quick_replies) AS qr
WHERE wc.quick_replies IS NOT NULL
  AND jsonb_array_length(wc.quick_replies) > 0
  AND (qr->>'trigger') IS NOT NULL
  AND (qr->>'trigger') != '';
