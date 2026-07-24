-- ═══════════════════════════════════════════════════════
-- 244: Add auto_approve_limits to platform_settings
-- ═══════════════════════════════════════════════════════
-- Moves hardcoded auto-approve limits to database for admin control.
-- Values are in local currency minor units.

INSERT INTO platform_settings (key, value, description, category)
VALUES (
  'auto_approve_limits',
  '{"NG": 500000, "US": 1000, "GB": 800, "CA": 1000, "GH": 5000}'::jsonb,
  'Max auto-approve payout amount per country in local currency minor units. Payouts above this require manual admin approval.',
  'payouts'
)
ON CONFLICT (key) DO NOTHING;
