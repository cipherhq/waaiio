-- Fix: Church keywords "tithe" and "offering" were routing to 'payment' capability
-- instead of 'giving' capability. This caused "No payment categories are set up yet"
-- because payment.flow.ts filters giving services OUT when active_capability != 'giving'.
--
-- Root cause: Migration 041 seeded these keywords before the 'giving' capability existed.

-- ── 1. Fix existing church keywords ──────────────────────────
UPDATE bot_keywords
SET payload = '{"capability":"giving"}',
    description = 'Tithe - starts giving flow'
WHERE keyword = 'tithe'
  AND scope = 'category'
  AND category = 'church'
  AND action_type = 'start_capability';

UPDATE bot_keywords
SET payload = '{"capability":"giving"}',
    description = 'Offering - starts giving flow'
WHERE keyword = 'offering'
  AND scope = 'category'
  AND category = 'church'
  AND action_type = 'start_capability';

-- ── 2. Add more church giving keywords ──────────────────────
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('donate', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'church', 'Donate - starts giving flow'),
  ('donation', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'church', 'Donation - starts giving flow'),
  ('seed', 'contains', 'start_capability', '{"capability":"giving"}', true, 55, 'category', 'church', 'Seed/sow seed - starts giving flow'),
  ('first fruit', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'church', 'First fruit - starts giving flow'),
  ('building fund', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'church', 'Building fund - starts giving flow'),
  ('welfare', 'contains', 'start_capability', '{"capability":"giving"}', true, 55, 'category', 'church', 'Welfare - starts giving flow')
ON CONFLICT DO NOTHING;

-- ── 3. Add mosque giving keywords ───────────────────────────
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('zakat', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'mosque', 'Zakat - starts giving flow'),
  ('sadaqah', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'mosque', 'Sadaqah - starts giving flow'),
  ('sadaka', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'mosque', 'Sadaka - starts giving flow'),
  ('fitrah', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'mosque', 'Fitrah - starts giving flow'),
  ('donate', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'mosque', 'Donate - starts giving flow'),
  ('donation', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'mosque', 'Donation - starts giving flow')
ON CONFLICT DO NOTHING;

-- ── 4. Add NGO giving keywords ──────────────────────────────
INSERT INTO bot_keywords (keyword, match_type, action_type, payload, is_active, priority, scope, category, description)
VALUES
  ('donate', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'ngo', 'Donate - starts giving flow'),
  ('donation', 'contains', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'ngo', 'Donation - starts giving flow'),
  ('give', 'exact', 'start_capability', '{"capability":"giving"}', true, 60, 'category', 'ngo', 'Give - starts giving flow')
ON CONFLICT DO NOTHING;
